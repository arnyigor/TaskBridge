import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

// CMP-01, second half: a session already running must not be reported as if the
// new MCP configuration had reached it. Pi takes --mcp-config and
// PI_MCP_CONFIG_MODE at spawn, so the honest answer for a live process is
// "pending_restart" — and for a session started after the change, "applied".
async function terminal(api, id) {
  for (let i = 0; i < 200; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Task did not finish');
}

async function agentHome(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-mcp-apply-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { PI_AGENT_DIR: dir };
}

test('an MCP change is reported as pending restart for a session already running', { timeout: 40000 }, async t => {
  const env = await agentHome(t);
  const fixture = await startFixture(0, {
    env,
    root: { pi: { command: undefined, projectTrust: 'deny', mcp: { mode: 'managed' } } },
  });
  t.after(() => fixture.close());
  const { api } = fixture;

  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'hello' });
  await terminal(api, created.id);

  // The session is registered before the first MCP verdict is asked for.
  await api('/api/mcp/definitions', { name: 'demo', url: 'https://example.test/mcp' });
  const status = await api('/api/mcp');
  assert.equal(status.mode, 'managed');
  assert.equal(status.controllable, true);
  assert.equal(typeof status.fingerprint, 'string');

  const running = status.apply;
  // Verified on the fixture: Pi stays alive after its turn, so the live process
  // genuinely holds the config it was spawned with and the answer must be
  // «pending_restart» — naming the session, not claiming the tool is gone.
  assert.equal(running.state, 'pending_restart');
  const pending = running.pending.find(item => item.taskId === created.id);
  assert.ok(pending, 'the running session is named');
  assert.match(running.detail, /перезапуск/i);
  assert.notEqual(pending.fingerprint, pending.wanted, 'the live process is on the old configuration');

  // A session created after the change starts on the new configuration, so it
  // cannot be pending: the change is in the file the new process is given.
  const fresh = await api('/api/tasks', { projectId: 'fixture', prompt: 'second' });
  await terminal(api, fresh.id);
  const after = (await api('/api/mcp')).apply;
  assert.equal(after.pending.some(item => item.taskId === fresh.id), false);
});
