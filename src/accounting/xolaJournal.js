// Xola sales journal (SOP Part A, Steps 2–7). Pure: no DB, no B2 — the service
// layer (services/journals.js) reads the files and saves the result.

import { ACCOUNTS, GROUP_LABELS, OPTIONS, lookupCompany, nameFor } from './settings.js';
import { place, convertCents, monthMeta } from './money.js';
import { splitRows } from './classify.js';
import { needsConversion, rateKey, rateMap, rateProblem } from './fx.js';
import * as C from './checks.js';

const GROUP_ORDER = ['xola', 'gyg', 'airbnb', 'groupon', 'viator'];
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

// Convert one included row to USD cents.
// Net, Processing and Service are converted and rounded; Gross is the sum of the
// converted parts (plus any converted local difference) so a balanced local
// block stays balanced to the cent after conversion.
export function toUsd(row, location, rmap) {
  const base = {
    net: row.net,
    processingFee: row.processingFee,
    serviceFee: row.serviceFee,
    gross: row.gross,
  };
  if (!needsConversion(row.currency)) return { ...base, rate: 1 };
  const rate = rmap.get(rateKey(location, row.currency, row.payoutDate));
  if (!rate) return null;
  const net = convertCents(row.net, rate);
  const processingFee = convertCents(row.processingFee, rate);
  const serviceFee = convertCents(row.serviceFee, rate);
  const localDiff = row.gross - row.net - row.processingFee - row.serviceFee;
  const gross = net + processingFee + serviceFee + convertCents(localDiff, rate);
  return { net, processingFee, serviceFee, gross, rate };
}

// Rate rows the Xola (or earnings) files need: one per location · currency ·
// payout date, for INCLUDED foreign-currency rows only.
export function neededRates(sellers, source = 'xola', options = OPTIONS) {
  const out = [];
  for (const s of sellers) {
    if (s.error || lookupCompany(s.sellerName, options).status !== 'post') continue;
    let split;
    try {
      split = splitRows(s.rows, s.sellerName);
    } catch {
      continue; // unknown Source is reported by the build itself
    }
    for (const r of split.included) {
      if (!needsConversion(r.currency)) continue;
      out.push({ location: s.sellerName, currency: r.currency, date: r.payoutDate, source });
    }
  }
  return out;
}

// Lines for ONE location. `usdIncluded` = included rows with a `.usd` block.
export function locationLines(location, klass, usdIncluded, meta) {
  const posts = [];
  for (const g of GROUP_ORDER) {
    const rows = usdIncluded.filter((r) => r.group === g);
    if (!rows.length) continue;
    posts.push({
      account: ACCOUNTS.clearing[g],
      amount: sum(rows, (r) => r.usd.net),
      side: 'debit',
      basis: 'net',
      group: g,
      text: `Xola net – ${GROUP_LABELS[g]} – ${location}`,
    });
  }
  posts.push(
    { account: ACCOUNTS.processing, amount: sum(usdIncluded, (r) => r.usd.processingFee), side: 'debit', basis: 'processingFee', text: `Xola processing fees – ${location}` },
    { account: ACCOUNTS.service, amount: sum(usdIncluded, (r) => r.usd.serviceFee), side: 'debit', basis: 'serviceFee', text: `Xola service fees – ${location}` },
    { account: ACCOUNTS.gross, amount: sum(usdIncluded, (r) => r.usd.gross), side: 'credit', basis: 'gross', text: `Xola gross sales – ${location}` }
  );

  const lines = [];
  for (const p of posts) {
    if (p.amount === 0) continue; // skip zero lines
    const { debit, credit } = place(p.amount, p.side);
    lines.push({
      journalNo: meta.journalNo,
      journalDate: meta.journalDate,
      account: p.account,
      debit,
      credit,
      description: p.text,
      class: klass,
      location,
      basis: p.basis,
      group: p.group || null,
      amount: p.amount,
    });
  }
  return lines;
}

// Per Source value, as Xola shows it on the Transactions sheet: what the file
// says (local currency) and where the app puts it. Lets the reviewer tie each
// clearing account to Xola's Source / Channels filter.
export function sourceBreakdown(split, usdIncluded = []) {
  const usdBy = new Map();
  for (const r of usdIncluded) {
    const k = r.source || '(blank)';
    usdBy.set(k, (usdBy.get(k) || 0) + r.usd.net);
  }
  const map = new Map();
  const add = (rows, treat) => {
    for (const r of rows) {
      const k = r.source || '(blank)';
      const e = map.get(k) || { source: k, rows: 0, grossLocalCents: 0, netLocalCents: 0, netUsdCents: null, postedTo: treat(r) };
      e.rows++;
      e.grossLocalCents += r.gross;
      e.netLocalCents += r.net;
      map.set(k, e);
    }
  };
  add(split.included, (r) => ACCOUNTS.clearing[r.group]);
  add(split.viator, () => 'Left out — posted from the Viator advice (VIA journal)');  // only when viatorInXola = false
  add(split.office, () => 'Left out — office booking with no Payout Date (OFFICE list)');
  add(split.review, () => 'Left out — Source not in the SOP (review list)');
  for (const e of map.values()) if (usdBy.has(e.source)) e.netUsdCents = usdBy.get(e.source);
  return [...map.values()].sort((a, b) => Math.abs(b.netLocalCents) - Math.abs(a.netLocalCents));
}

