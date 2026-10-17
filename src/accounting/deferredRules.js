// FX helper for the deferred journal. Pure.
// (This file used to hold a "which rule gives the known total" test; that was
// removed — the app has no hard-coded month figures.)

import { normName } from './settings.js';
import { convertCents } from './money.js';
import { rateKey, needsConversion } from './fx.js';

// USD for a row. Exact stored rate when there is one; otherwise the nearest
// stored rate for the same location + currency (flagged as approximate).
export function makeConverter(rates) {
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
