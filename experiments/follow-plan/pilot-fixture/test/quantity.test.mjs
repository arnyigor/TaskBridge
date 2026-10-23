import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuantity } from '../src/quantity.mjs';

test('положительное количество', () => {
  assert.equal(parseQuantity('12'), 12);
});

test('пробелы и нечисловые значения', () => {
  assert.equal(parseQuantity(' 7 '), 7);
  assert.throws(() => parseQuantity('abc'), /не число/);
  assert.throws(() => parseQuantity(''), /пустое/);
});
