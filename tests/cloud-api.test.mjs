import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, SqliteStore } from '../cloud/lib/store.mjs';
import { CloudAuth } from '../cloud/lib/auth.mjs';
import { createRouter } from '../cloud/lib/router.mjs';

const USER = { id: 'owner', token: 'user-token-1234567890' };
const MACHINE = { id: 'home-pc-01', secret: 'machine-secret-1234567890', ownerId: 'owner', displayName: 'Main Windows Workstation' };
const MACHINE_B = { id: 'other-pc', secret: 'other-machine-secret-1234', ownerId: 'owner' };

function makeService(store) {
  const auth = new CloudAuth({ users: [USER], machines: [MACHINE, MACHINE_B] });
  const router = createRouter({ store, auth, offlineAfterMs: 60000 });
  const raw = (path_, { method = 'GET', body = {}, query = {}, headers = {} } = {}) => router.handle({
    method, path: path_, body, query, rawBody: JSON.stringify(body), headers
  });
  const user = (path_, { method = 'GET', body = {}, query = {} } = {}) => router.handle({
    method, path: path_, body, query, rawBody: JSON.stringify(body), headers: { authorization: `Bearer ${USER.token}` }
  });
  const machine = (path_, { method = 'GET', body = {}, query = {}, id = MACHINE.id, secret = MACHINE.secret } = {}) => router.handle({
    method, path: path_, body, query, rawBody: JSON.stringify(body), headers: { authorization: `Bearer ${secret}`, 'x-taskbridge-machine': id }
  });
  const register = () => machine('/api/bridge/heartbeat', { method: 'POST', body: { machineId: MACHINE.id, status: 'ONLINE', version: '0.6.0' } });
  return { router, user, machine, raw, register, store };
}

async function eachStore(t, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-cloud-api-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  for (const [kind, store] of [['memory', await new MemoryStore().init()], ['sqlite', await SqliteStore.open(path.join(root, 'cloud.db'))]]) {
    await t.test(kind, async (sub) => {
      sub.after(async () => { await store.close(); });
      await fn(store);
    });
  }
}

test('cloud API: auth, task creation, offline queue, machine scope', async (t) => {
  await eachStore(t, async (store) => {
    const { user, machine, raw } = makeService(store);

    assert.equal((await raw('/api/tasks')).status, 401, 'no token → 401');
    const unauthMachine = await machine('/api/bridge/commands', { secret: 'wrong-secret-value' });
    assert.equal(unauthMachine.status, 401);

    // A machine the cloud has never seen cannot receive a task.
    assert.equal((await user('/api/tasks', { method: 'POST', body: { machineId: MACHINE.id, projectId: 'p', prompt: 'hi' } })).status, 404);

    // Heartbeat registers the machine.
    const beat = await machine('/api/bridge/heartbeat', { method: 'POST', body: { machineId: MACHINE.id, status: 'ONLINE', version: '0.6.0', protocolVersion: 1, capabilities: { pi: true } } });
    assert.equal(beat.status, 200);
    const machines = await user('/api/machines');
    assert.equal(machines.body[0].status, 'ONLINE');
    assert.equal(machines.body[0].version, '0.6.0');

    const created = await user('/api/tasks', { method: 'POST', body: { machineId: MACHINE.id, projectId: 'taskbridge', prompt: 'fix tests', options: { worktree: true } } });
    assert.equal(created.status, 202);
    assert.equal(created.body.status, 'QUEUED');
    assert.equal(created.body.machineStatus, 'ONLINE');
    assert.match(created.body.taskId, /^task_[0-9a-f]{32}$/);

    // A stale heartbeat is reported as OFFLINE but the task stays queued (§21).
    await store.upsertMachine({ ...(await store.getMachine(MACHINE.id)), lastHeartbeatAt: new Date(Date.now() - 300000).toISOString() });
    const offlineTask = await user('/api/tasks', { method: 'POST', body: { machineId: MACHINE.id, projectId: 'taskbridge', prompt: 'later' } });
    assert.equal(offlineTask.status, 202);
    assert.equal(offlineTask.body.machineStatus, 'OFFLINE');
    assert.equal(offlineTask.body.status, 'QUEUED');

    // Unknown machine is rejected.
    assert.equal((await user('/api/tasks', { method: 'POST', body: { machineId: 'nope', projectId: 'p', prompt: 'x' } })).status, 404);

    // The pending START_TASK is delivered with its payload intact.
    const commands = await machine('/api/bridge/commands', { query: { after: 0 } });
    assert.equal(commands.status, 200);
    assert.equal(commands.body.commands.length, 2);
    const start = commands.body.commands.find(c => c.taskId === created.body.taskId);
    assert.equal(start.type, 'START_TASK');
    assert.equal(start.payload.projectId, 'taskbridge');
    assert.equal(start.payload.options.worktree, true);

    // Ack is recorded.
    const ack = await machine(`/api/bridge/commands/${start.id}/ack`, { method: 'POST', body: { status: 'ACCEPTED' } });
    assert.equal(ack.status, 200);
    assert.equal((await store.getCommand(start.id)).status, 'ACCEPTED');
    assert.equal((await machine(`/api/bridge/commands/${start.id}/ack`, { method: 'POST', body: { status: 'NOPE' } })).status, 400);

    // Machine B must not touch machine A's command (§66).
    const foreign = await machine(`/api/bridge/commands/${start.id}/ack`, { method: 'POST', body: { status: 'ACCEPTED' }, id: MACHINE_B.id, secret: MACHINE_B.secret });
    assert.equal(foreign.status, 403);
  });
});

