import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';

// Changing the thinking level of a STOPPED session must save the level and show
// it as the effective one right away: the session picks it up at its next start
// (#selectionArgs passes --thinking), and a stale thinkingLevelActual reads as
// «кнопка не работает» in the chat.

const baseTask = (over = {}) => ({
  id: 'a', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  status: 'CANCELLED', workspacePath: os.tmpdir(), files: [], attachments: [], outputFiles: [],
  compaction: { count: 0 }, assistantText: '', thinkingText: '',
  model: { provider: 'strata', id: 'qwen3.8-flash-next-iq3-s', reasoning: true },
  thinkingLevel: 'medium', thinkingLevelActual: 'medium',
  ...over,
});

const makeManager = async (t, dataRootSuffix) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), dataRootSuffix));
  const store = new TaskStore(dataRoot);
  t.after(async () => { store.close(); await fs.rm(dataRoot, { recursive: true, force: true }); });
  return { manager: new TaskManager({ projects: [] }, dataRoot, store), store };
};

test('a stopped session keeps the changed level and shows it as the effective one', async t => {
  const { manager, store } = await makeManager(t, 'taskbridge-thinking-stopped-');
  const t0 = baseTask();
  await store.create(t0);
  manager.tasks.set('a', t0);

  const out = await manager.setThinkingLevel('a', 'high');
  assert.equal(out.thinkingLevel, 'high');
  // No live Pi: the level is saved and applied at the next start, so the
  // effective level is the saved one right away, not the stale old value.
  assert.equal(out.thinkingLevelActual, 'high');
});

test('a live session still shows what Pi really applied, not the request', async t => {
  const { manager, store } = await makeManager(t, 'taskbridge-thinking-live-');
  const t0 = baseTask({ status: 'RUNNING' });
  await store.create(t0);
  manager.tasks.set('a', t0);
  // Pi clamps or keeps the level; the read-back state wins over the request.
  manager.runtimes.set('a', { pi: { closed: false, setThinkingLevel: async () => {}, getState: async () => ({ thinkingLevel: 'medium' }) } });

  const out = await manager.setThinkingLevel('a', 'high');
  assert.equal(out.thinkingLevel, 'high');
  assert.equal(out.thinkingLevelActual, 'medium');
});

test('a retired runtime behaves like a stopped one', async t => {
  const { manager, store } = await makeManager(t, 'taskbridge-thinking-retired-');
  const t0 = baseTask();
  await store.create(t0);
  manager.tasks.set('a', t0);
  manager.runtimes.set('a', { pi: { closed: true } });

  const out = await manager.setThinkingLevel('a', 'high');
  assert.equal(out.thinkingLevel, 'high');
  assert.equal(out.thinkingLevelActual, 'high');
});
