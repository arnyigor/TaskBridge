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
  // The prompt reaches Pi before the USER_MESSAGE record is written (the RPC
  // acknowledgement comes first), so wait for the durable event, not just for
  // the send.
  let events = [];
  for (let i = 0; i < 200; i++) {
    events = (await f.store.readEvents('a', 0)).map(event => event.type);
    if (events.includes('USER_MESSAGE')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
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

test('Enter waits its turn while the model is busy, and several messages keep their order', async t => {
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

  // An idle session takes Enter straight away: `queue` means "wait your turn",
  // not "always park". Parking an idle chat made every message flash «В очереди»
  // and wait for the next pump tick.
  const quick = await f.manager.message('a', 'быстро', 'auto', [], null, { queue: true });
  assert.deepEqual(quick.pendingPrompts || [], [], 'nothing to wait for, nothing queued');
  await waitFor(() => f.sent.length === 4, 'the immediate send');
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

test('a session created while another one works waits in the queue instead of failing', async t => {
  const f = await fixture(t);
  f.task.status = 'RUNNING';
  f.manager.activeTaskId = 'a';
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: true });
  f.manager.queuePollMs = 5;

  // The old code threw "Модель уже выполняет другую сессию" (409 MODEL_BUSY) and
  // the operator's prompt was lost; now it is queued like any other.
  const created = await f.manager.createTask({ projectId: 'p', prompt: 'новая сессия' });
  assert.equal(created.status, 'QUEUED');
  assert.equal(created.queueReason, 'BUSY');
  assert.equal(created.current, 'В очереди');
  assert.ok(f.manager.queue.includes(created.id));
  const events = await f.store.readEvents(created.id, 0);
  assert.deepEqual(events.map(event => event.type), ['QUEUE_WAITING'], 'the wait is recorded, nothing was lost');
});

// The queue must be self-healing: whatever waits in it gets another chance on
// the poll tick, even when the wake-up that should have started it was lost.
// "Сообщение висит в очереди, хотя модель уже ответила" is exactly this failure.
test('a wake-up that arrives while the machine is busy is not lost', async t => {
  const f = await fixture(t);
  f.manager.queuePollMs = 20;
  const waitFor = async (check, what) => {
    for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), `timed out waiting for ${what}`);
  };

  // Another session owns the machine while the prompt is typed.
  f.manager.activeTaskId = 'other';
  const queued = await f.manager.message('a', 'подожду', 'auto', [], null, { queue: true });
  assert.deepEqual(queued.pendingPrompts.map(entry => entry.text), ['подожду']);
  assert.deepEqual(f.manager.queue, ['a']);
  assert.deepEqual(f.sent, [], 'nothing goes out while the machine is taken');

  // That session ends somewhere else entirely: nobody calls the pump. The queue
  // must notice by itself instead of waiting for the next user action.
  f.manager.activeTaskId = null;
  await waitFor(() => f.sent.length === 1, 'the queued prompt to go out on its own');
  assert.deepEqual(f.sent, ['подожду']);
  assert.deepEqual(f.manager.getTask('a').pendingPrompts, []);
  for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
});

test('a session waiting for a busy local model does not hold up the rest of the queue', async t => {
  const f = await fixture(t);
  f.manager.queuePollMs = 20;
  const waitFor = async (check, what) => {
    for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), `timed out waiting for ${what}`);
  };

  // 'a' needs the local model, which another consumer is holding.
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: true });
  await f.manager.message('a', 'жду модель', 'auto', [], null, { queue: true });

  // 'b' runs on a remote model: it has nothing to wait for.
  const remote = { ...f.task, id: 'b', status: 'SUCCEEDED', prompt: 'другая', model: { provider: 'anthropic', id: 'claude' }, pendingPrompts: null, files: [] };
  await f.store.create(remote);
  f.manager.tasks.set('b', remote);
  const remoteSent = [];
  f.manager.runtimes.set('b', {
    pi: { closed: false, getState: async () => ({ isStreaming: false }), prompt: async text => { remoteSent.push(text); }, sendFollowUp: async text => { remoteSent.push(text); }, abort: async () => {}, killTree: async () => {} },
    eventChain: Promise.resolve(), settleResolvers: [], cancelRequested: false
  });
  await f.manager.message('b', 'мне модель не нужна', 'auto', [], null, { queue: true });

  await waitFor(() => remoteSent.length === 1, 'the remote session to run past the blocked one');
  assert.deepEqual(remoteSent, ['мне модель не нужна']);
  assert.deepEqual(f.sent, [], 'the local one is still waiting for its model');
  assert.equal(f.manager.getTask('a').queueReason, 'MODEL_BUSY');
  for (const waiter of f.manager.runtimes.get('b').settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
  f.manager.queue = [];
});

