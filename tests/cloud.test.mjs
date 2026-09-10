import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CloudOutbox } from '../src/cloud/cloud-outbox.mjs';
import { CloudCommandDispatcher } from '../src/cloud/cloud-commands.mjs';
import { CloudTransport } from '../src/cloud/cloud-transport.mjs';
import { CloudEventState } from '../src/cloud/cloud-event-state.mjs';
import { sanitizeEvent } from '../src/cloud/cloud-sanitize.mjs';

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-cloud-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('cloud outbox survives restart and only removes acknowledged records', async t => {
  const root = await temp(t);
  const first = new CloudOutbox(root);
  await first.init();
  await first.enqueue({ eventId: 'a', event: { seq: 1 } });
  await first.enqueue({ eventId: 'a', event: { seq: 1 } });
  await first.enqueue({ eventId: 'b', event: { seq: 2 } });
  const second = new CloudOutbox(root);
  await second.init();
  assert.deepEqual((await second.take()).map(item => item.eventId), ['a', 'b']);
  await second.ack(['a']);
  const third = new CloudOutbox(root);
  await third.init();
  assert.deepEqual((await third.take()).map(item => item.eventId), ['b']);
});

test('event cursor reconstructs the SQLite-to-outbox crash gap without replaying pre-cloud history', async t => {
  const root = await temp(t);
  const events = [{ taskId: 'task', seq: 1 }, { taskId: 'task', seq: 2 }];
  const store = { readEvents: async (_id, limit, after = 0) => {
    const filtered = events.filter(event => event.seq > after);
    return limit ? filtered.slice(-limit) : filtered;
  } };
  const baseline = new CloudEventState(root, store);
  const firstReplay = [];
  await baseline.init([{ id: 'task' }], event => firstReplay.push(event));
  assert.deepEqual(firstReplay, []);
  events.push({ taskId: 'task', seq: 3 }); // SQLite commit happened; outbox write did not.
  const recovered = new CloudEventState(root, store);
  const replay = [];
  await recovered.init([{ id: 'task' }], event => replay.push(event));
  assert.deepEqual(replay.map(event => event.seq), [3]);
  await recovered.mark([{ taskId: 'task', event: events[2] }]);
  const afterAck = [];
  await new CloudEventState(root, store).init([{ id: 'task' }], event => afterAck.push(event));
  assert.deepEqual(afterAck, []);
});

test('cloud outbox repairs a torn final record after a crash', async t => {
  const root = await temp(t);
  const directory = path.join(root, 'cloud');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'outbox.jsonl'), '{"eventId":"good"}\n{"eventId":');
  const outbox = new CloudOutbox(root);
  await outbox.init();
  assert.deepEqual((await outbox.take()).map(item => item.eventId), ['good']);
  assert.equal(await fs.readFile(path.join(directory, 'outbox.jsonl'), 'utf8'), '{"eventId":"good"}\n');
});

test('cloud sanitizer masks secrets and bounds oversized tool output', () => {
  const event = { taskId: 'a', seq: 1, type: 'PI_EVENT', authorization: 'Bearer private',
    data: { token: 'private', pi: { output: `TASK_TOKEN=abc ${'x'.repeat(5000)} needle` } } };
  const clean = sanitizeEvent(event, { secret: 'needle', maxString: 200, maxBytes: 1024 });
  const text = JSON.stringify(clean);
  assert.doesNotMatch(text, /private|TASK_TOKEN=abc|needle/);
  assert.ok(Buffer.byteLength(text) <= 1024);
});

function fakeManager() {
  const tasks = new Map();
  let creates = 0;
  let cancelFailures = 1;
  return {
    tasks, get creates() { return creates; }, projects: [], queue: [], activeTaskId: null,
    getTask: id => tasks.get(id) || null, listProjects: () => [], listTasks: () => [...tasks.values()], state: async () => null,
    createTask: async (payload, options) => { creates++; const task = { id: options.requestedId, projectId: payload.projectId, prompt: payload.prompt, workspacePath: 'C:\\private' }; tasks.set(task.id, task); return task; },
    cancel: async id => { if (cancelFailures--) throw Object.assign(new Error('busy'), { code: 'BUSY' }); return { id, status: 'CANCELLED' }; },
    message: async () => ({}), compact: async () => ({})
  };
}

test('duplicate START uses one local task id and processed command ids survive restart', async t => {
  const root = await temp(t);
  const manager = fakeManager();
  const published = [];
  const command = { id: 'cmd_start', type: 'START_TASK', taskId: 'cloud_task', payload: { projectId: 'p', prompt: 'hello' } };
  const first = new CloudCommandDispatcher(manager, root, async (...args) => published.push(args));
  await first.init();
  assert.equal((await first.dispatch(command)).result.id, 'cloud_task');
  assert.equal((await first.dispatch(command)).duplicate, true);
  const second = new CloudCommandDispatcher(manager, root, async () => {});
  await second.init();
  assert.equal((await second.dispatch(command)).duplicate, true);
  assert.equal(manager.creates, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0][1].result.workspacePath, undefined);
});

test('failed STOP is not marked processed and succeeds on redelivery', async t => {
  const root = await temp(t);
  const dispatcher = new CloudCommandDispatcher(fakeManager(), root, async () => {});
  await dispatcher.init();
  const command = { id: 'cmd_stop', type: 'ABORT_TASK', taskId: 'a' };
  await assert.rejects(dispatcher.dispatch(command), { code: 'BUSY' });
  assert.equal((await dispatcher.dispatch(command)).duplicate, false);
});

test('transport keeps a failed upload, retries with stable ids, then acknowledges it', async t => {
  const root = await temp(t);
  const manager = new EventEmitter();
  const sent = [];
  let fail = true;
  const client = { publish: async (machineId, records) => { sent.push({ machineId, records }); if (fail) throw new Error('offline'); } };
  const outbox = new CloudOutbox(root);
  await outbox.init();
  const transport = new CloudTransport(manager, { enabled: true, machineId: 'pc' }, root, { secret: 'a'.repeat(20), client, outbox });
  await transport.enqueueEvent({ taskId: 'task', seq: 7, at: new Date().toISOString(), type: 'TASK_SUCCEEDED', message: 'done' });
  await assert.rejects(transport.flushOnce(), /offline/);
  assert.equal(outbox.size(), 1);
  fail = false;
  await transport.flushOnce();
  assert.equal(outbox.size(), 0);
  assert.equal(sent[0].records[0].eventId, sent[1].records[0].eventId);
  assert.equal(sent[1].machineId, 'pc');
});

test('command receipt is acknowledged only after local dispatch succeeds', async t => {
  const root = await temp(t);
  const manager = new EventEmitter();
  const acked = [];
  const transport = new CloudTransport(manager, { enabled: true, machineId: 'pc' }, root, { secret: 'a'.repeat(20), outbox: new CloudOutbox(root), client: {
    pull: async () => ({ messages: [{ receiptHandle: 'lease', command: { id: 'cmd', type: 'SYNC_STATE' } }] }),
    ack: async (_machine, receipt) => acked.push(receipt)
  } });
  transport.dispatcher = { dispatch: async () => { throw Object.assign(new Error('temporary'), { code: 'BUSY' }); } };
  await transport.pollOnce();
  assert.deepEqual(acked, []);
  transport.dispatcher = { dispatch: async () => ({}) };
  await transport.pollOnce();
  assert.deepEqual(acked, ['lease']);
});
