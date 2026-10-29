// Viator sales, commission and deferred revenue — "Empire Viator Sales, Commission
// & Deferred SOP" (28 Oct 2026). Pure: no database, no storage.
//
//   Inputs per Viator supplier account (see VIATOR_ACCOUNTS in settings.js):
//     • bookings reports (CSV)   booking-date report and travel-date report
//     • payout advices (XLSX)    what Viator actually paid per booking
//     • the product commission sheet (prices per adult / senior / youth / child)
//
//   Per booking (SOP section 2):  Sales and Net come from the status + payout rules.
//   Commission (section 3):       Sales − Net.
//   Sales & commission JE (4):    one JE, one line per class, booking month.
//   Deferred (5, 6):              booking-month sales − travel-month sales.

import XLSX from 'xlsx';
import { ACCOUNTS, OPTIONS, VIATOR_ACCOUNTS, lookupCompany, nameFor } from './settings.js';
import { normDate, place, monthMeta, convertCents } from './money.js';
import { rateKey, rateMap, needsConversion, rateProblem } from './fx.js';
import * as C from './checks.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const toNum = (v) => {
  const t = String(v ?? '').replace(/[^0-9.-]/g, '');
  if (t === '' || t === '-' || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const toCentsStrict = (v) => {
  const n = toNum(v);
  return n === null ? null : Math.round(n * 100);
};
const toInt = (v) => Math.max(0, Math.round(toNum(v) || 0));

export const accountById = (id) => VIATOR_ACCOUNTS.find((a) => a.id === String(id));

// ---- Which account does a file belong to? --------------------------------------------

// Payout advice:  VI0000005669845_USD_20261007_USD_SUP_BNK.xlsx  -> 5669845
// Bookings:       bookings-report-5669845-20261028124216.csv     -> 5669845
// Fallback:       a folder name such as "Empire Tours london (5669869)".
export function accountFromName(pathOrName) {
  const full = String(pathOrName || '');
  const base = full.split(/[\\/]/).pop();
  let m = /^VI0*(\d+)_/i.exec(base) || /bookings-report-(\d+)-/i.exec(base);
  if (m && accountById(m[1])) return accountById(m[1]);
  const folders = full.split(/[\\/]/).slice(0, -1).reverse();
  for (const f of folders) {
    const ids = [...f.matchAll(/(\d{4,})/g)].map((x) => x[1]);
    for (const id of ids) if (accountById(id)) return accountById(id);
  }
  return null;
}

export function fileKind(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  if (/^VI0*\d+_.*\.(xlsx|xls)$/i.test(base)) return 'payout';
  if (/\.csv$/i.test(base)) return 'bookings';
  return null;
}

// ---- Parsing -------------------------------------------------------------------------

function sheetRows(buffer, fileName) {
  const isCsv = /\.csv$/i.test(fileName || '');
  const wb = isCsv
    ? XLSX.read(Buffer.from(buffer).toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true })
    : XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: true, defval: '' });
}

function mapColumns(headerCells, wanted) {
  const cells = headerCells.map(key);
  const cols = {};
  for (const [field, aliases] of Object.entries(wanted)) {
    const i = cells.findIndex((c) => aliases.includes(c));
    if (i !== -1) cols[field] = i;
  }
  return cols;
}

const BOOKING_COLS = {
  ref: ['bookingreference', 'bookingref'],
  bookingDate: ['bookingdate'],
  net: ['netprice', 'net'],
  currency: ['currency'],
  status: ['status'],
  travelDate: ['traveldate'],
  adults: ['adults'],
  seniors: ['seniors'],
  youths: ['youths'],
  children: ['children'],
  infants: ['infants'],
  productCode: ['productcode'],
  productName: ['productname'],
  tourGrade: ['tourgradecode'],
  source: ['bookingsource'],
};

