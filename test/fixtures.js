// Synthetic Xola-style workbooks for tests. The layout follows what the code
// expects (headers found by name, deliberately NOT in the brief's order) —
// replace with a real export once one is available.
import XLSX from 'xlsx';

export const HEADERS = [
  'Confirmation Code', 'Source', 'Transaction Date', 'Arrival Date', 'Customer Name', 'Item',
  'Method', 'Currency', 'Gross', 'Processing Fee', 'Service Fee', 'Guest Fee', 'Net', 'Payout Date',
];

let seq = 1000;
export function tx(over = {}) {
  const gross = over.gross ?? 100;
  const processingFee = over.processingFee ?? 3;
  const serviceFee = over.serviceFee ?? 2;
  return {
    'Confirmation Code': `C${seq++}`,
    Source: 'checkout',
    'Transaction Date': '2026-08-05',
    'Arrival Date': '2026-08-20',
    'Customer Name': 'Test Guest',
    Item: 'River Tour',
    Method: 'Credit Card',
    Currency: 'USD',
    Gross: gross,
    'Processing Fee': processingFee,
    'Service Fee': serviceFee,
    'Guest Fee': over.guestFee ?? 1.5,
    Net: over.net ?? gross - processingFee - serviceFee,
    'Payout Date': '2026-08-10',
    ...over,
  };
}

function totals(rows) {
  const s = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  return { gross: s('Gross'), pf: s('Processing Fee'), sf: s('Service Fee'), gf: s('Guest Fee'), net: s('Net') };
}

// A Cash Flow / earnings workbook: Report Details + Summary + Transactions.
export function workbook(rows, { type = 'account', from = '2026-08-01', to = '2026-08-31', omit = [], summaryOverride } = {}) {
  const wb = XLSX.utils.book_new();
  const details =
    type === 'payout'
      ? [['Report', 'Payouts'], ['From Date', from], ['To Date', to], ['Payout Lag', 2]]
      : type === 'earnings'
        ? [['Report', 'Recognized Earnings'], ['Arrival date is between', `${from} and ${to}`]]
        : [['Report', 'Cash Flow'], ['Date is between', `${from} and ${to}`]];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(details), 'Report Details');

  const t = summaryOverride || totals(rows);
  const summary = [
    ['Method', 'Gross', 'Processing Fee', 'Service Fee', 'Guest Fee', 'Net'],
    ['Credit Card', t.gross, t.pf, t.sf, t.gf, t.net],
    ['Total', t.gross, t.pf, t.sf, t.gf, t.net],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');

  const headers = HEADERS.filter((h) => !omit.includes(h));
  const aoa = [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Transactions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
