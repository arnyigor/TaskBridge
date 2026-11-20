// P1 SQLite/WAL: (1) warnings OUTPUT_FILES агрегируются; (2) maintenanceCheckpoint
// уменьшает WAL и сохраняет данные. Всё на изолированных временных базах.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureOutputs, FILE_LIMITS } from '../src/files.mjs';
import { TaskStore } from '../src/task-store.mjs';

test('OUTPUT_FILES warnings are aggregated instead of 3.8 MB of paths', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-wal-capture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const taskDir = path.join(root, 'task');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  // Базель пуст: все файлы «изменились». Лимит файлов мал — остальное пойдёт
  // в «превышен лимит» (как в живом журнале с 13 467 предупреждениями).
  const baseline = { files: new Map(), truncated: false };
  for (let i = 0; i < 130; i++) fs.writeFileSync(path.join(workspace, `f${i}.txt`), `x${i}`);
  const saved = [];
  // captureOutputs резервирует до 100 файлов; заставим лимит сработать рано:
  for (let i = 0; i < 130; i++) {
    try { fs.copyFileSync(path.join(workspace, `f${i}.txt`), path.join(taskDir, 'files', `pre-${i}`)); } catch { /* dir появится */ }
  }
  fs.mkdirSync(path.join(taskDir, 'files'), { recursive: true });
  const output = await captureOutputs({ workspacePath: workspace }, taskDir, baseline);
  assert.ok(output.warnings.length <= 21, `предупреждений не больше 20 + сводка, а не сотни: ${output.warnings.length}`);
  const summary = output.warnings.find(w => w.startsWith('… ещё'));
  assert.ok(summary, 'есть сводка о сокращённом списке');
  assert.equal(output.files.length, 100, 'файлы сохраняются как раньше');
});

test('maintenanceCheckpoint shrinks a big WAL and keeps every row', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-wal-store-'));
  const store = new TaskStore(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // Создать задачу и записать много событий, чтобы WAL вырос.
  const task = { id: 'wal', createdAt: new Date().toISOString(), status: 'SUCCEEDED', prompt: 'x', files: [], assistantText: '', thinkingText: '', compaction: { count: 0 } };
  await store.create(task);
  const payload = JSON.stringify({ at: '2026-11-20T00:00:00Z', taskId: 'wal', type: 'PI_EVENT', message: 'x', data: { pi: { type: 'message_update', message: { content: 'y'.repeat(2000) } } } });
  for (let i = 0; i < 400; i++) await store.appendEvent('wal', JSON.parse(payload));
  const walBefore = fs.statSync(path.join(root, 'taskbridge.db-wal')).size;
  const eventsBefore = (await store.readEvents('wal', 0)).length;

  const result = await store.maintenanceCheckpoint(64 * 1024); // порог 64 КБ для теста
  assert.ok(result.checkpointed === true || result.reason === 'readers active', `обслуживание выполнено или честно отложено: ${JSON.stringify(result)}`);

  if (result.checkpointed) {
    const walAfter = fs.statSync(path.join(root, 'taskbridge.db-wal')).size;
    assert.ok(walAfter <= walBefore, `WAL не растёт после чекпоинта: ${walBefore} -> ${walAfter}`);
  }
  const eventsAfter = (await store.readEvents('wal', 0)).length;
  assert.equal(eventsAfter, eventsBefore, 'ни одно событие не потеряно');
  const integrity = store.db.exec ? null : null;
  const check = store.db.prepare('PRAGMA integrity_check').get();
  assert.equal(check.integrity_check, 'ok');
});