// Viator booking report (CSV). Customer names / contact details are NOT kept.
export function parseBookingsCsv(buffer, fileName = 'bookings.csv') {
  const rows = sheetRows(buffer, fileName);
  let h = -1;
  let cols = {};
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const c = mapColumns(rows[i] || [], BOOKING_COLS);
    if (c.ref !== undefined && c.bookingDate !== undefined) {
      h = i;
      cols = c;
      break;
    }
  }
  if (h === -1) throw new Error('not a Viator bookings report — the "Booking Reference" and "Booking Date" columns were not found');
  const missing = ['net', 'status', 'travelDate'].filter((f) => cols[f] === undefined);
  if (missing.length) throw new Error(`the bookings report has no ${missing.join(', ')} column`);

  const bookings = [];
  const warnings = [];
  for (const r of rows.slice(h + 1)) {
    const ref = String(r[cols.ref] ?? '').trim();
    if (!ref) continue;
    const bookingDate = normDate(r[cols.bookingDate]);
    const travelDate = normDate(r[cols.travelDate]);
    if (!bookingDate || !travelDate) {
      warnings.push(`${ref}: unreadable date — skipped`);
      continue;
    }
    const g = (f) => (cols[f] === undefined ? '' : r[cols[f]]);
    bookings.push({
      ref,
      refNum: ref.replace(/\D/g, ''),
      bookingDate,
      travelDate,
      status: String(g('status')).trim().toLowerCase(),
      netCents: toCentsStrict(g('net')) ?? 0,
      currency: String(g('currency') || '').trim().toUpperCase(),
      adults: toInt(g('adults')),
      seniors: toInt(g('seniors')),
      youths: toInt(g('youths')),
      children: toInt(g('children')),
      infants: toInt(g('infants')),
      productCode: String(g('productCode')).trim(),
      productName: String(g('productName')).trim(),
      tourGrade: String(g('tourGrade')).trim(),
      source: String(g('source')).trim(),
    });
  }
  return { bookings, warnings, ...detectBasis(bookings) };
}

// Is this the booking-date report or the travel-date report? Looked at from the
// data: a booking-date report has one booking month, a travel-date report one travel month.
export function detectBasis(bookings) {
  const bm = new Set(bookings.map((b) => b.bookingDate.slice(0, 7)));
  const tm = new Set(bookings.map((b) => b.travelDate.slice(0, 7)));
  if (!bookings.length) return { basis: 'empty', month: null };
  if (bm.size === 1 && tm.size === 1) return { basis: 'both', month: [...bm][0] };
  if (bm.size === 1) return { basis: 'booking', month: [...bm][0] };
  if (tm.size === 1) return { basis: 'travel', month: [...tm][0] };
  return { basis: 'unknown', month: null };
}

const PAYOUT_COLS = {
  ref: ['viatorreference'],
  arrival: ['arrivaldate'],
  sale: ['saledate'],
  amount: ['amount'],
  currency: ['currency'],
  converted: ['convertedamount'],
  convertedCurrency: ['convertedcurrency'],
};

// Viator payment advice (XLSX). Uses CONVERTED AMOUNT, never AMOUNT (SOP section 1).
// Some advices have no converted columns (same currency): then AMOUNT is used, but
// only when its CURRENCY is the account's own currency.
export function parsePayoutAdvice(buffer, fileName, homeCurrency = 'USD') {
  const rows = sheetRows(buffer, fileName);
  const h = rows.findIndex((r) => key(r?.[0]) === 'viatorreference');
  if (h === -1) throw new Error('not a Viator payment advice — the "VIATOR REFERENCE" header was not found');
  const cols = mapColumns(rows[h], PAYOUT_COLS);
  if (cols.ref === undefined || (cols.converted === undefined && cols.amount === undefined)) {
    throw new Error('the payment advice has no CONVERTED AMOUNT / AMOUNT column');
  }

  const out = [];
  const problems = [];
  let declared = null;
  for (const r of rows.slice(h + 1)) {
    const first = String(r[0] ?? '').trim();
    if (/^total payment/i.test(first)) {
      const cell = r.slice(1).find((c) => toNum(c) !== null);
      declared = cell === undefined ? null : toCentsStrict(cell);
      continue;
    }
    if (!/^\d+$/.test(first)) continue;
    const cell = (f) => (cols[f] === undefined ? '' : r[cols[f]]);
    let cents = toCentsStrict(cell('converted'));
    let currency = String(cell('convertedCurrency') || '').trim().toUpperCase();
    let usedAmount = false;
    if (cents === null) {
      const own = String(cell('currency') || '').trim().toUpperCase();
      cents = toCentsStrict(cell('amount'));
      currency = own;
      usedAmount = true;
      if (cents === null || (own && own !== homeCurrency)) {
        problems.push(`${first}: no converted amount and the amount is in ${own || '?'} — row skipped`);
        continue;
      }
    }
    if (!currency) currency = homeCurrency;
    out.push({ refNum: first, saleDate: normDate(cell('sale')), arrivalDate: normDate(cell('arrival')), cents, currency, usedAmount });
  }
  if (!out.length && declared === null) throw new Error('the payment advice has no booking rows');

  // Payment date: the file name (…_20261007_…), else the date at the top right.
  const fromName = /_(\d{4})(\d{2})(\d{2})_/.exec(String(fileName || '').split(/[\\/]/).pop());
  let paymentDate = fromName ? `${fromName[1]}-${fromName[2]}-${fromName[3]}` : '';
  if (!paymentDate) {
    for (const c of (rows[0] || []).filter((x) => x !== '')) {
      const d = parseDMonYY(c);
      if (d) paymentDate = d;
    }
  }
  return { rows: out, paymentDate, declaredCents: declared, sumCents: sum(out, (x) => x.cents), problems };
}

