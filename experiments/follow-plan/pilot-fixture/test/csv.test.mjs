import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.mjs';

test('строки разбираются в записи', () => {
  const rows = parseCsv('sku;title;quantity\nA-1;Товар;5\n');
  assert.deepEqual(rows, [{ sku: 'A-1', title: 'Товар', quantity: 5 }]);
});

test('заголовок пропускается', () => {
  const rows = parseCsv('sku;title;quantity\nA-2;Товар;3\n');
  assert.equal(rows.length, 1);
});
