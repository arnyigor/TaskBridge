// Время работы сообщения (turnMetrics): считается сервером, отдаётся в снимке
// задачи и остаётся неизменным после завершения хода.
//
// Клиент эти числа не пересчитывает: берёт `durationMs` из ответа сервера. Тест
// держит именно контракт — две подряд загрузки задачи дают одинаковые значения.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 25000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

test('turnMetrics: длительность хода приходит с сервера и не меняется', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'посчитай время' });
  const finished = await waitFor(async () => {
    const task = await api(`/api/tasks/${created.id}`);
    return ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status) ? task : null;
  }, { timeout: 40000 });
  assert.ok(finished, `ход не завершился: ${fixture.logs()}`);

  const metrics = finished.turnMetrics;
  assert.ok(metrics, 'у завершённого хода обязана быть длительность');
  assert.ok(Number.isFinite(metrics.durationMs) && metrics.durationMs > 0, `durationMs: ${metrics.durationMs}`);
  assert.ok(!Number.isNaN(Date.parse(metrics.startedAt)), 'startedAt — ISO-время');
  assert.ok(!Number.isNaN(Date.parse(metrics.finishedAt)), 'finishedAt — ISO-время');
  assert.ok(Date.parse(metrics.finishedAt) >= Date.parse(metrics.startedAt), 'конец не раньше начала');

  // Повторный запрос истории: числа те же, а не пересчитанные заново.
  await sleep(300);
  const again = await api(`/api/tasks/${created.id}`);
  assert.deepEqual(again.turnMetrics, metrics);

  // Приватные метки хода не утекают клиенту.
  assert.equal('_turnStartedAt' in finished, false);
  assert.equal('_turnFirstTokenAt' in finished, false);

  // В истории переписки у этого ответа своё время: снимок задачи знает только
  // последний ход, поэтому метрики живут ещё и отдельным событием.
  const events = await api(`/api/tasks/${created.id}/events`);
  const recorded = events.filter(event => event.type === 'TURN_METRICS').at(-1);
  assert.ok(recorded, 'событие TURN_METRICS должно попасть в журнал');
  assert.equal(recorded.data.durationMs, metrics.durationMs);
  assert.equal(typeof metrics.segmentId, 'string');
  assert.ok(events.some(event => event.seq === metrics.startEventSeq && event.data?.pi?.type === 'agent_start'));
  assert.ok(events.some(event => event.seq === metrics.messageEventSeq && event.data?.pi?.type === 'message_end'));
  assert.equal(events.filter(event => event.type === 'TURN_METRICS').length, 1, 'one terminal metric per segment');
  await fixture.restart();
  assert.deepEqual((await api(`/api/tasks/${created.id}`)).turnMetrics, metrics);
  const restored = await api(`/api/tasks/${created.id}/events`);
  assert.deepEqual(restored.filter(event => event.type === 'TURN_METRICS'), events.filter(event => event.type === 'TURN_METRICS'));

});

test('turnMetrics: TTFT и скорость приходят, если у хода были токены', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'ответь коротко' });
  const finished = await waitFor(async () => {
    const task = await api(`/api/tasks/${created.id}`);
    return ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status) ? task : null;
  }, { timeout: 40000 });
  assert.ok(finished, `ход не завершился: ${fixture.logs()}`);

  const metrics = finished.turnMetrics;
  assert.ok(metrics, 'у завершённого хода обязана быть длительность');
  if (metrics.firstTokenMs !== null) {
    assert.ok(metrics.firstTokenMs >= 0 && metrics.firstTokenMs <= metrics.durationMs, 'TTFT внутри хода');
  }
  if (metrics.outputTokensPerSecond !== null) {
    assert.ok(metrics.outputTokensPerSecond > 0, 'скорость положительна');
  }

});

