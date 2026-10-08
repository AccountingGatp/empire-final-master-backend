// Deferred revenue journal (SOP 10.5). Pure.
//   Cash Flow           = the location's total clearing debit in the XOLA journal (USD)
//   Recognized Earnings = Net of the `earnings` export, same Viator / office exclusions (USD)
//   Deferred            = Cash Flow − Recognized Earnings
// Entry: Dr 40001.1 Sales Revenue - Deferred / Cr 22001 Deferred Revenue.
// A negative Deferred flips the sides via place(). NEVER a reversing entry
// (OPTIONS.deferredReversal = 'never').

import { ACCOUNTS, OPTIONS, lookupCompany, nameFor, normName } from './settings.js';
import { place, monthMeta } from './money.js';
import { splitRows } from './classify.js';
import { rateMap, rateKey, rateProblem } from './fx.js';
import { toUsd } from './xolaJournal.js';
import * as C from './checks.js';

const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

/**
 * @param input
 *   month
 *   xola      the saved XOLA journal { status, lines, locations }
 *   earnings  [{ sellerName, rows, error }] parsed Recognized Earnings files
 *   rates     FX rate table
 *   files     the run's file tasks
 */
export function buildDeferredJournal({ month, xola, earnings, rates = [], files = [], options = OPTIONS }) {
  if (options.deferredReversal !== 'never') {
    // Guard: the SOP forbids reversing entries; nothing here ever creates one.
    throw new Error('deferredReversal must be "never" (SOP 10.5) — reversing entries are not supported');
  }
  if (!xola || !Array.isArray(xola.lines) || !xola.lines.length) {
    throw new Error('build the XOLA journal first');
  }

  const period = monthMeta(month);
  const meta = { journalNo: nameFor('deferred', month), journalDate: period.journalDate };
  const rmap = rateMap(rates);

  const clearingFromLines = new Map(); // location -> signed clearing (debit − credit)
  for (const l of xola.lines) {
    if (l.basis !== 'net') continue;
    clearingFromLines.set(l.location, (clearingFromLines.get(l.location) || 0) + (l.debit - l.credit));
  }
  const xolaLoc = new Map((xola.locations || []).map((l) => [normName(l.location), l]));
  const earnBy = new Map(earnings.map((e) => [normName(e.sellerName), e]));

  const names = new Map();
  for (const l of xola.locations || []) names.set(normName(l.location), l.location);
  for (const e of earnings) {
    if (lookupCompany(e.sellerName, options).status === 'post') names.set(normName(e.sellerName), e.sellerName);
  }

  const lines = [];
  const figures = [];
  const checks = [C.checkXolaReady(xola.status)];
  const missingRates = new Set();

  for (const [key, location] of [...names].sort((a, b) => a[1].localeCompare(b[1]))) {
    const who = lookupCompany(location, options);
    if (who.status !== 'post') continue;
    const klass = who.company.class;

    checks.push(C.checkDeferredFiles(location, files));

    const cashFlow = xolaLoc.get(key)?.clearingCents ?? 0;
    checks.push(C.checkCashFlowTie(location, cashFlow, clearingFromLines.get(location) ?? 0));

    let recognized = 0;
    const e = earnBy.get(key);
    if (e && !e.error) {
      // Transactions tab only — the Summary tab is not used (Controller, Oct 2026).
      const { included } = splitRows(e.rows, location); // throws on unknown Source
      for (const r of included) {
        const usd = toUsd(r, location, rmap);
        if (!usd) {
          const stored = rates.find((x) => rateKey(x.location, x.currency, x.date) === rateKey(location, r.currency, r.payoutDate));
          missingRates.add(`${location} · ${r.currency} · ${r.payoutDate || 'no payout date'}: ${rateProblem(r.currency, stored?.rate)}`);
          continue;
        }
        recognized += usd.net;
      }
    } else if (e?.error) {
      checks.push(C.result('D1', location, 'Recognized Earnings file readable', 'readable', 'failed', { unit: 'text', pass: false, note: e.error }));
    }

    const deferred = cashFlow - recognized;
    figures.push({ location, class: klass, cashFlowCents: cashFlow, recognizedCents: recognized, deferredCents: deferred });
    if (deferred === 0) continue;

    for (const [account, side, text] of [
      [ACCOUNTS.deferredDebit, 'debit', `Deferred revenue – ${location}`],
      [ACCOUNTS.deferredCredit, 'credit', `Deferred revenue – ${location}`],
    ]) {
      const { debit, credit } = place(deferred, side);
      lines.push({ ...meta, account, debit, credit, description: text, class: klass, location, basis: 'deferred', amount: deferred });
    }
  }

  if (missingRates.size) {
    const err = new Error(`FX rates needed before the deferred journal can be built (enter them in step 3 and click “Save rates”):\n${[...missingRates].join('\n')}`);
    err.code = 'FX_RATES_MISSING';
    err.details = [...missingRates];
    throw err;
  }

  const total = sum(figures, (f) => f.deferredCents);
  checks.push(
    ...C.checkBalanced(lines, 'D3'),
    ...[...new Set(lines.map((l) => l.location))].map((loc) => C.checkClasses(loc, lines.filter((l) => l.location === loc), 'D4')),
    ...C.checkKnownDeferred(month, total)
  );

  return { ...meta, lines, figures, totalDeferredCents: total, checks };
}
