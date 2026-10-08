// Viator (SOP Part B) — Layer 1: parse uploaded payment advice files and build
// the VIA journal. Pure: no DB / B2 here.
//
// PARSER INTERFACE
//   A parser is { name, accepts(fileName) -> bool, parse(buffer, fileName) -> Advice }
//   Advice = { rows: [{ entity, bookingRef, travelDate, netCents, currency }],
//              paymentDate: 'YYYY-MM-DD' | '', warnings: [] }
// No real advice file was available when this was written, so the only
// implementation is a TABULAR parser (CSV, and XLSX via the same code) that finds
// columns by header name using the aliases below. When a real advice arrives,
// add a parser to PARSERS (or extend the aliases) — nothing else changes.

import XLSX from 'xlsx';
import { ACCOUNTS, OPTIONS, lookupCompany, nameFor, normName, COMPANIES } from './settings.js';
import { toCents, normDate, place, monthMeta, convertCents } from './money.js';
import { needsConversion, rateMap, rateKey, rateProblem } from './fx.js';
import * as C from './checks.js';

const HEADER_ALIASES = {
  entity: ['entity', 'supplier', 'supplier name', 'operator', 'operator name', 'company', 'merchant'],
  bookingRef: ['booking ref', 'booking reference', 'booking ref.', 'booking id', 'booking number', 'reference', 'itinerary number', 'confirmation code'],
  travelDate: ['travel date', 'tour date', 'date of travel', 'activity date', 'service date'],
  net: ['net amount', 'net', 'net rate', 'amount payable', 'supplier net', 'payment amount', 'net payable', 'amount'],
  currency: ['currency', 'ccy', 'currency code'],
  paymentDate: ['payment date', 'paid date', 'remittance date', 'date paid'],
};
const REQUIRED = ['bookingRef', 'net'];

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = (rows[i] || []).map(normName);
    const cols = {};
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      const idx = cells.findIndex((c) => aliases.some((a) => normName(a) === c));
      if (idx !== -1) cols[key] = idx;
    }
    if (REQUIRED.every((k) => cols[k] !== undefined)) return { index: i, cols };
  }
  return null;
}

export const tabularParser = {
  name: 'tabular (CSV / XLSX)',
  accepts: (fileName) => /\.(csv|xlsx|xls)$/i.test(fileName || ''),
  parse(buffer, fileName, { defaultCurrency = 'USD', defaultEntity = '' } = {}) {
    const isCsv = /\.csv$/i.test(fileName || '');
    const wb = isCsv
      ? XLSX.read(buffer.toString('utf8'), { type: 'string', raw: true })
      : XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: true, defval: '' });
    const h = findHeader(rows);
    if (!h) {
      const want = REQUIRED.map((k) => `"${HEADER_ALIASES[k][0]}"`).join(' and ');
      throw new Error(`could not find the advice columns — the file needs at least ${want} headers`);
    }
    const warnings = [];
    if (h.cols.currency === undefined) warnings.push(`no Currency column — assumed ${defaultCurrency}`);
    if (h.cols.entity === undefined) warnings.push(`no Entity column — used the location picked at upload`);

    const out = [];
    let paymentDate = '';
    for (const r of rows.slice(h.index + 1)) {
      const ref = String(r[h.cols.bookingRef] ?? '').trim();
      if (!ref || /^total/i.test(ref)) continue;
      const pd = h.cols.paymentDate !== undefined ? normDate(r[h.cols.paymentDate]) : '';
      if (pd && !paymentDate) paymentDate = pd;
      out.push({
        entity: h.cols.entity !== undefined ? String(r[h.cols.entity] ?? '').trim() || defaultEntity : defaultEntity,
        bookingRef: ref,
        travelDate: h.cols.travelDate !== undefined ? normDate(r[h.cols.travelDate]) : '',
        netCents: toCents(r[h.cols.net]),
        currency:
          (h.cols.currency !== undefined ? String(r[h.cols.currency] ?? '').trim().toUpperCase() : '') || defaultCurrency,
      });
    }
    if (!out.length) throw new Error('the advice file has no booking rows');
    return { rows: out, paymentDate, warnings };
  },
};

export const PARSERS = [tabularParser];

export function parseAdvice(buffer, fileName, opts) {
  const p = PARSERS.find((x) => x.accepts(fileName));
  if (!p) {
    throw new Error(
      `no parser for "${fileName}" yet — upload the advice as CSV or XLSX (a parser for this format can be added in accounting/viator.js)`
    );
  }
  return { parser: p.name, ...p.parse(buffer, fileName, opts) };
}

export function homeCurrency(location) {
  return COMPANIES.find((c) => normName(c.name) === normName(location))?.currency || 'USD';
}

// Rate rows needed for the advices: one per location · currency · payment date
// (blank payment date = the user enters a rate for that advice).
export function neededViatorRates(advices) {
  const out = [];
  for (const a of advices) {
    for (const cur of new Set(a.rows.map((r) => r.currency))) {
      if (needsConversion(cur)) {
        out.push({ location: a.location, currency: cur, date: a.paymentDate || '', source: 'viator', label: `Viator advice ${a.fileName}` });
      }
    }
  }
  return out;
}

/**
 * Build the VIA journal.
 *   month        the SALES month 'YYYY-MM'
 *   advices      [{ location, fileName, paymentDate, rows }]
 *   rates        FX rate table
 *   xola         saved XOLA journal (for the Xola Viator Net per location)
 *   previous     { hadRun: bool, locations: [names] } — last month's advices
 */
