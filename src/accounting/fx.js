import { FX_LIMITS, normName } from './settings.js';

// FX: the SOP requires the BANKED rate (Wise GBP 10033 / Wise EUR 10036 deposit
// in QBO) for each payout date. The user enters them; nothing is fetched.
// A rate is USD per 1 unit of the currency.

export const rateKey = (location, currency, date) =>
  `${normName(location)}|${String(currency).toUpperCase()}|${date || ''}`;

export function needsConversion(currency) {
  return String(currency || 'USD').toUpperCase() !== 'USD';
}

// Validate one rate against the SOP limits. Returns null when fine, else a message.
export function rateProblem(currency, rate) {
  const cur = String(currency || '').toUpperCase();
  const lim = FX_LIMITS[cur];
  if (!lim) return `no FX limits configured for ${cur} — add it to FX_LIMITS in settings.js`;
  const n = Number(rate);
  if (rate === null || rate === undefined || rate === '' || !Number.isFinite(n)) {
    return `${cur} rate is not filled in`;
  }
  if (n < lim.min || n > lim.max) {
    return `${cur} rate ${n} is outside the allowed range ${lim.min}–${lim.max}`;
  }
  return null;
}

// Map of key -> rate for fast lookup (only valid rates).
export function rateMap(rates = []) {
  const m = new Map();
  for (const r of rates) {
    if (!rateProblem(r.currency, r.rate)) m.set(rateKey(r.location, r.currency, r.date), Number(r.rate));
  }
  return m;
}

// Merge freshly-needed rate rows into the stored table, keeping entered rates.
// `needed` = [{ location, currency, date, source }]
export function mergeRateTable(stored = [], needed = []) {
  const byKey = new Map(stored.map((r) => [rateKey(r.location, r.currency, r.date), r]));
  const out = [];
  const seen = new Set();
  for (const n of needed) {
    const k = rateKey(n.location, n.currency, n.date);
    if (seen.has(k)) {
      const existing = out.find((r) => rateKey(r.location, r.currency, r.date) === k);
      if (existing && n.source && !existing.sources.includes(n.source)) existing.sources.push(n.source);
      continue;
    }
    seen.add(k);
    const prev = byKey.get(k);
    out.push({
      location: n.location,
      currency: String(n.currency).toUpperCase(),
      date: n.date || '',
      label: n.label || '',
      rate: prev?.rate ?? null,
      enteredBy: prev?.enteredBy ?? null,
      enteredAt: prev?.enteredAt ?? null,
      sources: n.source ? [n.source] : [],
    });
  }
  // The table reflects exactly what the current files need. Sort for a stable UI.
  out.sort(
    (a, b) =>
      a.location.localeCompare(b.location) ||
      a.currency.localeCompare(b.currency) ||
      String(a.date).localeCompare(String(b.date))
  );
  return out;
}

// Every rate row that is missing or out of limits, as readable messages.
export function rateTableProblems(table = []) {
  return table
    .map((r) => {
      const p = rateProblem(r.currency, r.rate);
      return p ? `${r.location} · ${r.currency} · ${r.date || 'no payout date'}: ${p}` : null;
    })
    .filter(Boolean);
}
