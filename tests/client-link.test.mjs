import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';

// Фаза 4 плана: эпизоды DEGRADED считает сервер по сообщениям клиента.
// Обрыв потока при живом сервере раньше замечает именно клиент, поэтому без
// этих сообщений «часто отваливается» остаётся воспоминанием оператора.
test('client link reports count episodes, not retries', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const report = (body) => fixture.api('/api/clients/link', body);

  // Первое сообщение о работе — не эпизод: связь и была живой.
  await report({ state: 'live', clientId: 'phone-1' });
  let metrics = await fixture.api('/api/metrics');
  assert.equal(metrics.server.degradedEpisodes, 0);
  assert.equal(metrics.server.degradedClients.length, 0);

  // Обрыв → эпизод; повторы ретраев того же клиента — НЕ новые эпизоды.
  await report({ state: 'degraded', clientId: 'phone-1', reason: 'stream closed', attempt: 1 });
  await report({ state: 'degraded', clientId: 'phone-1', reason: 'stream closed', attempt: 2 });
  await report({ state: 'reconnecting', clientId: 'phone-1', reason: 'no server', attempt: 3 });
  metrics = await fixture.api('/api/metrics');
  assert.equal(metrics.server.degradedEpisodes, 1, 'три сообщения одного обрыва — один эпизод');
  assert.equal(metrics.server.degradedClients.length, 1);
  assert.equal(metrics.server.degradedClients[0].clientId, 'phone-1');
  assert.equal(metrics.server.degradedClients[0].state, 'reconnecting');
  assert.ok(metrics.server.lastDegradedAt, 'время последнего эпизода сохранено');

  // Восстановление, затем новый обрыв — второй эпизод.
  await report({ state: 'live', clientId: 'phone-1' });
  metrics = await fixture.api('/api/metrics');
  assert.equal(metrics.server.recoveredEpisodes, 1);
  assert.equal(metrics.server.degradedClients.length, 0, 'восстановившийся клиент не в списке');
  await report({ state: 'degraded', clientId: 'phone-1', reason: 'stream closed' });
  metrics = await fixture.api('/api/metrics');
  assert.equal(metrics.server.degradedEpisodes, 2);

  // Второй клиент считается отдельно: адрес/идентификатор — ключ эпизода.
  await report({ state: 'degraded', clientId: 'phone-2', reason: 'wifi lost' });
  metrics = await fixture.api('/api/metrics');
  assert.equal(metrics.server.degradedEpisodes, 3);
  assert.equal(metrics.server.degradedClients.length, 2);

  // Неизвестное состояние — отказ, а не молчаливая запись в метрики.
  await assert.rejects(report({ state: 'banana' }), { code: 'INPUT_INVALID' });
  await assert.rejects(report({}), { code: 'INPUT_INVALID' });
});

test('client link reports carry no prompt or history content', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  // В теле есть лишние поля — сервер обязан их игнорировать, а не хранить:
  // метрика не должна становиться каналом утечки содержимого сессии.
  await fixture.api('/api/clients/link', {
    state: 'degraded',
    clientId: 'phone-1',
    reason: 'stream closed',
    prompt: 'секретный текст задачи',
    events: [{ message: 'секретный ответ' }],
  });
  const metrics = await fixture.api('/api/metrics');
  const dump = JSON.stringify(metrics.server);
  assert.ok(!dump.includes('секретный'), `в метриках нет содержимого: ${dump.slice(0, 200)}`);
  assert.equal(metrics.server.degradedClients[0].reason, 'stream closed');
});
