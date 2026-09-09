import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Metrics } from '../src/metrics.mjs';
import { EventBuffer } from '../src/cloud/event-buffer.mjs';
import { EventUploader } from '../src/cloud/event-uploader.mjs';
import { CloudOutbox } from '../src/cloud/outbox.mjs';
import { ReconnectManager } from '../src/cloud/reconnect-manager.mjs';
import { CommandDispatcher, CommandLedger } from '../src/cloud/command-dispatcher.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { MemoryStore } from '../cloud/lib/store.mjs';
import { CloudAuth } from '../cloud/lib/auth.mjs';
import { createRouter } from '../cloud/lib/router.mjs';
import { startFixture } from './server-fixture.mjs';

test('metrics registry counts, gauges, observations and exports Prometheus text', () => {
  const metrics = new Metrics();
  metrics.increment('cloud_event_retry_count');
  metrics.increment('cloud_event_retry_count', 2);
  metrics.set('cloud_outbox_size', 7);
  metrics.observe('cloud_event_batch_size', 10);
  metrics.observe('cloud_event_batch_size', 30);
  metrics.observe('cloud_command_latency_ms', 5, { type: 'START_TASK' });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.cloud_event_retry_count, 3);
  assert.equal(snapshot.gauges.cloud_outbox_size, 7);
  assert.deepEqual(snapshot.observations.cloud_event_batch_size, { count: 2, sum: 40, avg: 20, min: 10, max: 30 });
  assert.ok(Object.keys(snapshot.observations).some(id => id.includes('cloud_command_latency_ms{type="START_TASK"}')));

  const text = metrics.toPrometheus();
  assert.match(text, /cloud_event_retry_count 3/);
  assert.match(text, /cloud_event_batch_size_count 2/);
  assert.match(text, /cloud_event_batch_size_max 30/);

  // A runaway label value must not grow memory without bound.
  const bounded = new Metrics({ maxSeries: 5 });
  for (let i = 0; i < 50; i++) bounded.increment('x', 1, { i });
  assert.ok(bounded.counters.size <= 6);
});

test('buffer, uploader, reconnect and dispatcher feed the documented metric names', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-metrics-'));
  const store = new TaskStore(path.join(root, 'tasks'));
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const metrics = new Metrics();

  const buffer = new EventBuffer({ coalesce: false, setTimer: () => 1, clearTimer: () => {}, metrics });
  const batches = [];
  buffer.on('flush', batch => batches.push(batch));
  buffer.push({ seq: 1, type: 'task_state', payload: {}, eventId: 'e1', taskId: 't' });
  buffer.push({ seq: 2, type: 'task_state', payload: {}, eventId: 'e2', taskId: 't' });
  assert.equal(metrics.snapshot().gauges.cloud_buffer_pending_events, 2);
  buffer.flushNow();
  assert.equal(metrics.snapshot().gauges.cloud_buffer_pending_events, 0);
  assert.equal(metrics.snapshot().observations.cloud_event_batch_size.max, 2);

  const outbox = await new CloudOutbox({ dir: path.join(root, 'outbox') }).init();
  const reconnect = new ReconnectManager({ setTimer: () => 1, clearTimer: () => {}, metrics });
  reconnect.markConnected();
  reconnect.markDisconnected('test');
  assert.equal(metrics.snapshot().counters.realtime_reconnect_count, 1);

  let fail = true;
  const uploader = new EventUploader({
    client: { machineId: 'm', uploadEvents: async () => { if (fail) throw Object.assign(new Error('x'), { code: 'HTTP_500' }); return { inserted: 1 }; } },
    outbox,
    reconnect,
    metrics
  });
  await uploader.send([{ seq: 1, type: 'task_state', payload: {}, eventId: 'e1', taskId: 't' }]);
  await uploader.drain();
  assert.equal(metrics.snapshot().counters.cloud_event_retry_count, 1);
  fail = false;
  await uploader.drain();
  assert.ok(metrics.snapshot().observations.cloud_event_upload_latency_ms.count >= 1);
  assert.equal(metrics.snapshot().gauges.cloud_outbox_size, 0);

  const dispatcher = new CommandDispatcher({ manager: { getTask: () => null }, ledger: new CommandLedger({ store }), metrics });
  await dispatcher.handle({ commandId: 'c1', machineId: 'm', taskId: 't', seq: 1, type: 'ABORT_TASK', payload: {} });
  assert.ok(Object.keys(metrics.snapshot().observations).some(id => id.startsWith('cloud_command_latency_ms')));
});

test('cloud metrics endpoint summarises machines, tasks and pending commands', async () => {
  const store = await new MemoryStore().init();
  const auth = new CloudAuth({ users: [{ id: 'owner', token: 'token-1234567890' }], machines: [{ id: 'm1', secret: 'secret-1234567890', ownerId: 'owner' }] });
  const router = createRouter({ store, auth, offlineAfterMs: 60000 });
  const call = (path_, { method = 'GET', body = {} } = {}) => router.handle({
    method, path: path_, body, query: {}, rawBody: JSON.stringify(body), headers: { authorization: 'Bearer token-1234567890' }
  });

  await store.upsertMachine({ id: 'm1', ownerId: 'owner', status: 'ONLINE', lastHeartbeatAt: new Date().toISOString() });
  await store.createTask({ id: 't1', ownerId: 'owner', machineId: 'm1', projectId: 'p', prompt: 'x', status: 'QUEUED', createdAt: new Date().toISOString(), lastEventSeq: 0 });
  await router.enqueue('m1', 'START_TASK', 't1', { projectId: 'p', prompt: 'x' });

  const metrics = await call('/api/metrics');
  assert.equal(metrics.status, 200);
  assert.equal(metrics.body.machines.total, 1);
  assert.equal(metrics.body.machines.byStatus.ONLINE, 1);
  assert.equal(metrics.body.tasks.byStatus.QUEUED, 1);
  assert.equal(metrics.body.commands.pending, 1);

  const anonymous = await router.handle({ method: 'GET', path: '/api/metrics', body: {}, query: {}, rawBody: '', headers: {} });
  assert.equal(anonymous.status, 401);
});

test('local /api/metrics exposes JSON and Prometheus text', { timeout: 20000 }, async t => {
  const fixture = await startFixture(undefined, { root: { cloud: { enabled: true, url: 'not-a-url' } } });
  t.after(() => fixture.close());

  const json = await fixture.api('/api/metrics');
  assert.equal(json.enabled, false, 'cloud disabled: nothing is collected');
  assert.equal(json.metrics, null);

  const text = await fetch(`${fixture.base}/api/metrics?format=prometheus`);
  assert.equal(text.status, 200);
  assert.match(text.headers.get('content-type'), /text\/plain/);
  assert.match(await text.text(), /cloud transport disabled/);
});
