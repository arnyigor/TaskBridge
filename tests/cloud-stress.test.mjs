import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { CloudWorker } from '../src/cloud/cloud-worker.mjs';
import { resolveCloudConfig } from '../src/cloud/cloud-config.mjs';
import { ToolOutputWindow } from '../src/tool-output.mjs';
import { EventMux } from '../src/events/event-mux.mjs';
import { EventNormalizer } from '../src/events/event-normalizer.mjs';
import { EventBuffer } from '../src/cloud/event-buffer.mjs';
import { CloudOutbox } from '../src/cloud/outbox.mjs';
import { EventUploader } from '../src/cloud/event-uploader.mjs';
import { ReconnectManager } from '../src/cloud/reconnect-manager.mjs';
import { startServer } from '../cloud/server.mjs';

// Stress / soak coverage (§106–§108).
//
// CI runs bounded versions that still exercise the real code paths: high event
// rate, a large tool log and a short reconnect storm. The full 30-minute /
// 100 MB / multi-hour soak is opt-in through environment variables so a normal
// `npm test` stays fast:
//
//   TASKBRIDGE_STRESS_EVENTS=30000        # default 3000
//   TASKBRIDGE_STRESS_LOG_MB=100          # default 16
//   TASKBRIDGE_STRESS_SECONDS=1800        # default 0 (short soak only)

const EVENTS = Math.max(100, Number(process.env.TASKBRIDGE_STRESS_EVENTS || 3000));
const LOG_MB = Math.max(1, Number(process.env.TASKBRIDGE_STRESS_LOG_MB || 16));
const SOAK_SECONDS = Math.max(0, Number(process.env.TASKBRIDGE_STRESS_SECONDS || 0));

function heapMb() {
  return process.memoryUsage().heapUsed / 1048576;
}

