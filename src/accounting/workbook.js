import XLSX from 'xlsx';
import { TRANSACTION_HEADERS, REPORT_MARKERS, normName, companyNames } from './settings.js';
import { toCents, normDate, findDates } from './money.js';

// Reading the Xola export workbooks. Everything is found BY HEADER NAME,
// never by column position.

export function readWorkbook(buffer) {
  return XLSX.read(buffer, { type: 'buffer' });
}

function findSheet(wb, name) {
  const want = normName(name);
  const actual = wb.SheetNames.find((n) => normName(n) === want);
  return actual ? wb.Sheets[actual] : null;
}

const rowsOf = (ws) => XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: true, defval: '' });

// Find the header row: the first row (within the first 20) containing every
// `needed` header. Returns { index, cols: {key: colIndex}, missing: [labels] }.
function locateHeaders(rows, wanted) {
  let best = { index: -1, cols: {}, missing: Object.values(wanted), hits: 0 };
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = (rows[i] || []).map(normName);
    const cols = {};
    const missing = [];
    for (const [key, label] of Object.entries(wanted)) {
      const idx = cells.indexOf(normName(label));
      if (idx === -1) missing.push(label);
      else cols[key] = idx;
    }
    const hits = Object.keys(cols).length;
    if (hits > best.hits) best = { index: i, cols, missing, hits };
    if (!missing.length) break;
  }
  return best;
}

const REQUIRED_TRANSACTION_HEADERS = ['Currency', 'Gross', 'Processing Fee', 'Service Fee', 'Guest Fee', 'Net', 'Source', 'Payout Date'];

// Xola's Recognized Earnings export has its own Transactions layout (confirmed
// from a real August 2026 file). Per row:
//   Recognized In Period            = the Net recognized this month (Summary Net = its total)
//   Previously / Collected In Period - Gross | Processing Fee | Service Fee | Net
// and no Payout Date column.
const RECOGNIZED_HEADERS = {
  transactionDate: 'Transaction Date',
  arrivalDate: 'Arrival Date',
  realizedDate: 'Realized Date',
  customerName: 'Customer Name',
  item: 'Item',
  currency: 'Currency',
  recognized: 'Recognized In Period',
  prevGross: 'Previously Collected - Gross',
  prevProc: 'Previously Collected - Processing Fee',
  prevSvc: 'Previously Collected - Service Fee',
  collGross: 'Collected In Period - Gross',
  collProc: 'Collected In Period - Processing Fee',
  collSvc: 'Collected In Period - Service Fee',
  source: 'Source',
  method: 'Method',
  confirmationCode: 'Confirmation Code',
};
const REQUIRED_RECOGNIZED_HEADERS = ['Currency', 'Recognized In Period', 'Source'];

function parseRecognizedRows(rows) {
  const { index, cols, missing } = locateHeaders(rows, RECOGNIZED_HEADERS);
  const missingRequired = missing.filter((label) => REQUIRED_RECOGNIZED_HEADERS.includes(label));
  if (missingRequired.length) {
    throw new Error(`Recognized Earnings Transactions sheet is missing header(s): ${missingRequired.join(', ')}`);
  }
  const out = [];
  for (const r of rows.slice(index + 1)) {
    const get = (k) => (cols[k] === undefined ? undefined : r[cols[k]]);
    const hasAny = ['source', 'confirmationCode', 'transactionDate', 'customerName'].some(
      (k) => String(get(k) ?? '').trim() !== ''
    );
    if (!hasAny) continue;
    const firstCell = String(r[0] ?? '').trim().toLowerCase();
    if (firstCell === 'total' || firstCell === 'totals') continue;
    const net = toCents(get('recognized'));
    const processingFee = toCents(get('prevProc')) + toCents(get('collProc'));
    const serviceFee = toCents(get('prevSvc')) + toCents(get('collSvc'));
    out.push({
      recognized: true,
      transactionDate: normDate(get('transactionDate')),
      arrivalDate: normDate(get('arrivalDate')),
      realizedDate: normDate(get('realizedDate')),
      customerName: String(get('customerName') ?? '').trim(),
      item: String(get('item') ?? '').trim(),
      currency: String(get('currency') ?? '').trim().toUpperCase() || 'USD',
      gross: toCents(get('prevGross')) + toCents(get('collGross')),
      processingFee,
      serviceFee,
      guestFee: 0,
      net,
      source: String(get('source') ?? '').trim().toLowerCase(),
      method: String(get('method') ?? '').trim(),
      payoutDate: '', // not in this report
      payoutDateRaw: '',
      confirmationCode: String(get('confirmationCode') ?? '').trim(),
    });
  }
  return out;
}

