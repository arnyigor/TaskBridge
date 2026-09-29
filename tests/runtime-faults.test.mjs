import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

// What a session looks like to a client when Pi misbehaves (backend plan B0:
// characterisation before the runtime refactor). Failure modes: tests/fake-pi.mjs.

const ACTIVE = ['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'VERIFYING', 'CANCELLING'];

async function settle(api, id, { tries = 200, delay = 50 } = {}) {
  let task;
  for (let i = 0; i < tries; i++) {
    task = await api(`/api/tasks/${id}`);
    if (!ACTIVE.includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(`task stayed ${task.status}`);
}

async function until(check, { tries = 200, delay = 50 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error('condition not met in time');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

test('Pi crashing mid tool call fails the turn with the reason, and the next message resumes', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-crash now' });

  const failed = await settle(api, task.id);
  assert.equal(failed.status, 'FAILED', 'not stuck in RUNNING');
  assert.equal(failed.errorCode, 'PI_SESSION_FAILED');
  assert.match(failed.error, /code=3/);
  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  assert.ok(events.some(event => event.type === 'PI_STDERR' && /simulated crash/.test(event.message || JSON.stringify(event.data))),
    'the stderr tail is kept with the session');

  await api(`/api/tasks/${task.id}/message`, { text: 'снова' });
  const resumed = await settle(api, task.id);
  assert.equal(resumed.status, 'SUCCEEDED', resumed.error || '');
});

test('garbage on Pi stdout is recorded and the turn still completes', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-garbage' });
  const done = await settle(api, task.id);
  assert.equal(done.status, 'SUCCEEDED', done.error || '');
  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  assert.equal(events.filter(event => event.type === 'PI_PROTOCOL_ERROR').length, 2);
});

// Pi answers the abort and then starts another turn half a second later (the tail
// it had already queued). Those frames used to be handled like any other:
// `agent_start` flipped the just-cancelled task back to RUNNING and the thinking
// delta went into the chat, so the operator saw reasoning continue after STOP.
test('STOP sticks: the frames Pi sends after abort do not revive the turn', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-abort-tail' });
  await until(async () => (await api(`/api/tasks/${task.id}`)).status === 'RUNNING');
  await api(`/api/tasks/${task.id}/cancel`, {});
  const stopped = await settle(api, task.id, { tries: 400 });
  assert.equal(stopped.status, 'CANCELLED', stopped.error || '');
  const thinking = stopped.thinkingText || '';
  // The tail arrives ~0.5 s after the abort response; 0.5 s later it must still
  // be ignored — no status flip and no reasoning added to the answer.
  await new Promise(resolve => setTimeout(resolve, 1200));
  const after = await api(`/api/tasks/${task.id}`);
  assert.equal(after.status, 'CANCELLED', 'the late agent_start must not set RUNNING');
  assert.equal(after.thinkingText || '', thinking, 'no reasoning may be appended after STOP');
});

test('STOP ends a turn whose Pi ignores abort, and takes its child processes down', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-deaf fault-child' });
  await until(async () => (await api(`/api/tasks/${task.id}`)).status === 'RUNNING');
  const childPid = await until(async () => {
    const events = await api(`/api/tasks/${task.id}/events?limit=0`);
    const line = events.filter(event => event.type === 'PI_STDERR').map(event => event.message || JSON.stringify(event.data)).join('\n');
    const match = line.match(/fake-pi child (\d+)/);
    return match ? Number(match[1]) : null;
  });
  t.after(() => { try { process.kill(childPid, 'SIGKILL'); } catch {} });

  await api(`/api/tasks/${task.id}/cancel`, {});
  const stopped = await settle(api, task.id, { tries: 400 });
  assert.equal(stopped.status, 'CANCELLED', stopped.error || '');
  if (process.platform !== 'win32') {
    await until(async () => !alive(childPid), { tries: 100 }).catch(() => {});
    assert.equal(alive(childPid), false, `child ${childPid} outlived STOP`);
  }
});

// While a model is being retried, Pi's own retry/limits-wait notices say «…
// retrying after error in 0m 05s. Error: Connection error.» — an error the agent
// DOES NOT have: it is still alive and will retry. Rendered verbatim in the chat
// they turned a working turn into a wall of failures (reported 2026-09-29). The
// retry-in-progress notices are dropped from the chat; a genuine failure notice
// and the raw frames (pi-events.jsonl) stay.
test('retry-in-progress notices are not shown as errors while the model is working', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-notices' });
  const done = await settle(api, task.id);
  assert.equal(done.status, 'SUCCEEDED', done.error || '');

  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  const notices = events.filter(event => event.type === 'UI_NOTIFY').map(event => event.message || '');
  assert.deepEqual(notices, ['Smart compaction failed safely and was cancelled: Connection error.'],
    'only the genuine failure may reach the chat');

  // Dropped from the chat, not from the record: the frame is still on disk, so a
  // retry loop stays diagnosable.
  const raw = await fs.readFile(path.join(fixture.root, 'data', 'tasks', task.id, 'artifacts', 'pi-events.jsonl'), 'utf8');
  assert.match(raw, /retrying after error in 0m 05s/);
});

// Speeds for a local model. Two measured errors, both fixed and pinned here:
//  - PP was prompt-tokens / time-to-first-token. A local engine keeps the prompt
//    in its KV cache and prefills only the new tail — Strata's own log for one
//    turn: «prompt 82996 tokens = 82643 reused + 353 read in 1982 ms», i.e.
//    178 tok/s of real prefill work while the UI claimed 32 895. Without the
//    engine's counter there is nothing to report, so PP is null, not invented.
//  - TG summed only gaps of ≤2 s between deltas and dropped the rest. A local
//    engine chunking slower than that lost most of its window: 50.4 tok/s shown
//    where the server said 36.7 (1054 generated in 28726 ms), and 100 tok/s in
//    another turn. The window is now the message's own span, first delta to end.
test('local model speeds: no invented PP, and TG over the real generation window', { timeout: 60000 }, async t => {
  const fixture = await startFixture(undefined, {
    root: { localRuntime: { externalServers: [{ provider: 'fixture', model: 'fixture', baseUrl: 'http://127.0.0.1:9' }] } }
  });
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-slow-stream', model: { provider: 'fixture', id: 'fixture' } });
  const done = await settle(api, task.id);
  assert.equal(done.status, 'SUCCEEDED', done.error || '');
  const metrics = done.metrics;
  assert.equal(metrics.pp, null, 'a KV-cached local prompt has no measurable prefill rate');
  assert.equal(metrics.ppSource, null);
  assert.equal(metrics.ppApproximate, false);
  assert.equal(metrics.inputTokens, 1000, 'the prompt size is still reported');
  assert.equal(metrics.outputTokens, 8);
  // 8 tokens over the ~3.4 s window, the 3 s pause included: ~2.4 tok/s. The old
  // gap-summing arithmetic reported >10 tok/s for the very same stream.
  assert.ok(metrics.tg > 0 && metrics.tg < 5, `tg=${metrics.tg} (expected ~2.4 tok/s)`);
  assert.equal(metrics.tgSource, 'usage');
  assert.equal(metrics.source, 'usage');
});