function parseDMonYY(v) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(String(v).trim());
  if (!m) return normDate(v);
  const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (mi < 0) return '';
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// ---- Product commission sheet (prices) ------------------------------------------------

const PRICE_COLS = {
  productCode: ['productcode', 'product', 'productid', 'code'],
  tourGrade: ['tourgradecode', 'tourgrade', 'grade', 'option', 'tourgradeoption'],
  adult: ['adult', 'adultprice', 'priceadult', 'viatorpriceadult', 'viatoradultprice'],
  senior: ['senior', 'seniorprice', 'priceseniors', 'priceSenior'.toLowerCase(), 'viatorpricesenior', 'viatorseniorprice'],
  youth: ['youth', 'youthprice', 'priceyouth', 'viatorpriceyouth', 'viatoryouthprice'],
  child: ['child', 'childprice', 'pricechild', 'viatorpricechild', 'viatorchildprice'],
  productName: ['productname', 'name', 'tour', 'tourname'],
  groupAdult: ['groupsizepricesadult', 'groupadultprices', 'adultgroupprices', 'groupprices', 'privategroupprices', 'adultgroupsizeprices'],
  groupSenior: ['groupsizepricessenior', 'groupseniorprices', 'seniorgroupprices', 'seniorgroupsizeprices'],
  booking: ['perbooking', 'perbookingvehicle', 'bookingprice', 'pricebooking', 'pricepervehicle', 'vehicleprice', 'privateprice'],
  commission: ['commission', 'commissionpct', 'commissionpercent', 'listedcommission', 'commissionrate', 'rate'],
  effective: ['effectivedate', 'effective', 'from', 'validfrom', 'startdate'],
};

// Reads the product commission sheet exported as CSV / XLSX. The header row is
// found by looking for a product-code column plus at least one price column.
export function parsePriceSheet(buffer, fileName = 'prices.csv') {
  const rows = sheetRows(buffer, fileName);
  let h = -1;
  let cols = {};
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const c = mapColumns(rows[i] || [], PRICE_COLS);
    if (c.productCode !== undefined && ['adult', 'senior', 'youth', 'child', 'booking', 'groupAdult'].some((f) => c[f] !== undefined)) {
      h = i;
      cols = c;
      break;
    }
  }
  if (h === -1) throw new Error('could not find the price columns — the sheet needs a product code column and adult / senior / youth / child price columns');
  const price = (v) => {
    const n = toNum(v);
    return n === null || String(v).trim() === '' ? null : Math.round(n * 100);
  };
  // "1:399.00|2:249.00|3:199.00" -> [39900, 24900, 19900] (index = group size − 1)
  const tierList = (v) => {
    const out = [];
    for (const part of String(v ?? '').split(/[|;,]/)) {
      const m = /^\s*(\d+)\s*[:=]\s*([\d.]+)/.exec(part);
      if (m) out[Number(m[1]) - 1] = Math.round(Number(m[2]) * 100);
    }
    for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = out[i - 1] ?? 0;
    return out.length ? out : null;
  };
  const out = [];
  for (const r of rows.slice(h + 1)) {
    const productCode = String(r[cols.productCode] ?? '').trim();
    if (!productCode) continue;
    const g = (f) => (cols[f] === undefined ? '' : r[cols[f]]);
    let commission = toNum(g('commission'));
    if (commission !== null && commission > 1) commission /= 100; // 40 -> 0.40
    out.push({
      productCode,
      tourGrade: String(g('tourGrade') || '').trim(),
      adult: price(g('adult')),
      senior: price(g('senior')),
      youth: price(g('youth')),
      child: price(g('child')),
      booking: price(g('booking')),
      productName: String(g('productName') || '').trim(),
      tiers: tierList(g('groupAdult')) ? { adult: tierList(g('groupAdult')), senior: tierList(g('groupSenior')) } : null,
      commission,
      effective: normDate(g('effective')),
    });
  }
  if (!out.length) throw new Error('the price sheet has no product rows');
  return { rows: out };
}

