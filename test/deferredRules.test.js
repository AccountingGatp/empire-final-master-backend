import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConverter } from '../src/accounting/deferredRules.js';
import { OPTIONS } from '../src/accounting/settings.js';
import { readWorkbook, parseTransactions } from '../src/accounting/workbook.js';
import XLSX from 'xlsx';
import { OPTIONS as SOP_OPTIONS } from '../src/accounting/settings.js';
// These tests cover the SOP Part B behaviour (Viator from the advice only).
SOP_OPTIONS.viatorInXola = false;

const row = (source, net, extra = {}) => ({ source, net, currency: 'USD', payoutDate: '2026-08-10', method: 'Credit Card', ...extra });

test('FX converter: exact rate for the date, else the nearest rate for the location', () => {
  const conv = makeConverter([
    { location: 'London Sightseeing Tours', currency: 'GBP', date: '2026-09-10', rate: 1.35 },
    { location: 'London Sightseeing Tours', currency: 'GBP', date: '2026-09-20', rate: 1.33 },
  ]);
  assert.deepEqual(conv('London Sightseeing Tours', 'GBP', '2026-09-10', 10000), { usd: 13500, approx: false });
  assert.deepEqual(conv('London Sightseeing Tours', 'GBP', '2026-09-19', 10000), { usd: 13300, approx: true });
  assert.deepEqual(conv('Chicago Private Tours', 'USD', '', 10000), { usd: 10000, approx: false });
});

test('empty Transactions sheet with a "No results" line = no activity', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Transactions'], [], ['No results'], [''], ['Generated', '9/3/26']]), 'Transactions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  assert.deepEqual(parseTransactions(readWorkbook(buf)), []);
});

test('Summary: a row with a blank Method is counted, not treated as the end of the table', async () => {
  const { parseSummaryTotals } = await import('../src/accounting/workbook.js');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Summary Report', '(1 Aug, 2026 - 31 Aug, 2026)'],
    [],
    ['Method', 'Gross', 'Processing Fee', 'Service Fee', 'Guest Fee', 'Net'],
    ['Electronic', 1000, 30, 5, 0, 965],
    ['', 828.82, 0, 0, 0, 828.82],
    ['Other', 25, 0, 0, 0, 25],
    [],
    ['Source', 'Gross', 'Net'],
    ['checkout', 999, 999],
  ]), 'Summary');
  const s = parseSummaryTotals(wb);
  assert.equal(s.gross, 185382);
  assert.equal(s.net, 181882);
});

test('real Xola Recognized file: rows tie to the Summary', async () => {
  const fs = await import('node:fs');
  const f = '/root/.claude/uploads/db0a0c86-c912-5f0c-a0cb-d6fd1a4d0cf1/715a0410-Amsterdam_Tours.xlsx';
  if (!fs.existsSync(f)) return;
  const { parseSummaryTotals } = await import('../src/accounting/workbook.js');
  const wb = readWorkbook(fs.readFileSync(f));
  const rows = parseTransactions(wb);
  assert.equal(rows.reduce((t, r) => t + r.net, 0), parseSummaryTotals(wb).net);
});

test('a renamed seller (Milan Tours) counts as Italy Tours: not missing, X7 passes', async () => {
  const { checkCashFlowFiles } = await import('../src/accounting/checks.js');
  const files = [{ type: 'account', sellerName: 'Milan Tours', status: 'done', reportCheck: { pass: true } }];
  const italy = checkCashFlowFiles(files).find((c) => c.location === 'Italy Tours');
  assert.equal(italy.pass, true);
});
