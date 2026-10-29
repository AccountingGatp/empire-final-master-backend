import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountFromName,
  fileKind,
  applyRules,
  grossFor,
  makePriceLookup,
  parsePriceSheet,
  parseBookingsCsv,
  buildViatorSop,
  neededViatorSopRates,
} from '../src/accounting/viatorSop.js';

const bk = (o = {}) => ({
  ref: 'BR-100', refNum: '100', bookingDate: '2026-10-05', travelDate: '2026-10-20', status: 'confirmed',
  netCents: 6000, currency: 'USD', adults: 2, seniors: 0, youths: 0, children: 0, infants: 0,
  productCode: 'P1', productName: 'Tour', tourGrade: 'TG1', source: '', ...o,
});
const prices = [{ productCode: 'P1', tourGrade: 'TG1', adult: 5000, senior: 4500, youth: 4000, child: 3000, booking: null, commission: 0.4, effective: '' }];
const rates = [{ location: 'London Sightseeing Tours', currency: 'GBP', date: '', rate: 1.3 }];

test('files are matched to the six accounts and typed', () => {
  assert.equal(accountFromName('x/VI0000005669845_USD_20261007_USD_SUP_BNK.xlsx').id, '5669845');
  assert.equal(accountFromName('bookings-report-5669869-20261028.csv').id, '5669869');
  assert.equal(accountFromName('bookings-report-1111111-20261028.csv'), null);
  assert.equal(fileKind('VI0000005669845_USD_1.xlsx'), 'payout');
  assert.equal(fileKind('bookings-report-5669845-1.csv'), 'bookings');
  assert.equal(fileKind('notes.txt'), null);
});

test('gross = guests x price per type; infants are free; missing product is flagged', () => {
  assert.equal(grossFor(bk({ adults: 2, children: 1, infants: 3 }), prices[0]).cents, 13000);
  assert.equal(grossFor(bk(), null).cents, null);
  assert.equal(grossFor(bk({ youths: 1 }), { ...prices[0], youth: null }).cents, null);
});

test('price lookup uses the latest effective row on or before the booking date', () => {
  const rows = [
    { ...prices[0], effective: '2026-01-01', adult: 4000 },
    { ...prices[0], effective: '2026-09-01', adult: 5000 },
    { ...prices[0], effective: '2026-11-01', adult: 9000 },
  ];
  assert.equal(makePriceLookup(rows)(bk()).adult, 5000);
  assert.equal(makePriceLookup(rows)(bk({ productCode: '5669845P1' })).adult, 5000); // account prefix ignored
});

test('status / payout rules', () => {
  const g = 10000;
  assert.deepEqual(pick(applyRules(bk(), undefined, g)), [10000, 6000, 4000]); // not in payout: gross, report net
  assert.deepEqual(pick(applyRules(bk(), 6000, g)), [10000, 6000, 4000]); // paid in full
  assert.deepEqual(pick(applyRules(bk(), 0, g)), [0, 0, 0]); // reversed
  assert.deepEqual(pick(applyRules(bk(), 3000, g)), [5000, 3000, 2000]); // partly paid: gross x paid / net
  assert.deepEqual(pick(applyRules(bk({ status: 'cancelled' }), undefined, g)), [0, 0, 0]);
  assert.deepEqual(pick(applyRules(bk({ status: 'cancelled' }), 6000, g)), [10000, 6000, 4000]); // cancelled but paid
});
const pick = (r) => [r.salesCents, r.netCents, r.commissionCents];

test('price sheet CSV: percent commission and header aliases', () => {
  const csv = 'Product Code,Tour Grade,Adult,Senior,Youth,Child,Commission,Effective Date\nP1,TG1,50,45,40,30,40,2026-01-01\n';
  const { rows } = parsePriceSheet(Buffer.from(csv), 'p.csv');
  assert.equal(rows[0].adult, 5000);
  assert.equal(rows[0].commission, 0.4);
  assert.throws(() => parsePriceSheet(Buffer.from('a,b\n1,2\n'), 'x.csv'), /price columns/);
});

test('bookings CSV keeps no customer details', () => {
  const csv = [
    'Booking Reference,Booking Date,Net Price,Currency,Status,Travel Date,Lead traveler Name,Lead traveler Contact Info,Adults,Seniors,Youths,Children,Infants,Product Code,Product Name,Tour Grade Code,Booking Source',
    'BR-1,"Oct 2, 2026",60.00,USD,Confirmed,"Oct 9, 2026",Jane Doe,jane@example.com,2,0,0,0,0,P1,Tour,TG1,Web',
  ].join('\n');
  const r = parseBookingsCsv(Buffer.from(csv), 'bookings-report-5669845-1.csv');
  assert.equal(r.bookings.length, 1);
  assert.doesNotMatch(JSON.stringify(r), /Jane|jane@/);
});

