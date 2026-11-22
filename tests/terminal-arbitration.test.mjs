import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';
import os from 'node:os';

// REL-01C: hard STOP of an active generation must publish exactly one terminal
// result. Teardown noise (the delivery RPC rejecting because killTree closed the
// process) used to commit TASK_FAILED first, and the stop handler added a
// second TASK_CANCELLED afterwards — two contradictory outcomes for one run.
test('hard STOP mid-generation commits a single terminal outcome', async t => {
  // Park the prompt RPC itself (arm-prompt gate): the exact staging shape, where
  // killTree rejected a pending delivery promise and #fail committed TASK_FAILED
  // before the stop handler finished with its own TASK_CANCELLED.
  const gate = await (await import('node:fs/promises')).mkdtemp(`${os.tmpdir()}/taskbridge-gate-`);
  await (await import('node:fs/promises')).writeFile(`${gate}/arm-prompt`, '1');
  const f = await startFixture(0, { env: { FAKE_PI_GATE_DIR: gate } });
  t.after(() => f.close());
  const created = await f.api('/api/tasks', { projectId: 'fixture', prompt: 'fault-hang' });
  let parked = false;
  for (let i = 0; i < 300 && !parked; i++) {
    parked = await (await import('node:fs/promises')).access(`${gate}/parked-prompt`).then(() => true, () => false);
    if (!parked) await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(parked, true, 'the prompt RPC must be parked while the stop lands');
  const stopped = await f.api(`/api/tasks/${created.id}/cancel`, { commandId: 'single-term-1', clientId: 'test', hard: true });
  assert.equal(stopped.status, 'CANCELLED');
  const events = await f.api(`/api/tasks/${created.id}/events?limit=0`);
  const terminals = events.filter(e => ['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_CANCELLED'].includes(e.type));
  assert.deepEqual(terminals.map(e => e.type), ['TASK_CANCELLED'], `journal terminals: ${JSON.stringify(terminals.map(e => [e.seq, e.type, e.data?.errorCode]))}`);
});

// A provider fault that finalizes BEFORE the operator presses STOP keeps its
// FAILED outcome: the stop arrives on a terminal status and must not relabel it.
test('a failure already committed before STOP stays FAILED', async t => {
  const f = await startFixture(0);
  t.after(() => f.close());
  const created = await f.api('/api/tasks', { projectId: 'fixture', prompt: 'fault-crash' });
  let failed = null;
  for (let i = 0; i < 300 && !failed; i++) {
    failed = await f.api(`/api/tasks/${created.id}`);
    if (failed.status !== 'FAILED') failed = null;
    else break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(failed?.status, 'FAILED');
  const stopped = await f.api(`/api/tasks/${created.id}/cancel`, { commandId: 'late-stop', clientId: 'test', hard: true });
  assert.equal(stopped.status, 'FAILED');
  const events = await f.api(`/api/tasks/${created.id}/events?limit=0`);
  assert.equal(events.filter(e => e.type === 'TASK_FAILED').length, 1);
  assert.equal(events.some(e => e.type === 'TASK_CANCELLED'), false);
});
