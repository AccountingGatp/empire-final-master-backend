import test from 'node:test';
import assert from 'node:assert/strict';
import { OPTIONS, ACCOUNTS } from '../src/accounting/settings.js';
import { classifyRow } from '../src/accounting/classify.js';
import { buildXolaJournal } from '../src/accounting/xolaJournal.js';
import { buildViatorJournal } from '../src/accounting/viator.js';

OPTIONS.viatorInXola = true;
const row = (source, net, extra = {}) => ({ source, net, gross: net + 5, processingFee: 3, serviceFee: 2, guestFee: 0, currency: 'USD', payoutDate: '2026-09-10', ...extra });

test('viatorInXola: Viator rows post to 10032 Viator Sales like Groupon', () => {
  assert.deepEqual(classifyRow(row('viator', 100)), { action: 'include', group: 'viator' });
  const j = buildXolaJournal({
    month: '2026-09',
    sellers: [{ sellerName: 'Washington DC Sightseeing Tours', rows: [row('checkout', 1000), row('viator', 500), row('groupon', 200)], summary: { gross: 1715, processingFee: 9, serviceFee: 6, net: 1700 } }],
  });
  const debit = (acc) => j.lines.filter((l) => l.account === acc).reduce((s, l) => s + l.debit, 0);
  assert.equal(debit(ACCOUNTS.clearing.viator), 500);
  assert.equal(debit(ACCOUNTS.clearing.groupon), 200);
  assert.equal(j.lines.reduce((s, l) => s + l.debit, 0), j.lines.reduce((s, l) => s + l.credit, 0));
  assert.ok(j.checks.filter((c) => c.id === 'X9').every((c) => c.pass));
  assert.equal(j.locations[0].viatorNetLocalCents, 500);
});

test('viatorInXola: the advice is a check only — no VIA lines, so no double count', () => {
  const v = buildViatorJournal({
    month: '2026-09',
    advices: [{ location: 'Washington DC Sightseeing Tours', fileName: 'a.csv', paymentDate: '2026-10-08', rows: [{ currency: 'USD', netCents: 500 }] }],
    xola: { locations: [{ location: 'Washington DC Sightseeing Tours', viatorNetLocalCents: 500, currency: 'USD' }] },
  });
  assert.equal(v.lines.length, 0);
  assert.ok(v.checks.find((c) => c.id === 'V5').pass);
});
