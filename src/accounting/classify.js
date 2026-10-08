import { SOURCES, OPTIONS } from './settings.js';

// Classify one Transactions row by its Source (lower-case, trimmed).
// Returns one of:
//   { action: 'include', group }            -> posts to ACCOUNTS.clearing[group]
//   { action: 'exclude', reason: 'viator' } -> kept for the Viator check
//   { action: 'exclude', reason: 'office' } -> Office bookings list
// Throws `unknown Source: X` for any value not in settings.SOURCES.
export function classifyRow(row) {
  const source = String(row.source ?? '').trim().toLowerCase();
  const rule = Object.prototype.hasOwnProperty.call(SOURCES, source) ? SOURCES[source] : undefined;
  if (!rule) {
    const err = new Error(`unknown Source: ${row.source === '' || row.source == null ? '(blank)' : row.source}`);
    err.code = 'UNKNOWN_SOURCE';
    throw err;
  }
  if (rule.exclude === 'viator' && OPTIONS.viatorInXola) return { action: 'include', group: 'viator' };
  if (rule.exclude) return { action: 'exclude', reason: rule.exclude };
  if (rule.excludeWhenNoPayoutDate) {
    if (row.recognized) {
      // The Recognized Earnings report has no Payout Date. Office bookings paid by
      // card go through Xola (like "office with a Payout Date"); anything else
      // (Method "Other": cash, voucher, imported) is treated as unpaid office.
      if (OPTIONS.recognizedOfficeRule === 'include') return { action: 'include', group: rule.group };
      if (OPTIONS.recognizedOfficeRule === 'exclude') return { action: 'exclude', reason: 'office' };
      return /electronic|credit|card/i.test(row.method || '') ? { action: 'include', group: rule.group } : { action: 'exclude', reason: 'office' };
    }
    if (!String(row.payoutDate ?? '').trim()) return { action: 'exclude', reason: 'office' };
  }
  return { action: 'include', group: rule.group };
}

// Split a seller's rows into included / viator / office. Every unknown Source
// in the seller is collected; if there are any, one error lists them all
// (value, rows, Net) — err.unknown = [{ source, count, net }].
export function splitRows(rows, sellerName = '') {
  const included = [];
  const viator = [];
  const office = [];
  const review = [];
  const unknown = new Map();
  for (const row of rows) {
    let c;
    try {
      c = classifyRow(row);
    } catch (err) {
      if (err.code !== 'UNKNOWN_SOURCE') throw err;
      const key = String(row.source ?? '').trim() || '(blank)';
      const u = unknown.get(key) || { source: key, count: 0, net: 0, seller: sellerName };
      u.count++;
      u.net += row.net || 0;
      unknown.set(key, u);
      continue;
    }
    if (c.action === 'include') included.push({ ...row, group: c.group });
    else if (c.reason === 'viator') viator.push(row);
    else if (c.reason === 'review') review.push(row);
    else office.push(row);
  }
  if (unknown.size) {
    const list = [...unknown.values()];
    const err = new Error(
      `unknown Source: ${list.map((u) => `${u.source} (${u.count} row${u.count === 1 ? '' : 's'})`).join(', ')}${sellerName ? ` (${sellerName})` : ''}`
    );
    err.code = 'UNKNOWN_SOURCE';
    err.unknown = list;
    throw err;
  }
  return { included, viator, office, review };
}
