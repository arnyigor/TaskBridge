import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { prepareProjectWorkspace, collectGitState, git } from '../src/git.mjs';

async function fixture(t, streaming = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-manager-test-'));
  const store = new TaskStore(root);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const manager = new TaskManager({ projects: [{ id: 'p', path: root, useWorktree: false }] }, root, store);
  const task = { id: 'a', createdAt: new Date().toISOString(), status: streaming ? 'RUNNING' : 'SUCCEEDED', workspacePath: root, prompt: 'original', files: [], assistantText: 'saved', thinkingText: '', compaction: { count: 0 } };
  await store.create(task);
  manager.tasks.set('a', task);
  const sent = [];
  const pi = { closed: false, getState: async () => ({ isStreaming: streaming }), prompt: async text => { sent.push(text); }, sendFollowUp: async text => { sent.push(text); }, abort: async () => {}, killTree: async () => {} };
  const runtime = { pi, eventChain: Promise.resolve(), settleResolvers: [], cancelRequested: false };
  manager.runtimes.set('a', runtime);
  manager.runtimeManager.isReady = async () => true;
  manager.runtimeManager.getBusyStatus = async () => ({ busy: false });
  return { manager, store, task, pi, runtime, sent, root };
}

test('busy model rejects new sessions and follow-ups before writing history or attachments', async t => {
  const f = await fixture(t);
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: true });
  await assert.rejects(f.manager.createTask({ prompt: 'new', projectId: 'p' }), { code: 'MODEL_BUSY' });
  await assert.rejects(f.manager.message('a', 'new', 'auto', [{ name: 'file.txt', base64: 'eA==' }]), { code: 'MODEL_BUSY' });
  assert.equal((await f.store.list()).length, 1);
  assert.deepEqual(await f.store.readEvents('a', 0), []);
  await assert.rejects(fs.access(path.join(f.root, '.taskbridge-input')));
});

test('trusted cloud task ids are validated and collisions are rejected before admission', async t => {
  const f = await fixture(t);
  f.manager.activeTaskId = 'a';
  await assert.rejects(f.manager.createTask({ prompt: 'new', projectId: 'p' }, { requestedId: '../bad' }), { code: 'INPUT_INVALID' });
  await assert.rejects(f.manager.createTask({ prompt: 'duplicate', projectId: 'p' }, { requestedId: 'a' }), { code: 'ID_CONFLICT' });
  assert.equal((await f.store.list()).length, 1);
});

test('registerProject persists to config.projects and rejects a duplicate id; removeProject removes both and rejects an unknown id', async t => {
  const f = await fixture(t);
  f.manager.registerProject({ id: 'q', name: 'Q', path: '/tmp/q', useWorktree: false, verification: [] });
  assert.ok(f.manager.projects.has('q'));
  assert.ok(f.manager.config.projects.some(p => p.id === 'q'));
  assert.throws(() => f.manager.registerProject({ id: 'q', name: 'dup', path: '/tmp/x' }), { code: 'INPUT_INVALID' });

  f.manager.removeProject('q');
  assert.ok(!f.manager.projects.has('q'));
  assert.ok(!f.manager.config.projects.some(p => p.id === 'q'));
  assert.ok(f.manager.projects.has('p')); // the original fixture project is untouched
  assert.throws(() => f.manager.removeProject('q'), { code: 'NOT_FOUND' });
});

test('RPC failure leaves no phantom message, active reservation, or settle timer', async t => {
  const f = await fixture(t);
  f.pi.prompt = async () => { throw new Error('RPC rejected'); };
  await assert.rejects(f.manager.message('a', 'retry me'), /RPC rejected/);
  assert.deepEqual(await f.store.readEvents('a', 0), []);
  assert.equal(f.manager.activeTaskId, null);
  assert.equal(f.runtime.settleResolvers.length, 0);
  assert.equal(f.task.assistantText, 'saved');
});

