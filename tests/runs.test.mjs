import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { SessionManager, sessionIdForTask } from '../src/session-manager.mjs';
import { startFixture } from './server-fixture.mjs';

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

test('late observations cannot reopen or replace a terminal run', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-runs-final-'));
  const store = new TaskStore(root);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED']) {
    const run = { id: status, taskId: 'a', status: 'RUNNING' };
    store.recordRun(run);
    store.recordRun({ ...run, status, finishedAt: '2026-10-15T00:00:00.000Z' });
    const final = store.getRun(run.id);
    store.recordRun({ ...run, status: 'RUNNING' });
    store.recordRun({ ...run, status: 'FAILED', finishedAt: '2026-10-15T00:00:01.000Z' });
    assert.deepEqual(store.getRun(run.id), final);
  }
});

test('a failed run is terminal before the HTTP snapshot and survives restart and follow-up', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'fault-crash run-ledger' });
  const settled = async expected => {
    for (let i = 0; i < 300; i++) {
      const snapshot = await fixture.api(`/api/tasks/${task.id}`);
      if (snapshot.status === expected) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`task did not reach ${expected}`);
  };
  await settled('FAILED');
  const failed = (await fixture.api(`/api/tasks/${task.id}/runs`)).runs;
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 'FAILED');
  await fixture.restart();
  assert.deepEqual((await fixture.api(`/api/tasks/${task.id}/runs`)).runs, failed);
  await fixture.api(`/api/tasks/${task.id}/message`, { text: 'clean follow-up' });
  await settled('SUCCEEDED');
  const runs = (await fixture.api(`/api/tasks/${task.id}/runs`)).runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[0].status, 'SUCCEEDED');
  assert.deepEqual(runs[1], failed[0]);
});

test('restart interrupts the old run without reopening it when the session resumes', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'fault-hang interrupted-run' });
  let original;
  for (let i = 0; i < 300; i++) {
    original = (await fixture.api(`/api/tasks/${task.id}/runs`)).runs[0];
    if (original?.status === 'RUNNING') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(original?.status, 'RUNNING');
  await fixture.restart();
  const runs = (await fixture.api(`/api/tasks/${task.id}/runs`)).runs;
  const interrupted = runs.find(run => run.id === original.id);
  assert.equal(interrupted.status, 'FAILED');
  assert.equal(interrupted.data.errorCode, 'UNKNOWN_AFTER_CRASH');
  assert.ok(interrupted.finishedAt);
  await fixture.restart();
  const again = (await fixture.api(`/api/tasks/${task.id}/runs`)).runs;
  assert.deepEqual(again.find(run => run.id === original.id), interrupted);
});
