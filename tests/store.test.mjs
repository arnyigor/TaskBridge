import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-store-test-'));
  const stores = [];
  const open = () => {
    const store = new TaskStore(root);
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores) store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, open };
}

test('concurrent writes preserve order, metadata and contiguous event cursors', async t => {
  const { open } = await fixture(t);
  const store = open();
  await store.create({ id: 'a' });
  const jobs = [];
  for (let i = 0; i < 40; i++) jobs.push(store.save({ id: 'a', value: i }), store.appendEvent('a', { value: i }));
  await Promise.all(jobs);
  assert.equal((await store.read('a')).value, 39);
  const events = await store.readEvents('a', 0);
  assert.deepEqual(events.map(x => x.value), Array.from({ length: 40 }, (_, i) => i));
  assert.deepEqual(events.map(x => x.seq), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal((await store.readEvents('a', 0, 35)).length, 5);
});

test('tasks and events survive reopening the database', async t => {
  const { open } = await fixture(t);
  const first = open();
  await first.create({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', status: 'RUNNING' });
  await first.appendEvent('a', { type: 'STATUS', message: 'ok' });
  first.close();
  const second = open();
  assert.equal((await second.read('a')).status, 'RUNNING');
  assert.deepEqual((await second.readEvents('a', 0)).map(x => x.message), ['ok']);
});

test('legacy file store is imported once, with torn tail lines skipped', async t => {
  const { root, open } = await fixture(t);
  const dir = path.join(root, 'tasks', 'a');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'task.json'), JSON.stringify({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', status: 'SUCCEEDED' }));
  await fs.writeFile(path.join(dir, 'events.jsonl'), '{"message":"one"}\n{"message":"two"}\n{"torn":');
  const store = open();
  assert.equal((await store.read('a')).status, 'SUCCEEDED');
  assert.deepEqual((await store.readEvents('a', 0)).map(x => x.seq), [1, 2]);
  await store.appendEvent('a', { message: 'three' });
  assert.deepEqual((await store.readEvents('a', 0)).map(x => x.message), ['one', 'two', 'three']);
  assert.equal((await store.readEvents('a', 0, 2))[0].seq, 3);
  // Reopening must not import the same legacy files a second time.
  const reloaded = open();
  assert.equal((await reloaded.readEvents('a', 0)).length, 3);
});

test('superseded streaming deltas are pruned, in-progress ones are kept', async t => {
  const { open } = await fixture(t);
  const store = open();
  await store.create({ id: 'a' });
  const frame = pi => ({ type: 'PI_EVENT', data: { pi } });
  await store.appendEvent('a', frame({ type: 'message_start', message: { role: 'assistant' } }));
  await store.appendEvent('a', frame({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'A' } }));
  await store.appendEvent('a', frame({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'B' } }));
  await store.appendEvent('a', frame({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'AB' }] } }));
  await store.appendEvent('a', frame({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'C' } }));
  assert.equal(await store.pruneStreamingDeltas('a'), 2);
  assert.deepEqual((await store.readEvents('a', 0)).map(e => e.data.pi.type), ['message_start', 'message_end', 'message_update']);
});

test('deleting a task cascades events and the foreign key blocks orphan writes', async t => {
  const { open } = await fixture(t);
  const first = open();
  await first.create({ id: 'a' });
  await first.appendEvent('a', { type: 'X' });
  await first.remove('a');
  assert.deepEqual(await first.readEvents('a', 0), []);
  // A second connection has no in-memory tombstone, so only the FK stops it.
  const second = open();
  await assert.rejects(second.appendEvent('a', { type: 'Y' }));
  assert.deepEqual(await second.readEvents('a', 0), []);
});

test('a pre-foreign-key database is migrated and orphan events are dropped', async t => {
  const { root, open } = await fixture(t);
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(path.join(root, 'taskbridge.db'));
  legacy.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL)');
  legacy.exec('CREATE TABLE events (task_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (task_id, seq)) WITHOUT ROWID');
  legacy.prepare('INSERT INTO tasks (id, created_at, updated_at, data) VALUES (?, ?, ?, ?)').run('a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', JSON.stringify({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' }));
  legacy.prepare('INSERT INTO events (task_id, seq, payload) VALUES (?, ?, ?)').run('a', 1, JSON.stringify({ type: 'X', seq: 1 }));
  legacy.prepare('INSERT INTO events (task_id, seq, payload) VALUES (?, ?, ?)').run('ghost', 1, JSON.stringify({ type: 'Y', seq: 1 }));
  legacy.close();
  const store = open();
  assert.deepEqual((await store.readEvents('a', 0)).map(e => e.type), ['X']);
  assert.equal(Number(store.db.prepare('PRAGMA user_version').get().user_version), 1);
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n), 1);
});

test('removed sessions cannot be recreated by late writes and traversal is rejected', async t => {
  const { open } = await fixture(t);
  const store = open();
  await store.create({ id: 'a' });
  await store.remove('a');
  await assert.rejects(store.save({ id: 'a' }), { code: 'NOT_FOUND' });
  for (const id of ['..', '../escape', '..\\escape', '/absolute', 'a/b']) assert.throws(() => store.taskDir(id));
});