test('accepted steering stores user text and attachment metadata separately', async t => {
  const f = await fixture(t, true);
  f.manager.activeTaskId = 'a';
  // The occupied model slot belongs to this streaming Pi session.
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: true });
  await f.manager.message('a', 'read this', 'auto', [{ name: 'file.txt', size: 1, base64: 'eA==' }]);
  const messages = (await f.store.readEvents('a', 0)).filter(x => x.type === 'USER_MESSAGE');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message, 'read this');
  assert.equal(messages[0].data.files.length, 1);
  assert.equal(messages[0].data.files[0].name, 'file.txt');
  assert.equal(messages[0].data.files[0].size, 1);
  assert.match(f.sent[0], /Additional files/);
});

test('simultaneous submissions are rejected while the first admission is pending', async t => {
  const f = await fixture(t, true);
  let release;
  f.pi.getState = () => new Promise(resolve => { release = () => resolve({ isStreaming: true }); });
  const first = f.manager.message('a', 'one');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.manager.message('a', 'two'), { code: 'BUSY' });
  release();
  await first;
  assert.equal((await f.store.readEvents('a', 0)).filter(x => x.type === 'USER_MESSAGE').length, 1);
});

test('repeated cancellation produces one terminal event', async t => {
  const f = await fixture(t, true);
  await Promise.all([f.manager.cancel('a'), f.manager.cancel('a')]);
  assert.equal(f.task.status, 'CANCELLED');
  assert.equal((await f.store.readEvents('a', 0)).filter(x => x.type === 'TASK_CANCELLED').length, 1);
});

test('deleting a task removes its scratch workspace, pi-sessions and workspace input copy', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-cleanup-data-'));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-cleanup-ws-'));
  const store = new TaskStore(dataRoot);
  t.after(async () => {
    store.close();
    await fs.rm(dataRoot, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  });
  const manager = new TaskManager({ projects: [] }, dataRoot, store);
  await fs.mkdir(path.join(dataRoot, 'pi-sessions', 'a'), { recursive: true });
  await fs.mkdir(path.join(dataRoot, 'workspaces', 'a'), { recursive: true });
  await fs.mkdir(path.join(scratch, '.taskbridge-input', 'a', 'file-1'), { recursive: true });
  await fs.writeFile(path.join(scratch, '.taskbridge-input', 'a', 'file-1', 'x.txt'), 'x');
  const task = { id: 'a', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'SUCCEEDED', workspacePath: scratch, files: [], attachments: [], outputFiles: [] };
  await store.create(task);
  manager.tasks.set('a', task);
  await manager.deleteTask('a');
  const exists = value => fs.access(value).then(() => true, () => false);
  assert.equal(await exists(path.join(dataRoot, 'pi-sessions', 'a')), false);
  assert.equal(await exists(path.join(dataRoot, 'workspaces', 'a')), false);
  assert.equal(await exists(path.join(scratch, '.taskbridge-input', 'a')), false);
  assert.equal(await exists(path.join(dataRoot, 'tasks', 'a')), false);
});

test('startup sweeps orphaned pi-sessions and workspaces for unknown task ids', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-sweep-data-'));
  const store = new TaskStore(dataRoot);
  t.after(async () => { store.close(); await fs.rm(dataRoot, { recursive: true, force: true }); });
  await fs.mkdir(path.join(dataRoot, 'pi-sessions', 'orphan'), { recursive: true });
  await fs.mkdir(path.join(dataRoot, 'workspaces', 'orphan'), { recursive: true });
  const task = { id: 'kept', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'SUCCEEDED' };
  await store.create(task);
  await fs.mkdir(path.join(dataRoot, 'pi-sessions', 'kept'), { recursive: true });
  const manager = new TaskManager({ projects: [] }, dataRoot, store);
  await manager.init();
  const exists = value => fs.access(value).then(() => true, () => false);
  assert.equal(await exists(path.join(dataRoot, 'pi-sessions', 'orphan')), false);
  assert.equal(await exists(path.join(dataRoot, 'workspaces', 'orphan')), false);
  assert.equal(await exists(path.join(dataRoot, 'pi-sessions', 'kept')), true);
});

test('server recovery terminates persisted queued sessions too', async t => {
  const f = await fixture(t);
  await f.store.save({ ...f.task, status: 'QUEUED' });
  await f.manager.init();
  assert.equal(f.manager.getTask('a').errorCode, 'FAILED_RECOVERY');
});

