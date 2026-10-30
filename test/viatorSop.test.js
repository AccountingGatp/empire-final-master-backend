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
const mkRow = (o) => ({ account: '5669845', tour: 'Tour', option: 'Opt', tg: 'TG1', start: '2026-01-01', end: '', days: [], gmin: null, gmax: null, commission: 0.4, ...o });
const prices = [
  mkRow({ type: 'adult', cents: 5000 }),
  mkRow({ type: 'senior', cents: 4500 }),
  mkRow({ type: 'youth', cents: 4000 }),
  mkRow({ type: 'child', cents: 3000 }),
];
const quoteFor = (rows, b = bk(), acc = '5669845') => makePriceLookup(rows)(b, acc);
const rates = [{ location: 'London Sightseeing Tours', currency: 'GBP', date: '', rate: 1.3 }];

test('files are matched to the six accounts and typed', () => {
  assert.equal(accountFromName('x/VI0000005669845_USD_20261007_USD_SUP_BNK.xlsx').id, '5669845');
  assert.equal(accountFromName('bookings-report-5669869-20261028.csv').id, '5669869');
  assert.equal(accountFromName('bookings-report-1111111-20261028.csv'), null);
  assert.equal(fileKind('VI0000005669845_USD_1.xlsx'), 'payout');
  assert.equal(fileKind('bookings-report-5669845-1.csv'), 'bookings');
  assert.equal(fileKind('notes.txt'), null);
});

test('gross = guests x price per type; infants are free; missing price type = 0', () => {
  const q = quoteFor(prices);
  assert.equal(grossFor(bk({ adults: 2, children: 1, infants: 3 }), q).cents, 13000);
  assert.equal(grossFor(bk({ adults: 1, youths: 1 }), quoteFor(prices.filter((r) => r.type !== 'youth'))).cents, 5000); // no Youth row -> 0
  assert.equal(grossFor(bk(), null).cents, null);
});

test('price lookup: tour name, then product code, then option title; dates must cover the booking', () => {
  const rows = [mkRow({ type: 'adult', cents: 4000, start: '2026-01-01', end: '2026-08-31' }), mkRow({ type: 'adult', cents: 5000, start: '2026-09-01' })];
  const look = makePriceLookup(rows);
  assert.equal(look(bk({ bookingDate: '2026-07-01' }), '5669845').rows[0].cents, 4000);
  assert.equal(look(bk({ bookingDate: '2026-10-01' }), '5669845').rows[0].cents, 5000);
  assert.equal(look(bk({ bookingDate: '2025-12-01' }), '5669845').fallback, true); // before every period: nearest used
  assert.equal(look(bk(), '5538'), null); // another location's tab
  // product name in another language: the product code identifies the tour
  const foreign = bk({ productName: 'Visite guidée', ref: 'BR-2', refNum: '2' });
  const codeMap = look.codeMapFor('5669845', [bk(), foreign]);
  assert.equal(look(foreign, '5669845', codeMap).tour, 'Tour');
  // report names the tour differently: the option title (TG + title without the time) finds it
  const odd = bk({ productName: 'Renamed', productCode: 'PX', tourGradeTitle: 'Opt 18:00' });
  assert.equal(look(odd, '5669845').tour, 'Tour');
});

test('status / payout rules', () => {
  const g = 10000;
  assert.deepEqual(pick(applyRules(bk(), undefined, g)), [10000, 6000, 4000]); // not in payout: gross, report net
  assert.deepEqual(pick(applyRules(bk(), 6000, g)), [10000, 6000, 4000]); // paid in full
  assert.deepEqual(pick(applyRules(bk(), 0, g)), [0, 0, 0]); // reversed
  assert.deepEqual(pick(applyRules(bk(), 3000, g)), [5000, 3000, 2000]); // partly paid: gross x paid / net
  assert.deepEqual(pick(applyRules(bk({ status: 'cancelled', netCents: 0 }), undefined, g)), [0, 0, 0]); // Net 0, not paid
  assert.deepEqual(pick(applyRules(bk({ status: 'cancelled' }), undefined, g)), [10000, 6000, 4000]); // Net above 0, not yet paid out
  assert.deepEqual(pick(applyRules(bk({ status: 'cancelled' }), 6000, g)), [10000, 6000, 4000]); // cancelled but paid
});
const pick = (r) => [r.salesCents, r.netCents, r.commissionCents];

test('price list workbook: one tab per location, group sizes, open end date', async () => {
  const XLSX = (await import('xlsx')).default;
  const head = ['Tour', 'Option', 'Option code', 'Start date', 'End date', 'Days', 'Price type', 'Group size (travelers)', 'Retail price', 'Commission rate'];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ['Tour', 'Opt', 'TG2', 'Oct 13, 2026', 'No end date', 'Sun, Mon', 'Adult', '1', 399, 0.3], ['Tour', 'Opt', 'TG2', 'Oct 13, 2026', 'No end date', 'Sun, Mon', 'Adult', '0-2', 249, 0.3], ['Tour', 'Opt', 'TG2', 'Oct 13, 2026', 'No end date', 'Tue', 'No prices added', '', '', '']]), 'Charleston');
  const { rows } = parsePriceSheet(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'l.xlsx');
  assert.equal(rows.length, 2); // "No prices added" is not a price
  assert.equal(rows[0].account, '5669891');
  assert.equal(rows[0].end, '');
  assert.deepEqual([rows[1].gmin, rows[1].gmax, rows[1].cents], [0, 2, 24900]);
  assert.throws(() => parsePriceSheet(Buffer.from('a,b\n1,2\n'), 'x.csv'), /price list/);
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
  const out = buildViatorSop({ month: '2026-10', accounts: [account('5669845', [bk({ productName: 'Unknown tour', productCode: 'NOPE' })])], prices, rates });
  assert.ok(out.exceptions.some((e) => e.kind === 'unpriced'));
  assert.ok([...out.via.checks].some((c) => !c.pass));
});

test('group-size (private) prices: the row for the size of the party is used', () => {
  const tier = (n, cents) => mkRow({ tg: 'TG2', type: 'adult', gmin: n, gmax: n, cents });
  const q = (o) => quoteFor([tier(1, 39900), tier(2, 24900), tier(3, 19900)], bk({ tourGrade: 'TG2~11:00', ...o }));
  assert.equal(grossFor(bk({ adults: 2 }), q({ adults: 2 })).cents, 2 * 24900);
  assert.equal(grossFor(bk({ adults: 3 }), q({ adults: 3 })).cents, 3 * 19900);
  assert.ok(grossFor(bk({ adults: 5 }), q({ adults: 5 })).reason); // bigger than the listed sizes
  const veh = quoteFor([mkRow({ type: 'vehicle', cents: 99900 })]);
  assert.equal(grossFor(bk({ adults: 7 }), veh).cents, 99900); // per booking, not per guest
});

test('the built-in Viator Product Commission List reads and every product has a commission and a date', async () => {
  const { default: fs } = await import('fs');
  const d = JSON.parse(fs.readFileSync(new URL('../src/data/viatorPrices.default.json', import.meta.url), 'utf8'));
  assert.ok(d.rows.length > 40);
  assert.ok(d.rows.every((r) => r.account && r.tour && r.tg && r.type && r.cents >= 0));
});
