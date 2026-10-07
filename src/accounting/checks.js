// Checks engine (SOP Step 7, SOP 10.5 checks, SOP Part B checks).
// Money is compared in INTEGER CENTS. Every check returns
//   { id, location, name, expected, actual, diff, pass, unit, note?, hardStop? }
// unit: 'money' (cents) | 'count' | 'text'

import { normName, expectedCompanies, VIATOR, KNOWN_DEFERRED_TOTALS } from './settings.js';
import { needsConversion, rateKey } from './fx.js';

const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

export function result(id, location, name, expected, actual, extra = {}) {
  const numeric = typeof expected === 'number' && typeof actual === 'number';
  const diff = numeric ? actual - expected : expected === actual ? 0 : null;
  const pass = extra.pass !== undefined ? extra.pass : numeric ? diff === 0 : expected === actual;
  return {
    id,
    location,
    name,
    expected,
    actual,
    diff,
    pass,
    unit: extra.unit || 'money',
    ...(extra.note ? { note: extra.note } : {}),
    ...(extra.hardStop ? { hardStop: true } : {}),
  };
}

// ---- Xola journal checks (X1–X14) -------------------------------------------

const SUMMARY_FIELDS = [
  ['X1', 'net', 'Net'],
  ['X2', 'gross', 'Gross'],
  ['X3', 'processingFee', 'Processing Fee'],
  ['X4', 'serviceFee', 'Service Fee'],
];

// 1–4: sum over ALL Transactions rows = the seller's Summary-sheet total.
export function checkSummaryTies(location, allRows, summary) {
  return SUMMARY_FIELDS.map(([id, field, label]) => {
    const actual = sum(allRows, (r) => r[field]);
    const expected = summary?.[field];
    if (expected === null || expected === undefined) {
      return result(id, location, `All-rows ${label} = Summary total ${label}`, null, actual, {
        pass: false,
        note: summary?.error || `Summary sheet has no ${label} column`,
      });
    }
    return result(id, location, `All-rows ${label} = Summary total ${label}`, expected, actual);
  });
}

// 5: for included rows, Gross − Processing − Service = Net (local currency).
export function checkNetFormula(location, included) {
  const expected =
    sum(included, (r) => r.gross) - sum(included, (r) => r.processingFee) - sum(included, (r) => r.serviceFee);
  const actual = sum(included, (r) => r.net);
  return result('X5', location, 'Included: Gross − Processing − Service = Net', expected, actual);
}

const ALLOWED_BASIS = new Set(['net', 'processingFee', 'serviceFee', 'gross']);

// 6: no journal line uses a Guest Fee amount. Every line must be built from an
// allowed basis AND its amount must equal that basis summed over the included
// (converted) rows — so nothing else (e.g. Guest Fee) can have crept in.
export function checkNoGuestFee(location, lines, usdIncluded) {
  let bad = 0;
  const notes = [];
  for (const l of lines) {
    if (!ALLOWED_BASIS.has(l.basis)) {
      bad++;
      notes.push(`${l.account} uses ${l.basis}`);
      continue;
    }
    const rows = l.group ? usdIncluded.filter((r) => r.group === l.group) : usdIncluded;
    const expected = sum(rows, (r) => r.usd[l.basis]);
    if (expected !== l.amount) {
      bad++;
      notes.push(`${l.account}: line ${l.amount} ≠ ${l.basis} total ${expected}`);
    }
  }
  return result('X6', location, 'No journal line uses a Guest Fee amount', 0, bad, {
    unit: 'count',
    note: notes.join('; ') || undefined,
  });
}

// 7: every expected company has a verified Cash Flow file.
export function checkCashFlowFiles(files) {
  return expectedCompanies().map(({ name, key }) => {
    const f = files.find((t) => t.type === 'account' && normName(t.sellerName) === key);
    const ok = !!f && f.status === 'done' && !!f.reportCheck?.pass;
    const note = !f
      ? 'no Cash Flow file for this company in the run'
      : f.status !== 'done'
        ? `file status: ${f.status}${f.error ? ` — ${f.error}` : ''}`
        : !f.reportCheck?.pass
          ? `Report Details check failed: ${f.reportCheck?.message || 'not checked'}`
          : undefined;
    return result('X7', name, 'Verified Cash Flow file', 'verified', ok ? 'verified' : 'missing', {
      unit: 'text',
      pass: ok,
      note,
    });
  });
}