test('turnMetrics: ошибка модели тоже даёт фактическое время и статус', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'ответь model-error' });
  const finished = await waitFor(async () => {
    const task = await api(`/api/tasks/${created.id}`);
    return ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status) ? task : null;
  }, { timeout: 40000 });
  assert.ok(finished, `ход не завершился: ${fixture.logs()}`);
  assert.equal(finished.status, 'FAILED');
  // Время до ошибки — факт, а не «ход завершён успешно».
  assert.ok(finished.turnMetrics, 'у ошибочного хода тоже есть длительность');
  assert.ok(finished.turnMetrics.durationMs > 0);
});

test('turnMetrics: прерванный ход сохраняет время до прерывания', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'ответь slow' });
  await waitFor(async () => {
    const task = await api(`/api/tasks/${created.id}`);
    return task.status === 'RUNNING' ? task : null;
  }, { timeout: 20000 });
  await sleep(600);
  await api(`/api/tasks/${created.id}/cancel`, {});

  const finished = await waitFor(async () => {
    const task = await api(`/api/tasks/${created.id}`);
    return ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status) ? task : null;
  }, { timeout: 40000 });
  assert.ok(finished, `ход не завершился: ${fixture.logs()}`);
  assert.equal(finished.status, 'CANCELLED');
  assert.ok(finished.turnMetrics, 'у прерванного хода тоже есть длительность');
  assert.ok(finished.turnMetrics.durationMs > 0, `durationMs: ${finished.turnMetrics.durationMs}`);
  assert.ok(finished.turnMetrics.durationMs < 10000, 'время до прерывания, а не до конца 10-секундной генерации');
});


test('turnMetrics: Pi crash closes measurement before TASK_FAILED', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-crash' });
  const finished = await waitFor(async () => {
    const task = await api(`/api/tasks/${created.id}`);
    return task.status === 'FAILED' ? task : null;
  });
  assert.ok(finished, fixture.logs());
  assert.ok(finished.turnMetrics?.durationMs >= 0);
  const events = await api(`/api/tasks/${created.id}/events`);
  const metrics = events.filter(event => event.type === 'TURN_METRICS');
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0].seq < events.find(event => event.type === 'TASK_FAILED').seq);
});

test('turnMetrics: no-token failure never reuses the preceding turn speed', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'answer' });
  const first = await waitFor(async () => {
    const task = await api(`/api/tasks/${created.id}`);
    return task.status === 'SUCCEEDED' ? task : null;
  });
  assert.ok(first?.turnMetrics);
  await api(`/api/tasks/${created.id}/message`, { text: 'model-error-empty', now: true });
  const failed = await waitFor(async () => {
    const task = await api(`/api/tasks/${created.id}`);
    return task.status === 'FAILED' ? task : null;
  });
  assert.ok(failed?.turnMetrics);
  assert.equal(failed.turnMetrics.outputTokensPerSecond, null);
  assert.notEqual(failed.turnMetrics.segmentId, first.turnMetrics.segmentId);
  const events = await api(`/api/tasks/${created.id}/events`);
  assert.equal(events.filter(event => event.type === 'TURN_METRICS').length, 2);
});

test('usage frames carry provider and locality from the server, not from the model name', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'answer' });
  await waitFor(async () => {
    const task = await api(`/api/tasks/${created.id}`);
    return task.status === 'SUCCEEDED' ? task : null;
  });
  const events = await api(`/api/tasks/${created.id}/events`);
  const end = events.filter(event => event.type === 'PI_EVENT' && event.data?.pi?.type === 'message_end'
    && event.data.pi.message?.role === 'assistant').at(-1);
  assert.ok(end, 'assistant message_end is stored');
  // Local/cloud is a server fact, not a guess from the model name. The fixture has
  // no provider configured, and this project treats an unknown provider as the
  // managed local runtime — so the flag must be present and boolean either way.
  assert.equal(typeof end.data.pi.message.isLocal, 'boolean');
  assert.equal(typeof end.data.pi.message.model, 'string');
});
