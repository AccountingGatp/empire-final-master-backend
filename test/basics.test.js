import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRow, splitRows } from '../src/accounting/classify.js';
import { place, toCents, normDate, monthMeta, previousMonth, convertCents } from '../src/accounting/money.js';
import { rateProblem, mergeRateTable, rateMap, rateKey } from '../src/accounting/fx.js';
import { lookupCompany, nameFor, OPTIONS, ACCOUNTS } from '../src/accounting/settings.js';

// ---- Source classification ------------------------------------------------------
test('Source: checkout / refund / office-with-payout go to Xola clearing', () => {
  assert.deepEqual(classifyRow({ source: 'checkout' }), { action: 'include', group: 'xola' });
  assert.deepEqual(classifyRow({ source: ' Refund ' }), { action: 'include', group: 'xola' });
  assert.deepEqual(classifyRow({ source: 'office', payoutDate: '2026-08-10' }), { action: 'include', group: 'xola' });
});

test('Source: office with blank Payout Date is excluded to the office list', () => {
  assert.deepEqual(classifyRow({ source: 'office', payoutDate: '' }), { action: 'exclude', reason: 'office' });
  assert.deepEqual(classifyRow({ source: 'OFFICE' }), { action: 'exclude', reason: 'office' });
});

test('Source: GYG / Airbnb / Groupon go to their own clearing accounts', () => {
  assert.equal(classifyRow({ source: 'Get Your Guide' }).group, 'gyg');
  assert.equal(classifyRow({ source: 'airbnb' }).group, 'airbnb');
  assert.equal(classifyRow({ source: 'groupon' }).group, 'groupon');
});

test('Source: viator is excluded', () => {
  assert.deepEqual(classifyRow({ source: 'viator' }), { action: 'exclude', reason: 'viator' });
});

test('Source: any other value stops the build with "unknown Source: X"', () => {
  assert.throws(() => classifyRow({ source: 'expedia' }), /unknown Source: expedia/);
  assert.deepEqual(classifyRow({ source: '' }), { action: 'exclude', reason: 'review' }); // decided in settings
  assert.deepEqual(classifyRow({ source: 'Tiqets' }), { action: 'exclude', reason: 'review' });
  assert.throws(() => classifyRow({ source: 'constructor' }), /unknown Source: constructor/);
  assert.throws(
    () => splitRows([{ source: 'klook', net: 100 }, { source: 'expedia', net: 50 }, { source: 'klook', net: 5 }], 'Paris Tours'),
    /unknown Source: klook \(2 rows\), expedia \(1 row\) \(Paris Tours\)/
  );
});

// ---- Sign rule ----------------------------------------------------------------------
test('place(): positive amount goes to its natural side', () => {
  assert.deepEqual(place(1000, 'debit'), { debit: 1000, credit: 0 });
  assert.deepEqual(place(1000, 'credit'), { debit: 0, credit: 1000 });
});

test('place(): negative amount goes positive in the opposite column', () => {
  assert.deepEqual(place(-250, 'debit'), { debit: 0, credit: 250 });
  assert.deepEqual(place(-250, 'credit'), { debit: 250, credit: 0 });
});

test('money helpers: cents, dates, months', () => {
  assert.equal(toCents('1,234.56'), 123456);
  assert.equal(toCents('(12.50)'), -1250);
  assert.equal(toCents(1.15), 115);
  assert.equal(toCents(''), 0);
  assert.equal(normDate('08/10/2026'), '2026-08-10');
  assert.equal(normDate('Aug 10, 2026'), '2026-08-10');
  assert.equal(normDate(46244), '2026-08-10'); // Excel serial
  assert.equal(normDate(''), '');
  // Xola's own formats
  assert.equal(normDate('09-Sep-2026'), '2026-09-09');
  assert.equal(normDate('2026-08-28 00:32:57'), '2026-08-28');
  assert.equal(normDate('8/1/26'), '2026-08-01');
  assert.equal(monthMeta('2026-02').journalDate, '2/28/2026');
  assert.equal(monthMeta('2026-08').to, '2026-08-31');
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(convertCents(10000, 1.3456), 13456);
});

