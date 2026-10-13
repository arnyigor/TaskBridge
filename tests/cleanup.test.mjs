import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startFixture } from './server-fixture.mjs';
import { rankCandidates } from '../src/cleanup.mjs';

// PROC-04/05 (docs/TASKBRIDGE_RESOURCE_CLEANUP_PLAN.md): a batch cleanup must
// be previewed, revalidated and confirmed, must report per-process results and
// never touch protected processes — not even through a plan built for them.

const DUMMY = '-e "setInterval(() => {}, 1000)"';

function spawnDummy(args = [DUMMY]) {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
}

test('rankCandidates ranks by accounted memory and never proposes protected processes', () => {
  const list = [
    { pid: 1, name: 'notepad.exe', memoryBytes: 100 * 1024 * 1024, commandLine: 'notepad' },
    { pid: 2, name: 'node.exe', memoryBytes: 600 * 1024 * 1024, commandLine: 'node worker.js' },
    { pid: 3, name: 'node.exe', memoryBytes: 10 * 1024 * 1024, commandLine: 'node server.mjs' }, // TaskBridge
    { pid: 4, name: 'lsass.exe', memoryBytes: 50 * 1024 * 1024, commandLine: '' },
  ];
  const { candidates, skipped } = rankCandidates(list, { objective: 'ram' });
  assert.deepEqual(candidates.map(entry => entry.pid), [2, 1], 'biggest accounted RAM first, TaskBridge/system excluded');
  assert.deepEqual(skipped.map(entry => entry.pid).sort(), [3, 4]);
});

test('gpu objective prefers GPU processes and known runtimes', () => {
  const list = [
    { pid: 1, name: 'somegame.exe', memoryBytes: 10, commandLine: 'somegame' },
    { pid: 2, name: 'notepad.exe', memoryBytes: 10 * 1024 * 1024 * 1024, commandLine: 'notepad' },
  ];
  const { candidates } = rankCandidates(list, { objective: 'gpu', gpuPids: new Set([1]) });
  const relevant = candidates.filter(entry => entry._relevant).map(entry => entry.pid);
  assert.deepEqual(relevant, [1], 'gpu flag beats a huge unrelated process');
});

test('cleanup preview → execute → idempotent retry, end to end', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const dummies = [spawnDummy(), spawnDummy(), spawnDummy()];
  t.after(() => { for (const d of dummies) { try { d.kill('SIGKILL'); } catch {} } });
  const pids = dummies.map(d => d.pid);

  const preview = await fixture.api('/api/system/cleanup/preview', { objective: 'ram', pids });
  assert.ok(preview.planId);
  assert.equal(preview.candidates.length, 3, 'explicit pids become the plan candidates');
  assert.ok(preview.expiresAt > Date.now() - 1000);
  assert.ok(preview.warnings.length > 0, 'the plan must warn that estimates are not promises');

  const commandId = `test-${preview.planId}`;
  const result = await fixture.api('/api/system/cleanup/execute', { planId: preview.planId, commandId, confirm: true });
  assert.equal(result.stopped, 3);
  assert.ok(result.items.every(item => item.status === 'STOPPED'), JSON.stringify(result.items));
  assert.equal(typeof result.ram.observedDeltaBytes, 'number');

  // A repeated commandId returns the same result and must not kill anything new.
  const freshDummy = spawnDummy();
  t.after(() => { try { freshDummy.kill('SIGKILL'); } catch {} });
  const again = await fixture.api('/api/system/cleanup/execute', { planId: preview.planId, commandId, confirm: true });
  assert.equal(again.stopped, 3);
  assert.equal(again.idempotent, true);

  // The plan is single-use: a NEW commandId on the same planId must be refused.
  await assert.rejects(
    () => fixture.api('/api/system/cleanup/execute', { planId: preview.planId, commandId: 'other', confirm: true }),
    error => error.code === 'PLAN_NOT_FOUND',
  );

  // Result lookup by commandId (GET /api/system/cleanup/:id).
  const fetched = await fixture.api(`/api/system/cleanup/${commandId}`);
  assert.equal(fetched.stopped, 3);

  // History records counts, not command lines.
  const { history } = await fixture.api('/api/system/cleanup/history');
  const record = history.find(entry => entry.commandId === commandId);
  assert.ok(record);
  assert.equal(record.stopped, 3);
  assert.ok(!JSON.stringify(history).includes('setInterval'), 'history must not carry command lines');
});

test('execute refuses without confirm, with an expired plan, and reports PROTECTED per process', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  await assert.rejects(
    () => fixture.api('/api/system/cleanup/execute', { planId: 'none', commandId: 'c1', confirm: false }),
    error => error.code === 'CONFIRM_REQUIRED',
  );
  await assert.rejects(
    () => fixture.api('/api/system/cleanup/execute', { planId: 'none', commandId: 'c2', confirm: true }),
    error => error.code === 'PLAN_NOT_FOUND',
  );

  // A plan containing a protected pid (the fixture server itself, found by pid
  // via the ranked objective=false path is impossible; use explicit pids) must
  // come back with status PROTECTED for that process, not a global failure.
  const preview = await fixture.api('/api/system/cleanup/preview', { objective: 'ram', pids: [fixture.appPid] });
  const result = await fixture.api('/api/system/cleanup/execute', { planId: preview.planId, commandId: 'c3', confirm: true });
  assert.equal(result.items[0].status, 'PROTECTED');
  assert.equal(result.protectedCount, 1);
  assert.equal(result.stopped, 0);
});
