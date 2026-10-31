import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/sumon_trade_test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-test-access-secret-0001';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-test-refresh-secret-01';
process.env.NODE_ENV = 'test';
const { computeLine, computeTotals } = await import('../src/modules/transactions/service.js');

test('line: price × qty with percent discount and exclusive tax', () => {
  const r = computeLine({ qty: 10, price: 100, discountPercent: 10, taxRate: 18 });
  assert.equal(r.discountAmount, 100);
  assert.equal(r.taxAmount, 162);
  assert.equal(r.amount, 1062);
});

test('line: tax inclusive price extracts the tax', () => {
  const r = computeLine({ qty: 1, price: 118, taxRate: 18, taxInclusive: true });
  assert.equal(r.taxAmount, 18);
  assert.equal(r.amount, 118);
  assert.equal(r.taxable, 100);
});

test('line: flat discount cannot exceed the gross amount', () => {
  const r = computeLine({ qty: 1, price: 50, discountAmount: 80 });
  assert.equal(r.discountAmount, 50);
  assert.equal(r.amount, 0);
});

test('totals: bill discount, charges and round off', () => {
  const lines = [computeLine({ qty: 3, price: 33.33, taxRate: 5 }), computeLine({ qty: 1, price: 10 })];
  const t = computeTotals(lines, { discountPercent: 0, discountAmount: 5, charges: [{ amount: 20 }], roundOff: true });
  assert.equal(t.subtotal, 114.99);
  assert.equal(t.total, 130);
  assert.equal(t.roundOff, 0.01);
});

test('totals: no round off keeps paise', () => {
  const t = computeTotals([computeLine({ qty: 1, price: 99.99 })], { roundOff: false });
  assert.equal(t.total, 99.99);
  assert.equal(t.roundOff, 0);
});
