import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';
import { startServer } from '../cloud/server.mjs';

// End-to-end MVP acceptance path (§111): a task created through the cloud API is
// executed by the local TaskBridge + Pi runtime, and its normalized events
// stream back to the cloud without any inbound network access to the machine.

const USER_TOKEN = 'e2e-user-token-1234567890';
const MACHINE = { id: 'e2e-machine', secret: 'e2e-machine-secret-1234567890', ownerId: 'owner', displayName: 'E2E Workstation' };

function cloudEnv(port) {
  return {
    TASKBRIDGE_CLOUD_ENABLED: 'true',
    TASKBRIDGE_CLOUD_URL: `http://127.0.0.1:${port}`,
    TASKBRIDGE_MACHINE_ID: MACHINE.id,
    TASKBRIDGE_MACHINE_SECRET: MACHINE.secret,
    TASKBRIDGE_EVENT_FLUSH_MS: '20',
    TASKBRIDGE_HEARTBEAT_SECONDS: '5',
    TASKBRIDGE_IDLE_POLL_SECONDS: '0.2',
    TASKBRIDGE_ACTIVE_POLL_SECONDS: '0.2'
  };
}

async function withEnv(values, action) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try { return await action(); }
  finally {
    for (const key of Object.keys(values)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function waitFor(check, { timeoutMs = 20000, intervalMs = 100, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function setupCloud() {
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    storeTarget: 'memory:',
    env: { TASKBRIDGE_CLOUD_USER_TOKEN: USER_TOKEN, TASKBRIDGE_CLOUD_MACHINES: JSON.stringify([MACHINE]) },
    logger: () => {}
  });
  const user = async (route, { method = 'GET', body = {}, query = null } = {}) => {
    const search = query ? `?${new URLSearchParams(query)}` : '';
    const response = await fetch(`http://127.0.0.1:${server.port}${route}${search}`, {
      method,
      headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, user };
}

test('cloud-created task runs locally and streams back to the cloud', { timeout: 60000 }, async t => {
  const { server, user } = await setupCloud();
  t.after(() => server.close());

  const fixture = await withEnv(cloudEnv(server.port), () => startFixture());
  t.after(() => fixture.close());

  // The machine registers itself outbound; no inbound port is opened.
  const machine = await waitFor(async () => {
    const machines = await user('/api/machines');
    return machines.body.find(m => m.id === MACHINE.id && m.status === 'ONLINE');
  }, { message: 'machine heartbeat' });
  assert.equal(machine.displayName, MACHINE.displayName);

  const created = await user('/api/tasks', { method: 'POST', body: { machineId: MACHINE.id, projectId: 'fixture', prompt: 'hello from the phone' } });
  assert.equal(created.status, 202);

  const finished = await waitFor(async () => {
    const task = await user(`/api/tasks/${created.body.taskId}`);
    return ['COMPLETED', 'FAILED'].includes(task.body.status) ? task.body : null;
  }, { message: 'cloud task completion' });
  assert.equal(finished.status, 'COMPLETED', fixture.logs());

  // The cloud id is reused locally, so both sides agree without a mapping table.
  const local = await fixture.api(`/api/tasks/${created.body.taskId}`);
  assert.equal(local.status, 'SUCCEEDED');
  assert.match(local.assistantText, /Ответ 1/);

  const events = await user(`/api/tasks/${created.body.taskId}/events`, { query: { after: 0, limit: 2000 } });
  const types = events.body.events.map(event => event.type);
  assert.ok(types.includes('task_created'), 'task_created is uploaded');
  assert.ok(types.includes('tool_started'), 'tool lifecycle is streamed');
  assert.ok(types.includes('tool_finished'));
  assert.ok(types.includes('assistant_delta') || types.includes('assistant_delta_batch'), 'assistant text streams');
  assert.equal(types.at(-1), 'task_finished');
  const assistant = events.body.events.find(event => event.type === 'assistant_end');
  assert.match(assistant.payload.text, /Ответ 1/);

  // Reconnect/replay: asking again after the last cursor returns nothing new.
  const tail = events.body.events.at(-1).seq;
  const replay = await user(`/api/tasks/${created.body.taskId}/events`, { query: { after: tail } });
  assert.deepEqual(replay.body.events, []);
});

test('remote STOP terminates the local task and reports ABORTED', { timeout: 60000 }, async t => {
  const { server, user } = await setupCloud();
  t.after(() => server.close());

  const fixture = await withEnv(cloudEnv(server.port), () => startFixture());
  t.after(() => fixture.close());

  await waitFor(async () => (await user('/api/machines')).body.find(m => m.id === MACHINE.id && m.status === 'ONLINE'), { message: 'machine heartbeat' });

  const created = await user('/api/tasks', { method: 'POST', body: { machineId: MACHINE.id, projectId: 'fixture', prompt: 'slow please' } });
  await waitFor(async () => {
    const task = await user(`/api/tasks/${created.body.taskId}`);
    return task.body.status === 'RUNNING' ? task.body : null;
  }, { message: 'task running' });

  const stop = await user(`/api/tasks/${created.body.taskId}/commands`, { method: 'POST', body: { type: 'ABORT_TASK' } });
  assert.equal(stop.status, 202);

  const aborted = await waitFor(async () => {
    const task = await user(`/api/tasks/${created.body.taskId}`);
    return ['ABORTED', 'COMPLETED', 'FAILED'].includes(task.body.status) ? task.body : null;
  }, { message: 'task abort' });
  assert.equal(aborted.status, 'ABORTED', fixture.logs());
  assert.equal((await fixture.api(`/api/tasks/${created.body.taskId}`)).status, 'CANCELLED');
});
