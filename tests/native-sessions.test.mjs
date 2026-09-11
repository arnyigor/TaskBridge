import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';

// Native Pi session importer: a terminal session becomes a TaskBridge session.
// "Continue in TaskBridge" must be a safe copy by default — the terminal file is
// never written, locked or claimed — and taking ownership of the original is a
// separate, explicitly confirmed mode (new TZ: clone is the default).

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-native-sessions-'));
  const project = path.join(root, 'project');
  const sessions = path.join(root, 'native');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(sessions, { recursive: true });
  const store = new TaskStore(path.join(root, 'data'));
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const manager = new TaskManager({
    projects: [{ id: 'p', name: 'P', path: project, useWorktree: false }],
    pi: { sessionRoots: [sessions] }
  }, path.join(root, 'data'), store);

  const header = { type: 'session', version: 3, id: 'native-1', timestamp: '2026-09-09T10:00:00.000Z', cwd: project };
  const file = path.join(sessions, 'terminal-session.jsonl');
  const message = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp: '2026-09-09T10:00:00.000Z',
    message: { role, content: [{ type: 'text', text }], timestamp: 123, ...(role === 'assistant' ? { model: 'qwen3.8-27b', provider: 'llamacpp', usage: { totalTokens: 48921 } } : {}) } });
  const entries = [
    message('a', null, 'user', 'Начни с SessionManager'),
    message('b', 'a', 'assistant', 'Да, тогда архитектуру стоит упростить'),
    { type: 'model_change', id: 'c', parentId: 'b', timestamp: '2026-09-09T10:00:00.000Z', provider: 'llamacpp', modelId: 'qwen3.8-27b' },
    { type: 'thinking_level_change', id: 'd', parentId: 'c', timestamp: '2026-09-09T10:00:00.000Z', thinkingLevel: 'medium' },
    message('e', 'd', 'user', 'Не обязательно именно в терминале')
  ];
  const body = [header, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n';
  await fs.writeFile(file, body);
  const resolved = await fs.realpath(file);
  const [listed] = await manager.nativeSessions.list('p');
  assert.ok(listed, 'fixture session must be discoverable');
  const key = listed.key;
  return { root, project, sessions, store, manager, file, body, key, resolved };
}

test('listing groups native sessions by project and suggests the freshly closed one', async t => {
  const f = await fixture(t);
  await fs.utimes(f.file, new Date(), new Date());
  const groups = await f.manager.nativeSessions.listAll();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'p');
  assert.equal(groups[0].sessions.length, 1);
  assert.equal(groups[0].suggestion.key, f.key);
  assert.equal(groups[0].sessions[0].existingTaskId, null);

  // An old session is listed but not suggested.
  await fs.utimes(f.file, new Date(Date.now() - 60 * 60 * 1000), new Date(Date.now() - 60 * 60 * 1000));
  const older = await f.manager.nativeSessions.listAll();
  assert.equal(older[0].suggestion, null);
});

test('preview reports model, thinking level, size and both last messages', async t => {
  const f = await fixture(t);
  const preview = await f.manager.nativeSessions.preview({ projectId: 'p', sessionKey: f.key });
  assert.equal(preview.name, 'terminal-session');
  assert.deepEqual(preview.model, { provider: 'llamacpp', id: 'qwen3.8-27b' });
  assert.equal(preview.thinkingLevel, 'medium');
  assert.equal(preview.tokens, 48921);
  assert.equal(preview.lastUser, 'Не обязательно именно в терминале');
  assert.match(preview.lastAssistant, /архитектуру стоит упростить/);
  assert.equal(preview.messageCount, 3);
  assert.equal(preview.existingTaskId, null);
  await assert.rejects(f.manager.nativeSessions.preview({ projectId: 'p', sessionKey: 'no' }), { code: 'INPUT_INVALID' });
});

test('import clones by default: the terminal file is untouched and unlocked', async t => {
  const f = await fixture(t);
  const task = await f.manager.importSession({ projectId: 'p', sessionKey: f.key });

  // The original session file is exactly as the terminal left it, and no
  // TaskBridge lease was placed next to it.
  assert.equal(await fs.readFile(f.file, 'utf8'), f.body);
  await assert.rejects(fs.access(`${f.file}.taskbridge.lock`));

  // The task continues from its own copy, not from the user's file.
  assert.notEqual(task.piSessionFile, f.file);
  assert.equal(path.basename(task.piSessionFile), 'source-session.jsonl');
  assert.equal(await fs.readFile(task.piSessionFile, 'utf8'), f.body);
  assert.equal(task.piSessionFile.startsWith(path.join(f.manager.dataRoot, 'tasks', task.id)), true);
  assert.equal(task.nativeSource.mode, 'clone');
  assert.equal(task.nativeSource.file, f.resolved);
  assert.equal(task.nativeSession, true);

  // History is imported as events and the session is immediately continuable.
  assert.equal(task.status, 'SUCCEEDED');
  const events = (await f.store.readEvents(task.id, 500)).map(event => event.type);
  assert.ok(events.includes('USER_MESSAGE'));
  assert.ok(events.includes('TASK_SUCCEEDED'));

  // The copy is a valid Pi v3 session for the same project.
  const { readPiSession } = await import('../src/pi-session-index.mjs');
  const reread = await readPiSession(task.piSessionFile, f.project);
  assert.equal(reread.branchMessages.length, 3);
});

test('importing the same session twice reuses the existing TaskBridge session', async t => {
  const f = await fixture(t);
  const first = await f.manager.importSession({ projectId: 'p', sessionKey: f.key });
  const second = await f.manager.importSession({ projectId: 'p', sessionKey: f.key });
  assert.equal(second.id, first.id);
  assert.equal((await f.store.list()).length, 1);
  // The list marks it so the UI can say "already open in TaskBridge".
  const listed = await f.manager.nativeSessions.list('p');
  assert.equal(listed[0].existingTaskId, first.id);
});

test('taking ownership of the original requires an explicit confirmation', async t => {
  const f = await fixture(t);
  await assert.rejects(
    f.manager.importSession({ projectId: 'p', sessionKey: f.key, mode: 'take-over' }),
    /Закройте эту сессию Pi в терминале/
  );
  const task = await f.manager.importSession({ projectId: 'p', sessionKey: f.key, mode: 'take-over', confirmedClosed: true });
  assert.equal(task.piSessionFile, f.resolved);
  assert.equal(task.nativeSource.mode, 'take-over');
});

test('unknown modes and unknown sessions are rejected before anything is written', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.importSession({ projectId: 'p', sessionKey: f.key, mode: 'magic' }), { code: 'INPUT_INVALID' });
  await assert.rejects(
    f.manager.importSession({ projectId: 'p', sessionKey: 'a'.repeat(64) }),
    { code: 'NOT_FOUND' }
  );
  assert.equal((await f.store.list()).length, 0);
});