// 8: every GBP/EUR included row has an entered rate within the limits.
export function checkRates(location, included, rmap) {
  const foreign = included.filter((r) => needsConversion(r.currency));
  const withRate = foreign.filter((r) => rmap.has(rateKey(location, r.currency, r.payoutDate)));
  return result('X8', location, 'Every GBP/EUR row has a rate within limits', foreign.length, withRate.length, {
    unit: 'count',
  });
}

// 9: no included row has Source = viator.
export function checkNoViatorIncluded(location, included) {
  const n = included.filter((r) => String(r.source).trim().toLowerCase() === 'viator').length;
  return result('X9', location, 'No included row has Source = viator', 0, n, { unit: 'count' });
}

// 10: no included row is an office booking with a blank Payout Date.
export function checkNoOfficeBlankIncluded(location, included) {
  const n = included.filter(
    (r) => String(r.source).trim().toLowerCase() === 'office' && !String(r.payoutDate ?? '').trim()
  ).length;
  return result('X10', location, 'No included office booking with blank Payout Date', 0, n, { unit: 'count' });
}

// 11: every journal line has a Class.
export function checkClasses(location, lines, id = 'X11') {
  const n = lines.filter((l) => !String(l.class || '').trim()).length;
  return result(id, location, 'Every journal line has a Class', 0, n, { unit: 'count' });
}

// 12: debits = credits, per location and in total.
export function checkBalanced(lines, id = 'X12') {
  const byLoc = new Map();
  for (const l of lines) {
    if (!byLoc.has(l.location)) byLoc.set(l.location, []);
    byLoc.get(l.location).push(l);
  }
  const out = [];
  for (const [loc, ls] of byLoc) {
    out.push(result(id, loc, 'Debits = credits', sum(ls, (l) => l.debit), sum(ls, (l) => l.credit)));
  }
  out.push(result(id, 'ALL', 'Debits = credits (whole journal)', sum(lines, (l) => l.debit), sum(lines, (l) => l.credit)));
  return out;
}

// 13: included + viator + office-excluded rows = all rows.
export function checkRowCounts(location, all, included, viator, office, review = []) {
  return result(
    'X13',
    location,
    'Included + Viator + office-excluded + review rows = all rows',
    all.length,
    included.length + viator.length + office.length + review.length,
    { unit: 'count' }
  );
}

// 14: every file passed the Report Details check (one row per seller).
export function checkReportDetailsAll(files, types = ['account', 'payout', 'earnings']) {
  const bySeller = new Map();
  for (const f of files.filter((t) => types.includes(t.type))) {
    if (!bySeller.has(f.sellerName)) bySeller.set(f.sellerName, []);
    bySeller.get(f.sellerName).push(f);
  }
  return [...bySeller].map(([seller, fs]) => {
    const passed = fs.filter((f) => f.reportCheck?.pass);
    const failed = fs.filter((f) => !f.reportCheck?.pass);
    return result('X14', seller, 'Every file passed the Report Details check', fs.length, passed.length, {
      unit: 'count',
      note: failed.map((f) => `${f.type}: ${f.reportCheck?.message || f.error || 'not verified'}`).join('; ') || undefined,
    });
  });
}

// ---- Deferred journal checks (D0–D5) ----------------------------------------

// D0: the XOLA journal it depends on is ready (not blocked).
export function checkXolaReady(xolaStatus) {
  return result('D0', 'ALL', 'XOLA journal is ready (not blocked)', 'ready', xolaStatus || 'not built', {
    unit: 'text',
  });
}

// D1: both files exist (verified) for every location.
export function checkDeferredFiles(location, files) {
  const key = normName(location);
  const has = (type) =>
    files.some((f) => f.type === type && normName(f.sellerName) === key && f.status === 'done' && f.reportCheck?.pass);
  const missing = ['account', 'earnings'].filter((t) => !has(t));
  return result('D1', location, 'Cash Flow and Recognized Earnings files both verified', 2, 2 - missing.length, {
    unit: 'count',
    note: missing.length ? `missing / unverified: ${missing.map((t) => (t === 'account' ? 'Cash Flow' : 'Recognized Earnings')).join(', ')}` : undefined,
  });
}

