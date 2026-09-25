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
  const manager = new TaskManager({ projects: [{ id: 'p', path: root, useWorktree: false }] }, root, store);
  t.after(async () => {
    await manager.close().catch(() => {});
    store.close();
    for (let i = 0; i < 10; i++) {
      try { await fs.rm(root, { recursive: true, force: true }); break; }
      catch { await new Promise(r => setTimeout(r, 60)); }
    }
  });
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

// Cutting in never stops anything: only the model itself or STOP ends a command.
// While the turn streams the text goes in as steering, so the command in flight
// finishes and the model answers the new text next.
function recordSteering(f) {
  const modes = [];
  let aborts = 0;
  f.pi.abort = async () => { aborts += 1; };
  f.pi.sendFollowUp = async (text, mode) => { f.sent.push(text); modes.push(mode); };
  return { modes, aborts: () => aborts };
}

test('send-now cuts in as steering: the turn and its command keep running, the queue stays', async t => {
  const f = await fixture(t, true);
  f.manager.activeTaskId = 'a';
  const pi = recordSteering(f);
  f.manager.toolLogs.set('a:t1', { name: 'tool-t1.log', bytes: 0 });
  f.task.pendingPrompts = [{ id: 'p1', text: 'потом', mode: 'auto', files: [] }];
  f.manager.pendingFiles.set('p1', { files: [], uploadToken: null });
  await f.manager.message('a', 'срочно', 'auto', [], null, { now: true });
  assert.equal(pi.aborts(), 0, 'the turn and the command in it are not stopped');
  assert.deepEqual(f.sent, ['срочно']);
  assert.deepEqual(pi.modes, ['steer'], 'the text goes into the running turn');
  const types = (await f.store.readEvents('a', 0)).map(event => event.type);
  assert.ok(!types.includes('TASK_CANCELLED'), types.join(','));
  assert.ok(types.includes('USER_MESSAGE'), types.join(','));
  assert.equal(f.manager.getTask('a').status, 'RUNNING');
  assert.equal(f.manager.activeTaskId, 'a', 'the running turn still owns the machine');
  assert.deepEqual((f.task.pendingPrompts || []).map(p => p.text), ['потом'], 'the queue is not touched');
  assert.ok(f.manager.pendingFiles.has('p1'), 'the staged files of the queued prompt stay');
});

test('the queued «Отправить сейчас» targets one pendingId and steers into the run', async t => {
  const f = await fixture(t, true);
  f.manager.activeTaskId = 'a';
  const pi = recordSteering(f);
  await f.manager.message('a', 'второе', 'auto', [], null, { queue: true });
  // A follow-up would wait for the end of the turn again: "now" steers it in.
  f.task.pendingPrompts[0].mode = 'follow_up';
  const [first] = f.task.pendingPrompts;
  await f.manager.sendPendingNow('a', first.id);
  assert.equal(pi.aborts(), 0, '«Отправить сейчас» does not stop the running turn');
  assert.deepEqual(f.sent, ['второе']);
  assert.deepEqual(pi.modes, ['steer']);
  assert.deepEqual(f.task.pendingPrompts || [], [], 'the delivered prompt left the queue');
  const types = (await f.store.readEvents('a', 0)).map(event => event.type);
  assert.ok(!types.includes('TASK_CANCELLED'), types.join(','));
});

test('pending IDs select identical messages and stale actions never affect another entry', async t => {
  const f = await fixture(t, true);
  f.manager.activeTaskId = 'a';
  await f.manager.message('a', 'same', 'auto', [], null, { queue: true });
  await f.manager.message('a', 'same', 'auto', [], null, { queue: true });
  const [first, second] = f.task.pendingPrompts;
  await f.manager.dropPending('a', second.id);
  await f.manager.dropPending('a', second.id);
  await f.manager.sendPendingNow('a', second.id);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.task.pendingPrompts.map(p => p.id), [first.id]);
  await f.manager.sendPendingNow('a', first.id);
  await f.manager.sendPendingNow('a', first.id);
  assert.deepEqual(f.sent, ['same']);
});

test('dropping a follow-up before the workspace exists preserves the initial queued task', async t => {
  const f = await fixture(t);
  f.manager.activeTaskId = 'other';
  f.task.workspacePath = null;
  f.task.status = 'QUEUED';
  await f.manager.message('a', 'follow-up', 'auto', [], null, { queue: true });
  await f.manager.dropPending('a', f.task.pendingPrompts[0].id);
  assert.equal(f.task.status, 'QUEUED');
  assert.equal(f.task.prompt, 'original');
  assert.ok(f.manager.queue.includes('a'));
});

