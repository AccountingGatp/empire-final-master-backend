// "Which reading of SOP 10.5 gives the known Deferred total?" Pure.
//
// SOP 10.5 defines
//   Cash Flow           = Xola Net for every transaction paid in the month
//                         ("the same number as the sales entry's clearing debit")
//   Recognized Earnings = Xola Net for every tour delivered in the month
// but does not say which rows (Viator, office, blank Source) count on the
// Recognized side. The August figure 7,886.66 comes from the "Empire Clearing
// Acc Working" sheet. This module works out the total under every sensible
// reading, so the data — not a guess — shows which one the working sheet used.
//
// Nothing here changes the journal. It is a report shown next to check D5.

import { SOURCES, OPTIONS, KNOWN_DEFERRED_TOTALS, lookupCompany, normName } from './settings.js';
import { convertCents } from './money.js';
import { rateKey, needsConversion } from './fx.js';

// What a row is, independent of the settings switches.
function kind(row, recognizedFile) {
  const source = String(row.source ?? '').trim().toLowerCase();
  const rule = Object.prototype.hasOwnProperty.call(SOURCES, source) ? SOURCES[source] : null;
  if (!rule || rule.exclude === 'review') return 'review'; // tiqets, blank, unknown
  if (rule.exclude === 'viator') return OPTIONS.viatorInXola ? 'normal' : 'viator';
  if (rule.excludeWhenNoPayoutDate) {
    if (recognizedFile) return /electronic|credit|card/i.test(row.method || '') ? 'officeCard' : 'officeOther';
    return String(row.payoutDate ?? '').trim() ? 'officeCard' : 'officeOther';
  }
  return 'normal';
}

// USD for a row. Exact stored rate when there is one; otherwise the nearest
// stored rate for the same location + currency (flagged as approximate).
function makeConverter(rates) {
  const exact = new Map();
  const byLoc = new Map();
  for (const r of rates || []) {
    const n = Number(r.rate);
    if (!Number.isFinite(n) || n <= 0) continue;
    exact.set(rateKey(r.location, r.currency, r.date), n);
    const k = `${normName(r.location)}|${String(r.currency).toUpperCase()}`;
    if (!byLoc.has(k)) byLoc.set(k, []);
    byLoc.get(k).push({ date: r.date || '9999-12-31', rate: n });
  }
  const anyCur = (cur) => (rates || []).find((r) => String(r.currency).toUpperCase() === cur && Number(r.rate) > 0);
  return (location, currency, date, cents) => {
    if (!needsConversion(currency)) return { usd: cents, approx: false };
    const cur = String(currency).toUpperCase();
    const e = exact.get(rateKey(location, cur, date));
    if (e) return { usd: convertCents(cents, e), approx: false };
    const list = byLoc.get(`${normName(location)}|${cur}`);
    if (list?.length) {
      const target = date || '9999-12-31';
      const best = list.reduce((a, b) => (Math.abs(Date.parse(b.date) - Date.parse(target)) < Math.abs(Date.parse(a.date) - Date.parse(target)) ? b : a));
      return { usd: convertCents(cents, best.rate), approx: true };
    }
    const any = anyCur(cur);
    if (any) return { usd: convertCents(cents, Number(any.rate)), approx: true };
    return { usd: null, approx: true };
  };
}

// Sum a file's rows by kind, in USD.
function totalsByKind(file, recognizedFile, convert) {
  const t = { normal: 0, viator: 0, officeCard: 0, officeOther: 0, review: 0, approxRows: 0, missingRows: 0, currency: 'USD' };
  for (const r of file.rows || []) {
    if (needsConversion(r.currency)) t.currency = r.currency;
    const c = convert(file.sellerName, r.currency, r.payoutDate, r.net);
    if (c.usd === null) {
      t.missingRows++;
      continue;
    }
    if (c.approx) t.approxRows++;
    t[kind(r, recognizedFile)] += c.usd;
  }
  return t;
}

const CASH_FLOW = [
  { id: 'A', label: 'clearing debit (no Viator, no unpaid office, no blank Source)', pick: (t) => t.normal + t.officeCard },
  { id: 'B', label: 'clearing debit + Viator', pick: (t) => t.normal + t.officeCard + t.viator },
  { id: 'C', label: 'every row', pick: (t) => t.normal + t.officeCard + t.officeOther + t.viator + t.review },
];

