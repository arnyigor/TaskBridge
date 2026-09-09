import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';

test('backup is a consistent snapshot and later writes do not leak into it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-backup-'));
  const store = new TaskStore(root);
  const restoredDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-backup-open-'));
  let restored = null;
  t.after(async () => {
    store.close();
    if (restored) restored.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(restoredDir, { recursive: true, force: true });
  });
  await store.create({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  await store.appendEvent('a', { type: 'X' });
  const target = path.join(root, 'backups', 'snap.db');
  assert.equal(await store.backup(target), path.resolve(target));
  await store.appendEvent('a', { type: 'Y' }); // must not appear in the snapshot
  await store.checkpoint();

  await fs.copyFile(target, path.join(restoredDir, 'taskbridge.db'));
  restored = new TaskStore(restoredDir);
  assert.equal((await restored.read('a')).id, 'a');
  assert.deepEqual((await restored.readEvents('a', 0)).map(e => e.type), ['X']);
});

test('sqlite pragmas follow options and invalid values fall back to safe defaults', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-pragma-'));
  const full = new TaskStore(root, { synchronous: 'FULL', busyTimeoutMs: 1234 });
  t.after(async () => {
    full.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(Number(full.db.prepare('PRAGMA synchronous').get().synchronous), 2);
  assert.equal(Number(full.db.prepare('PRAGMA busy_timeout').get().timeout), 1234);
  full.close();

  const fallback = new TaskStore(root, { synchronous: 'bogus', busyTimeoutMs: -5 });
  assert.equal(fallback.synchronous, 'NORMAL');
  assert.equal(fallback.busyTimeoutMs, 0);
  fallback.close();
});
