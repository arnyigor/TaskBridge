import test from 'node:test';
import assert from 'node:assert/strict';
import { shipmentCost } from '../src/pricing.mjs';

test('2 кг по 300 ₽/кг стоят 600 ₽', () => {
  assert.equal(shipmentCost('2kg', 300), 600);
});

test('500 г по 400 ₽/кг стоят 200 ₽', () => {
  assert.equal(shipmentCost('500g', 400), 200);
});

test('цена округляется до копеек', () => {
  assert.equal(shipmentCost('333g', 199.99), 66.6);
});
