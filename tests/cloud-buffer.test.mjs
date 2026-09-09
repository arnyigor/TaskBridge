import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventBuffer } from '../src/cloud/event-buffer.mjs';
import { EventMux } from '../src/events/event-mux.mjs';
import { CloudOutbox } from '../src/cloud/outbox.mjs';
import { EventUploader } from '../src/cloud/event-uploader.mjs';
import { ReconnectManager } from '../src/cloud/reconnect-manager.mjs';

function event(seq, type, payload = {}, extra = {}) {
  return { eventId: `e${seq}`, machineId: 'm', taskId: 't', seq, timestamp: new Date().toISOString(), type, payload, ...extra };
}

test('buffer flushes on interval, on max size and immediately for high priority', async () => {
  const timers = [];
  const buffer = new EventBuffer({ flushMs: 50, maxEvents: 3, maxBytes: 1024, coalesce: false, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  const batches = [];
  buffer.on('flush', batch => batches.push(batch));

  buffer.push(event(1, 'assistant_delta', { text: 'a' }));
  buffer.push(event(2, 'assistant_delta', { text: 'b' }));
  assert.equal(batches.length, 0, 'normal events wait for the flush timer');
  assert.equal(timers.at(-1).ms, 50);
  timers.at(-1).fn();
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(e => e.seq), [1, 2]);

  // Size limit splits into batches of maxEvents.
  buffer.push(event(3, 'assistant_delta', { text: 'c' }));
  buffer.push(event(4, 'assistant_delta', { text: 'd' }));
  buffer.push(event(5, 'assistant_delta', { text: 'e' }));
  buffer.push(event(6, 'assistant_delta', { text: 'f' }));
  buffer.flushNow();
  assert.equal(batches.length, 3);
  assert.deepEqual(batches[1].map(e => e.seq), [3, 4, 5]);
  assert.deepEqual(batches[2].map(e => e.seq), [6]);

  // A durable high-priority event is flushed without waiting.
  buffer.push(event(7, 'tool_started', { toolCallId: 'c1' }));
  assert.equal(timers.at(-1).ms, 0, 'high priority schedules an immediate flush');
  assert.equal(batches.length, 3, 'nothing is sent before the timer fires');
  timers.at(-1).fn();
  assert.equal(batches.length, 4);
  assert.deepEqual(batches[3].map(e => e.seq), [7]);
});

test('buffer coalesces consecutive assistant deltas of one message and keeps seq continuity', () => {
  const buffer = new EventBuffer({ flushMs: 1000, coalesce: true, setTimer: () => 1, clearTimer: () => {} });
  const batches = [];
  buffer.on('flush', batch => batches.push(batch));
  buffer.push(event(10, 'assistant_delta', { messageId: 'msg_1', text: 'Checking ' }));
  buffer.push(event(11, 'assistant_delta', { messageId: 'msg_1', text: 'the ' }));
  buffer.push(event(12, 'assistant_delta', { messageId: 'msg_1', text: 'tests' }));
  buffer.flushNow();
  assert.equal(batches[0].length, 1);
  const merged = batches[0][0];
  assert.equal(merged.type, 'assistant_delta_batch');
  assert.equal(merged.seqFrom, 10);
  assert.equal(merged.seqTo, 12);
  assert.equal(merged.payload.text, 'Checking the tests');
  assert.equal(merged.payload.count, 3);

  // A gap in seq or a different message must not be merged.
  buffer.push(event(13, 'assistant_delta', { messageId: 'msg_1', text: 'x' }));
  buffer.push(event(15, 'assistant_delta', { messageId: 'msg_1', text: 'y' }));
  buffer.flushNow();
  assert.equal(batches[1].length, 2);
});

test('buffer never drops durable events under backpressure', () => {
  const buffer = new EventBuffer({ setTimer: () => 1, clearTimer: () => {} });
  buffer.push(event(1, 'assistant_delta', { text: 'a' }));
  buffer.push(event(2, 'tool_started', { toolCallId: 'c1' }));
  buffer.push(event(3, 'assistant_delta', { text: 'b' }));
  buffer.push(event(4, 'task_failed', { error: 'x' }));
  const dropped = buffer.dropNonCritical();
  assert.equal(dropped, 2);
  assert.deepEqual(buffer.pending.map(e => e.type), ['tool_started', 'task_failed']);
});

test('mux assigns event ids and sequence numbers and emits snapshots', () => {
  const published = [];
  const mux = new EventMux({ machineId: 'm', snapshotPolicy: { note: () => {}, due: () => false, mark: () => {} } });
  mux.addTransport({ publishEvents: events => published.push(...events) });

  const first = mux.publishLocal('t1', 'task_state', { status: 'RUNNING' });
  const second = mux.publishLocal('t1', 'task_log', { message: 'hello' });
  assert.deepEqual(first.map(e => e.seq), [1]);
  assert.deepEqual(second.map(e => e.seq), [2]);
  assert.equal(published.length, 2);
  assert.match(published[0].eventId, /^[0-9a-f-]{36}$/);
  assert.equal(published[0].machineId, 'm');
  assert.equal(published[0].taskId, 't1');

  // A due snapshot is appended after the delta, with its own cursor.
  let due = false;
  const snapMux = new EventMux({ machineId: 'm', snapshotPolicy: { note: () => {}, due: () => due, mark: () => {} } });
  const out = [];
  snapMux.addTransport({ publishEvents: events => out.push(...events) });
  snapMux.normalizer.normalizePiFrame('t', { type: 'message_start', message: { role: 'assistant', content: [] } });
  snapMux.normalizer.normalizePiFrame('t', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } });
  due = true;
  const events = snapMux.handleLocalEvent({ taskId: 't', type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' world' } } } });
  assert.deepEqual(events.map(e => e.type), ['assistant_delta', 'assistant_snapshot']);
  assert.equal(events[1].payload.text, 'hello world');
  assert.equal(events[1].seq, events[0].seq + 1);
});

