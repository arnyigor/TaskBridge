import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeight } from '../src/parse.mjs';

test('килограммы переводятся в граммы', () => {
  assert.equal(parseWeight('1.5kg'), 1500);
});

test('граммы остаются граммами', () => {
  assert.equal(parseWeight('250g'), 250);
});

test('неразборчивый текст — ошибка', () => {
  assert.throws(() => parseWeight('два кило'), /не разобрать вес/);
});
