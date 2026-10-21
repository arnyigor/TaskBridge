// Подписи проверки соединения (TB-PROV-01B): по ним оператор решает, что делать,
// поэтому они проверяются отдельно от DOM и сервера.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_CHECK_IDLE, PROVIDER_CHECK_LABELS, providerCheckLabel, providerCheckText } from '../web/provider-check-view.mjs';

test('все статусы контракта имеют человеческую подпись', () => {
  for (const status of ['AVAILABLE', 'UNAUTHORIZED', 'RATE_LIMITED', 'TIMEOUT', 'UNREACHABLE', 'UNSUPPORTED', 'UNKNOWN']) {
    assert.equal(typeof PROVIDER_CHECK_LABELS[status], 'string', status);
    assert.ok(PROVIDER_CHECK_LABELS[status].length > 0, status);
  }
  assert.equal(providerCheckLabel('available'), PROVIDER_CHECK_LABELS.AVAILABLE, 'регистр не важен');
  assert.equal(providerCheckLabel(undefined), PROVIDER_CHECK_LABELS.UNKNOWN, 'неизвестное не молчит');
  assert.equal(PROVIDER_CHECK_IDLE, 'Проверка не выполнялась');
});

test('строка результата показывает статус, задержку и что делать', () => {
  const text = providerCheckText({ status: 'AVAILABLE', latencyMs: 42, httpStatus: 200 });
  assert.match(text, /Доступен/);
  assert.match(text, /42 мс/);
  assert.match(text, /HTTP 200/);
  assert.match(text, /\/models/, 'сказано, что проверялся только список моделей');

  const denied = providerCheckText({ status: 'UNAUTHORIZED' });
  assert.match(denied, /Ключ не принят/);
  assert.match(denied, /переменную окружения/, 'подсказка ведёт к действию');
  assert.doesNotMatch(denied, /NaN|null|undefined/, 'пустые поля не печатаются');

  assert.match(providerCheckText({ status: 'RATE_LIMITED' }), /Ограничение частоты/);
  assert.match(providerCheckText({ status: 'TIMEOUT' }), /Не ответил вовремя/);
  assert.match(providerCheckText({ status: 'UNSUPPORTED' }), /Так проверить нельзя/);
  assert.match(providerCheckText({}), /Неизвестно/, 'без статуса — честное «неизвестно»');
});
