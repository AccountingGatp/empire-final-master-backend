import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/accounting/checks.js';
import { rateMap } from '../src/accounting/fx.js';

const L = 'London Sightseeing Tours';
const row = (o = {}) => ({ source: 'checkout', payoutDate: '2026-08-10', currency: 'USD', gross: 10000, processingFee: 300, serviceFee: 200, guestFee: 150, net: 9500, ...o });

test('X1–X4 Summary ties: pass when all-row totals match, fail when not', () => {
  const rows = [row(), row()];
  const ok = C.checkSummaryTies(L, rows, { gross: 20000, processingFee: 600, serviceFee: 400, net: 19000 });
  assert.deepEqual(ok.map((c) => [c.id, c.pass]), [['X1', true], ['X2', true], ['X3', true], ['X4', true]]);
  const bad = C.checkSummaryTies(L, rows, { gross: 20000, processingFee: 600, serviceFee: 400, net: 18999 });
  assert.equal(bad[0].pass, false);
  assert.equal(bad[0].diff, 1);
  const missing = C.checkSummaryTies(L, rows, { gross: 1, processingFee: 1, serviceFee: 1, net: null });
  assert.equal(missing[0].pass, false);
  assert.match(missing[0].note, /no Net column/);
});

test('X5 Gross − Processing − Service = Net', () => {
  assert.equal(C.checkNetFormula(L, [row(), row()]).pass, true);
  const f = C.checkNetFormula(L, [row({ net: 9350 })]); // guest fee deducted from Net
  assert.equal(f.pass, false);
  assert.equal(f.diff, -150);
});

test('X6 no journal line uses a Guest Fee amount', () => {
  const usd = [{ ...row(), group: 'xola', usd: { net: 9500, processingFee: 300, serviceFee: 200, gross: 10000 } }];
  const good = [
    { account: 'clear', basis: 'net', group: 'xola', amount: 9500 },
    { account: 'pf', basis: 'processingFee', amount: 300 },
    { account: 'sf', basis: 'serviceFee', amount: 200 },
    { account: 'gross', basis: 'gross', amount: 10000 },
  ];
  assert.equal(C.checkNoGuestFee(L, good, usd).pass, true);
  const guest = [...good, { account: 'guest', basis: 'guestFee', amount: 150 }];
  assert.equal(C.checkNoGuestFee(L, guest, usd).pass, false);
  const sneaky = [{ account: 'gross', basis: 'gross', amount: 10150 }]; // gross + guest fee
  assert.equal(C.checkNoGuestFee(L, sneaky, usd).pass, false);
});

test('X7 every expected company has a verified Cash Flow file', () => {
  const files = [{ sellerName: 'Paris Tours', type: 'account', status: 'done', reportCheck: { pass: true } }];
  const res = C.checkCashFlowFiles(files);
  assert.equal(res.find((c) => c.location === 'Paris Tours').pass, true);
  const london = res.find((c) => c.location === L);
  assert.equal(london.pass, false);
  assert.match(london.note, /no Cash Flow file/);
  const unverified = C.checkCashFlowFiles([{ sellerName: 'Paris Tours', type: 'account', status: 'done', reportCheck: { pass: false, message: 'wrong report' } }]);
  assert.equal(unverified.find((c) => c.location === 'Paris Tours').pass, false);
});

test('X8 every GBP/EUR row has a rate within limits', () => {
  const inc = [row({ currency: 'GBP' }), row({ currency: 'GBP', payoutDate: '2026-08-17' }), row()];
  const good = rateMap([
    { location: L, currency: 'GBP', date: '2026-08-10', rate: 1.3 },
    { location: L, currency: 'GBP', date: '2026-08-17', rate: 1.31 },
  ]);
  assert.equal(C.checkRates(L, inc, good).pass, true);
  const bad = rateMap([
    { location: L, currency: 'GBP', date: '2026-08-10', rate: 1.3 },
    { location: L, currency: 'GBP', date: '2026-08-17', rate: 1.6 }, // out of limits
  ]);
  const r = C.checkRates(L, inc, bad);
  assert.equal(r.pass, false);
  assert.deepEqual([r.expected, r.actual], [2, 1]);
});

test('X9 no included row has Source = viator', () => {
  assert.equal(C.checkNoViatorIncluded(L, [row()]).pass, true);
  assert.equal(C.checkNoViatorIncluded(L, [row(), row({ source: 'viator' })]).pass, false);
});

test('X10 no included office booking with a blank Payout Date', () => {
  assert.equal(C.checkNoOfficeBlankIncluded(L, [row({ source: 'office' })]).pass, true);
  assert.equal(C.checkNoOfficeBlankIncluded(L, [row({ source: 'office', payoutDate: '' })]).pass, false);
});

