// Deferred revenue journal (SOP 10.5, as the Controller works it — Oct 2026). Pure.
//
//   Cash Flow           = GROSS of every row on the Cash Flow export (Analytics ›
//                         Cash Flow › Export Transactions), column "Gross"
//   Recognized Earnings = GROSS of every row on the Recognized Earnings export
//                         (Analytics › Recognized Earnings › Export Transactions):
//                         "Previously Collected - Gross" + "Collected In Period - Gross"
//   Deferred            = Cash Flow − Recognized Earnings   (gross, not net)
//
// All rows count — no Source exclusions (checked against the Controller's
// September 2026 entry: Chicago River Boat −124,654.57 to the cent).
// Posted ONE pair of lines per CLASS (companies sharing a class are added up):
//   Dr 40001.1 Sales Revenue - Deferred / Cr 22001 Deferred Revenue
// A negative Deferred flips the sides via place(). NEVER a reversing entry.

import { ACCOUNTS, OPTIONS, KNOWN_DEFERRED_BY_CLASS, lookupCompany, nameFor } from './settings.js';
import { place, monthMeta } from './money.js';
import { makeConverter } from './deferredRules.js';
import * as C from './checks.js';

const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * @param input
 *   month      'YYYY-MM'
 *   cashFlow   [{ sellerName, rows, error }] parsed Cash Flow files
 *   earnings   [{ sellerName, rows, error }] parsed Recognized Earnings files
 *   rates      FX rate table
 *   files      the run's file tasks
 */
export function buildDeferredJournal({ month, cashFlow = [], earnings = [], rates = [], files = [], options = OPTIONS }) {
  if (options.deferredReversal !== 'never') {
    throw new Error('deferredReversal must be "never" (SOP 10.5) — reversing entries are not supported');
  }
  const period = monthMeta(month);
  const meta = { journalNo: nameFor('deferred', month), journalDate: period.journalDate };
  const description = `Deferred revenue adjustment - ${MONTHS[period.month - 1]} ${period.year}`;
  const convert = makeConverter(rates);

  // Keyed by the exact Xola seller name: "Tours of NYC" and "ToursOfNYC" are two
  // different Xola sellers (same class) and must both count.
  const cfBy = new Map(cashFlow.map((f) => [f.sellerName, f]));
  const reBy = new Map(earnings.map((f) => [f.sellerName, f]));
  const names = new Map();
  for (const f of [...cashFlow, ...earnings]) names.set(f.sellerName, f.sellerName);

  const checks = [];
  const figures = [];
  const missingRates = new Set();
  let approxRows = 0;

  // Gross of a file in USD (all rows).
  const grossUsd = (file, location, recognized) => {
    let total = 0;
    for (const r of file?.rows || []) {
      const date = recognized ? '' : r.payoutDate;
      const c = convert(location, r.currency, date, r.gross);
      if (c.usd === null) {
        missingRates.add(`${location} · ${r.currency}: no FX rate at all for this currency`);
        continue;
      }
      if (c.approx) approxRows++;
      total += c.usd;
    }
    return total;
  };

  for (const [key, location] of [...names].sort((a, b) => a[1].localeCompare(b[1]))) {
    const who = lookupCompany(location, options);
    if (who.status !== 'post') continue;
    const klass = who.company.class;
    const cf = cfBy.get(key);
    const re = reBy.get(key);

    checks.push(C.checkDeferredFiles(location, files));
    for (const [f, label] of [[cf, 'Cash Flow'], [re, 'Recognized Earnings']]) {
      if (f?.error) checks.push(C.result('D1', location, `${label} file readable`, 'readable', 'failed', { unit: 'text', pass: false, note: f.error }));
    }

    const cashFlowCents = cf && !cf.error ? grossUsd(cf, location, false) : 0;
    const recognizedCents = re && !re.error ? grossUsd(re, location, true) : 0;
    figures.push({ location, class: klass, cashFlowCents, recognizedCents, deferredCents: cashFlowCents - recognizedCents });
  }

  if (missingRates.size) {
    const err = new Error(`FX rates needed before the deferred journal can be built (enter them in step 3 and click “Save rates”):\n${[...missingRates].join('\n')}`);
    err.code = 'FX_RATES_MISSING';
    err.details = [...missingRates];
    throw err;
  }

  // One pair of lines per class.
  const byClass = new Map();
  for (const f of figures) {
    const c = byClass.get(f.class) || { class: f.class, locations: [], deferredCents: 0 };
    c.locations.push(f.location);
    c.deferredCents += f.deferredCents;
    byClass.set(f.class, c);
  }
  const lines = [];
  for (const c of [...byClass.values()].sort((a, b) => a.class.localeCompare(b.class))) {
    if (c.deferredCents === 0) continue;
    for (const [account, side] of [[ACCOUNTS.deferredDebit, 'debit'], [ACCOUNTS.deferredCredit, 'credit']]) {
      const { debit, credit } = place(c.deferredCents, side);
      lines.push({ ...meta, account, debit, credit, description, class: c.class, location: c.locations.join(', '), basis: 'deferred', amount: c.deferredCents });
    }
  }

  const total = sum(figures, (f) => f.deferredCents);
  checks.push(
    ...C.checkBalanced(lines, 'D3'),
    ...[...byClass.keys()].map((k) => C.checkClasses(k, lines.filter((l) => l.class === k), 'D4')),
    ...C.checkKnownDeferred(month, total)
  );
  const knownByClass = KNOWN_DEFERRED_BY_CLASS[month];
  if (knownByClass) {
    for (const [klass, cents] of Object.entries(knownByClass)) {
      checks.push(C.result('D5', klass, `Deferred for the class = Controller's entry for ${month}`, cents, byClass.get(klass)?.deferredCents ?? 0));
    }
  }
  if (approxRows) {
    checks.push(
      C.result('D7', 'ALL', 'Every foreign row had its own FX rate', 0, approxRows, {
        unit: 'count',
        pass: true,
        note: `${approxRows} GBP/EUR row(s) used the nearest rate for the location (no rate for their own date)`,
      })
    );
  }

  return { ...meta, lines, figures, classes: [...byClass.values()], totalDeferredCents: total, checks };
}
