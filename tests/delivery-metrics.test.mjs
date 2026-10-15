import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { Metrics, percentile } from '../src/metrics.mjs';

// Шаг C-C плана улучшений: наблюдаемость доставки. Замеры turn_dispatch_ms /
// ack_latency_ms / eventchain_wait_ms / sse_publish_lag_ms попадают в
// /api/metrics, факт отправки/ACK — записью taskbridge_turn_timing в
// pi-events.jsonl, а /api/health остаётся без auth даже при включённой авторизации.

const ACTIVE = ['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'VERIFYING', 'CANCELLING'];

async function settle(api, id, { tries = 200, delay = 50 } = {}) {
  let task;
  for (let i = 0; i < tries; i++) {
    task = await api(`/api/tasks/${id}`);
    if (!ACTIVE.includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(`task stayed ${task.status}`);
}

test('delivery timings are observed and exposed in /api/metrics (JSON and Prometheus)', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'delivery-metrics' });
  const done = await settle(api, task.id);
  assert.equal(done.status, 'SUCCEEDED', done.error || '');
  // Шаг C-A: точка последнего прогресса в снимке задачи (на ней строится
  // клиентский таймер молчания).
  assert.ok(done.turnState, 'turnState is in the task snapshot');
  assert.ok(done.turnState.lastProgressAt, 'lastProgressAt is recorded');
  assert.ok(!Number.isFinite(Date.parse(done.turnState.lastProgressAt)) === false);
  assert.equal(done.turnState.silentMs, null, 'terminal turn does not report silence');

  const metrics = await api('/api/metrics');
  assert.equal(metrics.enabled, false, 'fixture runs without cloud transport');
  assert.ok(metrics.delivery, 'delivery section is exposed even without cloud');
  const observations = metrics.delivery.observations || {};
  for (const name of ['turn_dispatch_ms', 'ack_latency_ms']) {
    assert.ok(observations[name]?.count >= 1, `${name} observed at least once`);
    assert.ok(observations[name].max >= 0);
  }
  assert.ok(observations.sse_publish_lag_ms?.count >= 1, 'sse_publish_lag_ms observed on publish');

  const text = await (await fetch(`${fixture.base}/api/metrics?format=prometheus`)).text();
  for (const name of ['turn_dispatch_ms', 'ack_latency_ms', 'sse_publish_lag_ms']) {
    assert.match(text, new RegExp(`${name}_count `), `${name} in Prometheus output`);
  }
});

test('the turn timing fact is written to pi-events.jsonl', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'turn-timing-frame' });
  const done = await settle(api, task.id);
  assert.equal(done.status, 'SUCCEEDED', done.error || '');

  const raw = await fs.readFile(path.join(fixture.root, 'data', 'tasks', task.id, 'artifacts', 'pi-events.jsonl'), 'utf8');
  const timings = raw.split('\n').filter(line => line.includes('"type":"taskbridge_turn_timing"'));
  assert.ok(timings.length >= 1, 'at least one turn timing record');
  const record = JSON.parse(timings[0]);
  assert.equal(record.phase, 'initial');
  assert.ok(Number.isFinite(record.dispatchMs), 'dispatchMs is a number');
  assert.ok(Number.isFinite(record.ackMs), 'ackMs is a number (fake pi answers)');
  assert.equal(record.ackError ?? null, null);
});

test('/api/health answers without credentials even when auth is enabled', { timeout: 30000 }, async t => {
  const fixture = await startFixture(undefined, { server: { auth: { enabled: true } } });
  t.after(() => fixture.close());

  // Auth is really on (the fixture calls from loopback, which AccessControl
  // treats as the trusted PC, so a guarded route answers — the gate itself is
  // what must sit AFTER health).
  const authState = await (await fetch(`${fixture.base}/api/auth`)).json();
  assert.equal(authState.enabled, true, 'auth override took effect');
  // …and health still answers without any credentials — it sits before the
  // access gate on purpose (priority fast-path, план улучшений §4.2).
  const health = await fetch(`${fixture.base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
});

// Фаза 4 (observability): перцентили по окну последних значений и секция
// server-здоровья в /api/metrics. Без p95 «медиана хорошая, а хвосты ад»
// оставалось невидимым.
test('Metrics snapshot exposes p95 over the recent window, not the whole history', () => {
  const metrics = new Metrics({ observationWindow: 10 });
  // 90 быстрых значений в начале (ушедших из окна) и 10 медленных в конце.
  for (let i = 0; i < 90; i++) metrics.observe('latency_ms', 1);
  for (let i = 0; i < 10; i++) metrics.observe('latency_ms', 1000);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.observations['latency_ms'].count, 100, 'агрегаты считаются по всей истории');
  assert.equal(snapshot.observations['latency_ms'].p95, 1000, 'p95 — по последним значениям окна');
});

test('percentile interpolates and tolerates a single value', () => {
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([], 0.95), 0);
  assert.equal(percentile([1, 2], 1.5), 2, 'квантиль зажат в [0..1]');
});

test('metrics carry a server-health section: uptime, sse clients, event chain, drops', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const metrics = await fixture.api('/api/metrics');
  assert.ok(metrics.server, 'секция server присутствует');
  assert.ok(Number.isFinite(metrics.server.uptimeSec) && metrics.server.uptimeSec >= 0, JSON.stringify(metrics.server));
  assert.equal(metrics.server.sseClients, 0, 'подписчиков нет — ноль');
  assert.ok(Number.isFinite(metrics.server.eventChainDepth), 'глубина eventChain — число');
  assert.equal(metrics.server.droppedStreams, 0, 'обрывов стрима ещё не было');
});
