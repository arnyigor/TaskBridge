import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-store-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new TaskStore(root);
}

test('concurrent writes preserve order, metadata and contiguous event cursors', async t => {
  const store = await fixture(t);
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

test('legacy and torn records survive reload and append without losing valid history', async t => {
  const store = await fixture(t);
  await store.create({ id: 'a' });
  await fs.writeFile(path.join(store.taskDir('a'), 'events.jsonl'), '{"message":"one"}\n{"message":"two"}\n{"torn":');
  assert.deepEqual((await store.readEvents('a', 0)).map(x => x.seq), [1, 2]);
  await store.appendEvent('a', { message: 'three' });
  assert.deepEqual((await store.readEvents('a', 0)).map(x => x.message), ['one', 'two', 'three']);
  assert.equal((await store.readEvents('a', 0, 2))[0].seq, 4);
  const reloaded = new TaskStore(path.dirname(store.root));
  await reloaded.appendEvent('a', { message: 'four' });
  assert.equal((await reloaded.readEvents('a', 1))[0].seq, 5);
});

test('removed sessions cannot be recreated by late writes and traversal is rejected', async t => {
  const store = await fixture(t);
  await store.create({ id: 'a' });
  await store.remove('a');
  await assert.rejects(store.save({ id: 'a' }), { code: 'NOT_FOUND' });
  for (const id of ['..', '../escape', '..\\escape', '/absolute', 'a/b']) assert.throws(() => store.taskDir(id));
});
