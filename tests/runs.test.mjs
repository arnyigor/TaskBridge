import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { SessionManager, sessionIdForTask } from '../src/session-manager.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-runs-test-'));
  const store = new TaskStore(root);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const manager = new TaskManager({ projects: [{ id: 'p', path: root, useWorktree: false }] }, root, store);
  const task = { id: 'a', createdAt: new Date().toISOString(), status: 'SUCCEEDED', workspacePath: root, prompt: 'original', files: [], assistantText: 'saved', thinkingText: '', compaction: { count: 0 } };
  await store.create(task);
  manager.tasks.set('a', task);
  const sent = [];
  const pi = { closed: false, getState: async () => ({ isStreaming: false }), prompt: async text => { sent.push(text); }, sendFollowUp: async text => { sent.push(text); }, abort: async () => {}, killTree: async () => {} };
  const runtime = { pi, eventChain: Promise.resolve(), settleResolvers: [], cancelRequested: false };
  manager.runtimes.set('a', runtime);
  manager.runtimeManager.isReady = async () => true;
  manager.runtimeManager.getBusyStatus = async () => ({ busy: false });
  return { manager, store, task, pi, runtime, sent, root };
}

test('run ledger stores a run, preserves startedAt on update, newest first', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-runs-store-'));
  const store = new TaskStore(root);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });

  store.recordRun({ id: 'r1', taskId: 'a', sessionId: 'a', kind: 'prompt', status: 'RUNNING', startedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(store.getRun('r1').status, 'RUNNING');

  // Finishing a run updates status/finishedAt but keeps startedAt.
  store.recordRun({ id: 'r1', taskId: 'a', sessionId: 'a', kind: 'prompt', status: 'SUCCEEDED', finishedAt: '2026-01-01T00:01:00.000Z' });
  const r1 = store.getRun('r1');
  assert.equal(r1.status, 'SUCCEEDED');
  assert.equal(r1.startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(r1.finishedAt, '2026-01-01T00:01:00.000Z');

  store.recordRun({ id: 'r2', taskId: 'a', status: 'RUNNING', startedAt: '2026-01-02T00:00:00.000Z' });
  assert.deepEqual(store.listRuns('a').map((x) => x.id), ['r2', 'r1']);
  assert.equal(store.getRun('nope'), null);
});

test('SessionManager exposes a session view and resolves runners', async t => {
  const f = await fixture(t);
  const sm = new SessionManager(f.manager);

  const session = sm.sessionForTask('a');
  assert.equal(session.id, 'a');
  assert.equal(session.taskId, 'a');
  assert.equal(session.runnerId, 'pi');
  assert.equal(session.state, 'SUCCEEDED');
  assert.equal(sessionIdForTask({ id: 'x' }), 'x');
  assert.equal(sessionIdForTask({ id: 'x', sessionId: 'y' }), 'y');

  assert.equal(sm.sessionForTask('missing'), null);
  assert.equal(sm.taskForSession('a').id, 'a');
  assert.ok(sm.listSessions().some((s) => s.id === 'a'));

  // A live Pi process is wrapped as a runner; a closed one is not.
  assert.ok(sm.runnerFor('a'));
  f.pi.closed = true;
  assert.equal(sm.runnerFor('a'), null);
});

test('a delivered prompt records a run that finishes when the task settles', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.manager.listRuns('a'), [], 'no runs before any prompt');

  await f.manager.message('a', 'go', 'auto', [], null, { now: true });
  // Mirror what the real Pi event loop does: release the settle waiter.
  for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
  for (let i = 0; i < 100 && f.manager.activeTaskId; i++) await new Promise((resolve) => setTimeout(resolve, 5));

  const runs = f.manager.listRuns('a');
  assert.ok(runs.length >= 1, 'a run is recorded once the turn is delivered');
  assert.equal(runs[0].kind, 'prompt');
  assert.equal(runs[0].status, 'SUCCEEDED');
  assert.ok(runs[0].finishedAt, 'the run is closed when the task settles');
});
