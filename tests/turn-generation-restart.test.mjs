// Регресс BUG-P0 (поколения ходов): номер хода обязан переживать рестарт
// сервера. _turn не персистится напрямую (publicTask его вырезает), но
// turnState.turn сохраняется — restoreSessions должен восстанавливать номер,
// иначе после рестарта два разных хода получают одинаковый номер и атрибуция
// терминалов ломается в другую сторону (ревью 2026-11-20).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';

test('turn generation survives a server restart: 5 → 6 → restart → 7', { timeout: 60_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-turn-gen-'));
  const store = new TaskStore(root);
  const makeManager = () => new TaskManager({ projects: [{ id: 'p', path: root, useWorktree: false }] }, root, store);

  const manager1 = makeManager();
  await manager1.init();
  t.after(async () => {
    await manager1.close().catch(() => {});
    await manager2.close().catch(() => {});
    store.close();
    for (let i = 0; i < 10; i++) {
      try { await fs.rm(root, { recursive: true, force: true }); break; }
      catch { await new Promise(r => setTimeout(r, 60)); }
    }
  });

  const task = { id: 'g', createdAt: new Date().toISOString(), status: 'SUCCEEDED', workspacePath: root, prompt: 'gen', files: [], assistantText: '', thinkingText: '', compaction: { count: 0 } };
  await store.create(task);
  manager1.tasks.set('g', task);
  const state = { isStreaming: false };
  const pi = { closed: false, getState: async () => state, prompt: async () => {}, sendFollowUp: async () => {}, abort: async () => {}, killTree: async () => {} };
  const runtime = { pi, eventChain: Promise.resolve(), settleResolvers: [], cancelRequested: false };
  manager1.runtimes.set('g', runtime);
  manager1.runtimeManager.isReady = async () => true;
  manager1.runtimeManager.getBusyStatus = async () => ({ busy: false });

  // Два хода: нумерация доходит до 2 (для чистой задачи это и есть поколения 1→2).
  for (let i = 0; i < 2; i++) {
    await manager1.message('g', `ход ${i + 1}`);
    for (let k = 0; k < 200 && manager1.activeTaskId; k++) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setImmediate(r));
  }
  const saved = await store.read('g');
  const savedTurn = saved?.turnState?.turn ?? saved?.turnState?.turn === 0 ? saved?.turnState?.turn : null;
  assert.equal(savedTurn, 2, `turnState.turn сохранён в снимке: ${JSON.stringify(saved?.turnState)}`);
  assert.equal(manager1.tasks.get('g')._turn, 2);

  // Рестарт: новый менеджер на том же хранилище — init() восстанавливает номер.
  await manager1.close().catch(() => {});
  const manager2 = makeManager();
  await manager2.init();
  const restored = manager2.tasks.get('g');
  assert.ok(restored, 'сессия восстановлена');
  assert.equal(restored._turn, 2, 'номер поколения восстановлен из turnState.turn');

  // Следующий ход — номер 3, не 1: старые события с меньшим номером не властны над ним.
  const pi2 = { closed: false, getState: async () => ({ isStreaming: false }), prompt: async () => {}, sendFollowUp: async () => {}, abort: async () => {}, killTree: async () => {} };
  const runtime2 = { pi: pi2, eventChain: Promise.resolve(), settleResolvers: [], cancelRequested: false };
  manager2.runtimes.set('g', runtime2);
  manager2.runtimeManager.isReady = async () => true;
  manager2.runtimeManager.getBusyStatus = async () => ({ busy: false });
  await manager2.message('g', 'ход после рестарта');
  for (let k = 0; k < 200 && manager2.activeTaskId; k++) await new Promise(r => setTimeout(r, 5));
  assert.equal(manager2.tasks.get('g')._turn, 3, 'номер продолжается, не начинается заново');

  async function unused() {}
  await unused();
});