test('cloud API: event upload dedupes, replicates task state and supports replay', async (t) => {
  await eachStore(t, async (store) => {
    const { user, machine, register } = makeService(store);
    await register();
    const created = await user('/api/tasks', { method: 'POST', body: { machineId: MACHINE.id, projectId: 'p', prompt: 'go' } });
    const taskId = created.body.taskId;

    const events = [
      { eventId: 'e1', taskId, seq: 1, type: 'task_state', timestamp: new Date().toISOString(), payload: { status: 'RUNNING' } },
      { eventId: 'e2', taskId, seq: 2, type: 'tool_started', timestamp: new Date().toISOString(), payload: { toolCallId: 'c1', toolName: 'bash' } },
      { eventId: 'e3', taskId, seq: 3, type: 'tool_finished', timestamp: new Date().toISOString(), payload: { toolCallId: 'c1', exitCode: 0 } },
      { eventId: 'e4', taskId, seq: 4, type: 'assistant_delta', timestamp: new Date().toISOString(), payload: { messageId: 'msg_1', text: 'hi' } }
    ];
    const upload = await machine('/api/bridge/events', { method: 'POST', body: { machineId: MACHINE.id, events } });
    assert.deepEqual(upload.body, { inserted: 4, duplicates: 0 });

    // Redelivery must not duplicate rows (§44).
    const again = await machine('/api/bridge/events', { method: 'POST', body: { machineId: MACHINE.id, events } });
    assert.deepEqual(again.body, { inserted: 0, duplicates: 4 });

    const task = await user(`/api/tasks/${taskId}`);
    assert.equal(task.body.status, 'RUNNING');
    assert.equal(task.body.lastEventSeq, 4);

    const page = await user(`/api/tasks/${taskId}/events`, { query: { after: 1, limit: 2 } });
    assert.equal(page.body.fromSeq, 2);
    assert.equal(page.body.toSeq, 3);
    assert.equal(page.body.hasMore, true);
    assert.deepEqual(page.body.events.map(e => e.seq), [2, 3]);

    const rest = await user(`/api/tasks/${taskId}/events`, { query: { after: 3 } });
    assert.equal(rest.body.hasMore, false);
    assert.deepEqual(rest.body.events.map(e => e.seq), [4]);

    // Terminal event finishes the replica.
    await machine('/api/bridge/events', { method: 'POST', body: { events: [{ eventId: 'e5', taskId, seq: 5, type: 'task_finished', timestamp: new Date().toISOString(), payload: { status: 'COMPLETED' } }] } });
    assert.equal((await user(`/api/tasks/${taskId}`)).body.status, 'COMPLETED');

    // A machine cannot upload events pretending to be another machine.
    const spoof = await machine('/api/bridge/events', { method: 'POST', body: { events: [{ eventId: 'x', taskId, seq: 9, type: 'task_state', machineId: 'other-pc', payload: {} }] } });
    assert.equal(spoof.status, 403);

    // FOLLOW_UP after completion is refused.
    const follow = await user(`/api/tasks/${taskId}/commands`, { method: 'POST', body: { type: 'FOLLOW_UP', payload: { text: 'more' } } });
    assert.equal(follow.status, 409);
    assert.equal(follow.body.error.code, 'TASK_ALREADY_FINISHED');
  });
});