test('a cancelled session at the head of the queue does not stall what is behind it', async t => {
  const f = await fixture(t);
  f.manager.queuePollMs = 20;
  const waitFor = async (check, what) => {
    for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), `timed out waiting for ${what}`);
  };

  // A dead entry at the head (cancelled between queueing and the pump) used to
  // stop the pump for good: it was shifted, and nothing re-ran it.
  f.manager.activeTaskId = 'other';
  const dead = { ...f.task, id: 'dead', status: 'CANCELLED', prompt: 'отменённая', pendingPrompts: null, files: [] };
  await f.store.create(dead);
  f.manager.tasks.set('dead', dead);
  f.manager.queue.push('dead');
  await f.manager.message('a', 'я за ним', 'auto', [], null, { queue: true });
  assert.deepEqual(f.manager.queue, ['dead', 'a']);

  f.manager.activeTaskId = null;
  await waitFor(() => f.sent.length === 1, 'the prompt behind the cancelled session');
  assert.deepEqual(f.sent, ['я за ним']);
  assert.deepEqual(f.manager.queue, []);
  for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
});

// Graceful shutdown mirrors RuntimeControl.closePi: close stdin first, and only
// force-kill a process that refuses to exit. The router is stopped too, and no
// new work starts afterwards.
test('close() shuts the Pi and the router down gracefully', async t => {
  const f = await fixture(t);
  let stdinClosed = 0;
  let killed = 0;
  let routerStopped = 0;
  const proc = { pid: 4242, exitCode: 0 }; // already exited -> no forced kill
  const pi = {
    closed: false,
    proc,
    getState: async () => ({ isStreaming: false }),
    prompt: async () => {}, sendFollowUp: async () => {},
    abort: async () => {}, killTree: async () => { killed++; },
    closeStdin: () => { stdinClosed++; }
  };
  f.runtime.pi = pi;
  f.manager.localModels = { enabled: true, stop: async () => { routerStopped++; } };

  await f.manager.close();

  assert.equal(stdinClosed, 1, 'close stdin is requested first');
  assert.equal(killed, 0, 'an already-exited process is not force-killed');
  assert.equal(routerStopped, 1, 'the always-on router is stopped');
  assert.equal(f.manager.runtimes.size, 0, 'no live runtime is left behind');
  assert.equal(f.manager.closing, true, 'closing is latched');
});

test('close() force-kills a Pi that refuses to exit in time', async t => {
  const f = await fixture(t);
  let killed = 0;
  // `proc` never emits close and has no exit code: waitProcessClose resolves
  // false after 2500ms and close() falls back to killTree().
  const proc = { pid: 9999, exitCode: null, signalCode: null, once: () => {}, removeListener: () => {} };
  const pi = {
    closed: false,
    proc,
    getState: async () => ({ isStreaming: false }),
    prompt: async () => {}, sendFollowUp: async () => {},
    abort: async () => {}, killTree: async () => { killed++; },
    closeStdin: () => {}
  };
  f.runtime.pi = pi;
  await f.manager.close();
  assert.equal(killed, 1, 'the stuck process is force-killed');
  assert.equal(f.manager.runtimes.size, 0);
});

test('commandId dedupes a retry and conflicts on changed content', async t => {
  const f = await fixture(t);
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: true });
  f.manager.queuePollMs = 5;

  const first = await f.manager.message('a', 'один раз', 'auto', [], null, { queue: true, commandId: 'cmd-1' });
  assert.equal((first.pendingPrompts || []).length, 1, 'first call stores one prompt');

  // Duplicate commandId+payload replays the saved result instead of firing again.
  const second = await f.manager.message('a', 'один раз', 'auto', [], null, { queue: true, commandId: 'cmd-1' });
  assert.equal(second.id, first.id);
  assert.equal((second.pendingPrompts || []).length, 1, 'replay did not double the prompt');
  assert.equal(f.manager.commandLedger.size, 1);

  // Same commandId with different content is a conflict, executed by no one.
  await assert.rejects(
    () => f.manager.message('a', 'другой', 'auto', [], null, { queue: true, commandId: 'cmd-1' }),
    { code: 'CONFLICT' },
  );
  assert.equal((f.manager.tasks.get('a').pendingPrompts || []).length, 1, 'the conflicting call changed nothing');

  await f.manager.cancel('a');
});

