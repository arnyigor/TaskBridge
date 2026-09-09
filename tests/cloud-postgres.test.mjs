import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, SqliteStore, openStore, resolveStoreTarget } from '../cloud/lib/store.mjs';
import { CloudAuth } from '../cloud/lib/auth.mjs';
import { createRouter } from '../cloud/lib/router.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Postgres parity suite. Runs only when a throw-away database is provided:
//
//   TASKBRIDGE_TEST_DATABASE_URL=postgres://user:pass@host/db npm test
//
// The same scenarios as tests/cloud-api.test.mjs are executed against the
// Postgres adapter so a serverless deployment is verified, not assumed.

const DATABASE_URL = process.env.TASKBRIDGE_TEST_DATABASE_URL;

function makeService(store) {
  const auth = new CloudAuth({
    users: [{ id: 'owner', token: 'pg-user-token-1234567890' }],
    machines: [{ id: 'pg-machine', secret: 'pg-machine-secret-1234567890', ownerId: 'owner' }]
  });
  const router = createRouter({ store, auth, offlineAfterMs: 60000 });
  const user = (route, { method = 'GET', body = {}, query = {} } = {}) => router.handle({
    method, path: route, body, query, rawBody: JSON.stringify(body), headers: { authorization: 'Bearer pg-user-token-1234567890' }
  });
  const machine = (route, { method = 'GET', body = {}, query = {} } = {}) => router.handle({
    method, path: route, body, query, rawBody: JSON.stringify(body), headers: { authorization: 'Bearer pg-machine-secret-1234567890', 'x-taskbridge-machine': 'pg-machine' }
  });
  return { router, user, machine };
}

test('postgres store: full API round trip, dedupe, priority and reconcile', { skip: DATABASE_URL ? false : 'TASKBRIDGE_TEST_DATABASE_URL is not set' }, async t => {
  const store = await openStore(DATABASE_URL);
  t.after(() => store.close());
  assert.equal(store.kind, 'postgres');

  // Clean slate for the shared database.
  for (const task of await store.listTasks('owner', { limit: 500 })) await store.deleteTask(task.id);
  for (const machine of await store.listMachines('owner')) await store.upsertMachine({ ...machine, lastHeartbeatAt: null });

  const { user, machine } = makeService(store);
  await machine('/api/bridge/heartbeat', { method: 'POST', body: { machineId: 'pg-machine', status: 'ONLINE', version: 'test' } });
  const created = await user('/api/tasks', { method: 'POST', body: { machineId: 'pg-machine', projectId: 'p', prompt: 'pg task' } });
  assert.equal(created.status, 202);
  const taskId = created.body.taskId;

  // Commands: priority ordering and uniqueness of (machineId, seq).
  await user(`/api/tasks/${taskId}/commands`, { method: 'POST', body: { type: 'FOLLOW_UP', payload: { text: 'note' } } });
  await user(`/api/tasks/${taskId}/commands`, { method: 'POST', body: { type: 'ABORT_TASK' } });
  const commands = await machine('/api/bridge/commands', { query: { after: 0 } });
  assert.deepEqual(commands.body.commands.map(command => command.type), ['ABORT_TASK', 'START_TASK', 'FOLLOW_UP']);

  // Events: dedupe on (taskId, seq) / eventId, state replication and replay.
  const batch = [
    { eventId: 'pg-e1', taskId, seq: 1, type: 'task_state', timestamp: new Date().toISOString(), payload: { status: 'RUNNING' } },
    { eventId: 'pg-e2', taskId, seq: 2, type: 'tool_started', timestamp: new Date().toISOString(), payload: { toolCallId: 'c1', toolName: 'bash' } },
    { eventId: 'pg-e3', taskId, seq: 3, type: 'task_finished', timestamp: new Date().toISOString(), payload: { status: 'COMPLETED' } }
  ];
  assert.deepEqual((await machine('/api/bridge/events', { method: 'POST', body: { events: batch } })).body, { inserted: 3, duplicates: 0 });
  assert.deepEqual((await machine('/api/bridge/events', { method: 'POST', body: { events: batch } })).body, { inserted: 0, duplicates: 3 });

  const task = await user(`/api/tasks/${taskId}`);
  assert.equal(task.body.status, 'COMPLETED');
  assert.equal(task.body.lastEventSeq, 3);
  const page = await user(`/api/tasks/${taskId}/events`, { query: { after: 1, limit: 10 } });
  assert.deepEqual(page.body.events.map(event => event.seq), [2, 3]);

  // Reconcile repairs drift the same way as with the other stores.
  const second = await user('/api/tasks', { method: 'POST', body: { machineId: 'pg-machine', projectId: 'p', prompt: 'pg drift' } });
  await machine('/api/bridge/events', { method: 'POST', body: { events: [{ eventId: 'pg-r1', taskId: second.body.taskId, seq: 1, type: 'task_state', payload: { status: 'RUNNING' } }] } });
  const reconcile = await machine('/api/bridge/reconcile', { method: 'POST', body: { machineId: 'pg-machine', activeTasks: [], lastEventSeqByTask: {} } });
  assert.ok(reconcile.body.actions.some(action => action.taskId === second.body.taskId && action.action === 'MARKED_FAILED'));
  assert.equal((await user(`/api/tasks/${second.body.taskId}`)).body.errorCode, 'MACHINE_LOST_TASK');
});

test('store target resolution prefers explicit config, then Postgres env, then memory', () => {
  assert.equal(resolveStoreTarget({}), 'memory:');
  assert.equal(resolveStoreTarget({ POSTGRES_URL: 'postgres://x' }), 'postgres://x');
  assert.equal(resolveStoreTarget({ DATABASE_URL: 'postgres://y' }), 'postgres://y');
  assert.equal(resolveStoreTarget({ TASKBRIDGE_CLOUD_STORE: 'sqlite:/tmp/x.db', POSTGRES_URL: 'postgres://x' }), 'sqlite:/tmp/x.db');
});

test('openStore routes memory, sqlite and postgres targets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-store-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const memory = await openStore('memory:');
  assert.equal(memory.kind, 'memory');
  const sqlite = await openStore(`sqlite:${path.join(root, 'x.db')}`);
  assert.equal(sqlite.kind, 'sqlite');
  await sqlite.close();

  // Postgres is only imported when it is actually configured.
  await assert.rejects(openStore('mysql://nope'), /Unsupported cloud store target/);
  assert.ok(MemoryStore && SqliteStore);
});