const RECOGNIZED = [
  { id: '1', label: 'all office, no Viator', pick: (t) => t.normal + t.officeCard + t.officeOther },
  { id: '2', label: 'office by Method (card only), no Viator', pick: (t) => t.normal + t.officeCard },
  { id: '3', label: 'no office, no Viator', pick: (t) => t.normal },
  { id: '4', label: 'all office + Viator', pick: (t) => t.normal + t.officeCard + t.officeOther + t.viator },
  { id: '5', label: 'office by Method + Viator', pick: (t) => t.normal + t.officeCard + t.viator },
  { id: '6', label: 'every row', pick: (t) => t.normal + t.officeCard + t.officeOther + t.viator + t.review },
  { id: '7', label: 'the Summary sheet Net', pick: (t, s) => s },
];

/**
 * @param month      'YYYY-MM'
 * @param cashFlow   [{ sellerName, rows, error }]   parsed Cash Flow files
 * @param earnings   [{ sellerName, rows, summary, error }] parsed Recognized files
 * @param rates      the run's FX table
 * @returns null when the month has no known total; otherwise
 *   { knownCents, current, variants: [{ id, cashFlow, recognized, scope, totalCents, diffCents, approx }], perLocation }
 */
export function testDeferredRules({ month, cashFlow = [], earnings = [], rates = [], options = OPTIONS }) {
  const knownCents = KNOWN_DEFERRED_TOTALS[month];
  if (knownCents === undefined) return null;
  const convert = makeConverter(rates);

  const cf = new Map();
  for (const f of cashFlow) if (!f.error) cf.set(normName(f.sellerName), { name: f.sellerName, t: totalsByKind(f, false, convert) });
  const re = new Map();
  for (const f of earnings) {
    if (f.error) continue;
    const t = totalsByKind(f, true, convert);
    // Summary Net in USD: converted like the rows (Recognized rows have no payout date).
    let summaryUsd = null;
    const sNet = f.summary && !f.summary.error ? f.summary.net : null;
    if (sNet !== null && sNet !== undefined) {
      const c = convert(f.sellerName, t.currency, '', sNet);
      summaryUsd = c.usd;
      if (c.approx && needsConversion(t.currency)) t.approxRows++;
    }
    re.set(normName(f.sellerName), { name: f.sellerName, t, summaryUsd });
  }

  const names = new Map();
  for (const [k, v] of [...cf, ...re]) names.set(k, v.name);

  const scopes = [
    { id: 'sop', label: 'SOP companies', test: (n) => lookupCompany(n, options).status === 'post' },
    { id: 'discount', label: 'SOP companies + Chicago Discount', test: (n) => lookupCompany(n, { ...options, includeChicagoDiscount: true }).status === 'post' },
  ];
  const zero = { normal: 0, viator: 0, officeCard: 0, officeOther: 0, review: 0, approxRows: 0, missingRows: 0 };

  const variants = [];
  const perLocation = {};
  for (const scope of scopes) {
    const locs = [...names].filter(([, n]) => scope.test(n));
    for (const c of CASH_FLOW) {
      for (const r of RECOGNIZED) {
        let total = 0;
        let approx = 0;
        const rows = [];
        for (const [k, n] of locs) {
          const ct = cf.get(k)?.t || zero;
          const rt = re.get(k)?.t || zero;
          const rs = re.get(k)?.summaryUsd ?? 0;
          const cash = c.pick(ct);
          const rec = r.pick(rt, rs);
          total += cash - rec;
          approx += ct.approxRows + rt.approxRows + ct.missingRows + rt.missingRows;
          rows.push({ location: n, cashFlowCents: cash, recognizedCents: rec, deferredCents: cash - rec });
        }
        const id = `${c.id}${r.id}${scope.id === 'discount' ? '+CD' : ''}`;
        variants.push({
          id,
          cashFlow: c.label,
          recognized: r.label,
          scope: scope.label,
          totalCents: total,
          diffCents: total - knownCents,
          approxRows: approx,
        });
        perLocation[id] = rows;
      }
    }
  }
  variants.sort((a, b) => Math.abs(a.diffCents) - Math.abs(b.diffCents));

  const officeId = { include: '1', byMethod: '2', exclude: '3' }[options.recognizedOfficeRule] || '2';
  const current = `A${officeId}${options.includeChicagoDiscount ? '+CD' : ''}`;
  const best = variants[0];
  return {
    knownCents,
    current,
    variants: variants.slice(0, 12),
    best: best ? { ...best, locations: perLocation[best.id] } : null,
    currentResult: variants.find((v) => v.id === current) || null,
  };
}
