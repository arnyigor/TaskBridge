// Статус проверки оставался `RUNNING`, если процесс умер посреди проверки
// (или сама проверка бросила исключение). Ни один из путей не доводил статус до
// терминального, а.restoreSessions после перезапуска записывал его на диск как
// «вечно идущую» проверку. Восстановление теперь закрывает такой статус как
// INTERRUPTED: результат неизвестен, а не пройден и не провален.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { restoreSessions } from '../src/application/session-recovery.mjs';
import { TaskStore } from '../src/task-store.mjs';

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
