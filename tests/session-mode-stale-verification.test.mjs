// Переключение режима отвечало «Сессия занята» спустя дни после проверки:
// `verificationStatus` оставался `RUNNING`, если процесс умер посреди проверки
// (или сама проверка бросила исключение). Ни один из путей не доводил статус до
// терминального, а `setSessionMode` считает `RUNNING` доказательством того, что
// в рабочей папке ещё работают команды с правами агента, и отказывает в смене
// режима навсегда.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { restoreSessions } from '../src/application/session-recovery.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';

async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new TaskStore(root);
  t.after(async () => {
    store.close();
    for (let i = 0; i < 10; i++) {
      try { await fs.rm(root, { recursive: true, force: true }); break; }
      catch { await new Promise(r => setTimeout(r, 60)); }
    }
  });
  return { root, store };
}

test('a verification without a process is not restored as RUNNING', async t => {
  const { store } = await tempRoot(t, 'taskbridge-restore-stale-');
  const running = { id: 'a', status: 'SUCCEEDED', verificationStatus: 'RUNNING', verification: [] };
  const passed = { id: 'b', status: 'SUCCEEDED', verificationStatus: 'PASSED', verification: [] };
  await restoreSessions([running, passed], {
    store,
    enqueue: () => {},
    restorePendingFiles: async () => {},
    onRestored: () => {},
    continuePrompt: 'continue',
  });
  assert.equal(running.verificationStatus, 'INTERRUPTED', 'никто уже не выполняет эту проверку');
  assert.equal(passed.verificationStatus, 'PASSED', 'завершённый итог не переписывается');
  assert.equal((await store.list()).find(task => task.id === 'a').verificationStatus, 'INTERRUPTED', 'закрытый статус сохранён на диск');
});

test('mode switching works again once the stale check is closed', async t => {
  const { root, store } = await tempRoot(t, 'taskbridge-stale-check-');
  const manager = new TaskManager({ projects: [{ id: 'p', path: root, useWorktree: false }] }, root, store);
  t.after(async () => { await manager.close().catch(() => {}); });
  const task = {
    id: 'stale', createdAt: new Date().toISOString(), status: 'SUCCEEDED',
    workspacePath: root, projectId: 'p', prompt: 'original', files: [],
    assistantText: '', thinkingText: '', compaction: { count: 0 },
    verificationStatus: 'RUNNING', verification: [],
  };
  await store.create(task);
  manager.tasks.set(task.id, task);

  // The record a killed process left behind: the status alone is not a running check.
  await assert.rejects(manager.setSessionMode(task.id, 'plan'), error => error.code === 'BUSY');
  task.verificationStatus = 'INTERRUPTED';
  const switched = await manager.setSessionMode(task.id, 'plan');
  assert.equal(switched.mode, 'plan');
});
