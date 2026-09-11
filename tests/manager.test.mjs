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

test('a busy local model queues the prompt instead of refusing it', async t => {
  const f = await fixture(t);
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: true });
  f.manager.queuePollMs = 5;

  // A new session waits its turn instead of losing the operator's prompt.
  const queued = await f.manager.createTask({ prompt: 'new', projectId: 'p' });
  assert.equal(queued.status, 'QUEUED');
  assert.equal(queued.queueReason, 'MODEL_BUSY');
  assert.equal(queued.current, 'Ждёт освобождения локальной модели');
  assert.deepEqual(f.manager.queue, [queued.id]);
  assert.equal(queued.workspacePath, null, 'nothing is prepared while waiting');

  // A follow-up to an existing session is queued the same way: the text is kept,
  // and Pi still has not seen it.
  const followUp = await f.manager.message('a', 'позже');
  assert.equal(followUp.queueReason, 'MODEL_BUSY');
  assert.equal(followUp.pendingPrompts[0].text, 'позже');
  const waitingEvents = await f.store.readEvents('a', 0);
  assert.deepEqual(waitingEvents.map(event => event.type), ['QUEUE_WAITING'], 'only the waiting state is recorded');
  assert.equal(waitingEvents.some(event => event.type === 'USER_MESSAGE'), false, 'nothing is sent to Pi while waiting');
  assert.deepEqual(f.manager.queue, [queued.id, 'a']);

  // Cancelling a waiting session drops its queued prompt.
  const cancelled = await f.manager.cancel('a');
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.pendingPrompts, null);
  assert.equal(cancelled.queueReason, null);
  assert.deepEqual(f.manager.queue, [queued.id]);

  await f.manager.cancel(queued.id);
  assert.deepEqual(f.manager.queue, []);
});

test('a queued prompt is delivered as soon as the model is free', async t => {
  const f = await fixture(t);
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: true });
  f.manager.queuePollMs = 5;
  const queued = await f.manager.message('a', 'позже');
  assert.equal(queued.pendingPrompts[0].text, 'позже');

  // The model frees up: the queue delivers the stored prompt unchanged.
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: false });
  for (let i = 0; i < 200 && !f.sent.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.sent, ['позже']);
  const events = (await f.store.readEvents('a', 0)).map(event => event.type);
  assert.ok(events.includes('USER_MESSAGE'), events.join(','));
  assert.ok(events.includes('QUEUE_WAITING'), events.join(','));
  const task = f.manager.getTask('a');
  assert.deepEqual(task.pendingPrompts, []);
  assert.equal(task.queueReason, null);
  assert.deepEqual(f.manager.queue, []);

  // Let the detached settle path finish (while the store is still open) instead
  // of leaving a 12h timer and a late write behind.
  for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
  for (let i = 0; i < 200 && f.manager.activeTaskId; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setImmediate(resolve));
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