const stripAccount = (code) => String(code).replace(/^\d+(?=P|MINI|[A-Z])/i, '');
const gradeBase = (g) => String(g || '').split('~')[0].trim().toLowerCase();

// Returns a lookup(booking) -> price row | null. Product code + tour grade; the
// latest row whose effective date is on or before the booking date wins.
export function makePriceLookup(rows = []) {
  const index = new Map();
  for (const r of rows) {
    for (const pc of new Set([key(r.productCode), key(stripAccount(r.productCode))])) {
      for (const g of new Set([key(r.tourGrade), key(gradeBase(r.tourGrade)), ''])) {
        const k = `${pc}|${g}`;
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(r);
      }
    }
  }
  return (b) => {
    const pcs = [key(b.productCode), key(stripAccount(b.productCode))];
    const gs = [key(b.tourGrade), key(gradeBase(b.tourGrade)), ''];
    for (const pc of pcs) {
      for (const g of gs) {
        const list = index.get(`${pc}|${g}`);
        if (!list) continue;
        const ok = list.filter((r) => !r.effective || r.effective <= b.bookingDate);
        const pool = ok.length ? ok : list;
        return pool.reduce((a, c) => ((c.effective || '') >= (a.effective || '') ? c : a));
      }
    }
    return null;
  };
}

// Viator Gross = adults × adult + seniors × senior + youths × youth + children × child
// (infants free); a private per-vehicle product is priced per booking (SOP section 2).
export function grossFor(b, row) {
  if (!row) return { cents: null, reason: 'product / tour grade not in the price sheet' };
  // Private / group-size pricing: every guest pays the price listed for the size of the party.
  if (row.tiers?.adult?.length) {
    const size = (b.adults || 0) + (b.seniors || 0) + (b.youths || 0) + (b.children || 0);
    const at = (list) => list[Math.min(Math.max(size, 1), list.length) - 1];
    const cents = ((b.adults || 0) + (b.youths || 0) + (b.children || 0)) * at(row.tiers.adult) + (b.seniors || 0) * at(row.tiers.senior || row.tiers.adult);
    return size > row.tiers.adult.length ? { cents, reason: `party of ${size} is bigger than the largest listed group size (${row.tiers.adult.length}) — priced at that tier` } : { cents };
  }
  if (row.booking !== null && row.booking !== undefined && row.adult === null) return { cents: row.booking, perBooking: true };
  const need = [
    ['adults', 'adult'],
    ['seniors', 'senior'],
    ['youths', 'youth'],
    ['children', 'child'],
  ];
  let total = 0;
  for (const [count, p] of need) {
    if (!b[count]) continue;
    if (row[p] === null || row[p] === undefined) return { cents: null, reason: `no ${p} price in the price sheet for ${b.productCode} ${b.tourGrade}` };
    total += b[count] * row[p];
  }
  return { cents: total };
}

// ---- Per booking: status + payout rules (SOP section 2) --------------------------------

const ACTIVE = new Set(['confirmed', 'amended']);
const DEAD = new Set(['cancelled', 'canceled', 'rejected']);

/**
 * @returns the booking with: grossCents, paidCents, hasPayout, salesCents, netCents,
 *          commissionCents, rule, flags[]
 */
