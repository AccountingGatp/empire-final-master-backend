import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workbook, tx } from './fixtures.js';
import { readWorkbook, parseTransactions, parseSummaryTotals, checkReportDetails } from '../src/accounting/workbook.js';
import { buildXolaJournal, neededRates } from '../src/accounting/xolaJournal.js';
import { buildDeferredJournal } from '../src/accounting/deferredJournal.js';
import { buildViatorJournal, parseAdvice } from '../src/accounting/viator.js';
import { writeJournalXlsx, writeOfficeXlsx, writeChecksXlsx } from '../src/accounting/output.js';
import { ACCOUNTS } from '../src/accounting/settings.js';
import XLSX from 'xlsx';
import { OPTIONS as SOP_OPTIONS } from '../src/accounting/settings.js';
// These tests cover the SOP Part B behaviour (Viator from the advice only).
SOP_OPTIONS.viatorInXola = false;

const parse = (buf) => {
  const wb = readWorkbook(buf);
  return { rows: parseTransactions(wb), summary: parseSummaryTotals(wb) };
};
const verified = (sellerName, types = ['account', 'payout', 'earnings']) =>
  types.map((type) => ({ sellerName, type, status: 'done', reportCheck: { pass: true, message: 'ok' } }));

// ---- Reading files ------------------------------------------------------------------
test('Transactions are read by header name, whatever the column order', () => {
  const { rows, summary } = parse(workbook([tx({ gross: 50, processingFee: 1.5, serviceFee: 1, net: 47.5 })]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gross, 5000);
  assert.equal(rows[0].net, 4750);
  assert.equal(rows[0].source, 'checkout');
  assert.equal(summary.net, 4750);
});

test('A missing header fails the seller and names the header', () => {
  const buf = workbook([tx()], { omit: ['Payout Date', 'Source'] });
  assert.throws(() => parseTransactions(readWorkbook(buf)), /missing header\(s\): Source, Payout Date/);
});

test('Report Details: right report + right month passes', () => {
  const r = checkReportDetails(workbook([tx()]), 'account', '2026-08-01', '2026-08-31');
  assert.equal(r.pass, true, r.message);
  const p = checkReportDetails(workbook([tx()], { type: 'payout' }), 'payout', '2026-08-01', '2026-08-31');
  assert.equal(p.pass, true, p.message);
});

test('Report Details: a Payout file in the Cash Flow slot fails (August 2026 bug)', () => {
  const r = checkReportDetails(workbook([tx()], { type: 'payout' }), 'account', '2026-08-01', '2026-08-31');
  assert.equal(r.pass, false);
  assert.match(r.message, /wrong report/);
  const c = checkReportDetails(workbook([tx()]), 'payout', '2026-08-01', '2026-08-31');
  assert.equal(c.pass, false);
});

test('Report Details: Xola\'s real layout ("8/1/26, 8/31/26", Company line) passes; wrong company fails', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Report Name', 'Cash Flow Report'], ['Company', 'Paris Tours'], ['Date is between', '8/1/26, 8/31/26']]), 'Report Details');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  assert.equal(checkReportDetails(buf, 'account', '2026-08-01', '2026-08-31', { company: 'Paris Tours' }).pass, true);
  const wrong = checkReportDetails(buf, 'account', '2026-08-01', '2026-08-31', { company: 'London Sightseeing Tours' });
  assert.equal(wrong.pass, false);
  assert.match(wrong.message, /wrong company/);
  const payout = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(payout, XLSX.utils.aoa_to_sheet([['Report Name', 'Cash Flow Report'], ['Company', 'Paris Tours'], ['From Date', '8/1/26'], ['To Date', '8/31/26'], ['Payout Lag as of Exported date', '1 day']]), 'Report Details');
  assert.equal(checkReportDetails(XLSX.write(payout, { type: 'buffer', bookType: 'xlsx' }), 'payout', '2026-08-01', '2026-08-31').pass, true);
});

test('Only the money / Source / Payout Date columns are required on Transactions', () => {
  const rows = parseTransactions(readWorkbook(workbook([tx()], { omit: ['Item', 'Confirmation Code', 'Customer Name', 'Method'] })));
  assert.equal(rows.length, 1);
  assert.throws(() => parseTransactions(readWorkbook(workbook([tx()], { omit: ['Guest Fee'] }))), /missing header\(s\): Guest Fee/);
});

test('Report Details: wrong month fails', () => {
  const r = checkReportDetails(workbook([tx()], { from: '2026-07-01', to: '2026-07-31' }), 'account', '2026-08-01', '2026-08-31');
  assert.equal(r.pass, false);
  assert.match(r.message, /date range is not 2026-08-01 → 2026-08-31/);
});