test('a second submission is rejected while the first admission is still pending', async t => {
  const f = await fixture(t, true);
  // #message asks Pi for its state before deciding queue vs delivery, so the
  // stub parks only the first call: that is the admission the guard must see.
  let calls = 0;
  let release;
  f.pi.getState = () => {
    if (calls++ === 0) return new Promise(resolve => { release = () => resolve({ isStreaming: true }); });
    return Promise.resolve({ isStreaming: true });
  };
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

test('restart restores a queued prompt and fails only what was really running', async t => {
  const f = await fixture(t);
  // Never started: the prompt was never sent anywhere, so it survives.
  await f.store.save({ ...f.task, id: 'queued', status: 'QUEUED', workspacePath: null, prompt: 'никогда не стартовала' });
  // Already running: its Pi process is gone, so it cannot continue.
  await f.store.save({ ...f.task, id: 'running', status: 'RUNNING', workspacePath: f.root });
  await f.manager.init();

  assert.equal(f.manager.getTask('running').errorCode, 'FAILED_RECOVERY');
  const restored = f.manager.getTask('queued');
  assert.equal(restored.status, 'QUEUED');
  assert.equal(restored.queueReason, 'RESTORED');
  assert.deepEqual(f.manager.queue, ['queued']);
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

test('send now bypasses the queue, and a queued prompt can be sent or dropped early', async t => {
  const f = await fixture(t);
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: true });
  f.manager.queuePollMs = 5;
  // A delivered prompt leaves a "wait for Pi to settle" waiter behind; resolving
  // it here mirrors what the real Pi event loop does and keeps the test clean.
  const settle = async () => {
    for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
    // The finalizer releases the model slot asynchronously.
    for (let i = 0; i < 100 && f.manager.activeTaskId; i++) await new Promise(resolve => setTimeout(resolve, 5));
  };

  // Ctrl+Enter: the prompt goes to Pi immediately, even while the model is busy.
  const now = await f.manager.message('a', 'срочно', 'auto', [], null, { now: true });
  assert.equal(now.pendingPrompts, undefined);
  assert.deepEqual(f.sent, ['срочно']);
  assert.equal((await f.store.readEvents('a', 0)).some(event => event.type === 'USER_MESSAGE'), true);
  await settle();

  // Plain send queues instead.
  const queued = await f.manager.message('a', 'потом');
  assert.equal(queued.pendingPrompts[0].text, 'потом');
  assert.deepEqual(f.manager.queue, ['a']);

  // "Send now" on the queued prompt delivers it at once and clears the queue.
  f.sent.length = 0;
  const sentNow = await f.manager.sendPendingNow('a');
  await settle();
  assert.deepEqual(f.sent, ['потом']);
  assert.deepEqual(sentNow.pendingPrompts, [], 'the queue entry is gone');
  assert.deepEqual(f.manager.queue, []);
  assert.equal((await f.store.readEvents('a', 0)).filter(event => event.type === 'USER_MESSAGE').length, 2);

  // Dropping a queued prompt neither sends it nor loses the session.
  const dropped = await f.manager.message('a', 'лишнее');
  assert.equal(dropped.pendingPrompts[0].text, 'лишнее');
  const after = await f.manager.dropPending('a');
  assert.deepEqual(after.pendingPrompts, [], 'the queue entry is gone');
  assert.equal(after.queueReason, null);
  assert.equal(after.status, 'SUCCEEDED');
  assert.deepEqual(f.manager.queue, []);
  assert.deepEqual(f.sent, ['потом'], 'nothing extra was sent');

  // Actions on an empty queue are rejected instead of silently doing nothing.
  await assert.rejects(f.manager.sendPendingNow('a'), { code: 'INPUT_INVALID' });
  await assert.rejects(f.manager.dropPending('a'), { code: 'INPUT_INVALID' });
  await settle();
});

test('Enter queues even when the model is free, and several messages wait in order', async t => {
  const f = await fixture(t);
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: true });
  f.manager.queuePollMs = 5;
  const waitFor = async (check, what) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), `timed out waiting for ${what}`);
  };
  const settle = async () => {
    for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
    for (let i = 0; i < 100 && f.manager.activeTaskId; i++) await new Promise(resolve => setTimeout(resolve, 5));
  };

  // Nothing is lost when several prompts are typed in a row: they accumulate and
  // are delivered one turn at a time, in order.
  await f.manager.message('a', 'первое', 'auto', [], null, { queue: true });
  await f.manager.message('a', 'второе', 'auto', [], null, { queue: true });
  const third = await f.manager.message('a', 'третье', 'auto', [], null, { queue: true });
  assert.deepEqual(third.pendingPrompts.map(entry => entry.text), ['первое', 'второе', 'третье']);

  // The model frees up: the queue drains in order, one prompt per turn.
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: false });
  await waitFor(() => f.sent.length === 1, 'the first prompt');
  assert.deepEqual(f.sent, ['первое']);
  await settle();
  await waitFor(() => f.sent.length === 2, 'the second prompt');
  assert.deepEqual(f.sent, ['первое', 'второе']);
  await settle();
  await waitFor(() => f.sent.length === 3, 'the third prompt');
  assert.deepEqual(f.sent, ['первое', 'второе', 'третье']);
  await settle();
  assert.deepEqual(f.manager.getTask('a').pendingPrompts, []);
  assert.deepEqual(f.manager.queue, []);

  // With a free model the queued prompt is picked up at once, not on the retry
  // tick: an idle session must still feel like a normal chat.
  const quick = await f.manager.message('a', 'быстро', 'auto', [], null, { queue: true });
  assert.deepEqual(quick.pendingPrompts.map(entry => entry.text), ['быстро']);
  await waitFor(() => f.sent.length === 4, 'the immediate pickup');
  assert.equal(f.sent.at(-1), 'быстро');
  await settle();
});

test('a message to another session waits in that session queue instead of being refused', async t => {
  const f = await fixture(t);
  // 'b' exists and the machine is owned by 'a' (a running session).
  const other = { ...f.task, id: 'b', status: 'SUCCEEDED', workspacePath: f.root, prompt: 'другая' };
  await f.store.create(other);
  f.manager.tasks.set('b', other);
  f.manager.activeTaskId = 'a';
  f.task.status = 'RUNNING';
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: true });
  f.manager.queuePollMs = 5;

  const queued = await f.manager.message('b', 'подожду', 'auto', [], null, { queue: false });
  assert.equal(queued.queueReason, 'BUSY');
  assert.equal(queued.pendingPrompts[0].text, 'подожду');
  assert.deepEqual(f.manager.queue, ['b'], 'the session waits its turn');
  assert.equal(f.manager.getTask('b').status, 'QUEUED');

  // Ctrl+Enter cannot create a second writer either: it queues as well.
  const urgent = await f.manager.message('b', 'срочно', 'auto', [], null, { now: true });
  assert.deepEqual(urgent.pendingPrompts.map(entry => entry.text), ['подожду', 'срочно']);
});

test('send now refuses while another session owns the machine and keeps the prompt', async t => {
  const f = await fixture(t);
  const other = { ...f.task, id: 'b', status: 'RUNNING', workspacePath: f.root, prompt: 'занята' };
  await f.store.create(other);
  f.manager.tasks.set('b', other);
  f.manager.activeTaskId = 'b';
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: true });

  const queued = await f.manager.message('a', 'хочу сейчас');
  assert.equal(queued.queueReason, 'BUSY', 'the machine is owned by another session');

  // "Сейчас" cannot mean a second parallel generation: the refusal names the
  // owner, and the prompt stays in the queue instead of vanishing.
  await assert.rejects(f.manager.sendPendingNow('a'), /занята сессией/);
  const task = f.manager.getTask('a');
  assert.deepEqual(task.pendingPrompts.map(entry => entry.text), ['хочу сейчас']);
  assert.deepEqual(f.manager.queue, ['a'], 'still waiting its turn');
  assert.equal(f.sent.length, 0, 'Pi still has not seen it');
});
