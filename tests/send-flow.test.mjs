import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';

async function setupFixture(t, streaming = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-send-test-'));
  const store = new TaskStore(root);
  const manager = new TaskManager({ projects: [{ id: 'p', path: root, useWorktree: false }] }, root, store);
  manager.queuePollMs = 100000; // prevent async pump race during quick unit assertions
  t.after(async () => {
    manager.closing = true;
    if (manager.pumpTimer) clearTimeout(manager.pumpTimer);
    store.close();
    // A background finalizer (settle → verify) spawns git with the temp
    // workspace as its CWD; on Windows the rmdir then fails with EBUSY until
    // that child exits. Retry instead of failing the test.
    for (let i = 0; i < 20; i++) {
      try { await fs.rm(root, { recursive: true, force: true }); return; }
      catch (error) { if (error.code !== 'EBUSY') throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const task = {
    id: 't1',
    createdAt: new Date().toISOString(),
    status: streaming ? 'RUNNING' : 'SUCCEEDED',
    workspacePath: root,
    prompt: 'initial prompt',
    files: [],
    compaction: { count: 0 }
  };
  await store.create(task);
  manager.tasks.set('t1', task);
  const sent = [];
  const pi = {
    closed: false,
    getState: async () => ({ isStreaming: streaming }),
    prompt: async (text) => { sent.push(text); },
    sendFollowUp: async (text) => { sent.push(text); },
    abort: async () => {},
    killTree: async () => {}
  };
  const runtime = { pi, eventChain: Promise.resolve(), settleResolvers: [], cancelRequested: false };
  manager.runtimes.set('t1', runtime);
  manager.runtimeManager.isReady = async () => true;
  manager.runtimeManager.getBusyStatus = async () => ({ busy: false, loaded: true });
  return { manager, store, task, pi, runtime, sent, root };
}

test('immediate send while model idle completes quickly and persists user message', async (t) => {
  const f = await setupFixture(t, false);
  const res = await f.manager.message('t1', 'hello world', 'auto', [], null, { now: true, queue: false });
  assert.equal(res.status, 'RUNNING');
  assert.deepEqual(f.sent, ['hello world']);
  const events = await f.store.readEvents('t1', 0);
  const userMsg = events.find(e => e.type === 'USER_MESSAGE');
  assert.ok(userMsg);
  assert.equal(userMsg.data.text, 'hello world');

  for (const waiter of f.runtime.settleResolvers.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
});

test('queue send while model busy parks prompt cleanly and does not lose text', async (t) => {
  const f = await setupFixture(t, true); // currently running & streaming
  const res = await f.manager.message('t1', 'queued text', 'auto', [], null, { now: false, queue: true });
  assert.ok(res.pendingPrompts);
  assert.equal(res.pendingPrompts.length, 1);
  assert.equal(res.pendingPrompts[0].text, 'queued text');
  assert.deepEqual(f.sent, []); // not sent immediately
});

test('cold model queues prompt and sets MODEL_LOADING reason', async (t) => {
  const f = await setupFixture(t, false);
  f.manager.runtimeManager.getBusyStatus = async () => ({ busy: false, loaded: false });
  const res = await f.manager.message('t1', 'cold prompt', 'auto', [], null, { now: false, queue: true });
  assert.equal(res.queueReason, 'MODEL_LOADING');
  assert.equal(res.pendingPrompts[0].text, 'cold prompt');
});
