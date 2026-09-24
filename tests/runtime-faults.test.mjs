import test from 'node:test';
import assert from 'node:assert/strict';
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
