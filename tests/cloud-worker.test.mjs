import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { CloudWorker } from '../src/cloud/cloud-worker.mjs';
import { CommandDispatcher, CommandLedger } from '../src/cloud/command-dispatcher.mjs';
import { ApprovalManager } from '../src/cloud/approval-manager.mjs';
import { resolveCloudConfig, validateCloudConfig, defaultMachineId } from '../src/cloud/cloud-config.mjs';
import { startServer } from '../cloud/server.mjs';

const USER_TOKEN = 'user-token-for-worker-test';
const MACHINE = { id: 'home-pc-01', secret: 'machine-secret-for-worker-test', ownerId: 'owner', displayName: 'Test Workstation' };
const ENV = {
  TASKBRIDGE_CLOUD_USER_TOKEN: USER_TOKEN,
  TASKBRIDGE_CLOUD_MACHINES: JSON.stringify([MACHINE])
};

// Minimal TaskManager stand-in: it only needs the surface CloudWorker and
// CommandDispatcher use, plus the same 'task-event' stream the real one emits.
function createStubManager() {
  const emitter = new EventEmitter();
  const tasks = new Map();
  const calls = { create: [], cancel: [], message: [], compact: [], setModel: [], setThinking: [] };
  const api = {
    activeTaskId: null,
    calls,
    on: (...args) => emitter.on(...args),
    off: (...args) => emitter.off(...args),
    listTasks: () => [...tasks.values()],
    getTask: id => tasks.get(id) ?? null,
    emit: event => emitter.emit('task-event', event),
    async createTask(input, options = {}) {
      calls.create.push({ ...input, ...(options.requestedId ? { id: options.requestedId } : {}) });
      const at = new Date().toISOString();
      const task = { id: options.requestedId ?? input.id ?? `local-${calls.create.length}`, createdAt: at, updatedAt: at, status: 'QUEUED', projectId: input.projectId, prompt: input.prompt, current: 'Queued' };
      tasks.set(task.id, task);
      api.activeTaskId = task.id;
      api.emit({ at, taskId: task.id, type: 'TASK_QUEUED', message: 'Task queued', data: {} });
      api.emit({ at, taskId: task.id, type: 'STATUS', message: 'Pi starting', data: { status: 'RUNNING' } });
      api.emit({ at, taskId: task.id, type: 'PI_EVENT', message: 'tool: bash', data: { pi: { type: 'agent_start' } } });
      api.emit({ at, taskId: task.id, type: 'PI_EVENT', message: 'tool: bash', data: { pi: { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: './gradlew test' } } } });
      api.emit({ at, taskId: task.id, type: 'PI_EVENT', message: 'tool done', data: { pi: { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', isError: false, exitCode: 0 } } });
      api.emit({ at, taskId: task.id, type: 'PI_EVENT', message: 'delta', data: { pi: { type: 'message_start', message: { role: 'assistant', content: [] } } } });
      api.emit({ at, taskId: task.id, type: 'PI_EVENT', message: 'delta', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Checking tests' } } } });
      api.emit({ at, taskId: task.id, type: 'PI_EVENT', message: 'end', data: { pi: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Checking tests' }], stopReason: 'stop' } } } });
      api.emit({ at, taskId: task.id, type: 'PI_EVENT', message: 'settled', data: { pi: { type: 'agent_settled' } } });
      task.status = 'SUCCEEDED';
      task.current = 'Done';
      api.activeTaskId = null;
      api.emit({ at, taskId: task.id, type: 'TASK_SUCCEEDED', message: 'Done', data: {} });
      return task;
    },
    async cancel(id) { calls.cancel.push(id); const task = tasks.get(id); if (task) { task.status = 'CANCELLED'; } api.emit({ at: new Date().toISOString(), taskId: id, type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} }); return task ?? null; },
    async message(id, text, mode) { calls.message.push({ id, text, mode }); return tasks.get(id) ?? null; },
    async compact(id, instructions) { calls.compact.push({ id, instructions }); return { tokensBefore: 10, estimatedTokensAfter: 5 }; },
    async setModel(id, provider, modelId) { calls.setModel.push({ id, provider, modelId }); return tasks.get(id) ?? null; },
    async setThinkingLevel(id, level) { calls.setThinking.push({ id, level }); return tasks.get(id) ?? null; }
  };
  return api;
}

async function fixture(t, { storeTarget = 'memory:' } = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-cloud-worker-'));
  const store = new TaskStore(dataRoot);
  const server = await startServer({ port: 0, host: '127.0.0.1', storeTarget, env: ENV, logger: () => {} });
  const manager = createStubManager();
  const config = resolveCloudConfig({
    cloud: {
      enabled: true,
      url: `http://127.0.0.1:${server.port}`,
      machineId: MACHINE.id,
      machineSecret: MACHINE.secret,
      machineDisplayName: MACHINE.displayName,
      eventFlushMs: 10,
      heartbeatSeconds: 1,
      idlePollSeconds: 0.2,
      activePollSeconds: 0.1,
      coalesceDeltas: false
    }
  }, {}, { dataRoot });
  const worker = new CloudWorker({ config, manager, store, dataRoot, logger: () => {}, version: '0.6.0' });

  const user = async (route, { method = 'GET', body = {}, query = null } = {}) => {
    const search = query ? `?${new URLSearchParams(query)}` : '';
    const response = await fetch(`http://127.0.0.1:${server.port}${route}${search}`, {
      method,
      headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  t.after(async () => {
    await worker.stop();
    await server.close();
    store.close();
    await fs.rm(dataRoot, { recursive: true, force: true });
  });
  return { worker, manager, store, server, dataRoot, user, config };
}

async function flush(worker) {
  worker.buffer.flushNow();
  await worker.uploader.drain();
}

test('config: cloud transport is opt-in, validated and gets a non-identifying machine id', () => {
  const disabled = resolveCloudConfig({}, {}, { dataRoot: 'C:\\Users\\someone\\secret-path' });
  assert.equal(disabled.enabled, false);
  assert.equal(validateCloudConfig(disabled).ok, true);

  const bad = resolveCloudConfig({ cloud: { enabled: true, url: 'not-a-url', machineSecret: 'short' } }, {}, { dataRoot: 'x' });
  const check = validateCloudConfig(bad);
  assert.equal(check.ok, false);
  assert.match(check.problems.join(' '), /TASKBRIDGE_CLOUD_URL/);
  assert.match(check.problems.join(' '), /at least 16 characters/);

  const id = defaultMachineId('C:\\Users\\someone\\secret-path');
  assert.match(id, /^machine-[0-9a-f]{12}$/);
  assert.ok(!id.includes('someone'), 'the default machine id must not leak the path');
});

test('dispatcher routes commands, deduplicates redelivery and rejects unsupported ones', async (t) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-cloud-dispatch-'));
  const store = new TaskStore(dataRoot);
  t.after(async () => { store.close(); await fs.rm(dataRoot, { recursive: true, force: true }); });
  const manager = createStubManager();
  const approvals = new ApprovalManager({ timeoutMinutes: 0 });
  const dispatcher = new CommandDispatcher({ manager, approvals, ledger: new CommandLedger({ store }) });

  const start = { commandId: 'c1', machineId: 'm', taskId: 'task_abc', seq: 1, type: 'START_TASK', payload: { projectId: 'p', prompt: 'do it' }, createdAt: new Date().toISOString() };
  assert.equal((await dispatcher.handle(start)).status, 'ACCEPTED');
  assert.equal(manager.calls.create.length, 1);
  assert.equal(manager.calls.create[0].id, 'task_abc');

  // Redelivery of the same commandId must not start a second task (§16).
  assert.equal((await dispatcher.handle(start)).status, 'DUPLICATE');
  assert.equal(manager.calls.create.length, 1);

  // A duplicate taskId with a *new* command is also idempotent.
  const again = await dispatcher.handle({ ...start, commandId: 'c2', seq: 2 });
  assert.equal(again.status, 'DUPLICATE');

  assert.equal((await dispatcher.handle({ commandId: 'c3', machineId: 'm', taskId: 'task_abc', seq: 3, type: 'FOLLOW_UP', payload: { text: 'go on' } })).status, 'ACCEPTED');
  assert.deepEqual(manager.calls.message[0], { id: 'task_abc', text: 'go on', mode: 'auto' });
  assert.equal((await dispatcher.handle({ commandId: 'c4', machineId: 'm', taskId: 'task_abc', seq: 4, type: 'COMPACT', payload: {} })).status, 'ACCEPTED');
  assert.equal((await dispatcher.handle({ commandId: 'c5', machineId: 'm', taskId: 'task_abc', seq: 5, type: 'ABORT_TASK', payload: {} })).status, 'ACCEPTED');
  assert.deepEqual(manager.calls.cancel, ['task_abc']);

  // Runtime model/thinking changes are supported when the manager exposes them (§51).
  const thinking = await dispatcher.handle({ commandId: 'c6', machineId: 'm', taskId: 'task_abc', seq: 6, type: 'SET_THINKING', payload: { level: 'medium' } });
  assert.equal(thinking.status, 'ACCEPTED');
  assert.deepEqual(manager.calls.setThinking, [{ id: 'task_abc', level: 'medium' }]);
  const model = await dispatcher.handle({ commandId: 'c8', machineId: 'm', taskId: 'task_abc', seq: 8, type: 'SET_MODEL', payload: { model: { provider: 'anthropic', modelId: 'sonnet' } } });
  assert.equal(model.status, 'ACCEPTED');
  assert.deepEqual(manager.calls.setModel, [{ id: 'task_abc', provider: 'anthropic', modelId: 'sonnet' }]);

  const unknownTask = await dispatcher.handle({ commandId: 'c7', machineId: 'm', taskId: 'nope', seq: 7, type: 'ABORT_TASK', payload: {} });
  assert.equal(unknownTask.error.code, 'TASK_NOT_FOUND');

  // The ledger is durable: a new dispatcher over the same store still dedupes.
  const restarted = new CommandDispatcher({ manager, approvals, ledger: new CommandLedger({ store }) });
  assert.equal((await restarted.handle(start)).status, 'DUPLICATE');
  assert.equal(manager.calls.create.length, 1);
});

test('approval manager resolves once, rejects unknown ids and cancels with the task', async () => {
  const approvals = new ApprovalManager({ timeoutMinutes: 0 });
  const request = approvals.request({ taskId: 't1', toolCallId: 'c1', toolName: 'bash', args: { command: 'git reset --hard' }, risk: 'destructive' });
  assert.equal(approvals.list().length, 1);
  assert.equal(approvals.resolve(request.approvalId, 'ALLOW_ONCE'), true);
  assert.deepEqual(await request.promise, { approvalId: request.approvalId, decision: 'ALLOW_ONCE' });
  assert.equal(approvals.resolve(request.approvalId, 'DENY'), false, 'a second resolution is refused');

  const second = approvals.request({ taskId: 't2', toolName: 'write' });
  assert.equal(approvals.cancelTask('t2'), 1);
  assert.deepEqual(await second.promise, { approvalId: second.approvalId, decision: 'DENY' });

  assert.equal(approvals.resolve('approval_unknown', 'ALLOW_ONCE'), false);
  assert.equal(approvals.snapshot().requested, 2);
});

test('worker heartbeats, executes a cloud task and streams normalized events', async (t) => {
  const f = await fixture(t);
  await f.worker.start();
  await f.worker.heartbeat.sendOnce();

  const machines = await f.user('/api/machines');
  assert.equal(machines.body[0].id, MACHINE.id);
  assert.equal(machines.body[0].status, 'ONLINE');
  assert.equal(machines.body[0].version, '0.6.0');
  assert.equal(f.worker.reconciled !== null, true, 'startup reconciliation ran');

  const created = await f.user('/api/tasks', { method: 'POST', body: { machineId: MACHINE.id, projectId: 'taskbridge', prompt: 'fix tests' } });
  assert.equal(created.status, 202);

  await f.worker.poll();
  assert.deepEqual(f.manager.calls.create.map(c => c.id), [created.body.taskId], 'the cloud task id is reused locally');
  await flush(f.worker);

  const task = await f.user(`/api/tasks/${created.body.taskId}`);
  assert.equal(task.body.status, 'COMPLETED');

  const events = await f.user(`/api/tasks/${created.body.taskId}/events`, { query: { after: 0, limit: 500 } });
  const types = events.body.events.map(event => event.type);
  assert.deepEqual(types, [
    'task_created',
    'task_state',
    'turn_started',
    'tool_started',
    'tool_finished',
    'assistant_delta',
    'assistant_end',
    'turn_finished',
    'task_finished'
  ]);
  assert.deepEqual(events.body.events.map(event => event.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9], 'sequence is contiguous and monotonic');
  assert.equal(events.body.events.find(e => e.type === 'tool_started').payload.toolName, 'bash');
  assert.equal(events.body.events.find(e => e.type === 'assistant_end').payload.text, 'Checking tests');
  assert.ok(events.body.events.every(e => e.machineId === MACHINE.id));
});

test('worker deduplicates redelivered commands and honours ABORT_TASK', async (t) => {
  const f = await fixture(t);
  await f.worker.start();
  await f.worker.heartbeat.sendOnce();
  const created = await f.user('/api/tasks', { method: 'POST', body: { machineId: MACHINE.id, projectId: 'p', prompt: 'task' } });
  await f.worker.poll();
  assert.equal(f.manager.calls.create.length, 1);

  // Re-delivering the very same command must not start a second local task.
  const commands = await f.server.service.store.listCommands(MACHINE.id, { after: 0 });
  const start = commands.find(command => command.type === 'START_TASK');
  assert.equal((await f.worker.dispatcher.handle(start)).status, 'DUPLICATE');
  assert.equal(f.manager.calls.create.length, 1);

  const abort = await f.user(`/api/tasks/${created.body.taskId}/commands`, { method: 'POST', body: { type: 'ABORT_TASK' } });
  assert.equal(abort.status, 202);
  await f.worker.poll();
  assert.deepEqual(f.manager.calls.cancel, [created.body.taskId]);
  await flush(f.worker);
  assert.equal((await f.user(`/api/tasks/${created.body.taskId}`)).body.status, 'ABORTED');
});

test('tasks queued while the machine is offline start when it reconnects', async (t) => {
  const f = await fixture(t);
  // The worker is not started: the machine is effectively offline.
  await f.server.service.store.upsertMachine({ id: MACHINE.id, ownerId: 'owner', status: 'ONLINE', lastHeartbeatAt: new Date().toISOString() });
  const created = await f.user('/api/tasks', { method: 'POST', body: { machineId: MACHINE.id, projectId: 'p', prompt: 'queued offline' } });
  assert.equal(created.status, 202);
  assert.equal((await f.server.service.store.listCommands(MACHINE.id, { after: 0 }))[0].status, 'PENDING');

  // Reconnect: the worker heartbeats, reconciles and picks the command up.
  await f.worker.start();
  await f.worker.poll();
  assert.deepEqual(f.manager.calls.create.map(c => c.id), [created.body.taskId]);
});

test('worker keeps events in the local outbox while the cloud is unreachable', async (t) => {
  const f = await fixture(t);
  await f.worker.start();
  await f.worker.heartbeat.sendOnce();
  // Drop the keep-alive sockets too, otherwise undici reuses them and the
  // "outage" would silently succeed.
  f.server.server.closeAllConnections?.();
  await f.server.close();

  f.worker.mux.publishLocal('task_x', 'task_state', { status: 'RUNNING' });
  f.worker.buffer.flushNow();
  await f.worker.uploader.drain();
  await f.worker.poll();

  const outbox = await f.worker.outbox.stats();
  assert.equal(outbox.events, 1, 'the event stays queued locally');
  assert.equal(f.worker.reconnect.connected, false);

  const status = await f.worker.status();
  assert.equal(status.pendingEvents, 1);
  assert.equal(status.connected, false);
  assert.ok(status.lastPollError, 'the failure is reported in diagnostics');
  assert.equal(JSON.stringify(status).includes(MACHINE.secret), false, 'diagnostics never expose the secret');
});