// ---- XOLA journal -----------------------------------------------------------------------
const CHI = 'Chicago Private Tours';
const LON = 'London Sightseeing Tours';

function sampleSellers() {
  const chicago = [
    tx({ gross: 100, processingFee: 3, serviceFee: 2 }),
    tx({ Source: 'refund', gross: -40, processingFee: 0, serviceFee: 0 }),
    tx({ Source: 'Get Your Guide', gross: 80, processingFee: 0, serviceFee: 0, net: 80 }),
    tx({ Source: 'viator', gross: 60, processingFee: 0, serviceFee: 0, net: 60, 'Payout Date': '' }),
    tx({ Source: 'office', gross: 25, processingFee: 0, serviceFee: 0, net: 25, 'Payout Date': '' }),
    tx({ Source: 'office', gross: 30, processingFee: 1, serviceFee: 0, net: 29 }),
  ];
  const london = [
    tx({ Currency: 'GBP', gross: 100, processingFee: 3, serviceFee: 2, 'Payout Date': '2026-08-10' }),
    tx({ Currency: 'GBP', gross: 50, processingFee: 1.5, serviceFee: 1, 'Payout Date': '2026-08-17' }),
  ];
  return [
    { sellerName: CHI, ...parse(workbook(chicago)) },
    { sellerName: LON, ...parse(workbook(london)) },
    { sellerName: 'Austin Tours', ...parse(workbook([tx()])) },
  ];
}
const RATES = [
  { location: LON, currency: 'GBP', date: '2026-08-10', rate: 1.3 },
  { location: LON, currency: 'GBP', date: '2026-08-17', rate: 1.2999 },
];
const FILES = [...verified(CHI), ...verified(LON)];

test('XOLA: lines per Source group, correct accounts, balanced, classed', () => {
  const j = buildXolaJournal({ month: '2026-08', sellers: sampleSellers(), rates: RATES, files: FILES });
  assert.equal(j.journalNo, 'XOLA-2026-08');
  assert.equal(j.journalDate, '8/31/2026');

  const chi = j.lines.filter((l) => l.location === CHI);
  const acc = (a) => chi.find((l) => l.account === a);
  // Xola group = checkout 95 + refund −40 + office-with-payout 29 = 84
  assert.equal(acc(ACCOUNTS.clearing.xola).debit, 8400);
  assert.equal(acc(ACCOUNTS.clearing.gyg).debit, 8000);
  assert.equal(acc(ACCOUNTS.processing).debit, 400);
  assert.equal(acc(ACCOUNTS.service).debit, 200);
  assert.equal(acc(ACCOUNTS.gross).credit, 17000); // 100 − 40 + 80 + 30 (viator/office-blank excluded)
  assert.ok(chi.every((l) => l.class === 'Empire Tours:Chicago'));

  // Viator + office-blank rows are kept aside.
  const loc = j.locations.find((l) => l.location === CHI);
  assert.equal(loc.viatorNetLocalCents, 6000);
  assert.equal(j.office.length, 1);
  assert.equal(j.office[0].gross, 2500);

  // Austin is not posted.
  assert.deepEqual(j.notPosted, [{ sellerName: 'Austin Tours', reason: 'no class – not posted' }]);
  assert.ok(!j.lines.some((l) => l.location === 'Austin Tours'));

  // All posted-location checks pass (X7 fails only for companies missing from this small sample).
  const failing = j.checks.filter((c) => !c.pass && c.id !== 'X7');
  assert.deepEqual(failing, []);
});

test('XOLA: GBP rows converted at their own payout date rate and still balance', () => {
  const j = buildXolaJournal({ month: '2026-08', sellers: sampleSellers(), rates: RATES, files: FILES });
  const lon = j.lines.filter((l) => l.location === LON);
  const debit = lon.reduce((s, l) => s + l.debit, 0);
  const credit = lon.reduce((s, l) => s + l.credit, 0);
  assert.equal(debit, credit);
  // net 95 @1.3 = 123.50 ; net 47.50 @1.2999 = 61.745 -> 61.75
  assert.equal(lon.find((l) => l.account === ACCOUNTS.clearing.xola).debit, 12350 + 6175);
  assert.ok(lon.every((l) => l.class === 'Empire Tours:London'));
});

test('XOLA: build is blocked while any GBP/EUR rate is missing or out of limits', () => {
  assert.throws(
    () => buildXolaJournal({ month: '2026-08', sellers: sampleSellers(), rates: RATES.slice(0, 1), files: FILES }),
    /FX rates needed.*2026-08-17: GBP rate is not filled in/s
  );
  assert.throws(
    () => buildXolaJournal({ month: '2026-08', sellers: sampleSellers(), rates: [RATES[0], { ...RATES[1], rate: 1.5 }], files: FILES }),
    /outside the allowed range/
  );
  const needed = neededRates(sampleSellers());
  assert.deepEqual([...new Set(needed.map((n) => n.date))], ['2026-08-10', '2026-08-17']);
});

