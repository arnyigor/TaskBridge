import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';

async function fixture(t, streaming = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-manager-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TaskStore(root);
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
  assert.deepEqual(messages[0].data.files, [{ name: 'file.txt', size: 1 }]);
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

test('server recovery terminates persisted queued sessions too', async t => {
  const f = await fixture(t);
  await f.store.save({ ...f.task, status: 'QUEUED' });
  await f.manager.init();
  assert.equal(f.manager.getTask('a').errorCode, 'FAILED_RECOVERY');
});
