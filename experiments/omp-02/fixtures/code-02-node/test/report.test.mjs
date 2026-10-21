import test from 'node:test';
import assert from 'node:assert/strict';
import { reportRow, reportTotal } from '../src/report.mjs';

test('строка отчёта показывает вес и стоимость', () => {
  assert.equal(reportRow('1.5kg', 200), '1.5kg → 300.00 ₽');
});

test('итог складывает отправки', () => {
  const total = reportTotal([
    { weight: '1kg', pricePerKilogram: 100 },
    { weight: '500g', pricePerKilogram: 100 },
  ]);
  assert.equal(total, 'Итого: 150.00 ₽');
});
