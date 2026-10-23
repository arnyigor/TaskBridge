import test from 'node:test';
import assert from 'node:assert/strict';
import { sumBySku, emptySkus } from '../src/stock.mjs';

test('суммы по SKU', () => {
  const totals = sumBySku([{ sku: 'A', quantity: 2 }, { sku: 'A', quantity: 3 }, { sku: 'B', quantity: 1 }]);
  assert.equal(totals.get('A'), 5);
  assert.equal(totals.get('B'), 1);
});

test('нулевые остатки перечисляются', () => {
  assert.deepEqual(emptySkus(new Map([['A', 0], ['B', 4]])), ['A']);
});
