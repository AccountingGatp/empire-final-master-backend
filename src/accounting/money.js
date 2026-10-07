import XLSX from 'xlsx';

// Money is handled in INTEGER CENTS everywhere in the accounting code.

// Parse a cell into cents. Accepts numbers, "1,234.50", "(12.00)", "$5", "".
export function toCents(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Math.round(v * 100);
  let s = String(v).trim();
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^0-9.-]/g, '');
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  const c = Math.round(n * 100);
  return neg ? -Math.abs(c) : c;
}

export const fromCents = (c) => Math.round(c) / 100;

export function fmtCents(c) {
  const n = fromCents(c);
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Convert local cents to USD cents at `rate` (USD per unit), rounded to the cent.
export const convertCents = (cents, rate) => Math.round(cents * rate);

// Sign rule (kept from the original importFile.js):
// positive -> its natural column; negative -> absolute value in the opposite column.
// Returns cents.
export function place(amountCents, naturalSide) {
  const debitNatural = naturalSide === 'debit';
  if (amountCents >= 0) {
    return debitNatural ? { debit: amountCents, credit: 0 } : { debit: 0, credit: amountCents };
  }
  const abs = Math.abs(amountCents);
  return debitNatural ? { debit: 0, credit: abs } : { debit: abs, credit: 0 };
}

// ---- Dates ---------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function ymd(y, m, d) {
  if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// Normalise a cell to 'YYYY-MM-DD', or '' when blank / unparseable.
// Handles Excel serials, Date objects, ISO, US M/D/YYYY and "Aug 5, 2026" / "5 Aug 2026".
export function normDate(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()) || '';
  }
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) {
      const p = XLSX.SSF.parse_date_code(v);
      return p ? ymd(p.y, p.m, p.d) || '' : '';
    }
    return '';
  }
  const found = findDates(String(v));
  return found[0] || '';
}

// Every date found inside a piece of text, normalised to 'YYYY-MM-DD'.
export function findDates(text) {
  const s = String(text || '');
  const out = [];
  let m;
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/g;
  while ((m = iso.exec(s))) out.push(ymd(+m[1], +m[2], +m[3]));
  // US M/D/YYYY and Xola's short M/D/YY ("8/1/26, 8/31/26" on Report Details).
  const us = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g;
  while ((m = us.exec(s))) out.push(ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]));
  // Xola's D-Mon-YYYY ("09-Sep-2026") used for payout dates.
  const dMonY = /\b(\d{1,2})-([A-Za-z]{3})-(\d{4})\b/g;
  while ((m = dMonY.exec(s))) {
    const i = MONTH_ABBR.indexOf(m[2].toLowerCase());
    if (i >= 0) out.push(ymd(+m[3], i + 1, +m[1]));
  }
  const mdy = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g;
  while ((m = mdy.exec(s))) {
    const i = MONTH_ABBR.indexOf(m[1].slice(0, 3).toLowerCase());
    if (i >= 0) out.push(ymd(+m[3], i + 1, +m[2]));
  }
  const dmy = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g;
  while ((m = dmy.exec(s))) {
    const i = MONTH_ABBR.indexOf(m[2].slice(0, 3).toLowerCase());
    if (i >= 0) out.push(ymd(+m[3], i + 1, +m[1]));
  }
  return out.filter(Boolean);
}

// Period metadata for a 'YYYY-MM' month.
export function monthMeta(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!m) throw new Error(`bad month "${month}"`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return {
    year,
    month: mon,
    from: `${year}-${pad2(mon)}-01`,
    to: `${year}-${pad2(mon)}-${pad2(lastDay)}`,
    // QBO import date: M/D/YYYY, no leading zeros.
    journalDate: `${mon}/${lastDay}/${year}`,
  };
}

// The month before 'YYYY-MM'.
export function previousMonth(month) {
  const { year, month: mon } = monthMeta(month);
  const d = new Date(Date.UTC(year, mon - 2, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}