export function buildViatorJournal({ month, advices, rates = [], xola = null, previous = { hadRun: false, locations: [] }, options = OPTIONS }) {
  if (!advices.length) throw new Error('upload at least one Viator payment advice first');
  const period = monthMeta(month);
  const meta = { journalNo: nameFor('viator', month), journalDate: period.journalDate };
  const rmap = rateMap(rates);

  const byLoc = new Map();
  for (const a of advices) {
    const k = normName(a.location);
    if (!byLoc.has(k)) byLoc.set(k, { location: a.location, advices: [] });
    byLoc.get(k).advices.push(a);
  }

  const lines = [];
  const figures = [];
  const checks = [];
  const missingRates = new Set();

  for (const { location, advices: list } of [...byLoc.values()].sort((a, b) => a.location.localeCompare(b.location))) {
    const who = lookupCompany(location, options);
    if (who.status !== 'post') {
      checks.push(C.result('V0', location, 'Entity has a QBO class', 'class', 'none', { unit: 'text', pass: false, note: who.reason }));
      continue;
    }
    let usd = 0;
    let local = 0;
    const currencies = new Set();
    for (const a of list) {
      for (const r of a.rows) {
        currencies.add(r.currency);
        local += r.netCents;
        if (!needsConversion(r.currency)) {
          usd += r.netCents;
          continue;
        }
        const rate = rmap.get(rateKey(location, r.currency, a.paymentDate || ''));
        if (!rate) {
          const stored = rates.find((x) => rateKey(x.location, x.currency, x.date) === rateKey(location, r.currency, a.paymentDate || ''));
          missingRates.add(`${location} · ${r.currency} · ${a.paymentDate || `advice ${a.fileName}`}: ${rateProblem(r.currency, stored?.rate)}`);
          continue;
        }
        usd += convertCents(r.netCents, rate);
      }
    }
    const currency = [...currencies].join('/') || 'USD';
    figures.push({ location, class: who.company.class, currency, adviceLocalCents: local, adviceUsdCents: usd, files: list.map((a) => a.fileName) });

    const locLines = [];
    if (usd !== 0 && !options.viatorInXola) {
      for (const [account, side] of [[ACCOUNTS.viatorClearing, 'debit'], [ACCOUNTS.viatorRevenue, 'credit']]) {
        const { debit, credit } = place(usd, side);
        locLines.push({ ...meta, account, debit, credit, description: `Viator net per payment advice – ${location}`, class: who.company.class, location, basis: 'adviceNet', amount: usd });
      }
    }
    lines.push(...locLines);

    const journalDebit = locLines.filter((l) => l.account === ACCOUNTS.viatorClearing).reduce((s, l) => s + l.debit - l.credit, 0);
    if (!options.viatorInXola) checks.push(C.checkViatorEntity(location, journalDebit, usd));
    checks.push(C.checkClasses(location, locLines, 'V7'));

    const xolaLoc = (xola?.locations || []).find((l) => normName(l.location) === normName(location));
    checks.push(C.checkViatorVsXola(location, xolaLoc?.viatorNetLocalCents ?? 0, local, currency));
  }

  // Xola had Viator sales but no advice was uploaded for the location.
  for (const l of xola?.locations || []) {
    if (l.viatorNetLocalCents && !byLoc.has(normName(l.location))) {
      checks.push(C.checkViatorVsXola(l.location, l.viatorNetLocalCents, 0, l.currency));
    }
  }

  if (missingRates.size) {
    const err = new Error(`FX rates needed before the Viator journal can be built (enter them in step 3 and click “Save rates”):\n${[...missingRates].join('\n')}`);
    err.code = 'FX_RATES_MISSING';
    err.details = [...missingRates];
    throw err;
  }

  const journalTotal = lines.filter((l) => l.account === ACCOUNTS.viatorClearing).reduce((s, l) => s + l.debit - l.credit, 0);
  const adviceTotal = figures.reduce((s, f) => s + f.adviceUsdCents, 0);
  checks.push(
    ...C.checkViatorContinuity(previous.locations || [], [...byLoc.values()].map((b) => b.location), previous.hadRun),
    C.checkViatorDate(meta.journalDate, period.journalDate),
    ...(options.viatorInXola
      ? [C.result('V4', 'ALL', 'Viator is posted in the XOLA journal (setting viatorInXola) — advices are a check only, nothing to import here', 'check only', 'check only', { unit: 'text', pass: true })]
      : [C.checkViatorTotal(journalTotal, adviceTotal)]),
    ...C.checkBalanced(lines, 'V6')
  );
  if (!xola) {
    checks.push(C.result('V5', 'ALL', 'XOLA journal built (needed for the Viator comparison)', 'built', 'not built', { unit: 'text', pass: false }));
  }

  return { ...meta, lines, figures, checks };
}

// ---- Layer 2 hook (NOT built yet) ---------------------------------------------
// Fetch the month's advice for an entity automatically — by API if Viator has
// one, otherwise with Playwright on a non-Vercel host. Must return
// { fileName, buffer } so it can go through exactly the same upload path.
export async function fetchAdvice(/* { entity, month } */) {
  throw new Error('Automatic Viator advice download is not built yet (Layer 2) — upload the file instead.');
}
export const AUTO_FETCH_AVAILABLE = false;