test('removing the last queued prompt does not finish the active generation', async t => {
  const f = await fixture(t, true);
  f.manager.activeTaskId = 'a';
  await f.manager.message('a', 'remove me', 'auto', [], null, { queue: true });
  const after = await f.manager.dropPending('a');
  assert.equal(after.status, 'RUNNING');
  assert.equal(f.manager.activeTaskId, 'a');
  assert.deepEqual(after.pendingPrompts, []);
  const events = await f.store.readEvents('a', 0);
  assert.equal(events.some(e => e.type === 'TASK_SUCCEEDED' || e.type === 'TASK_CANCELLED'), false);
});

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
  assert.deepEqual(waitingEvents.map(event => event.type), ['QUEUE_WAITING', 'PROMPT_QUEUED'], 'only the waiting state and the queued entry are recorded');
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

  // Actions on an empty queue: «Отправить сейчас» silently no-ops — the pump may
  // have already delivered the only queued prompt, and an error for a message
  // that was sent is worse than silence. Dropping still rejects.
  const idle = await f.manager.sendPendingNow('a');
  assert.deepEqual(idle.pendingPrompts, [], 'nothing was sent and nothing is queued');
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

test('a rejected commandId replays the same error and delivery flags conflict', async t => {
  const f = await fixture(t, true); // streaming: now → steer, queue → park
  f.pi.sendFollowUp = async () => { throw Object.assign(new Error('fixture refused'), { code: 'PI_REJECTED' }); };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      () => f.manager.message('a', 'reject me', 'auto', [], null, { now: true, commandId: 'reject-1' }),
      error => error.code === 'PI_REJECTED' && /fixture refused/.test(error.message),
    );
  }
  assert.equal(f.manager.commandLedger.get('reject-1')?.status, 'REJECTED');

  // The same commandId with a different delivery intent is a conflict, not a replay.
  await f.manager.message('a', 'queued', 'auto', [], null, { queue: true, commandId: 'delivery-1' });
  await assert.rejects(
    () => f.manager.message('a', 'queued', 'auto', [], null, { now: true, commandId: 'delivery-1' }),
    { code: 'CONFLICT' },
  );
  await f.manager.cancel('a');
});

test('an in-flight commandId is refused as ACCEPTED, not re-run', async t => {
  const f = await fixture(t);
  // Pre-seed an in-flight entry with the exact payload hash so the guard sees it.
  const args = ['a', 'ещё', 'auto', [], null, false, false];
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
  const hash = createHash('sha256').update(JSON.stringify(['a', 'crash', 'auto', [], null, false, false])).digest('hex');
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

test('a queued prompt survives a send-now', async t => {
  const f = await fixture(t, true);
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

test('regenerateLastTurn keeps the previous answer as a variant', async t => {
  const f = await fixture(t); // settled session with a fake Pi
  // Resolving the settle waiter runs the finalizer while the store is still
  // open; waiting for the model slot to clear keeps its write from landing
  // after the test closed the database.
  const settle = async () => {
    for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
    for (let i = 0; i < 100 && f.manager.activeTaskId; i++) await new Promise(resolve => setTimeout(resolve, 5));
  };
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'USER_MESSAGE', message: 'вопрос', data: { text: 'вопрос' } });
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'PI_EVENT', message: '', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ответ А' } } } });
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'TASK_SUCCEEDED', message: 'Done', data: {} });

  const task = await f.manager.regenerateLastTurn('a', 'assistant-1');
  assert.equal(task.status, 'RUNNING', 'the same question goes to the model again');
  assert.deepEqual(f.sent, ['вопрос'], 'and Pi actually sees it');
  await settle();
  const events = await f.store.readEvents('a', 0);
  const marker = events.find(event => event.type === 'TURN_VARIANT_START');
  assert.ok(marker, events.map(event => event.type).join(','));
  assert.deepEqual({ turnSeq: marker.data.turnSeq, text: marker.data.text }, { turnSeq: 1, text: 'вопрос' });
  assert.ok(events.some(event => event.data?.pi?.assistantMessageEvent?.delta === 'ответ А'), 'the previous answer is not deleted');
  assert.equal(events.filter(event => event.type === 'USER_MESSAGE').length, 1, 'the question is not duplicated');

  // A second variant may be made from the newest one — but only from a settled session.
  f.manager.tasks.get('a').status = 'SUCCEEDED';
  f.sent.length = 0;
  await f.manager.regenerateLastTurn('a', `assistant-${marker.data.variantId}`);
  await settle();
  const marks = (await f.store.readEvents('a', 0)).filter(event => event.type === 'TURN_VARIANT_START');
  assert.equal(marks.length, 2);
  assert.equal(new Set(marks.map(mark => mark.data.variantId)).size, 2, 'each variant has its own id');
  assert.deepEqual(f.sent, ['вопрос']);

  // Anything that is not an answer of the newest exchange is refused, and so is
  // regenerating while the session works.
  f.manager.tasks.get('a').status = 'SUCCEEDED';
  await assert.rejects(() => f.manager.regenerateLastTurn('a', 'assistant-initial'), err => err.code === 'NOT_ALLOWED');
  f.manager.tasks.get('a').status = 'RUNNING';
  await assert.rejects(() => f.manager.regenerateLastTurn('a', 'assistant-1'), err => err.code === 'NOT_ALLOWED');
});