test('an in-flight commandId is refused as ACCEPTED, not re-run', async t => {
  const f = await fixture(t);
  // Pre-seed an in-flight entry with the exact payload hash so the guard sees it.
  const args = ['a', 'ещё', 'auto', [], null];
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(JSON.stringify(args)).digest('hex');
  f.manager.commandLedger.set('inflight-1', { hash: digest, done: false, result: null, at: Date.now() });

  await assert.rejects(
    () => f.manager.message('a', 'ещё', 'auto', [], null, { commandId: 'inflight-1' }),
    { code: 'ACCEPTED' },
  );
});

test('command dedup survives a restart via the SQLite ledger', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cmd-durable-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const busy = async () => ({ busy: true }); // queue, so no Pi pipeline is needed
  const makeTask = (store) => ({ id: 'a', createdAt: new Date().toISOString(), status: 'SUCCEEDED', workspacePath: root, prompt: 'x', files: [], assistantText: '', thinkingText: '', compaction: { count: 0 } });

  // First process: execute the command once.
  const store1 = new TaskStore(root);
  const m1 = new TaskManager({ projects: [{ id: 'p', path: root, useWorktree: false }] }, root, store1);
  await m1.init();
  await store1.create(makeTask(store1));
  m1.tasks.set('a', { id: 'a', createdAt: new Date().toISOString(), status: 'SUCCEEDED', workspacePath: root, prompt: 'x', files: [], assistantText: '', thinkingText: '', compaction: { count: 0 } });
  m1.runtimeManager.isReady = async () => true;
  m1.runtimeManager.getBusyStatus = busy;
  m1.queuePollMs = 5;
  const r1 = await m1.message('a', 'привет', 'auto', [], null, { queue: true, commandId: 'dc-1' });
  assert.equal((r1.pendingPrompts || []).length, 1, 'first process queued the prompt once');
  await m1.close();
  store1.close();

  // Second process "restarts" on the same data root with an empty ledger.
  const store2 = new TaskStore(root);
  const m2 = new TaskManager({ projects: [{ id: 'p', path: root, useWorktree: false }] }, root, store2);
  await m2.init();
  m2.runtimeManager.isReady = async () => true;
  m2.runtimeManager.getBusyStatus = busy;
  m2.queuePollMs = 5;

  const stored = store2.getCommand('dc-1');
  assert.ok(stored && stored.done, 'the command is persisted as done');

  // The replayed result must not enqueue the prompt a second time.
  const r2 = await m2.message('a', 'привет', 'auto', [], null, { queue: true, commandId: 'dc-1' });
  assert.equal((r2.pendingPrompts || []).length, 1, 'restart replay did not double the prompt');

  await m2.close();
  store2.close();
});

test('an unfinished command after crash is UNKNOWN_AFTER_CRASH, never re-run', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cmd-crash-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const store = new TaskStore(root);
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(JSON.stringify(['a', 'crash', 'auto', [], null])).digest('hex');
  // Simulate: a command was ACCEPTED right before the process died.
  store.upsertCommand('crashed-1', { hash, done: false });

  const m = new TaskManager({ projects: [{ id: 'p', path: root, useWorktree: false }] }, root, store);
  await m.init();
  m.runtimeManager.isReady = async () => true;
  m.runtimeManager.getBusyStatus = async () => ({ busy: true });
  await assert.rejects(
    () => m.message('a', 'crash', 'auto', [], null, { commandId: 'crashed-1' }),
    { code: 'UNKNOWN_AFTER_CRASH' },
  );
  await m.close();
  store.close();
});

test('commandId dedupes cancel too (same result, different intent conflicts)', async t => {
  const f = await fixture(t);
  const first = await f.manager.cancel('a', { commandId: 'cc-1' });
  assert.equal(first.status, 'SUCCEEDED'); // terminal task: returns as-is

  // Duplicate commandId+payload replays the stored result without cancel work.
  const second = await f.manager.cancel('a', { commandId: 'cc-1' });
  assert.equal(second.id, first.id);
  assert.ok(f.manager.commandLedger.get('cc-1'), 'cancel recorded in the ledger');

  // Same commandId with a different intent (different task) is a conflict.
  await assert.rejects(() => f.manager.cancel('other', { commandId: 'cc-1' }), { code: 'CONFLICT' });
});