test('outbox persists batches, survives restart and never drops durable events at the limit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-cloud-outbox-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const outbox = await new CloudOutbox({ dir: root }).init();
  await outbox.enqueue([event(1, 'tool_started', { toolCallId: 'c1' }), event(2, 'assistant_delta', { text: 'x'.repeat(200) })], { machineId: 'm' });
  await outbox.enqueue([event(3, 'task_failed', { error: 'boom' })], { machineId: 'm' });
  assert.equal((await outbox.stats()).batches, 2);

  // A crashed upload leaves SENDING behind; init() must recover it.
  const records = await outbox.list();
  await outbox.markSending(records[0]);
  const reopened = await new CloudOutbox({ dir: root }).init();
  assert.equal((await reopened.list())[0].state, 'PENDING');

  // Shrink the limit below the current size: only the non-durable delta may go.
  reopened.maxBytes = 60;
  const dropped = await reopened.enforceLimit();
  assert.equal(dropped, 1);
  const remaining = (await reopened.list()).flatMap(record => record.events).map(e => e.type);
  assert.deepEqual(remaining, ['tool_started', 'task_failed']);

  assert.deepEqual(await reopened.pendingEventSeqs(), { t: 3 });
  await reopened.clear();
  assert.equal((await reopened.list()).length, 0);
});

test('uploader retries failed batches and keeps them until acknowledged', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-cloud-upload-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const outbox = await new CloudOutbox({ dir: root }).init();
  const reconnect = new ReconnectManager({ setTimer: () => 1, clearTimer: () => {} });
  let fail = true;
  const uploaded = [];
  const client = {
    machineId: 'm',
    uploadEvents: async (events) => {
      if (fail) throw Object.assign(new Error('boom'), { code: 'HTTP_500', retryable: true });
      uploaded.push(...events);
      return { inserted: events.length, duplicates: 0 };
    }
  };
  const uploader = new EventUploader({ client, outbox, reconnect, maxRetryDelayMs: 1000 });

  await uploader.send([event(1, 'task_state', { status: 'RUNNING' })]);
  await uploader.drain();
  assert.equal(uploaded.length, 0);
  assert.equal((await outbox.list()).length, 1, 'a failed batch stays in the outbox');
  assert.equal((await outbox.list())[0].attempts, 1);
  assert.equal(reconnect.connected, false);

  fail = false;
  await uploader.drain();
  assert.deepEqual(uploaded.map(e => e.seq), [1]);
  assert.equal((await outbox.list()).length, 0);
  assert.equal(uploader.snapshot().lastUploadedSeq.t, 1);
  assert.equal(reconnect.connected, true);
});

test('reconnect manager ramps 1s→30s, caps and resets after a success', () => {
  const delays = [];
  const manager = new ReconnectManager({ maxDelayMs: 30000, setTimer: () => 1, clearTimer: () => {} });
  for (let i = 0; i < 7; i++) delays.push(manager.nextDelay());
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000, 30000, 30000]);
  assert.equal(manager.attempt, 7);
  manager.markConnected();
  assert.equal(manager.attempt, 0);
  assert.equal(manager.connected, true);
  manager.markDisconnected('test');
  assert.equal(manager.reconnects, 1);
});