export function applyRules(b, paid, grossCents) {
  const hasPayout = paid !== undefined;
  const paidCents = hasPayout ? paid : 0;
  const reportNet = b.netCents;
  const flags = [];
  let sales = 0;
  let net = 0;
  let rule;

  if (ACTIVE.has(b.status)) {
    if (!hasPayout) {
      rule = 'Confirmed/Amended, not in a payout yet';
      sales = grossCents;
      net = reportNet;
    } else if (paidCents === 0) {
      rule = 'Confirmed/Amended, paid 0 (reversed in a payout)';
    } else if (paidCents < 0) {
      rule = 'Confirmed/Amended, negative payout';
      flags.push('payout is negative — treated as 0, check in Viator');
    } else if (reportNet > 0 && paidCents < reportNet) {
      rule = 'Confirmed/Amended, partly paid';
      sales = grossCents === null ? null : Math.round((grossCents * paidCents) / reportNet);
      net = paidCents;
    } else {
      rule = 'Confirmed/Amended, paid in full';
      sales = grossCents;
      net = paidCents;
      if (reportNet > 0 && paidCents > reportNet) flags.push(`paid ${paidCents / 100} is more than the report net ${reportNet / 100}`);
    }
  } else if (DEAD.has(b.status)) {
    if (!hasPayout || paidCents === 0) {
      rule = 'Cancelled/Rejected, not paid';
    } else {
      rule = 'Cancelled, but Viator paid it';
      sales = grossCents;
      net = paidCents;
    }
  } else {
    rule = `Unknown status "${b.status}" — treated like Confirmed`;
    flags.push(`unknown status "${b.status}"`);
    sales = hasPayout ? (paidCents > 0 ? grossCents : 0) : grossCents;
    net = hasPayout ? Math.max(paidCents, 0) : reportNet;
  }
  return { grossCents, paidCents, hasPayout, salesCents: sales, netCents: net, commissionCents: sales === null ? null : sales - net, rule, flags };
}

// ---- The whole month -------------------------------------------------------------------

const monthOf = (d) => String(d).slice(0, 7);
const monthEnd = (month) => monthMeta(month).journalDate;

/**
 * @param input
 *   month     'YYYY-MM' (the month being closed)
 *   accounts  [{ id, bookingFiles:[{fileName, basis, month, bookings, warnings}],
 *                payoutFiles:[{fileName, paymentDate, rows, declaredCents, sumCents, problems}] }]
 *   prices    price-sheet rows (parsePriceSheet().rows) — required
 *   rates     the run's FX rate table (London needs GBP · date '' = monthly average)
 */