test(`streaming stress: ${EVENTS} events stay batched, bounded and lossless`, { timeout: 120000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-stress-stream-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const outbox = await new CloudOutbox({ dir: path.join(root, 'outbox'), maxBytes: 32 * 1048576 }).init();
  const metrics = { observed: [], set() {}, observe(name, value) { this.observed.push(value); }, increment() {}, snapshot() { return {}; } };
  const reconnect = new ReconnectManager({ setTimer: () => 1, clearTimer: () => {} });

  const received = [];
  let requests = 0;
  let latencyMs = 2;
  const client = {
    machineId: 'stress',
    async uploadEvents(events) {
      requests += 1;
      await new Promise(resolve => setTimeout(resolve, latencyMs));
      received.push(...events);
      return { inserted: events.length, duplicates: 0 };
    }
  };

  const buffer = new EventBuffer({ flushMs: 50, maxEvents: 100, maxBytes: 128 * 1024, coalesce: false, metrics });
  const uploader = new EventUploader({ client, outbox, reconnect, metrics, maxRetryDelayMs: 200 });
  buffer.on('flush', events => { uploader.send(events).catch(() => {}); });

  const mux = new EventMux({ machineId: 'stress' });
  mux.addTransport({ publishEvents: events => buffer.pushMany(events) });

  const before = heapMb();
  const startedAt = Date.now();
  for (let i = 0; i < EVENTS; i++) {
    // 1 delta + 1 durable every 5 events: a realistic mixed stream.
    mux.publishLocal('task_stress', 'assistant_delta', { messageId: 'msg_1', text: `token-${i} ` });
    if (i % 5 === 0) mux.publishLocal('task_stress', 'tool_updated', { toolCallId: 'c1', mode: 'delta', output: `line ${i}\n` });
    if (i % 50 === 0) mux.publishLocal('task_stress', 'tool_started', { toolCallId: `call_${i}`, toolName: 'bash', args: { command: 'true' } });
    // Yield periodically so timers can fire and the batch path stays exercised.
    if (i % 200 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  buffer.flushNow();
  await uploader.drain();
  const elapsedMs = Date.now() - startedAt;
  const peakHeapMb = heapMb() - before;

  const expected = mux.lastSeqByTask().task_stress;
  assert.equal(received.length, expected, 'every event reached the cloud');
  const seqs = received.map(event => event.seq);
  assert.deepEqual(seqs, Array.from({ length: expected }, (_, i) => i + 1), 'sequence is contiguous and monotonic');
  assert.ok(requests <= expected, `batching happened (${requests} requests for ${expected} events)`);
  assert.ok(requests < expected / 10, `request count stays low (${requests})`);
  assert.ok((await outbox.stats()).batches === 0, 'the outbox is drained');
  assert.ok(peakHeapMb < 256, `bounded memory (grew ${peakHeapMb.toFixed(1)} MB)`);
  if (EVENTS >= 3000) {
    const rate = EVENTS / (elapsedMs / 1000);
    console.log(`[stress] ${EVENTS} events in ${elapsedMs} ms (${rate.toFixed(0)} ev/s), ${requests} uploads, heap +${peakHeapMb.toFixed(1)} MB`);
  }
});

test(`large tool log: ${LOG_MB} MB stays local with a bounded cloud payload`, { timeout: 180000 }, async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-stress-log-'));
  const store = new TaskStore(dataRoot);
  t.after(async () => { store.close(); await fs.rm(dataRoot, { recursive: true, force: true }); });

  const manager = new TaskManager({ projects: [], cloud: { toolOutput: { maxFullMb: 1 } } }, dataRoot, store);
  const task = { id: 'a', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'RUNNING', workspacePath: dataRoot, files: [], attachments: [], outputFiles: [], compaction: { count: 0 }, assistantText: '', thinkingText: '' };
  await store.create(task);
  manager.tasks.set('a', task);

  const normalizer = new EventNormalizer({ toolOutput: { rollingKb: 64, tailKb: 64, snapshotMs: 0 } });
  normalizer.normalizePiFrame('a', { type: 'tool_execution_start', toolCallId: 'call_big', toolName: 'bash', args: { command: 'yes' } });

  const chunk = 'x'.repeat(1024 * 1024);
  let cloudBytes = 0;
  const before = heapMb();
  for (let i = 0; i < LOG_MB; i++) {
    // Local log keeps everything (this is what stays on the machine).
    await store.appendRaw('a', 'tool-call_big.log', chunk);
    // Cloud sees only bounded deltas/snapshots.
    const events = normalizer.normalizePiFrame('a', { type: 'tool_execution_update', toolCallId: 'call_big', output: chunk });
    for (const event of events) cloudBytes += Buffer.byteLength(JSON.stringify(event.payload), 'utf8');
  }
  const end = normalizer.normalizePiFrame('a', { type: 'tool_execution_end', toolCallId: 'call_big', toolName: 'bash', exitCode: 0 })[0];
  const heapGrowthMb = heapMb() - before;

  const artifact = await fs.stat(path.join(store.taskDir('a'), 'artifacts', 'tool-call_big.log'));
  assert.equal(artifact.size, LOG_MB * 1024 * 1024, 'the full log stays on the machine');
  assert.ok(cloudBytes < LOG_MB * 1024 * 1024 * 0.1, `cloud payload stayed bounded (${(cloudBytes / 1048576).toFixed(2)} MB)`);
  assert.equal(end.type, 'tool_finished');
  assert.equal(end.payload.fullLogAvailable, true);
  assert.equal(end.payload.truncated, true);
  assert.ok(Buffer.byteLength(end.payload.tail, 'utf8') <= 64 * 1024, 'the final event carries a bounded tail');
  assert.ok(heapGrowthMb < 256, `bounded memory (grew ${heapGrowthMb.toFixed(1)} MB)`);

  // The explicit fetch is capped too, and the whole log remains reachable locally.
  const fetched = await manager.fetchToolOutput('a', 'call_big');
  assert.equal(fetched.truncated, true);
  assert.ok(Buffer.byteLength(fetched.text, 'utf8') <= 1024 * 1024 + 4);
  console.log(`[stress] ${LOG_MB} MB tool log: cloud payload ${(cloudBytes / 1048576).toFixed(2)} MB, heap +${heapGrowthMb.toFixed(1)} MB`);

  const window = new ToolOutputWindow({ rollingBytes: 64 * 1024 });
  window.append('y'.repeat(4 * 1024 * 1024));
  assert.ok(window.state.tailBytes <= 64 * 1024, 'the rolling window itself is bounded');
});

test('soak: reconnects and upload failures never lose durable state', { timeout: 120000 }, async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-stress-soak-'));
  const store = new TaskStore(dataRoot);
  t.after(async () => { store.close(); await fs.rm(dataRoot, { recursive: true, force: true }); });

  const cloud = await startServer({
    port: 0,
    host: '127.0.0.1',
    storeTarget: 'memory:',
    env: { TASKBRIDGE_CLOUD_USER_TOKEN: 'soak-token-1234567890', TASKBRIDGE_CLOUD_MACHINES: JSON.stringify([{ id: 'soak-machine', secret: 'soak-secret-1234567890', ownerId: 'owner' }]) },
    logger: () => {}
  });
  t.after(() => cloud.close());

  const manager = new EventEmitter();
  Object.assign(manager, { activeTaskId: null, listTasks: () => [], getTask: () => null });
  const config = resolveCloudConfig({
    cloud: {
      enabled: true,
      url: `http://127.0.0.1:${cloud.port}`,
      machineId: 'soak-machine',
      machineSecret: 'soak-secret-1234567890',
      eventFlushMs: 20,
      heartbeatSeconds: 60,
      coalesceDeltas: false
    }
  }, {}, { dataRoot });
  const worker = new CloudWorker({ config, manager, store, dataRoot, logger: () => {} });
  t.after(() => worker.stop());

  // Force upload failures so the outbox and the retry path are exercised.
  const realUpload = worker.client.uploadEvents.bind(worker.client);
  let failures = 0;
  worker.client.uploadEvents = async (events) => {
    if (failures < 3) { failures += 1; throw Object.assign(new Error('simulated outage'), { code: 'HTTP_500', retryable: true }); }
    return realUpload(events);
  };

  await worker.start();
  const total = 300;
  for (let i = 0; i < total; i++) {
    worker.mux.publishLocal('task_soak', 'assistant_delta', { messageId: 'msg_1', text: `t${i} ` });
    if (i % 10 === 0) worker.mux.publishLocal('task_soak', 'tool_started', { toolCallId: `c${i}`, toolName: 'bash', args: {} });
    if (i % 200 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  worker.buffer.flushNow();

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await worker.uploader.drain();
    if ((await worker.outbox.stats()).batches === 0) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  assert.ok(failures >= 3, 'the outage path was exercised');
  assert.equal((await worker.outbox.stats()).batches, 0, 'the outbox eventually drained');
  const stored = await cloud.service.store.listEvents('task_soak', { after: 0, limit: 5000 });
  const seqs = stored.map(event => event.seq);
  assert.deepEqual(seqs, Array.from({ length: total + Math.floor((total - 1) / 10) + 1 }, (_, i) => i + 1), 'every durable event arrived exactly once, in order');
  assert.equal(worker.reconnect.connected, true);
  console.log(`[stress] soak: ${seqs.length} events delivered after ${failures} simulated failures`);

  // Opt-in long run: keeps publishing at ~100 events/s for the requested time.
  if (SOAK_SECONDS > 0) {
    const stopAt = Date.now() + SOAK_SECONDS * 1000;
    let published = 0;
    while (Date.now() < stopAt) {
      for (let i = 0; i < 10; i++) {
        worker.mux.publishLocal('task_soak', 'assistant_delta', { messageId: 'msg_2', text: 'x' });
        published += 1;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      if (published % 1000 === 0) await worker.uploader.drain();
    }
    worker.buffer.flushNow();
    await worker.uploader.drain();
    assert.equal((await worker.outbox.stats()).batches, 0, 'the outbox is empty after the long soak');
    console.log(`[stress] long soak: ${SOAK_SECONDS}s, ~${published} additional events`);
  }
});
