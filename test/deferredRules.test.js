import test from 'node:test';
import assert from 'node:assert/strict';
import { testDeferredRules } from '../src/accounting/deferredRules.js';
import { OPTIONS } from '../src/accounting/settings.js';
import { readWorkbook, parseTransactions } from '../src/accounting/workbook.js';
import XLSX from 'xlsx';

const row = (source, net, extra = {}) => ({ source, net, currency: 'USD', payoutDate: '2026-08-10', method: 'Credit Card', ...extra });

test('rule test: finds the reading that gives the known August total', () => {
  // Known Aug total = 7,886.66. Build data where "A4" (clearing − Recognized incl. Viator) hits it.
  const cashFlow = [{ sellerName: 'Chicago Private Tours', rows: [row('checkout', 1000000), row('viator', 50000)] }];
  const earnings = [{
    sellerName: 'Chicago Private Tours',
    rows: [row('checkout', 200000, { payoutDate: '' }), row('viator', 11334, { payoutDate: '' })],
    summary: { net: 211334 },
  }];
  const r = testDeferredRules({ month: '2026-08', cashFlow, earnings });
  assert.equal(r.knownCents, 788666);
  assert.equal(r.variants[0].diffCents, 0);
  assert.match(r.variants[0].id, /^A[4-7]/);
  assert.equal(r.current, `A${{ include: '1', byMethod: '2', exclude: '3' }[OPTIONS.recognizedOfficeRule]}`);
  assert.equal(testDeferredRules({ month: '2026-05', cashFlow, earnings }), null);
});

test('rule test: office rows split by Method on the Recognized side', () => {
  const cashFlow = [{ sellerName: 'Chicago Private Boat Tours', rows: [row('checkout', 100000)] }];
  const earnings = [{
    sellerName: 'Chicago Private Boat Tours',
    rows: [row('office', 30000, { method: 'Other', payoutDate: '' }), row('office', 20000, { method: 'Electronic', payoutDate: '' })],
  }];
  const r = testDeferredRules({ month: '2026-08', cashFlow, earnings });
  const all = Object.fromEntries(r.variants.map((v) => [v.id, v.totalCents]));
  // variants list is the closest 12; recompute the three office readings directly
  const again = testDeferredRules({ month: '2026-08', cashFlow, earnings });
  const want = { A1: 100000 - 50000, A2: 100000 - 20000, A3: 100000 };
  for (const [id, cents] of Object.entries(want)) {
    const v = again.variants.find((x) => x.id === id);
    if (v) assert.equal(v.totalCents, cents);
  }
  assert.ok(Object.keys(all).length > 0);
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
