import ExcelJS from 'exceljs';
import { fromCents } from './money.js';

// Workbook writers (styling kept from the original importFile.js).
const FONT = 'Arial';
const NAVY = 'FF1F3864';
const WHITE = 'FFFFFFFF';
const MONEY = '#,##0.00;(#,##0.00)';

function sheet(wb, name, headers, widths) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  const hr = ws.addRow(headers);
  hr.eachCell((cell) => {
    cell.font = { name: FONT, bold: true, color: { argb: WHITE }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  });
  ws.columns = widths.map((width) => ({ width }));
  return ws;
}

function addRow(ws, values, moneyCols = []) {
  const row = ws.addRow(values);
  row.eachCell({ includeEmpty: true }, (cell) => {
    if (!cell.font || !cell.font.name) cell.font = { name: FONT, size: 10 };
  });
  for (const c of moneyCols) row.getCell(c).numFmt = MONEY;
  return row;
}

const book = () => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GATP Solutions';
  return wb;
};
const buf = async (wb) => Buffer.from(await wb.xlsx.writeBuffer());
const money = (c) => (c ? fromCents(c) : null);

// QBO / SaasAnt journal import: *JournalNo, *JournalDate, *AccountName, *Debits, *Credits, Description, Class
// With { extended: true } (Viator JEs, SOP section 4) the layout is
// *JournalNo, *JournalDate, *AccountName, *Debits, *Credits, Description, Name, Currency, Location, Class.
// No total row in the import file.
export async function writeJournalXlsx(lines, { extended = false } = {}) {
  const wb = book();
  const ws = sheet(
    wb,
    'Journal Entry',
    extended
      ? ['*JournalNo', '*JournalDate', '*AccountName', '*Debits', '*Credits', 'Description', 'Name', 'Currency', 'Location', 'Class']
      : ['*JournalNo', '*JournalDate', '*AccountName', '*Debits', '*Credits', 'Description', 'Class'],
    extended ? [16, 13, 44, 14, 14, 52, 14, 10, 14, 38] : [16, 13, 44, 14, 14, 52, 38]
  );
  for (const l of lines) {
    const head = [l.journalNo, l.journalDate, l.account, money(l.debit), money(l.credit), l.description];
    addRow(ws, extended ? [...head, l.name || '', l.currency || 'USD', '', l.class] : [...head, l.class], [4, 5]);
  }
  return buf(wb);
}

// Viator workings: summary per location, every booking with its price / status /
// payout result, the Exceptions list and the deferred working (SOP sections 3, 5).
export async function writeViatorWorkingsXlsx({ month, locations, detail, exceptions }) {
  const wb = book();
  const pct = (v) => (v === null || v === undefined ? null : Math.round(v * 10000) / 10000);

  const s = sheet(
    wb,
    'Summary',
    ['Location', 'Class', 'Currency', 'Bookings (booked in month)', 'Sales (local)', 'Net (local)', 'Commission (local)', 'Commission %', 'Rate to USD', 'Sales (USD)', 'Commission (USD)', 'Unpriced bookings'],
    [32, 30, 9, 14, 15, 15, 16, 12, 11, 15, 16, 12]
  );
  for (const l of locations) {
    addRow(s, [l.location, l.class, l.currency, l.bookings, fromCents(l.salesLocalCents), fromCents(l.netLocalCents), fromCents(l.commissionLocalCents), pct(l.commissionPct), l.rate, fromCents(l.salesCents), fromCents(l.commissionCents), l.unpriced], [5, 6, 7, 10, 11]);
  }
  addRow(s, ['Total (USD)', '', '', '', '', '', '', '', '', fromCents(locations.reduce((a, l) => a + l.salesCents, 0)), fromCents(locations.reduce((a, l) => a + l.commissionCents, 0)), ''], [10, 11]);

  const d = sheet(
    wb,
    'Deferred working',
    ['Location', 'Currency', `Cash Flow = Sales by booking month ${month}`, `Reco Ear = Sales by travel month ${month}`, 'Deferred (local)', 'Deferred (USD)'],
    [32, 9, 24, 24, 16, 16]
  );
  for (const l of locations) {
    addRow(d, [l.location, l.currency, fromCents(l.cashFlowLocalCents), fromCents(l.recognizedLocalCents), fromCents(l.deferredLocalCents), fromCents(l.deferredCents)], [3, 4, 5, 6]);
  }

  const b = sheet(
    wb,
    'Bookings',
    ['Location', 'Booking ref', 'Booking date', 'Travel date', 'Status', 'Source', 'Product code', 'Tour grade', 'Adults', 'Seniors', 'Youths', 'Children', 'Infants', 'Viator gross', 'Report net', 'Paid by Viator', 'Sales', 'Net', 'Commission', 'Rule applied'],
    [30, 16, 12, 12, 11, 12, 14, 14, 7, 7, 7, 8, 7, 12, 12, 12, 12, 12, 12, 46]
  );
  for (const r of detail) {
    addRow(
      b,
      [r.location, r.ref, r.bookingDate, r.travelDate, r.status, r.source, r.productCode, r.tourGrade, r.adults, r.seniors, r.youths, r.children, r.infants, r.grossCents === null ? null : fromCents(r.grossCents), fromCents(r.reportNetCents ?? 0), r.hasPayout ? fromCents(r.paidCents) : null, fromCents(r.salesCents ?? 0), fromCents(r.netCents ?? 0), fromCents(r.commissionCents ?? 0), r.rule],
      [14, 15, 16, 17, 18, 19]
    );
  }

  const e = sheet(wb, 'Exceptions', ['Location', 'Booking ref', 'Kind', 'What', 'Net', 'Price the net implies'], [30, 16, 11, 90, 12, 18]);
  for (const x of exceptions) {
    addRow(e, [x.location, x.ref, x.kind, x.detail, x.net === undefined ? null : fromCents(x.net), x.impliedGross ? fromCents(x.impliedGross) : null], [5, 6]);
  }
  if (!exceptions.length) addRow(e, ['None.']);
  return buf(wb);
}