export function buildViatorSop({ month, accounts, prices, rates = [], options = OPTIONS }) {
  if (!prices?.length) {
    const err = new Error('The Viator product commission sheet has not been uploaded yet — upload it in the Viator step first.');
    err.code = 'NO_PRICES';
    throw err;
  }
  const period = monthMeta(month);
  const end = period.journalDate;
  const lookup = makePriceLookup(prices);
  const rmap = rateMap(rates);
  const desc = `${MONTHS[period.month - 1]} ${period.year}`;
  const metaVia = { journalNo: nameFor('viator', month), journalDate: end };
  const metaDef = { journalNo: nameFor('viatorDef', month), journalDate: end };

  const checks = [];
  const defChecks = [];
  const exceptions = [];
  const detail = [];
  const locations = [];
  const missingRates = new Set();

  for (const def of VIATOR_ACCOUNTS) {
    const acc = accounts.find((a) => a.id === def.id) || { id: def.id, bookingFiles: [], payoutFiles: [] };
    const who = lookupCompany(def.location, options);
    const klass = who.status === 'post' ? who.company.class : '';
    const name = def.location;

    // -- files present?
    const bf = acc.bookingFiles || [];
    const pf = acc.payoutFiles || [];
    const empties = bf.filter((f) => f.basis === 'empty').length;
    const hasBooking = bf.some((f) => ['booking', 'both'].includes(f.basis) && f.month === month);
    const hasTravel = bf.some((f) => ['travel', 'both'].includes(f.basis) && f.month === month);
    const covered = (hasBooking && hasTravel) || (hasBooking && empties > 0) || (hasTravel && empties > 0) || (empties >= 2);
    checks.push(
      C.result('VS1', name, 'Booking-date and travel-date report for the month are both there', 'both', covered ? 'both' : hasBooking ? 'booking-date only' : hasTravel ? 'travel-date only' : bf.length ? 'month not covered' : 'no files', {
        unit: 'text',
        pass: covered,
        note: covered ? undefined : `Download both Viator bookings reports for ${desc} (booking date and travel date) for ${def.label} and upload them.`,
      })
    );

    // -- bookings: combine both reports, one row per booking reference
    const byRef = new Map();
    let mismatch = 0;
    for (const f of bf) {
      for (const b of f.bookings) {
        const old = byRef.get(b.refNum);
        if (!old) byRef.set(b.refNum, b);
        else if (old.status !== b.status || old.netCents !== b.netCents || old.adults !== b.adults || old.seniors !== b.seniors || old.youths !== b.youths || old.children !== b.children) {
          mismatch++;
          exceptions.push({ location: name, ref: b.ref, kind: 'mismatch', detail: `Booking-date and travel-date report disagree (status ${old.status} / ${b.status}, net ${old.netCents / 100} / ${b.netCents / 100})` });
        }
      }
    }
    checks.push(C.result('VS6', name, 'Same booking has the same status, guests and net in both reports', 0, mismatch, { unit: 'count' }));

    // -- payouts up to month-end, per booking reference
    const paidBy = new Map();
    let payoutRows = 0;
    let futureFiles = 0;
    for (const f of pf) {
      if (f.paymentDate && f.paymentDate > end) {
        futureFiles++;
        continue;
      }
      for (const r of f.rows) {
        payoutRows++;
        paidBy.set(r.refNum, (paidBy.get(r.refNum) || 0) + r.cents);
      }
      if (f.declaredCents !== null && f.declaredCents !== undefined) {
        checks.push(
          C.result('VS4', name, `Payout ${f.fileName}: rows add up to TOTAL PAYMENT`, f.declaredCents, f.sumCents, {
            note: f.declaredCents === f.sumCents ? undefined : 'The CONVERTED AMOUNT rows do not add up to the total printed on the advice.',
          })
        );
      }
      for (const p of f.problems || []) exceptions.push({ location: name, ref: '', kind: 'payout', detail: `${f.fileName}: ${p}` });
    }

    // -- price + rules for every booking
    const rows = [];
    let unpriced = 0;
    let unpricedNet = 0;
    let anomalies = 0;
    let priceOff = 0;
    for (const b of [...byRef.values()].sort((x, y) => x.bookingDate.localeCompare(y.bookingDate) || x.ref.localeCompare(y.ref))) {
      const row = lookup(b);
      const g = grossFor(b, row);
      const r = applyRules(b, paidBy.get(b.refNum), g.cents);
      const out = { location: name, ...b, ...r, reportNetCents: b.netCents, listedCommission: row?.commission ?? null, priceReason: g.reason || null };
      if (r.salesCents === null) {
        // No price: left out of Sales / Net / Commission until the sheet has it (check VS2).
        unpriced++;
        unpricedNet += b.netCents;
        out.salesCents = 0;
        out.netCents = 0;
        out.commissionCents = 0;
        exceptions.push({ location: name, ref: b.ref, kind: 'unpriced', detail: `${g.reason} (${b.productCode} ${b.tourGrade}, net ${b.netCents / 100})`, net: b.netCents });
      }
      if (g.cents !== null && g.reason) {
        anomalies++;
        exceptions.push({ location: name, ref: b.ref, kind: 'status', detail: g.reason });
      }
      for (const f of r.flags) {
        anomalies++;
        exceptions.push({ location: name, ref: b.ref, kind: 'status', detail: f });
      }
      // Price check: implied commission % = 1 − Net ÷ Gross.
      if (g.cents > 0 && b.netCents > 0 && ACTIVE.has(b.status) && !(r.hasPayout && r.paidCents === 0)) {
        const implied = 1 - b.netCents / g.cents;
        const listed = row?.commission;
        const near5 = Math.abs(implied * 100 - Math.round((implied * 100) / 5) * 5) <= 0.25;
        const nearListed = listed !== null && listed !== undefined && Math.abs(implied - listed) <= 0.006;
        out.impliedCommission = implied;
        if (!near5 && !nearListed) {
          priceOff++;
          const rate = listed ?? Math.round((implied * 100) / 5) * 0.05;
          exceptions.push({
            location: name,
            ref: b.ref,
            kind: 'price',
            detail: `${b.productCode} ${b.tourGrade}: net ${b.netCents / 100} on gross ${g.cents / 100} is ${(implied * 100).toFixed(1)}% commission — not the listed rate or a round 5% step`,
            impliedGross: rate < 1 ? Math.round(b.netCents / (1 - rate)) : null,
          });
        }
      }
      rows.push(out);
    }
    detail.push(...rows);

    checks.push(
      C.result('VS2', name, 'Every booking found a price in the sheet', 0, unpriced, {
        unit: 'count',
        note: unpriced ? `${unpriced} booking(s) (net ${(unpricedNet / 100).toFixed(2)}) have no price and are NOT in Sales — add the product / tour grade to the price sheet (SOP: use the current equivalent option and note it).` : undefined,
      }),
      C.result('VS3', name, 'Price check: commission % is the listed rate or a round 5% step', 0, priceOff, {
        unit: 'count',
        note: priceOff ? 'Listed on the Exceptions sheet of the workings file with the price the net implies. Do not change figures until confirmed in Viator.' : undefined,
      }),
      C.result('VS7', name, 'No unusual status / payout combinations', 0, anomalies, { unit: 'count', note: anomalies ? 'See the Exceptions sheet.' : undefined })
    );

    // -- month figures (local currency)
    const book = rows.filter((x) => monthOf(x.bookingDate) === month);
    const trav = rows.filter((x) => monthOf(x.travelDate) === month);
    const salesLocal = sum(book, (x) => x.salesCents);
    const netLocal = sum(book, (x) => x.netCents);
    const commissionLocal = salesLocal - netLocal;
    const cashFlowLocal = salesLocal;
    const recognizedLocal = sum(trav, (x) => x.salesCents);
    const deferredLocal = cashFlowLocal - recognizedLocal;

    // -- currency
    let rate = 1;
    if (needsConversion(def.currency)) {
      rate = rmap.get(rateKey(name, def.currency, ''));
      if (!rate) {
        const stored = rates.find((x) => rateKey(x.location, x.currency, x.date) === rateKey(name, def.currency, ''));
        missingRates.add(`${name} · ${def.currency} · monthly average: ${rateProblem(def.currency, stored?.rate)}`);
        rate = 0;
      }
    }
    const usd = (c) => (needsConversion(def.currency) ? convertCents(c, rate) : c);

    const unpaidNet = sum(rows.filter((x) => !x.hasPayout && x.netCents > 0 && x.salesCents > 0), (x) => x.netCents);
    locations.push({
      location: name,
      label: def.label,
      class: klass,
      currency: def.currency,
      rate: needsConversion(def.currency) ? rate : null,
      bookings: book.length,
      travelling: trav.length,
      allBookings: rows.length,
      statuses: countBy(book, (x) => x.status),
      payoutRows,
      salesLocalCents: salesLocal,
      netLocalCents: netLocal,
      commissionLocalCents: commissionLocal,
      commissionPct: salesLocal ? commissionLocal / salesLocal : 0,
      salesCents: usd(salesLocal),
      commissionCents: usd(commissionLocal),
      netCents: usd(netLocal),
      cashFlowLocalCents: cashFlowLocal,
      recognizedLocalCents: recognizedLocal,
      deferredLocalCents: deferredLocal,
      deferredCents: usd(deferredLocal),
      unpaidNetLocalCents: unpaidNet,
      unpriced,
      futurePayoutFiles: futureFiles,
      files: { bookings: bf.map((f) => f.fileName), payouts: pf.map((f) => f.fileName) },
    });

    if (!klass) {
      checks.push(C.result('VS5', name, 'Entity has a QBO class', 'class', 'none', { unit: 'text', pass: false, note: who.reason }));
    }
  }

  if (missingRates.size) {
    const err = new Error(`FX rates needed before the Viator journals can be built (enter them in step 3 and click “Save rates”):\n${[...missingRates].join('\n')}`);
    err.code = 'FX_RATES_MISSING';
    err.details = [...missingRates];
    throw err;
  }

  // -- Sales & commission JE: one line per class (SOP section 4)
  const byClass = new Map();
  for (const l of locations) {
    if (!l.class) continue;
    const c = byClass.get(l.class) || { class: l.class, locations: [], sales: 0, commission: 0, deferred: 0 };
    c.locations.push(l.location);
    c.sales += l.salesCents;
    c.commission += l.commissionCents;
    c.deferred += l.deferredCents;
    byClass.set(l.class, c);
  }
  const sorted = [...byClass.values()].sort((a, b) => a.class.localeCompare(b.class));
  const lines = [];
  const mk = (meta, account, side, amount, description, c, basis) => {
    const { debit, credit } = place(amount, side);
    return { ...meta, account, debit, credit, description, class: c.class, location: c.locations.join(', '), name: '', currency: 'USD', basis, amount };
  };
  for (const c of sorted) {
    if (c.sales !== 0) {
      lines.push(mk(metaVia, ACCOUNTS.viatorClearing, 'debit', c.sales, `Viator sales - ${desc}`, c, 'sales'));
      lines.push(mk(metaVia, ACCOUNTS.viatorRevenue, 'credit', c.sales, `Viator sales - ${desc}`, c, 'sales'));
    }
  }
  for (const c of sorted) {
    if (c.commission !== 0) {
      lines.push(mk(metaVia, ACCOUNTS.viatorCommission, 'debit', c.commission, `Viator commission - ${desc}`, c, 'commission'));
      lines.push(mk(metaVia, ACCOUNTS.viatorClearing, 'credit', c.commission, `Viator commission - ${desc}`, c, 'commission'));
    }
  }
  checks.push(...C.checkBalanced(lines, 'VS8'), ...sorted.map((c) => C.checkClasses(c.class, lines.filter((l) => l.class === c.class), 'VS9')));
  const unpaid = sum(locations, (l) => l.unpaidNetLocalCents);
  checks.push(
    C.result('VS10', 'ALL', '10032 Viator clearing after both lines = net on bookings not yet paid out (information)', unpaid, unpaid, {
      pass: true,
      note: 'Compare with the 10032 Viator Sales balance in QBO after this JE and the month’s payouts.',
    })
  );

  // -- Deferred JE (SOP section 6)
  const defLines = [];
  for (const c of sorted) {
    if (c.deferred === 0) continue;
    defLines.push(mk(metaDef, ACCOUNTS.deferredDebit, 'debit', c.deferred, `Deferred revenue adjustment - Viator - ${desc}`, c, 'deferred'));
    defLines.push(mk(metaDef, ACCOUNTS.deferredCredit, 'credit', c.deferred, `Deferred revenue adjustment - Viator - ${desc}`, c, 'deferred'));
  }
  for (const l of locations) {
    defChecks.push(
      C.result('VD1', l.location, 'Cash Flow − Recognized Earnings = Deferred', l.cashFlowLocalCents - l.recognizedLocalCents, l.deferredLocalCents)
    );
  }
  defChecks.push(
    C.result('VD2', 'ALL', 'Both bases use the same bookings and amounts (checked in the sales JE: VS6)', 0, sum(checks.filter((c) => c.id === 'VS6'), (c) => c.actual), { unit: 'count' }),
    C.result('VD3', 'ALL', 'Roll-forward: opening + Cash Flow − Recognized = closing balance', 'not checked', 'not checked', {
      unit: 'text',
      pass: true,
      note: 'Needs the opening balance and booking / travel reports from 1 Jan. Check 22001 in QBO = Xola deferred (excl. Viator) + Viator deferred.',
    }),
    ...C.checkBalanced(defLines, 'VD4'),
    ...sorted.map((c) => C.checkClasses(c.class, defLines.filter((l) => l.class === c.class), 'VD5'))
  );

  const totals = {
    sales: sum(locations, (l) => l.salesCents),
    commission: sum(locations, (l) => l.commissionCents),
    deferred: sum(locations, (l) => l.deferredCents),
  };
  return {
    via: { ...metaVia, lines, checks, figures: locations, classes: sorted, totals },
    def: { ...metaDef, lines: defLines, checks: defChecks, figures: locations, classes: sorted, totals },
    exceptions,
    detail,
    locations,
  };
}

function countBy(arr, f) {
  const m = {};
  for (const x of arr) m[f(x)] = (m[f(x)] || 0) + 1;
  return m;
}

// FX rows the Viator journals need: London (GBP) at the month's average rate.
export function neededViatorSopRates(accounts) {
  const out = [];
  for (const def of VIATOR_ACCOUNTS) {
    if (!needsConversion(def.currency)) continue;
    const acc = accounts.find((a) => a.id === def.id);
    if (!acc || !(acc.bookingFiles?.length || acc.payoutFiles?.length)) continue;
    out.push({ location: def.location, currency: def.currency, date: '', source: 'viator', label: 'Viator monthly average' });
  }
  return out;
}