test('XOLA: Tiqets and blank Source rows are left out for review (settings decision)', () => {
  const rows = [tx(), tx({ Source: 'Tiqets', gross: 61.17, processingFee: 0, serviceFee: 0, net: 61.17 }), tx({ Source: '' })];
  const j = buildXolaJournal({ month: '2026-08', sellers: [{ sellerName: CHI, ...parse(workbook(rows)) }], files: FILES });
  assert.equal(j.review.length, 2);
  assert.equal(j.lines.find((l) => l.account === ACCOUNTS.gross).credit, 10000); // only the checkout row
  assert.equal(j.checks.find((c) => c.id === 'X13' && c.location === CHI).pass, true);
});

test('XOLA: an unknown Source stops the build', () => {
  const s = [{ sellerName: CHI, ...parse(workbook([tx({ Source: 'expedia' })])) }];
  const s2 = [...s, { sellerName: LON, ...parse(workbook([tx({ Source: 'klook' }), tx({ Source: 'Expedia TAAP' })])) }];
  assert.throws(
    () => buildXolaJournal({ month: '2026-08', sellers: s2, files: FILES }),
    (err) =>
      err.code === 'UNKNOWN_SOURCE' &&
      /Source "expedia"/.test(err.message) &&
      /Source "klook"/.test(err.message) &&
      /Source "expedia taap"/i.test(err.message)
  );
});

test('XOLA: the Summary tab is not used — a different Summary changes nothing', () => {
  const rows = [tx()];
  const buf = workbook(rows, { summaryOverride: { gross: 100, pf: 3, sf: 2, gf: 1.5, net: 94 } });
  const j = buildXolaJournal({ month: '2026-08', sellers: [{ sellerName: CHI, ...parse(buf) }], files: FILES });
  assert.equal(j.checks.filter((c) => ['X1', 'X2', 'X3', 'X4'].includes(c.id)).length, 0);
  assert.equal(j.lines.reduce((t, l) => t + l.debit, 0), j.lines.reduce((t, l) => t + l.credit, 0));
});

// ---- Deferred ------------------------------------------------------------------------------
test('DEF: Cash Flow − Recognized Earnings, flips sides when negative, never reverses', () => {
  const x = buildXolaJournal({ month: '2026-08', sellers: sampleSellers(), rates: RATES, files: FILES });
  const earnings = [
    { sellerName: CHI, rows: parse(workbook([tx({ gross: 50, processingFee: 1, serviceFee: 1 })], { type: 'earnings' })).rows },
    { sellerName: LON, rows: parse(workbook([tx({ Currency: 'GBP', gross: 500, processingFee: 0, serviceFee: 0, net: 500, 'Payout Date': '2026-08-10' })], { type: 'earnings' })).rows },
  ];
  const d = buildDeferredJournal({
    month: '2026-08',
    xola: { status: 'ready', lines: x.lines, locations: x.locations },
    earnings,
    rates: RATES,
    files: FILES,
  });
  assert.equal(d.journalNo, 'DEF-2026-08');
  const chi = d.figures.find((f) => f.location === CHI);
  assert.equal(chi.cashFlowCents, 16400); // 84 + 80
  assert.equal(chi.recognizedCents, 4800);
  assert.equal(chi.deferredCents, 11600);
  const chiLines = d.lines.filter((l) => l.location === CHI);
  assert.equal(chiLines.find((l) => l.account === ACCOUNTS.deferredDebit).debit, 11600);
  assert.equal(chiLines.find((l) => l.account === ACCOUNTS.deferredCredit).credit, 11600);

  const lon = d.figures.find((f) => f.location === LON);
  assert.equal(lon.recognizedCents, 65000); // 500 GBP @ 1.3
  assert.ok(lon.deferredCents < 0);
  const lonLines = d.lines.filter((l) => l.location === LON);
  assert.equal(lonLines.find((l) => l.account === ACCOUNTS.deferredDebit).credit, -lon.deferredCents); // flipped
  assert.ok(d.checks.filter((c) => ['D2', 'D3', 'D4'].includes(c.id)).every((c) => c.pass));
  assert.ok(d.checks.find((c) => c.id === 'D1' && c.location === CHI).pass);

  assert.throws(
    () => buildDeferredJournal({ month: '2026-08', xola: x, earnings, rates: RATES, files: FILES, options: { deferredReversal: 'flag' } }),
    /never/
  );
});

// ---- Viator ----------------------------------------------------------------------------------
const CSV = `Booking Reference,Travel Date,Net Amount,Currency,Payment Date
BR-1,08/12/2026,60.00,USD,09/05/2026
BR-2,08/19/2026,40.00,USD,09/05/2026
Total,,100.00,,
`;

