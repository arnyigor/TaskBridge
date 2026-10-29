import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backupStore, verifyRestore, walkFiles } from '../scripts/backup-memory-store.mjs';

// MEM-01: the backup of a memory store has to be provable, not plausible.
// These tests build their own synthetic store — the real one never participates.

async function store(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-mem-backup-'));
  const source = path.join(root, 'persistent_memory');
  const files = {
    'taskbridge.md': '# Проект: taskbridge | Срез от 2026-10-29 10:00\n\nактивная тема\n',
    '.access.json': '{"taskbridge": {"reads": 3}}\n',
    '.archive/old.20261001-101010.md': '# Проект: old\n\nархив\n',
    '.history/taskbridge/20261029-100000-00.md': '# Проект: taskbridge\n\nверсия\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(source, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, 'utf8');
  }
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
  return { root, source, destination: path.join(root, 'backup'), restore: path.join(root, 'restore'), files };
}

test('a backup records every file, including archive and history, and restores byte-for-byte', async t => {
  const { source, destination, restore, files } = await store(t);
  const report = await backupStore({ source, destination });

  assert.equal(report.consistent, true, JSON.stringify(report.drifted));
  assert.equal(report.fileCount, Object.keys(files).length);
  assert.deepEqual(report.files.map(file => file.path).sort(), Object.keys(files).sort());
  for (const file of report.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);

  const manifest = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
  assert.equal(manifest.fileCount, report.fileCount, 'манифест пишется вместе с копией');

  const restored = await verifyRestore({ manifestPath: path.join(destination, 'manifest.json'), restoreDir: restore });
  assert.equal(restored.ok, true, JSON.stringify(restored.problems));
  assert.equal(restored.fileCount, report.fileCount);
  for (const [rel, body] of Object.entries(files)) {
    assert.equal(await fs.readFile(path.join(restore, rel), 'utf8'), body, `восстановление ${rel}`);
  }
});

test('a source that changes during the copy is reported as inconsistent, not silently mixed', async t => {
  const { source, destination } = await store(t);
  const report = await backupStore({
    source,
    destination,
    onAfterCopy: async () => {
      await fs.writeFile(path.join(source, 'taskbridge.md'), '# Проект: taskbridge | Срез от 2026-10-29 10:05\n\nпереписано во время копирования\n', 'utf8');
    },
  });
  assert.equal(report.consistent, false, 'параллельная запись должна ломать consistent');
  assert.ok(report.drifted.some(entry => entry.path === 'taskbridge.md'), JSON.stringify(report.drifted));
  assert.equal(report.fileCount, 4, 'скопированные файлы не выбрасываются из манифеста');
});

test('a file that appears during the copy is drift, not part of the snapshot', async t => {
  const { source, destination } = await store(t);
  const report = await backupStore({
    source,
    destination,
    onAfterCopy: async () => fs.writeFile(path.join(source, 'new-topic.md'), '# Проект: new\n', 'utf8'),
  });
  assert.equal(report.consistent, false);
  assert.ok(report.drifted.some(entry => entry.path === 'new-topic.md' && entry.reason === 'appeared-during-backup'));
});

test('backup refuses to nest inside its own source', async t => {
  const { source } = await store(t);
  await assert.rejects(() => backupStore({ source, destination: path.join(source, 'backup') }), /refusing to nest/);
  await assert.rejects(() => backupStore({ source: path.join(source, '.history'), destination: source }), /refusing to nest/);
});

test('an unreadable source file is reported instead of producing a clean-looking backup', async t => {
  const { source, destination } = await store(t);
  const victim = '.history/taskbridge/20261029-100000-00.md';
  // Файл исчезает между обходом каталога и копированием — тот же класс ошибки,
  // что и потеря доступа: манифест не должен выглядеть полным.
  const report = await backupStore({
    source,
    destination,
    onBeforeCopy: async rel => { if (rel === victim) await fs.rm(path.join(source, rel)); },
  });
  assert.equal(report.consistent, false, 'неполная копия не считается консистентной');
  assert.ok(report.errors.some(entry => entry.path === victim && /copy-failed/.test(entry.reason)), JSON.stringify(report.errors));
  assert.equal(report.fileCount, 3);
});

test('restore verification notices a tampered backup file', async t => {
  const { source, destination, restore } = await store(t);
  await backupStore({ source, destination });
  await fs.writeFile(path.join(destination, 'taskbridge.md'), 'подменено', 'utf8');
  const restored = await verifyRestore({ manifestPath: path.join(destination, 'manifest.json'), restoreDir: restore });
  assert.equal(restored.ok, false);
  assert.ok(restored.problems.some(problem => problem.reason === 'restore-mismatch'), JSON.stringify(restored));
});

test('backup and restore refuse existing destination directories', async t => {
  const { source, destination, restore } = await store(t);
  await backupStore({ source, destination });
  await assert.rejects(() => backupStore({ source, destination }), { code: 'EEXIST' });
  await fs.mkdir(restore);
  await fs.writeFile(path.join(restore, 'keep.md'), 'keep');
  await assert.rejects(() => verifyRestore({ manifestPath: path.join(destination, 'manifest.json'), restoreDir: restore }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(restore, 'keep.md'), 'utf8'), 'keep');
});

test('restore rejects manifest path traversal before writing anything', async t => {
  const { source, destination, restore } = await store(t);
  await backupStore({ source, destination });
  const manifestPath = path.join(destination, 'manifest.json');
  const report = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  report.files[0].path = '../escape.md';
  await fs.writeFile(manifestPath, JSON.stringify(report));
  await assert.rejects(() => verifyRestore({ manifestPath, restoreDir: restore }), /invalid manifest path/);
  await assert.rejects(() => fs.stat(restore), { code: 'ENOENT' });
});

test('walkFiles reports the store layout in a stable order', async t => {
  const { source } = await store(t);
  const walked = await walkFiles(source);
  assert.deepEqual(walked.files.map(file => file.rel), [
    '.access.json',
    '.archive/old.20261001-101010.md',
    '.history/taskbridge/20261029-100000-00.md',
    'taskbridge.md',
  ]);
  assert.deepEqual(walked.skipped, []);
});
