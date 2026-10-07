import config from '../config.js';

// SUGGESTED FX rates from the European Central Bank (via frankfurter.dev — free,
// no key). These are MARKET rates, not the banked Wise rate the SOP requires, so
// they are only ever offered as suggestions in step 3: nothing is saved until the
// user checks them against the Wise deposit (10033 GBP / 10036 EUR) and clicks
// Save. Saved rates keep origin "ecb" so the CHECKS file shows where they came from.

export const SUGGESTION_SOURCE = 'ECB market rate (frankfurter.dev)';

const shift = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// Daily USD rates for one currency between two dates: [[date, rate], ...] sorted.
async function fetchSeries(currency, from, to) {
  const url = `${config.frankfurterBase}/${shift(from, -7)}..${to}?base=${encodeURIComponent(currency)}&symbols=USD`;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`could not reach frankfurter.dev (${err.message})`);
  }
  if (!res.ok) throw new Error(`frankfurter.dev answered ${res.status} for ${currency}`);
  const data = await res.json();
  return Object.entries(data?.rates || {})
    .map(([date, r]) => [date, Number(r?.USD)])
    .filter(([, r]) => Number.isFinite(r))
    .sort((a, b) => a[0].localeCompare(b[0]));
}

// The ECB publishes on business days only: use the latest rate on or before the date.
function rateOnOrBefore(series, date) {
  let hit = null;
  for (const [d, r] of series) {
    if (d <= date) hit = { date: d, rate: r };
    else break;
  }
  return hit;
}

/**
 * Suggestions for the run's rate table.
 * Rows with no payout date use the last day of the month.
 * @returns {Promise<{ suggestions: Array<{location,currency,date,rate,rateDate}>, problems: string[] }>}
 */
export async function suggestRates(run) {
  const rows = (run.fxRates || []).map((r) => (r.toObject ? r.toObject() : r));
  const byCurrency = new Map();
  for (const r of rows) {
    const date = r.date || run.to;
    if (!byCurrency.has(r.currency)) byCurrency.set(r.currency, []);
    byCurrency.get(r.currency).push({ ...r, lookup: date });
  }

  const suggestions = [];
  const problems = [];
  for (const [currency, list] of byCurrency) {
    const dates = list.map((r) => r.lookup).sort();
    let series;
    try {
      series = await fetchSeries(currency, dates[0], dates[dates.length - 1]);
    } catch (err) {
      problems.push(`${currency}: ${err.message}`);
      continue;
    }
    for (const r of list) {
      const hit = rateOnOrBefore(series, r.lookup);
      if (!hit) {
        problems.push(`${r.location} · ${currency} · ${r.date || 'no payout date'}: no ECB rate on or before ${r.lookup}`);
        continue;
      }
      suggestions.push({
        location: r.location,
        currency,
        date: r.date || '',
        rate: Number(hit.rate.toFixed(4)),
        rateDate: hit.date,
      });
    }
  }
  return { suggestions, problems, source: SUGGESTION_SOURCE };
}