test('cloud API: command priority ordering and reconcile repair drift', async (t) => {
  await eachStore(t, async (store) => {
    const { user, machine, register } = makeService(store);
    await register();
    const created = await user('/api/tasks', { method: 'POST', body: { machineId: MACHINE.id, projectId: 'p', prompt: 'long task' } });
    const taskId = created.body.taskId;

    await user(`/api/tasks/${taskId}/commands`, { method: 'POST', body: { type: 'FOLLOW_UP', payload: { text: 'note' } } });
    await user(`/api/tasks/${taskId}/commands`, { method: 'POST', body: { type: 'ABORT_TASK' } });
    const commands = await machine('/api/bridge/commands', { query: { after: 0 } });
    assert.deepEqual(commands.body.commands.map(c => c.type), ['ABORT_TASK', 'FOLLOW_UP', 'START_TASK']);

    // Cloud thinks the task runs; the machine reports it no longer has it.
    await machine('/api/bridge/events', { method: 'POST', body: { events: [{ eventId: 'r1', taskId, seq: 1, type: 'task_state', payload: { status: 'RUNNING' } }] } });
    assert.equal((await user(`/api/tasks/${taskId}`)).body.status, 'RUNNING');
    const reconcile = await machine('/api/bridge/reconcile', { method: 'POST', body: { machineId: MACHINE.id, activeTasks: [], lastEventSeqByTask: {} } });
    assert.equal(reconcile.status, 200);
    assert.deepEqual(reconcile.body.actions.map(a => a.action), ['MARKED_FAILED']);
    const repaired = await user(`/api/tasks/${taskId}`);
    assert.equal(repaired.body.status, 'FAILED');
    assert.equal(repaired.body.errorCode, 'MACHINE_LOST_TASK');

    // A local status wins over the cloud replica.
    const second = await user('/api/tasks', { method: 'POST', body: { machineId: MACHINE.id, projectId: 'p', prompt: 'another' } });
    await machine('/api/bridge/reconcile', { method: 'POST', body: { machineId: MACHINE.id, activeTasks: [{ taskId: second.body.taskId, status: 'COMPLETED' }], lastEventSeqByTask: {} } });
    assert.equal((await user(`/api/tasks/${second.body.taskId}`)).body.status, 'COMPLETED');
  });
});

test('cloud API: approvals are stored and resolved asynchronously', async (t) => {
  await eachStore(t, async (store) => {
    const { user, machine, register } = makeService(store);
    await register();
    const created = await user('/api/tasks', { method: 'POST', body: { machineId: MACHINE.id, projectId: 'p', prompt: 'danger' } });
    const taskId = created.body.taskId;

    await machine('/api/bridge/events', { method: 'POST', body: { events: [{
      eventId: 'a1', taskId, seq: 1, type: 'approval_required',
      payload: { approvalId: 'approval_123', toolCallId: 'call_42', toolName: 'bash', args: { command: 'git reset --hard' }, risk: 'destructive' }
    }] } });
    const approvals = await user(`/api/tasks/${taskId}/approvals`);
    assert.equal(approvals.body.length, 1);
    assert.equal(approvals.body[0].status, 'PENDING');

    const decision = await user(`/api/tasks/${taskId}/commands`, { method: 'POST', body: { type: 'APPROVAL_RESPONSE', payload: { approvalId: 'approval_123', decision: 'ALLOW_ONCE' } } });
    assert.equal(decision.status, 202);
    const commands = await machine('/api/bridge/commands', { query: { after: 0 } });
    const approvalCommand = commands.body.commands.find(c => c.type === 'APPROVAL_RESPONSE');
    assert.equal(approvalCommand.payload.approvalId, 'approval_123');
  });
});

test('cloud API: browser reconnect replays a gap with no duplicates and no gaps', async (t) => {
  await eachStore(t, async (store) => {
    const { user, machine, register } = makeService(store);
    await register();
    const created = await user('/api/tasks', { method: 'POST', body: { machineId: MACHINE.id, projectId: 'p', prompt: 'stream' } });
    const taskId = created.body.taskId;
    const batch = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => ({
      eventId: `e${from + index}`, taskId, seq: from + index, type: 'assistant_delta', payload: { messageId: 'msg_1', text: `t${from + index}` }
    }));

    await machine('/api/bridge/events', { method: 'POST', body: { events: batch(1, 100) } });
    const first = await user(`/api/tasks/${taskId}/events`, { query: { after: 0, limit: 2000 } });
    assert.deepEqual(first.body.events.map(e => e.seq), Array.from({ length: 100 }, (_, i) => i + 1));

    // The browser is closed; the machine keeps producing 101–250.
    await machine('/api/bridge/events', { method: 'POST', body: { events: batch(101, 250) } });

    const replay = await user(`/api/tasks/${taskId}/events`, { query: { after: 100, limit: 2000 } });
    assert.deepEqual(replay.body.events.map(e => e.seq), Array.from({ length: 150 }, (_, i) => 101 + i));
    assert.equal(replay.body.hasMore, false);

    // A retried upload during replay must not introduce duplicates.
    const retry = await machine('/api/bridge/events', { method: 'POST', body: { events: batch(101, 250) } });
    assert.equal(retry.body.duplicates, 150);
    const again = await user(`/api/tasks/${taskId}/events`, { query: { after: 100, limit: 2000 } });
    assert.deepEqual(again.body.events.map(e => e.seq), replay.body.events.map(e => e.seq));
  });
});