// Office bookings excluded from the journal (Source = office, blank Payout Date).
export async function writeOfficeXlsx(rows, review = []) {
  const wb = book();
  const ws = sheet(
    wb,
    'Office bookings',
    ['Location', 'Transaction Date', 'Arrival Date', 'Customer Name', 'Item', 'Gross', 'Net', 'Method', 'Confirmation Code', 'Currency'],
    [32, 15, 13, 26, 36, 12, 12, 14, 20, 10]
  );
  for (const r of rows) {
    addRow(
      ws,
      [r.location, r.transactionDate, r.arrivalDate, r.customerName, r.item, fromCents(r.gross), fromCents(r.net), r.method, r.confirmationCode, r.currency],
      [6, 7]
    );
  }
  if (!rows.length) addRow(ws, ['No office bookings with a blank Payout Date this month.']);

  // Bookings whose Source is not in the SOP table (e.g. Tiqets, blank): left out
  // of the journal and listed here for the Controller.
  const rs = sheet(
    wb,
    'Source review',
    ['Location', 'Source', 'Transaction Date', 'Arrival Date', 'Customer Name', 'Item', 'Gross', 'Net', 'Payout Date', 'Confirmation Code', 'Currency'],
    [32, 14, 15, 13, 26, 36, 12, 12, 13, 20, 10]
  );
  for (const r of review) {
    addRow(
      rs,
      [r.location, r.source || '(blank)', r.transactionDate, r.arrivalDate, r.customerName, r.item, fromCents(r.gross), fromCents(r.net), r.payoutDate, r.confirmationCode, r.currency],
      [7, 8]
    );
  }
  if (!review.length) addRow(rs, ['No bookings with a Source outside the SOP table this month.']);
  return buf(wb);
}

function fmtValue(v, unit) {
  if (v === null || v === undefined) return '';
  if (unit === 'money' && typeof v === 'number') return fromCents(v);
  return v;
}

// CHECKS-YYYY-MM.xlsx: every check result, run date, user, FX rates, accepted diffs.
export async function writeChecksXlsx({ month, runDate, user, journals, fxRates = [], acceptedDiffs = [] }) {
  const wb = book();

  const info = sheet(wb, 'Run', ['Field', 'Value'], [24, 60]);
  addRow(info, ['Month', month]);
  addRow(info, ['Run date', runDate ? new Date(runDate).toISOString() : '']);
  addRow(info, ['Generated at', new Date().toISOString()]);
  addRow(info, ['Generated by', user || '']);
  for (const [key, j] of Object.entries(journals)) {
    if (!j) continue;
    addRow(info, [`${key} journal`, `${j.journalNo || ''} · ${j.status || 'not built'}${j.generatedAt ? ` · built ${new Date(j.generatedAt).toISOString()}` : ''}`]);
  }

  const ws = sheet(
    wb,
    'Checks',
    ['Journal', 'Check', 'Location', 'Name', 'Expected', 'Actual', 'Diff', 'Result', 'Note'],
    [10, 7, 32, 48, 16, 16, 12, 12, 60]
  );
  for (const [key, j] of Object.entries(journals)) {
    for (const c of j?.checks || []) {
      const accepted = !c.pass && acceptedDiffs.some((a) => a.journal === key && a.checkId === c.id && a.location === c.location);
      const row = addRow(ws, [
        key,
        c.id,
        c.location,
        c.name,
        fmtValue(c.expected, c.unit),
        fmtValue(c.actual, c.unit),
        fmtValue(c.diff, c.unit),
        c.pass ? 'PASS' : c.hardStop ? 'HARD STOP' : accepted ? 'ACCEPTED' : 'FAIL',
        c.note || '',
      ]);
      if (c.unit === 'money') for (const i of [5, 6, 7]) row.getCell(i).numFmt = MONEY;
      if (!c.pass) row.getCell(8).font = { name: FONT, size: 10, bold: true, color: { argb: accepted ? 'FFB45309' : 'FFB91C1C' } };
    }
  }

  const fx = sheet(wb, 'FX rates', ['Location', 'Currency', 'Date', 'Rate (USD per unit)', 'Rate source', 'Used by', 'Entered by', 'Entered at'], [32, 10, 16, 18, 34, 20, 30, 24]);
  for (const r of fxRates) {
    const origin = r.origin === 'ecb' ? 'ECB market rate (suggested, confirmed by user)' : 'Entered by user (banked rate)';
    addRow(fx, [r.location, r.currency, r.date || 'no date', r.rate, origin, (r.sources || []).join(', '), r.enteredBy || '', r.enteredAt ? new Date(r.enteredAt).toISOString() : '']);
  }
  if (!fxRates.length) addRow(fx, ['No foreign-currency rows this month.']);

  const acc = sheet(wb, 'Accepted differences', ['Journal', 'Check', 'Location', 'Diff', 'Reason', 'User', 'At'], [10, 7, 32, 14, 60, 30, 24]);
  for (const a of acceptedDiffs) {
    addRow(acc, [a.journal, a.checkId, a.location, a.diff ?? '', a.reason, a.user, a.at ? new Date(a.at).toISOString() : '']);
  }
  if (!acceptedDiffs.length) addRow(acc, ['None.']);

  return buf(wb);
}