test('commandStatus reports clientId and status after completion', async t => {
  const f = await fixture(t);
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: true });
  f.manager.queuePollMs = 5;
  await f.manager.message('a', 'статус', 'auto', [], null, { queue: true, commandId: 'cs-1', clientId: 'phone-x' });
  const st = f.manager.commandStatus('cs-1');
  assert.equal(st.status, 'COMPLETED');
  assert.equal(st.clientId, 'phone-x');
  assert.equal(st.done, true);
  assert.equal(f.manager.commandStatus('no-such-id'), null);
  await f.manager.cancel('a');
});

test('a failing project check never fails a completed answer and never holds the slot', async t => {
  const f = await fixture(t);
  f.task.projectId = 'p';
  // The project has a check that fails, like a red `npm test` suite.
  f.manager.projects.get('p').verification = ['node -e "process.exit(3)"'];

  await f.manager.message('a', 'go', 'auto', [], null, { now: true });
  // Mirror the real Pi event loop: release the settle waiter.
  for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }

  // Wait for the detached verification to store its verdict.
  for (let i = 0; i < 300; i++) {
    const task = f.manager.getTask('a');
    if (task.status === 'SUCCEEDED' && task.verificationStatus !== 'RUNNING') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const task = f.manager.getTask('a');
  // The answer is complete: the check's failure is reported separately, never as
  // "One or more verification commands failed", and never as a FAILED task.
  assert.equal(task.status, 'SUCCEEDED');
  assert.equal(task.error, null);
  assert.equal(task.errorCode, null);
  assert.equal(task.verificationStatus, 'FAILED');
  assert.equal(task.verification[0].ok, false);

  // The slot is free as soon as the turn is published, so a follow-up is sent
  // straight away instead of landing in the queue behind the checks.
  f.manager.projects.get('p').verification = [];
  f.sent.length = 0;
  const follow = await f.manager.message('a', 'next', 'auto', [], null, { now: true });
  assert.equal(follow.pendingPrompts, undefined, 'the follow-up was not queued');
  assert.deepEqual(f.sent, ['next']);

  // Let the second turn settle while the store is still open.
  for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
  for (let i = 0; i < 200 && f.manager.activeTaskId; i++) await new Promise(resolve => setTimeout(resolve, 5));
});

test('send-now stops the reasoning in flight so the message reaches Pi immediately', async t => {
  const f = await fixture(t, true); // RUNNING session with Pi streaming
  let aborts = 0;
  let aborted = false;
  f.pi.abort = async () => { aborts += 1; aborted = true; };
  f.pi.getState = async () => ({ isStreaming: !aborted });
  await f.manager.message('a', 'срочно', 'auto', [], null, { now: true });
  assert.equal(aborts, 1, 'the answer in flight was stopped');
  assert.deepEqual(f.sent, ['срочно'], 'the text was delivered as a fresh message');
  const types = (await f.store.readEvents('a', 0)).map(event => event.type);
  assert.ok(types.includes('TASK_CANCELLED'), `the interrupted turn is honest: ${types.join(',')}`);
  assert.ok(types.includes('USER_MESSAGE'), types.join(','));
  assert.equal(f.manager.getTask('a').status, 'RUNNING', 'and the new turn is running');
  for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
});

test('send-now never interrupts a running tool call', async t => {
  const f = await fixture(t, true);
  let aborts = 0;
  f.pi.abort = async () => { aborts += 1; };
  f.manager.toolLogs.set('a:t1', { name: 'tool-t1.log', bytes: 0 });
  await f.manager.message('a', 'текст', 'auto', [], null, { now: true });
  assert.equal(aborts, 0, 'aborting a tool call would leave half-applied side effects');
  assert.deepEqual(f.sent, ['текст'], 'the message still reaches Pi (as steering)');
});

test('a queued prompt survives the send-now interrupt', async t => {
  const f = await fixture(t, true);
  let aborted = false;
  f.pi.abort = async () => { aborted = true; };
  f.pi.getState = async () => ({ isStreaming: !aborted });
  const task = f.manager.tasks.get('a');
  task.pendingPrompts = [{ id: 'p1', text: 'потом', mode: 'auto', files: [] }];
  f.manager.pendingFiles.set('p1', { files: [], uploadToken: null });
  await f.manager.message('a', 'срочно', 'auto', [], null, { now: true });
  // Cutting in must not drop what the operator already queued: the prompt is
  // never released without being delivered.
  const pending = (f.manager.tasks.get('a').pendingPrompts || []).map(p => p.text);
  assert.ok(pending.includes('потом') || f.sent.includes('потом'), JSON.stringify({ pending, sent: f.sent }));
  assert.ok(f.manager.pendingFiles.has('p1'), 'the staged files of the queued prompt were not released');
  for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
});