// Parse the Transactions sheet into typed rows (amounts in cents, dates ISO).
// Reads both the Cash Flow layout and the Recognized Earnings layout.
// Throws "missing header: X" (naming every missing header) when any is absent.
export function parseTransactions(wb) {
  const ws = findSheet(wb, 'Transactions');
  if (!ws) throw new Error('no "Transactions" sheet in the file');
  const rows = rowsOf(ws);
  const isRecognized = rows.slice(0, 20).some((r) => (r || []).some((c) => normName(c) === 'recognizedinperiod'));
  if (isRecognized) return parseRecognizedRows(rows);
  const { index, cols, missing } = locateHeaders(rows, TRANSACTION_HEADERS);
  // The amounts, Source, Currency and Payout Date drive the journal: missing any
  // of them fails the seller. The descriptive columns (dates, customer, item,
  // method, confirmation code) only feed the OFFICE list, so they may be absent.
  const missingRequired = missing.filter((label) => REQUIRED_TRANSACTION_HEADERS.includes(label));
  // A company with no bookings this month: Xola writes an empty (or near-empty)
  // Transactions sheet with no header row. That is "no activity", not an error.
  // (Xola sometimes adds a title or "No results" line, so: no header row and no
  // row with 3+ filled cells = no table at all.)
  const filled = (r) => (r || []).filter((c) => String(c ?? '').trim() !== '').length;
  if (index === -1 && (rows.length <= 2 || rows.every((r) => filled(r) < 3))) return [];
  if (index === -1 || missingRequired.length) {
    throw new Error(`Transactions sheet is missing header(s): ${(index === -1 ? missing : missingRequired).join(', ')}`);
  }

  const out = [];
  for (const r of rows.slice(index + 1)) {
    const get = (k) => r[cols[k]];
    // A totals/footer row has no Source and no Confirmation Code and no dates.
    const hasAny = ['source', 'confirmationCode', 'transactionDate', 'customerName'].some(
      (k) => String(get(k) ?? '').trim() !== ''
    );
    if (!hasAny) continue;
    const firstCell = String(r[0] ?? '').trim().toLowerCase();
    if (firstCell === 'total' || firstCell === 'totals') continue;

    out.push({
      transactionDate: normDate(get('transactionDate')),
      arrivalDate: normDate(get('arrivalDate')),
      customerName: String(get('customerName') ?? '').trim(),
      item: String(get('item') ?? '').trim(),
      currency: String(get('currency') ?? '').trim().toUpperCase() || 'USD',
      gross: toCents(get('gross')),
      processingFee: toCents(get('processingFee')),
      serviceFee: toCents(get('serviceFee')),
      guestFee: toCents(get('guestFee')),
      net: toCents(get('net')),
      source: String(get('source') ?? '').trim().toLowerCase(),
      method: String(get('method') ?? '').trim(),
      payoutDate: normDate(get('payoutDate')),
      payoutDateRaw: String(get('payoutDate') ?? '').trim(),
      confirmationCode: String(get('confirmationCode') ?? '').trim(),
    });
  }
  return out;
}

