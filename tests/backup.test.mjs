import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

for (const mode of ['default', 'absolute', 'relative']) {
  test(`backup CLI uses the ${mode} data root and preserves a live WAL snapshot`, async t => {
    await fs.mkdir('.local', { recursive: true });
    const root = await fs.mkdtemp(path.resolve('.local/taskbridge-backup-cli-'));
    const codeRoot = path.join(root, 'program files');
    const dataRoot = mode === 'default' ? path.join(codeRoot, 'data') : path.join(root, 'данные с пробелами');
    const stores = [];
    t.after(async () => {
      for (const store of stores) store.close();
      await fs.rm(root, { recursive: true, force: true });
    });
    for (const dir of ['src', 'scripts']) await fs.mkdir(path.join(codeRoot, dir), { recursive: true });
    await fs.copyFile(new URL('../src/task-store.mjs', import.meta.url), path.join(codeRoot, 'src', 'task-store.mjs'));
    await fs.copyFile(new URL('../scripts/backup.mjs', import.meta.url), path.join(codeRoot, 'scripts', 'backup.mjs'));
    const source = new TaskStore(dataRoot);
    stores.push(source);
    await source.create({ id: 'selected-store' });
    await source.appendEvent('selected-store', { type: 'BEFORE_BACKUP' });
    if (mode !== 'default') {
      const shadow = new TaskStore(path.join(codeRoot, 'data'));
      stores.push(shadow);
      await shadow.create({ id: 'wrong-code-root-store' });
    }
    const env = { ...process.env };
    delete env.TASKBRIDGE_DATA_DIR;
    if (mode !== 'default') env.TASKBRIDGE_DATA_DIR = mode === 'relative' ? path.relative(root, dataRoot) : dataRoot;
    await promisify(execFile)(process.execPath, [path.join(codeRoot, 'scripts', 'backup.mjs')], { cwd: root, env, timeout: 15000 });
    const names = (await fs.readdir(path.join(dataRoot, 'backups'))).filter(name => name.endsWith('.db'));
    assert.equal(names.length, 1);
    await source.appendEvent('selected-store', { type: 'AFTER_BACKUP' });
    const restoredRoot = path.join(root, 'restored');
    await fs.mkdir(restoredRoot);
    await fs.copyFile(path.join(dataRoot, 'backups', names[0]), path.join(restoredRoot, 'taskbridge.db'));
    const restored = new TaskStore(restoredRoot);
    stores.push(restored);
    assert.equal((await restored.read('selected-store')).id, 'selected-store');
    assert.deepEqual((await restored.readEvents('selected-store', 0)).map(event => event.type), ['BEFORE_BACKUP']);
    assert.deepEqual((await source.readEvents('selected-store', 0)).map(event => event.type), ['BEFORE_BACKUP', 'AFTER_BACKUP']);
    if (mode !== 'default') {
      await assert.rejects(fs.access(path.join(codeRoot, 'data', 'backups')), error => error.code === 'ENOENT');
    }
  });
}

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