// D2: the Cash Flow figure used = the XOLA journal's clearing debit for the location.
export function checkCashFlowTie(location, cashFlowCents, xolaClearingCents) {
  return result('D2', location, 'Cash Flow figure = XOLA clearing debit', xolaClearingCents, cashFlowCents);
}

// D5: the month's Deferred total matches a known answer (only for months listed).
export function checkKnownDeferred(month, totalCents) {
  const known = KNOWN_DEFERRED_TOTALS[month];
  if (known === undefined) return [];
  return [result('D5', 'ALL', `Deferred total = known answer for ${month}`, known, totalCents)];
}

// ---- Viator checks (V1–V6) ------------------------------------------------------

// V1: each entity's journal total = its advice total (USD).
export function checkViatorEntity(location, journalCents, adviceCents) {
  return result('V1', location, 'Journal total = advice total', adviceCents, journalCents);
}

// V2: every entity that had an advice last month has one this month.
export function checkViatorContinuity(prevLocations, thisLocations, hadPreviousRun) {
  if (!hadPreviousRun) {
    return [
      result('V2', 'ALL', 'Entities with an advice last month have one this month', 'n/a', 'n/a', {
        unit: 'text',
        pass: true,
        note: 'no previous month run with Viator advices — not applicable',
      }),
    ];
  }
  const now = new Set(thisLocations.map(normName));
  return prevLocations.map((loc) =>
    result('V2', loc, 'Had an advice last month → has one this month', 'present', now.has(normName(loc)) ? 'present' : 'missing', {
      unit: 'text',
    })
  );
}

// V3: journal date is the last day of the sales month.
export function checkViatorDate(journalDate, expectedDate) {
  return result('V3', 'ALL', 'Journal date = end of the sales month', expectedDate, journalDate, { unit: 'text' });
}

// V4: journal total = sum of all advice totals.
export function checkViatorTotal(journalCents, allAdviceCents) {
  return result('V4', 'ALL', 'Journal total = sum of all advice totals', allAdviceCents, journalCents);
}

// V5: Viator-sourced Net in Xola vs the advice total (same currency), within
// tolerance. If Xola is ~35% higher, hard stop: the old commission error is back.
export function checkViatorVsXola(location, xolaLocalCents, adviceLocalCents, currency = '') {
  const base = adviceLocalCents;
  const ratio = base === 0 ? (xolaLocalCents === 0 ? 0 : Infinity) : (xolaLocalCents - base) / Math.abs(base);
  const within = Math.abs(ratio) <= VIATOR.tolerance;
  const band = VIATOR.commissionErrorBand;
  const commission = ratio >= band.min && ratio <= band.max;
  const pct = `${(ratio * 100).toFixed(1)}%`;
  const cur = currency ? ` (${currency})` : '';
  const note = commission
    ? `commission error is back — Xola is ${pct} higher than the advice`
    : !Number.isFinite(ratio)
      ? `Xola shows Viator sales${cur} but no advice was uploaded for this location`
      : `difference ${pct}${cur}`;
  return result('V5', location, `Xola Viator Net vs advice total (±${VIATOR.tolerance * 100}%)`, adviceLocalCents, xolaLocalCents, {
    pass: within,
    hardStop: commission,
    note,
  });
}

// ---- Status -----------------------------------------------------------------------

// A failed check counts as resolved only when someone typed a reason for that
// exact (journal, checkId, location) AND the difference hasn't changed since.
// Hard-stop checks can never be accepted.
export function isAccepted(check, journal, acceptedDiffs = []) {
  if (check.pass) return true;
  if (check.hardStop) return false;
  return acceptedDiffs.some(
    (a) =>
      a.journal === journal &&
      a.checkId === check.id &&
      a.location === check.location &&
      (a.diff === undefined || a.diff === null || a.diff === check.diff)
  );
}

export function journalStatus(checks, journal, acceptedDiffs = []) {
  return checks.every((c) => isAccepted(c, journal, acceptedDiffs)) ? 'ready' : 'blocked';
}