test('selectVariant persists the chosen answer and validates it', async t => {
  const f = await fixture(t);
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'USER_MESSAGE', message: 'вопрос', data: { text: 'вопрос' } });
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'TURN_VARIANT_START', message: '', data: { turnSeq: 1, variantId: 'v2' } });
  const result = await f.manager.selectVariant('a', { turnSeq: 1, variantId: '1' });
  assert.deepEqual(result, { ok: true, turnSeq: 1, variantId: '1', total: 2 });
  const events = await f.store.readEvents('a', 0);
  assert.equal(events.at(-1).type, 'TURN_VARIANT_SELECTED');
  assert.deepEqual(events.at(-1).data, { turnSeq: 1, variantId: '1' });
  await assert.rejects(() => f.manager.selectVariant('a', { turnSeq: 1, variantId: 'нет' }), err => err.code === 'NOT_FOUND');
  await assert.rejects(() => f.manager.selectVariant('a', { turnSeq: 9, variantId: '1' }), err => err.code === 'NOT_FOUND');
});

test('continueTurn appends to the existing answer instead of a new exchange', async t => {
  const f = await fixture(t);
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'USER_MESSAGE', message: 'вопрос', data: { text: 'вопрос' } });
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'PI_EVENT', message: '', data: { pi: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Вот причины:' }] } } } });
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'TASK_SUCCEEDED', message: 'Done', data: {} });

  const task = await f.manager.continueTurn('a', 'assistant-1');
  assert.equal(task.status, 'RUNNING');
  assert.deepEqual(f.sent, ['Продолжи свой предыдущий ответ ровно с того места, где он оборвался. Не повторяй уже написанное и не добавляй вступлений — продолжай текст сразу.']);
  const events = await f.store.readEvents('a', 0);
  assert.equal(events.filter(event => event.type === 'USER_MESSAGE').length, 1, 'no second question is announced');
  assert.equal(events.some(event => event.type === 'TURN_VARIANT_START'), false, 'no variant is created: the answer grows');
  assert.equal(events.some(event => event.type === 'TURN_TRUNCATED'), false, 'nothing is dropped');

  await assert.rejects(() => f.manager.continueTurn('a', 'assistant-999'), err => err.code === 'NOT_ALLOWED');
  // The run's settle waiter must not keep a 12h timer alive after the test.
  for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
});

test('continueTurn accepts an interrupted answer whose last message is empty', async t => {
  const f = await fixture(t);
  const pi = message => ({ at: new Date().toISOString(), taskId: 'a', type: 'PI_EVENT', message: '', data: { pi: { type: 'message_end', message } } });
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'USER_MESSAGE', message: 'вопрос', data: { text: 'вопрос' } });
  await f.store.appendEvent('a', pi({ role: 'assistant', content: [{ type: 'text', text: 'Смотрю код.' }, { type: 'toolCall', name: 'read' }], stopReason: 'toolUse' }));
  // Stopped mid-answer: the closing message is aborted and has no content.
  await f.store.appendEvent('a', pi({ role: 'assistant', content: [], stopReason: 'aborted' }));
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'TASK_CANCELLED', message: 'Cancelled', data: {} });

  const task = await f.manager.continueTurn('a', 'assistant-1');
  assert.equal(task.status, 'RUNNING');
  for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
});

test('continueTurn refuses an answer that produced nothing', async t => {
  const f = await fixture(t);
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'USER_MESSAGE', message: 'вопрос', data: { text: 'вопрос' } });
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'PI_EVENT', message: '', data: { pi: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'хм' }], stopReason: 'aborted' } } } });
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'TASK_CANCELLED', message: 'Cancelled', data: {} });
  await assert.rejects(() => f.manager.continueTurn('a', 'assistant-1'), err => err.code === 'INPUT_INVALID');
});