// Totals from the seller's Summary sheet (first table: Method | Gross | ... ).
// Uses the "Total" row when there is one, otherwise sums the method rows.
// Returns { gross, processingFee, serviceFee, net } in cents; a missing column is null.
export function parseSummaryTotals(wb) {
  const ws = findSheet(wb, 'Summary');
  if (!ws) throw new Error('no "Summary" sheet in the file');
  const rows = rowsOf(ws);
  const wanted = { method: 'Method', gross: 'Gross', processingFee: 'Processing Fee', serviceFee: 'Service Fee', net: 'Net' };
  const { index, cols } = locateHeaders(rows, wanted);
  if (index === -1 || cols.method === undefined || cols.gross === undefined) {
    throw new Error('Summary sheet has no "Method | Gross" table');
  }

  const sums = { gross: 0, processingFee: 0, serviceFee: 0, net: 0 };
  let totalRow = null;
  const isEmpty = (c) => String(c ?? '').trim() === '';
  const isNumber = (c) => typeof c === 'number' || /^\(?-?[$£€]?[\d,]*\.?\d+\)?$/.test(String(c ?? '').trim());
  for (const r of rows.slice(index + 1)) {
    // End of the first table: a fully empty row, or the header of the next table.
    // A row with a BLANK Method but amounts is a real method row (bookings with no
    // payment method) — it must be counted, not treated as the end of the table.
    if ((r || []).every(isEmpty)) break;
    const method = String(r[cols.method] ?? '').trim();
    if (normName(method) === 'total' || normName(method) === 'totals') {
      totalRow = r;
      break;
    }
    if (!isEmpty(r[cols.gross]) && !isNumber(r[cols.gross])) break;
    if (!method && isEmpty(r[cols.gross]) && (cols.net === undefined || isEmpty(r[cols.net]))) break;
    for (const k of Object.keys(sums)) if (cols[k] !== undefined) sums[k] += toCents(r[cols[k]]);
  }
  const pick = (k) => {
    if (cols[k] === undefined) return null;
    return totalRow ? toCents(totalRow[cols[k]]) : sums[k];
  };
  return {
    gross: pick('gross'),
    processingFee: pick('processingFee'),
    serviceFee: pick('serviceFee'),
    net: pick('net'),
  };
}

// Verify the "Report Details" sheet of a downloaded file.
// Returns { pass, found, message }. `found` is the sheet's text (trimmed) so the
// UI can show what was actually there.
export function checkReportDetails(buffer, type, from, to, { enforceMarker = true, company = null } = {}) {
  let wb;
  try {
    wb = readWorkbook(buffer);
  } catch (err) {
    return { pass: false, found: '', message: `file is not a readable workbook (${err.message})` };
  }
  const ws = findSheet(wb, 'Report Details');
  if (!ws) {
    return { pass: false, found: wb.SheetNames.join(', '), message: 'no "Report Details" sheet in the file' };
  }

  const cells = rowsOf(ws).flat().filter((c) => c !== '' && c !== null && c !== undefined);
  const text = cells.map(String).join(' | ');
  const found = text.slice(0, 500);
  const lower = text.toLowerCase();
  const marker = REPORT_MARKERS[type];
  if (!marker) return { pass: false, found, message: `unknown report type "${type}"` };

  for (const bad of marker.forbidden) {
    if (lower.includes(bad.toLowerCase())) {
      return {
        pass: false,
        found,
        message: `wrong report: expected ${marker.label} but Report Details shows "${bad}" (another report's marker)`,
      };
    }
  }
  if (enforceMarker) {
    const missing = marker.required.filter((s) => !lower.includes(s.toLowerCase()));
    if (missing.length) {
      return {
        pass: false,
        found,
        message: `wrong report: expected ${marker.label} but Report Details has no "${missing.join('", "')}"`,
      };
    }
  }

  // The file must be for the seller it was requested for (Report Details "Company").
  if (company) {
    const rows = rowsOf(ws);
    const row = rows.find((r) => normName(r?.[0]) === 'company');
    const fileCompany = row ? String(row[1] ?? '').trim() : '';
    if (fileCompany && !companyNames(company).has(normName(fileCompany))) {
      return { pass: false, found, message: `wrong company: the file is for "${fileCompany}", not "${company}"` };
    }
  }

  // Date range must be the run's month.
  const dates = new Set();
  for (const c of cells) {
    if (typeof c === 'number') {
      const d = normDate(c);
      if (d) dates.add(d);
    } else {
      for (const d of findDates(c)) dates.add(d);
    }
  }
  if (!dates.has(from) || !dates.has(to)) {
    const seen = [...dates].sort().join(', ') || 'none';
    return {
      pass: false,
      found,
      message: `date range is not ${from} → ${to} (dates on Report Details: ${seen})`,
    };
  }

  const note = !enforceMarker && !marker.required.length ? ' (marker not configured yet — recorded only)' : '';
  return { pass: true, found, message: `${marker.label} · ${from} → ${to}${note}` };
}