test('X11 every journal line has a Class', () => {
  assert.equal(C.checkClasses(L, [{ class: 'Empire Tours:London' }]).pass, true);
  assert.equal(C.checkClasses(L, [{ class: 'Empire Tours:London' }, { class: '' }]).pass, false);
});

test('X12 debits = credits per location and in total', () => {
  const ok = C.checkBalanced([
    { location: 'A', debit: 100, credit: 0 },
    { location: 'A', debit: 0, credit: 100 },
  ]);
  assert.ok(ok.every((c) => c.pass));
  assert.equal(ok.at(-1).location, 'ALL');
  const bad = C.checkBalanced([
    { location: 'A', debit: 100, credit: 0 },
    { location: 'A', debit: 0, credit: 99 },
  ]);
  assert.ok(bad.every((c) => !c.pass));
});

test('X13 included + viator + office rows = all rows', () => {
  const all = [row(), row({ source: 'viator' }), row({ source: 'office', payoutDate: '' })];
  assert.equal(C.checkRowCounts(L, all, [all[0]], [all[1]], [all[2]]).pass, true);
  assert.equal(C.checkRowCounts(L, all, [all[0]], [all[1]], []).pass, false);
});

test('X14 every file passed the Report Details check', () => {
  const f = (type, pass) => ({ sellerName: L, type, status: 'done', reportCheck: { pass, message: pass ? 'ok' : 'wrong report' } });
  assert.equal(C.checkReportDetailsAll([f('account', true), f('payout', true), f('earnings', true)])[0].pass, true);
  const bad = C.checkReportDetailsAll([f('account', true), f('payout', false)])[0];
  assert.equal(bad.pass, false);
  assert.match(bad.note, /payout: wrong report/);
});

test('D0–D2 and D5 deferred checks', () => {
  assert.equal(C.checkXolaReady('ready').pass, true);
  assert.equal(C.checkXolaReady('blocked').pass, false);
  const files = [
    { sellerName: L, type: 'account', status: 'done', reportCheck: { pass: true } },
    { sellerName: L, type: 'earnings', status: 'done', reportCheck: { pass: true } },
  ];
  assert.equal(C.checkDeferredFiles(L, files).pass, true);
  assert.equal(C.checkDeferredFiles(L, files.slice(0, 1)).pass, false);
  assert.equal(C.checkCashFlowTie(L, 500, 500).pass, true);
  assert.equal(C.checkCashFlowTie(L, 500, 400).pass, false);
  assert.equal(C.checkKnownDeferred('2026-08', 788666)[0].pass, true);
  assert.equal(C.checkKnownDeferred('2026-01', 8526930)[0].pass, false);
  assert.deepEqual(C.checkKnownDeferred('2026-03', 1), []);
});

test('V1–V5 Viator checks', () => {
  assert.equal(C.checkViatorEntity(L, 1000, 1000).pass, true);
  assert.equal(C.checkViatorEntity(L, 1350, 1000).pass, false);

  assert.equal(C.checkViatorContinuity([], [], false)[0].pass, true); // n/a
  const cont = C.checkViatorContinuity(['Paris Tours', L], [L], true);
  assert.deepEqual(cont.map((c) => c.pass), [false, true]);

  assert.equal(C.checkViatorDate('8/31/2026', '8/31/2026').pass, true);
  assert.equal(C.checkViatorDate('9/30/2026', '8/31/2026').pass, false);

  assert.equal(C.checkViatorTotal(5000, 5000).pass, true);
  assert.equal(C.checkViatorTotal(5001, 5000).pass, false);

  const near = C.checkViatorVsXola(L, 10400, 10000);
  assert.equal(near.pass, true);
  const off = C.checkViatorVsXola(L, 11500, 10000);
  assert.equal(off.pass, false);
  assert.equal(off.hardStop, undefined);
  const commission = C.checkViatorVsXola(L, 13500, 10000);
  assert.equal(commission.pass, false);
  assert.equal(commission.hardStop, true);
  assert.match(commission.note, /commission error is back/);
});

test('journal status: blocked until each failed check is accepted; hard stops never', () => {
  const fail = C.result('X5', L, 'x', 100, 99);
  const hard = { ...C.result('V5', L, 'y', 1, 2), hardStop: true };
  assert.equal(C.journalStatus([fail], 'xola', []), 'blocked');
  const acc = [{ journal: 'xola', checkId: 'X5', location: L, diff: -1, reason: 'rounding' }];
  assert.equal(C.journalStatus([fail], 'xola', acc), 'ready');
  // An acceptance for a different diff (data changed) no longer counts.
  assert.equal(C.journalStatus([C.result('X5', L, 'x', 100, 90)], 'xola', acc), 'blocked');
  assert.equal(C.journalStatus([hard], 'viator', [{ journal: 'viator', checkId: 'V5', location: L, diff: 1 }]), 'blocked');
});