test('an answer can be edited in place or branched into another variant', async t => {
  const f = await fixture(t);
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'USER_MESSAGE', message: 'вопрос', data: { text: 'вопрос' } });
  await f.store.appendEvent('a', { at: new Date().toISOString(), taskId: 'a', type: 'PI_EVENT', message: '', data: { pi: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ответ А' }] } } } });

  // In place: the record is corrected, no model is asked, no variant is made.
  const inplace = await f.manager.editTurn('a', { turnId: 'assistant-1', text: 'ответ А (исправлен)' });
  assert.deepEqual(inplace, { ok: true, turnId: 'assistant-1', role: 'assistant', branch: false });
  const events = await f.store.readEvents('a', 0);
  assert.ok(events.some(event => event.type === 'TURN_EDITED' && event.data.text === 'ответ А (исправлен)'));
  assert.equal(events.some(event => event.type === 'TURN_VARIANT_START'), false);

  // As a branch: the edited text becomes another variant of the same exchange.
  const branched = await f.manager.editTurn('a', { turnId: 'assistant-1', text: 'ответ Б', branch: true });
  assert.equal(branched.branch, true);
  assert.ok(branched.variantId);
  const marks = (await f.store.readEvents('a', 0)).filter(event => event.type === 'TURN_VARIANT_START');
  assert.equal(marks.length, 1);
  assert.deepEqual({ turnSeq: marks[0].data.turnSeq, editedText: marks[0].data.editedText }, { turnSeq: 1, editedText: 'ответ Б' });

  // Anything that is not an answer of the newest exchange is refused.
  await assert.rejects(() => f.manager.editTurn('a', { turnId: 'assistant-initial', text: 'x' }), err => err.code === 'NOT_ALLOWED');
  await assert.rejects(() => f.manager.editTurn('a', { turnId: 'assistant-1', text: '   ' }), err => err.code === 'INPUT_INVALID');
});

test('a cancel that overlaps a new delivery does not mark the running answer as stopped', async t => {
  const f = await fixture(t, true); // RUNNING session, Pi streaming
  // The interleaving that used to corrupt the turn: while the cancel is still
  // finalizing, the delivery of the next message starts a new run and resets
  // the cancel flag. A terminal TASK_CANCELLED written after that would mark the
  // fresh answer as «прервано».
  f.pi.abort = async () => {
    f.runtime.cancelRequested = false;
    f.manager.tasks.get('a').status = 'RUNNING';
  };
  await f.manager.cancel('a');
  const types = (await f.store.readEvents('a', 0)).map(event => event.type);
  assert.equal(types.includes('TASK_CANCELLED'), false, `отмена не должна перебить новый запуск: ${types.join(',')}`);
  assert.equal(f.manager.getTask('a').status, 'RUNNING');
});

test('a plain cancel still records TASK_CANCELLED', async t => {
  const f = await fixture(t, true);
  f.pi.abort = async () => {};
  await f.manager.cancel('a');
  const types = (await f.store.readEvents('a', 0)).map(event => event.type);
  assert.ok(types.includes('TASK_CANCELLED'), types.join(','));
  assert.equal(f.manager.getTask('a').status, 'CANCELLED');
});

// The finalizer of turn 1 must not release the machine slot after a newer turn
// has already taken the session over. Reproduced deterministically: the last
// artifact write of the finalizer is slowed down, and TASK_SUCCEEDED triggers a
// follow-up — exactly the race window a remote FOLLOW_UP hits in production.
test('a follow-up accepted while the turn is finalizing keeps the queue slot', async t => {
  const f = await fixture(t);
  const { manager, store, runtime, sent, task } = f;
  manager.queuePollMs = 20;

  // Slow down the finalizer's last artifact write (result.json): at that point
  // task.status is already SUCCEEDED, but the finalizer has not released the
  // slot yet — the exact window a follow-up enters through alreadyFinished.
  let armed = false;
  let slowedResolve;
  const slowed = new Promise(resolve => { slowedResolve = resolve; });
  const original = store.writeArtifact.bind(store);
  store.writeArtifact = async (...args) => {
    if (armed) {
      armed = false;
      await new Promise(r => setTimeout(r, 25));
      slowedResolve();
    }
    return original(...args);
  };

  let followUpStarted = false;
  manager.on('task-event', event => {
    if (event.type === 'TASK_SUCCEEDED' && !followUpStarted) {
      followUpStarted = true;
      armed = true;
      manager.message('a', 'второе').catch(() => {});
    }
  });

  const first = await manager.message('a', 'первое');
  assert.equal(first.status, 'RUNNING');
  for (const waiter of runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }

  await slowed;
  for (let i = 0; i < 200 && task._turn !== 2; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(task._turn, 2, 'the follow-up must start a new turn during finalization');

  // The new turn owns the machine: the old finalizer must not have released it.
  assert.equal(manager.activeTaskId, 'a', 'the slot must stay with the live turn');

  // While turn 2 is generating, another session must not start in parallel.
  const queued = await manager.createTask({ prompt: 'новая сессия', projectId: 'p' });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(manager.getTask(queued.id).status, 'QUEUED', 'no parallel task may start while the turn is live');

  await manager.deleteTask(queued.id).catch(() => {});
  for (let i = 0; i < 200 && !runtime.settleResolvers.length; i++) await new Promise(r => setTimeout(r, 5));
  for (const waiter of runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
  for (let i = 0; i < 200 && manager.getTask('a').status !== 'SUCCEEDED'; i++) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(sent, ['первое', 'второе']);
  assert.equal(manager.getTask('a').status, 'SUCCEEDED');
});

test('pending prompt files survive TaskBridge restart without being dropped', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-restart-files-test-'));
  const store = new TaskStore(root);
  const m1 = new TaskManager({ projects: [{ id: 'p', path: root, useWorktree: false }] }, root, store);
  const m2 = new TaskManager({ projects: [{ id: 'p', path: root, useWorktree: false }] }, root, store);
  t.after(async () => {
    await m1.close().catch(() => {});
    await m2.close().catch(() => {});
    store.close();
    for (let i = 0; i < 10; i++) {
      try { await fs.rm(root, { recursive: true, force: true }); break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
  });

  // 1. TaskManager instance 1: session queues a prompt with files while model is busy
  m1.runtimeManager.isReady = async () => true;
  m1.runtimeManager.getBusyStatus = async () => ({ busy: true });
  m1.queuePollMs = 10000;

  const task = { id: 'restart-files-task', createdAt: new Date().toISOString(), status: 'QUEUED', workspacePath: null, prompt: 'init', files: [], assistantText: '', thinkingText: '', compaction: { count: 0 } };
  await store.create(task);
  m1.tasks.set('restart-files-task', task);

  const filePayload = [{ name: 'important.txt', size: 4, base64: Buffer.from('data').toString('base64') }];
  const queued = await m1.message('restart-files-task', 'документ в очереди', 'auto', filePayload);
  assert.equal(queued.pendingPrompts.length, 1);

  // Verify pending-files.json exists on disk
  const pendingDiskFile = path.join(store.taskDir('restart-files-task'), 'pending-files.json');
  const diskData = JSON.parse(await fs.readFile(pendingDiskFile, 'utf8'));
  assert.ok(diskData[queued.pendingPrompts[0].id], 'pending files must be written to disk');

  // Once workspace is prepared, session can deliver on restart
  task.workspacePath = root;
  await store.save(task);

  // 2. TaskManager instance 2: simulates process restart over same store/data
  m2.runtimeManager.isReady = async () => true;
  m2.runtimeManager.getBusyStatus = async () => ({ busy: false });
  m2.queuePollMs = 10;

  // Mock Pi for delivery
  const sent = [];
  const pi = { closed: false, getState: async () => ({ isStreaming: false }), prompt: async text => { sent.push(text); }, sendFollowUp: async text => { sent.push(text); }, abort: async () => {}, killTree: async () => {} };
  m2.runtimes.set('restart-files-task', { pi, eventChain: Promise.resolve(), settleResolvers: [], cancelRequested: false });

  await m2.init();
  assert.ok(m2.queue.includes('restart-files-task'), 'task must be restored to queue');

  // Wait for delivery by pump
  for (let i = 0; i < 100 && !sent.length; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(sent.length, 1, 'queued message must be delivered after restart');
  assert.ok(sent[0].includes('документ в очереди'), 'prompt text preserved');
  assert.ok(sent[0].includes('important.txt'), 'attached file must be preserved after restart');

  // pending-files.json is cleaned up after the delivered prompt is persisted;
  // that write/delete happens a tick after Pi accepted the prompt, so poll
  // briefly instead of racing it.
  let fileLeft = true;
  for (let i = 0; i < 50 && fileLeft; i++) {
    fileLeft = await fs.access(pendingDiskFile).then(() => true, () => false);
    if (fileLeft) await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(fileLeft, false, 'pending-files.json must be removed once delivered');

  for (const waiter of m2.runtimes.get('restart-files-task').settleResolvers.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
  await m2.close();
});