test('applyTask applies the result patch to a clean source, then cleanup removes the worktree', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-apply-data-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-apply-repo-'));
  const store = new TaskStore(dataRoot);
  t.after(async () => {
    store.close();
    await fs.rm(dataRoot, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  });
  await git(['init', repo], os.tmpdir());
  await git(['config', 'user.name', 'Test'], repo);
  await git(['config', 'user.email', 'test@example.invalid'], repo);
  await git(['config', 'core.autocrlf', 'false'], repo);
  await fs.writeFile(path.join(repo, 'base.txt'), 'base\n');
  await git(['add', '.'], repo);
  await git(['commit', '-m', 'Base'], repo);

  const prepared = await prepareProjectWorkspace({ path: repo, useWorktree: true }, 'w', dataRoot);
  await fs.writeFile(path.join(prepared.workspacePath, 'base.txt'), 'base\nchanged\n');
  const state = await collectGitState(prepared.workspacePath);

  const manager = new TaskManager({ projects: [{ id: 'p', path: repo, useWorktree: true }] }, dataRoot, store);
  const task = {
    id: 'w', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'SUCCEEDED',
    worktree: true, sourcePath: repo, workspacePath: prepared.workspacePath, baseCommit: prepared.baseCommit,
    projectId: 'p', prompt: 'edit', files: [], attachments: [], outputFiles: []
  };
  await store.create(task);
  await store.writeArtifact('w', 'diff.patch', state.diff);
  manager.tasks.set('w', task);

  const applied = await manager.applyTask('w');
  assert.deepEqual(applied.applied.files, ['base.txt']);
  assert.equal(await fs.readFile(path.join(repo, 'base.txt'), 'utf8'), 'base\nchanged\n');
  // A dirty source now blocks another apply unless it is forced.
  await assert.rejects(manager.applyTask('w'), { code: 'PROJECT_DIRTY' });
  await manager.cleanupWorktree('w');
  await assert.rejects(fs.access(prepared.workspacePath));
  assert.equal(manager.getTask('w').workspacePath, null);
  await assert.rejects(manager.cleanupWorktree('w'), { code: 'INPUT_INVALID' });
});

test('setModel switches the session model and records the selection', async t => {
  const f = await fixture(t);
  const seen = [];
  f.pi.setModel = async (provider, modelId) => { seen.push([provider, modelId]); return { provider, id: modelId, contextWindow: 4096, maxTokens: 512 }; };
  const updated = await f.manager.setModel('a', 'ollama', 'glm-5');
  assert.deepEqual(seen, [['ollama', 'glm-5']]);
  assert.deepEqual(updated.model, { provider: 'ollama', id: 'glm-5', contextWindow: 4096, maxTokens: 512 });
  assert.deepEqual(updated.requestedModel, { provider: 'ollama', id: 'glm-5' });
  assert.equal(updated.thinkingLevelActual, null);
  const events = (await f.store.readEvents('a', 0)).filter(e => e.type === 'MODEL_SWITCH');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.provider, 'ollama');
});

test('setModel refuses while Pi is streaming and rejects malformed selections', async t => {
  const streaming = await fixture(t, true);
  await assert.rejects(streaming.manager.setModel('a', 'ollama', 'glm-5'), { code: 'BUSY' });
  const f = await fixture(t);
  await assert.rejects(f.manager.setModel('a', 'ollama', ''), { code: 'INPUT_INVALID' });
  await assert.rejects(f.manager.setModel('missing', 'ollama', 'glm-5'), { code: 'NOT_FOUND' });
});

test('setThinkingLevel stores the level and applies it to a live session', async t => {
  const f = await fixture(t);
  const seen = [];
  f.pi.setThinkingLevel = async (level) => { seen.push(level); };
  const updated = await f.manager.setThinkingLevel('a', 'high');
  assert.deepEqual(seen, ['high']);
  assert.equal(updated.thinkingLevel, 'high');
  assert.equal(updated.thinkingLevelActual, 'high');
  await assert.rejects(f.manager.setThinkingLevel('a', ''), { code: 'INPUT_INVALID' });
  const events = (await f.store.readEvents('a', 0)).filter(e => e.type === 'THINKING_LEVEL');
  assert.equal(events.length, 1);
});