test('Viator CSV parser finds columns by header name', () => {
  const a = parseAdvice(Buffer.from(CSV), 'advice.csv', { defaultEntity: CHI });
  assert.equal(a.rows.length, 2);
  assert.deepEqual(a.rows[0], { entity: CHI, bookingRef: 'BR-1', travelDate: '2026-08-12', netCents: 6000, currency: 'USD' });
  assert.equal(a.paymentDate, '2026-09-05');
  assert.throws(() => parseAdvice(Buffer.from('a,b\n1,2'), 'x.csv'), /could not find the advice columns/);
  assert.throws(() => parseAdvice(Buffer.from('%PDF'), 'x.pdf'), /no parser/);
});

test('VIA: net per advice, no gross-up, dated end of the sales month', () => {
  const x = buildXolaJournal({ month: '2026-08', sellers: sampleSellers(), rates: RATES, files: FILES });
  const a = parseAdvice(Buffer.from(CSV), 'advice.csv', { defaultEntity: CHI });
  const v = buildViatorJournal({
    month: '2026-08',
    advices: [{ location: CHI, fileName: 'advice.csv', paymentDate: a.paymentDate, rows: a.rows }],
    xola: x,
  });
  assert.equal(v.journalNo, 'VIA-2026-08');
  assert.equal(v.journalDate, '8/31/2026');
  assert.equal(v.lines.find((l) => l.account === ACCOUNTS.viatorClearing).debit, 10000);
  assert.equal(v.lines.find((l) => l.account === ACCOUNTS.viatorRevenue).credit, 10000);
  const v5 = v.checks.find((c) => c.id === 'V5' && c.location === CHI);
  // Xola Viator Net 60 vs advice 100 → −40%: fails (not the commission band).
  assert.equal(v5.pass, false);
  assert.equal(v5.hardStop, undefined);
  assert.ok(v.checks.filter((c) => ['V1', 'V3', 'V4', 'V6'].includes(c.id)).every((c) => c.pass));
});

test('VIA: Xola ~35% above the advice is a hard stop ("commission error is back")', () => {
  const v = buildViatorJournal({
    month: '2026-08',
    advices: [{ location: CHI, fileName: 'a.csv', paymentDate: '', rows: [{ entity: CHI, bookingRef: 'B', travelDate: '', netCents: 10000, currency: 'USD' }] }],
    xola: { locations: [{ location: CHI, viatorNetLocalCents: 13500, currency: 'USD' }] },
  });
  const v5 = v.checks.find((c) => c.id === 'V5');
  assert.equal(v5.hardStop, true);
  assert.match(v5.note, /commission error is back/);
});

// ---- Output files ---------------------------------------------------------------------------
test('Output workbooks have the required columns', async () => {
  const x = buildXolaJournal({ month: '2026-08', sellers: sampleSellers(), rates: RATES, files: FILES });
  const head = async (buf) => XLSX.utils.sheet_to_json(XLSX.read(buf).Sheets[XLSX.read(buf).SheetNames[0]], { header: 1 })[0];
  assert.deepEqual(await head(await writeJournalXlsx(x.lines)), ['*JournalNo', '*JournalDate', '*AccountName', '*Debits', '*Credits', 'Description', 'Class']);
  assert.deepEqual((await head(await writeOfficeXlsx(x.office))).slice(0, 9), ['Location', 'Transaction Date', 'Arrival Date', 'Customer Name', 'Item', 'Gross', 'Net', 'Method', 'Confirmation Code']);
  const checks = await writeChecksXlsx({ month: '2026-08', runDate: new Date(), user: 'me@x', journals: { xola: { ...x, status: 'blocked' } }, fxRates: RATES });
  assert.deepEqual(XLSX.read(checks).SheetNames, ['Run', 'Checks', 'FX rates', 'Accepted differences']);
});

test('A company with no bookings (empty Transactions sheet) is "no activity", not an error', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Report Name', 'Cash Flow Report'], ['Date is between', '8/1/26, 8/31/26']]), 'Report Details');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Transactions');
  const parsed = readWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const rows = parseTransactions(parsed);
  assert.deepEqual(rows, []);
  let summary;
  try { summary = parseSummaryTotals(parsed); } catch (err) { summary = { error: err.message }; }
  const j = buildXolaJournal({ month: '2026-08', sellers: [{ sellerName: 'NYC Discount Tours', rows, summary }], files: FILES });
  const own = j.checks.filter((c) => c.location === 'NYC Discount Tours');
  assert.ok(own.length > 0);
  assert.deepEqual(own.filter((c) => !c.pass && c.id !== 'X7'), []); // X7: no file in this test's file list
  assert.equal(j.lines.length, 0);
});