// ---- FX limits --------------------------------------------------------------------------
test('FX: GBP 1.25–1.45 and EUR 1.05–1.25 accepted at the limits', () => {
  assert.equal(rateProblem('GBP', 1.25), null);
  assert.equal(rateProblem('GBP', 1.45), null);
  assert.equal(rateProblem('EUR', 1.05), null);
  assert.equal(rateProblem('EUR', '1.25'), null);
});

test('FX: out-of-limit, blank or unknown-currency rates are rejected', () => {
  assert.match(rateProblem('GBP', 1.24), /outside the allowed range 1.25–1.45/);
  assert.match(rateProblem('EUR', 1.3), /outside/);
  assert.match(rateProblem('GBP', ''), /not filled in/);
  assert.match(rateProblem('GBP', null), /not filled in/);
  assert.match(rateProblem('CAD', 0.73), /no FX limits configured for CAD/);
});

test('FX: rate table merge keeps entered rates and only valid ones are used', () => {
  const stored = [{ location: 'London Sightseeing Tours', currency: 'GBP', date: '2026-08-10', rate: 1.33, enteredBy: 'a@x' }];
  const needed = [
    { location: 'London Sightseeing Tours', currency: 'GBP', date: '2026-08-10', source: 'xola' },
    { location: 'London Sightseeing Tours', currency: 'GBP', date: '2026-08-10', source: 'earnings' },
    { location: 'Paris Tours', currency: 'EUR', date: '', source: 'xola' },
  ];
  const table = mergeRateTable(stored, needed);
  assert.equal(table.length, 2);
  assert.equal(table[0].rate, 1.33);
  assert.deepEqual(table[0].sources, ['xola', 'earnings']);
  assert.equal(table[1].rate, null);
  const m = rateMap([...table, { location: 'Paris Tours', currency: 'EUR', date: 'x', rate: 2 }]);
  assert.equal(m.get(rateKey('London Sightseeing Tours', 'GBP', '2026-08-10')), 1.33);
  assert.equal(m.has(rateKey('Paris Tours', 'EUR', 'x')), false); // out of limits
});

// ---- Class lookup --------------------------------------------------------------------------
test('Class lookup matches on normalised seller name', () => {
  assert.equal(lookupCompany('Chicago Private Boat Tours').company.class, 'Empire Tours:Chicago');
  assert.equal(lookupCompany('chicago river boat architecture tours').company.class, 'Empire Tours:Chicago:Chicago Boats');
  assert.equal(lookupCompany('ToursOfNYC').company.class, 'NYC');
  assert.equal(lookupCompany('Tours of NYC').company.class, 'NYC');
  assert.equal(lookupCompany('Italy Tours').company.class, 'Empire Tours:Milan');
  assert.equal(lookupCompany('Milan Tours').company.class, 'Empire Tours:Milan'); // renamed in Xola
  assert.equal(lookupCompany('See It All Chicago Tours, LLC').company.class, 'Empire Tours:SIA');
});

test('Class lookup: Chicago Discount excluded by default, included when switched on', () => {
  assert.equal(lookupCompany('Chicago Discount Tours').status, 'excluded');
  const on = lookupCompany('Chicago Discount Tours', { ...OPTIONS, includeChicagoDiscount: true });
  assert.equal(on.status, 'post');
  assert.equal(on.company.class, 'Empire Tours:Chicago:Chicago Discount');
});

test('Class lookup: Austin / Ohio / Wisconsin are "no class – not posted"; others unknown', () => {
  for (const n of ['Austin Tours', 'Ohio Cabins', 'Wisconsin Lodges']) {
    assert.equal(lookupCompany(n).status, 'noClass');
    assert.equal(lookupCompany(n).reason, 'no class – not posted');
  }
  assert.equal(lookupCompany('Some New Seller').status, 'unknown');
});

test('Settings: journal names and the corrected service-fee account', () => {
  assert.equal(nameFor('xola', '2026-08'), 'XOLA-2026-08');
  assert.equal(nameFor('office', '2026-08'), 'OFFICE-2026-08');
  assert.equal(nameFor('deferred', '2026-01'), 'DEF-2026-01');
  assert.equal(nameFor('viator', '2026-08'), 'VIA-2026-08');
  assert.equal(ACCOUNTS.service, '40001.2 Service Fees');
});
