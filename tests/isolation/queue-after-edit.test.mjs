// Регресс BUG-P0 (2026-11-20, журнал b2451ed63c8b): сообщение, поставленное
// в очередь ВО ВРЕМЯ хода после Edit→Resend, пропало — его ход открылся
// (DISPATCHING) и завершился «Done» за 1 с без единого обращения к Pi.
// Терминал того же цикла был опубликован с раздутым turn (18 вместо 17):
// _turn увеличили steering/ensureSession, и терминалы читали task._turn
// вместо номера, зафиксированного при открытии хода.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';

test('a message queued during a post-edit turn is prompted to Pi and its terminal keeps the opened turn number', { timeout: 90_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-queue-edit-'));
  const store = new TaskStore(root);
  const manager = new TaskManager({ projects: [{ id: 'p', path: root, useWorktree: false }] }, root, store);
  t.after(async () => {
    await manager.close().catch(() => {});
    store.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const task = { id: 'a', createdAt: new Date().toISOString(), status: 'SUCCEEDED', workspacePath: root, prompt: 'original', files: [], assistantText: 'saved', thinkingText: '', compaction: { count: 0 } };
  await store.create(task);
  manager.tasks.set('a', task);

  const sent = [];
  const state = { isStreaming: false };
  const pi = { closed: false, getState: async () => ({ ...state }), prompt: async text => { sent.push(text); }, sendFollowUp: async text => { sent.push(text); }, abort: async () => {}, killTree: async () => {} };
  const runtime = { pi, eventChain: Promise.resolve(), settleResolvers: [], cancelRequested: false };
  manager.runtimes.set('a', runtime);
  manager.runtimeManager.isReady = async () => true;
  manager.runtimeManager.getBusyStatus = async () => ({ busy: false });

  // Ход 1: оператор шлёт вопрос; фейковый Pi не шлёт agent_settled —
  // сеттл разрешаем руками, как это делает реальный Pi.
  await manager.message('a', 'вопрос после правки', 'auto', [], null, { commandId: 'cmd-1' });
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.ok(sent.includes('вопрос после правки'), `Pi получил вопрос: ${JSON.stringify(sent)}`);
  for (const waiter of runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));

  // Ход 2: сообщение уходит в очередь и доставляется после сеттла первого.
  const second = await manager.message('a', 'вклинившийся вопрос', 'auto', [], null, { commandId: 'cmd-2', queue: true });
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.ok(sent.includes('вклинившийся вопрос'), `Pi получил квебовое сообщение: ${JSON.stringify(sent)}`);
  for (const waiter of runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));

  // Терминалы: каждый ход публикует СВОЙ номер поколения — строго возрастающие,
  // без раздувания от steering/очереди (журнал 2026-11-20: SUCCEEDED с turn=18
  // вместо 17).
  const events2 = await store.readEvents('a', 0);
  const terminals = events2.filter(e => e.type === 'TASK_SUCCEEDED').map(e => e.data?.turn).filter(Number.isFinite);
  assert.equal(terminals.length, 2, `два терминала: ${JSON.stringify(terminals)}`);
  assert.ok(terminals[0] < terminals[1], `номера строго растут, без раздувания: ${JSON.stringify(terminals)}`);
});