const account = (id, bookings, payouts = []) => ({
  id,
  bookingFiles: [
    { fileName: 'b.csv', basis: 'booking', month: '2026-10', bookings: bookings.filter((b) => b.bookingDate.startsWith('2026-10')), warnings: [] },
    { fileName: 't.csv', basis: 'travel', month: '2026-10', bookings: bookings.filter((b) => b.travelDate.startsWith('2026-10')), warnings: [] },
  ],
  payoutFiles: payouts,
});

test('month build: sales + commission journal balances; deferred = booked - travelled', () => {
  const list = [
    bk(), // booked + travels in Oct
    bk({ ref: 'BR-101', refNum: '101', travelDate: '2026-11-15' }), // booked Oct, travels Nov -> deferred
    bk({ ref: 'BR-102', refNum: '102', bookingDate: '2026-09-20', travelDate: '2026-10-03' }), // booked Sep, travels Oct -> released
  ];
  const out = buildViatorSop({ month: '2026-10', accounts: [account('5669845', list)], prices, rates });
  const debit = out.via.lines.reduce((s, l) => s + l.debit, 0);
  const credit = out.via.lines.reduce((s, l) => s + l.credit, 0);
  assert.equal(debit, credit);
  assert.ok(out.via.lines.every((l) => l.currency));
  // two Oct-booked bookings x $100 gross
  const sales = out.via.lines.filter((l) => l.account.startsWith('10032') && l.debit).reduce((s, l) => s + l.debit, 0);
  assert.equal(sales, 20000);
  const defDebit = out.def.lines.reduce((s, l) => s + l.debit, 0);
  assert.equal(defDebit, out.def.lines.reduce((s, l) => s + l.credit, 0));
  const loc = out.locations.find((l) => l.label.includes('Chicago G'));
  assert.equal(loc.cashFlowLocalCents, 20000); // booked in Oct
  assert.equal(loc.recognizedLocalCents, 20000); // travelled in Oct (BR-100 + BR-102)
  assert.equal(loc.deferredLocalCents, 0);
  assert.equal(loc.cashFlowLocalCents - loc.recognizedLocalCents, loc.deferredLocalCents);
});

test('no price sheet stops the build; London needs its monthly rate', () => {
  assert.throws(() => buildViatorSop({ month: '2026-10', accounts: [], prices: [] }), (e) => e.code === 'NO_PRICES');
  const need = neededViatorSopRates([account('5669869', [bk({ currency: 'GBP' })])]);
  assert.ok(need.some((r) => r.currency === 'GBP' && r.date === ''));
  const london = account('5669869', [bk({ currency: 'GBP' })]);
  assert.throws(() => buildViatorSop({ month: '2026-10', accounts: [london], prices, rates: [] }), (e) => e.code === 'FX_RATES_MISSING');
});

test('a product missing from the price sheet is left out and raises a check', () => {
  const out = buildViatorSop({ month: '2026-10', accounts: [account('5669845', [bk({ productCode: 'NOPE' })])], prices, rates });
  assert.ok(out.exceptions.some((e) => e.kind === 'unpriced'));
  assert.ok([...out.via.checks].some((c) => !c.pass));
});

test('group-size (private) prices: every guest pays the price for the size of the party', () => {
  const csv = 'Product Code,Tour Grade Code,Adult,Senior,Youth,Child,Group size prices - adult,Commission %,Effective Date\nP9,TG2,,,,,1:399|2:249|3:199,30,2026-10-13\n';
  const { rows } = parsePriceSheet(Buffer.from(csv), 'p.csv');
  assert.deepEqual(rows[0].tiers.adult, [39900, 24900, 19900]);
  const b = (o) => bk({ productCode: 'P9', tourGrade: 'TG2', ...o });
  assert.equal(grossFor(b({ adults: 2 }), rows[0]).cents, 2 * 24900);
  assert.equal(grossFor(b({ adults: 2, seniors: 1 }), rows[0]).cents, 3 * 19900);
  assert.ok(grossFor(b({ adults: 5 }), rows[0]).reason); // bigger than the listed sizes
});

test('the built-in price sheet reads and every product has a commission and a date', async () => {
  const { default: fs } = await import('fs');
  const d = JSON.parse(fs.readFileSync(new URL('../src/data/viatorPrices.default.json', import.meta.url), 'utf8'));
  assert.ok(d.rows.length > 40);
  assert.ok(d.rows.every((r) => r.productCode && r.commission > 0 && r.effective));
});
