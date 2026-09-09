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

test('removed sessions cannot be recreated by late writes and traversal is rejected', async t => {
  const { open } = await fixture(t);
  const store = open();
  await store.create({ id: 'a' });
  await store.remove('a');
  await assert.rejects(store.save({ id: 'a' }), { code: 'NOT_FOUND' });
  for (const id of ['..', '../escape', '..\\escape', '/absolute', 'a/b']) assert.throws(() => store.taskDir(id));
});