/**
 * Build the XOLA journal.
 * @param {object} input
 *   month   'YYYY-MM'
 *   sellers [{ sellerName, rows, summary, error }]  parsed Cash Flow files
 *   rates   the run's FX rate table [{ location, currency, date, rate }]
 *   files   the run's file tasks [{ sellerName, type, status, reportCheck, error }]
 * @returns { journalNo, journalDate, lines, locations, office, notPosted, checks }
 * Throws on an unknown Source or a missing / out-of-limit FX rate (build is blocked).
 */
export function buildXolaJournal({ month, sellers, rates = [], files = [], options = OPTIONS }) {
  const period = monthMeta(month);
  const meta = { journalNo: nameFor('xola', month), journalDate: period.journalDate };
  const rmap = rateMap(rates);

  const lines = [];
  const locations = [];
  const office = [];
  const review = []; // Source not in the SOP table, decided 'review' in settings
  const notPosted = [];
  const checks = [];
  const missingRates = new Set();
  const unknownSources = [];

  for (const s of [...sellers].sort((a, b) => a.sellerName.localeCompare(b.sellerName))) {
    const who = lookupCompany(s.sellerName, options);
    if (who.status !== 'post') {
      notPosted.push({ sellerName: s.sellerName, reason: who.reason });
      continue;
    }
    const location = s.sellerName;
    if (s.error) {
      checks.push(C.result('X0', location, 'Cash Flow file readable', 'readable', 'failed', { unit: 'text', pass: false, note: s.error }));
      continue;
    }

    let split;
    try {
      split = splitRows(s.rows, s.sellerName);
    } catch (err) {
      if (err.code !== 'UNKNOWN_SOURCE') throw err;
      unknownSources.push(...err.unknown);
      continue;
    }
    const { included, viator, office: officeRows, review: reviewRows } = split;

    const usdIncluded = [];
    for (const r of included) {
      const usd = toUsd(r, location, rmap);
      if (!usd) {
        const stored = rates.find((x) => rateKey(x.location, x.currency, x.date) === rateKey(location, r.currency, r.payoutDate));
        missingRates.add(
          `${location} · ${r.currency} · ${r.payoutDate || 'no payout date'}: ${rateProblem(r.currency, stored?.rate)}`
        );
        continue;
      }
      usdIncluded.push({ ...r, usd });
    }

    const locLines = locationLines(location, who.company.class, usdIncluded, meta);
    lines.push(...locLines);

    for (const r of officeRows) office.push({ location, ...r });
    for (const r of reviewRows) review.push({ location, ...r });

    const clearingCents = sum(locLines.filter((l) => l.basis === 'net'), (l) => l.amount);
    const currencies = [...new Set(s.rows.map((r) => r.currency))];
    locations.push({
      location,
      class: who.company.class,
      currency: currencies.length === 1 ? currencies[0] : currencies.join('/') || 'USD',
      rows: s.rows.length,
      included: included.length,
      viatorRows: viator.length,
      officeRows: officeRows.length,
      reviewRows: reviewRows.length,
      clearingCents, // USD, signed (debit positive)
      viatorNetLocalCents: sum([...viator, ...included.filter((r) => r.group === 'viator')], (r) => r.net),
      bySource: sourceBreakdown({ included, viator, office: officeRows, review: reviewRows }, usdIncluded),
      grossUsdCents: sum(usdIncluded, (r) => r.usd.gross),
    });

    checks.push(
      ...C.checkSummaryTies(location, s.rows, summaryFor(s)),
      C.checkNetFormula(location, included),
      C.checkNoGuestFee(location, locLines, usdIncluded),
      C.checkRates(location, included, rmap),
      C.checkNoViatorIncluded(location, included, options.viatorInXola),
      C.checkNoOfficeBlankIncluded(location, included),
      C.checkClasses(location, locLines),
      C.checkRowCounts(location, s.rows, included, viator, officeRows, reviewRows)
    );
  }

  if (unknownSources.length) {
    const lines = unknownSources.map(
      (u) => `${u.seller} · Source "${u.source}" · ${u.count} row${u.count === 1 ? '' : 's'} · Net ${(u.net / 100).toFixed(2)}`
    );
    const err = new Error(
      `unknown Source: these Source values are not in the SOP table, so the build stops (SOP Step 3).\n${lines.join('\n')}\n` +
        'Decide how to treat each one and add it to SOURCES in backend/src/accounting/settings.js.'
    );
    err.code = 'UNKNOWN_SOURCE';
    err.details = lines;
    throw err;
  }

  if (missingRates.size) {
    const err = new Error(`FX rates needed before the journal can be built (enter them in step 3 and click “Save rates”):\n${[...missingRates].join('\n')}`);
    err.code = 'FX_RATES_MISSING';
    err.details = [...missingRates];
    throw err;
  }

  checks.push(...C.checkCashFlowFiles(files), ...C.checkBalanced(lines), ...C.checkReportDetailsAll(files));
  checks.sort((a, b) => idNum(a.id) - idNum(b.id) || String(a.location).localeCompare(String(b.location)));

  return { ...meta, lines, locations, office, review, notPosted, checks };
}

// No bookings this month: an empty/missing Summary means zero totals (so the
// ties pass); a Summary that DOES show money with no transactions still fails.
function summaryFor(s) {
  if (s.rows.length) return s.summary;
  const sm = s.summary;
  const empty = !sm || sm.error || ['gross', 'processingFee', 'serviceFee', 'net'].every((k) => !sm[k]);
  return empty ? { gross: 0, processingFee: 0, serviceFee: 0, net: 0 } : sm;
}

const idNum = (id) => Number(String(id).replace(/\D/g, '')) || 0;
