import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Required settings so config.js loads; frankfurter is a local fake.
Object.assign(process.env, {
  MONGODB_URI: 'mongodb://x', XOLA_API_KEY: 'x', GOOGLE_CLIENT_ID: 'x', JWT_SECRET: 'x',
  B2_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com', B2_BUCKET: 'b', B2_KEY_ID: 'k', B2_APP_KEY: 'a',
  FRANKFURTER_BASE: 'http://127.0.0.1:4655/v1',
});

test('ECB suggestions: rate on or before each payout date; blank date uses month end', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    const base = new URL(req.url, 'http://x').searchParams.get('base');
    const rates = base === 'GBP'
      ? { '2026-08-07': { USD: 1.3401 }, '2026-08-10': { USD: 1.3456 }, '2026-08-31': { USD: 1.35 } }
      : { '2026-08-28': { USD: 1.1702 } };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ base, rates }));
  }).listen(4655);
  const { suggestRates } = await import('../src/services/fxRates.js');
  const run = {
    to: '2026-08-31',
    fxRates: [
      { location: 'London Sightseeing Tours', currency: 'GBP', date: '2026-08-09' }, // Sunday -> Friday 8/7
      { location: 'London Sightseeing Tours', currency: 'GBP', date: '2026-08-10' },
      { location: 'London Sightseeing Tours', currency: 'GBP', date: '' }, // month end
      { location: 'Paris Tours', currency: 'EUR', date: '2026-08-30' },
    ],
  };
  const { suggestions, problems } = await suggestRates(run);
  srv.close();
  assert.deepEqual(problems, []);
  const get = (loc, d) => suggestions.find((s) => s.location === loc && s.date === d);
  assert.deepEqual([get('London Sightseeing Tours', '2026-08-09').rate, get('London Sightseeing Tours', '2026-08-09').rateDate], [1.3401, '2026-08-07']);
  assert.equal(get('London Sightseeing Tours', '2026-08-10').rate, 1.3456);
  assert.equal(get('London Sightseeing Tours', '').rate, 1.35);
  assert.equal(get('Paris Tours', '2026-08-30').rate, 1.1702);
  assert.equal(seen.length, 2); // one request per currency
});
