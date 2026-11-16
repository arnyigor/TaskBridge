import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planRead, planSearch, sessionMode } from '../src/session-capabilities.mjs';
import { startFixture } from './server-fixture.mjs';

async function terminal(api, id) {
  for (let i = 0; i < 300; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error('Timeout');
}

test('Plan read/search are literal and realpath confined', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-plan-tools-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'project'));
  await fs.writeFile(path.join(root, 'secret'), 'outside');
  await fs.writeFile(path.join(root, 'project', 'a.txt'), 'hello .*\nworld');
  assert.equal(sessionMode(), 'agent');
  assert.equal(sessionMode('chat'), 'chat');
  assert.throws(() => sessionMode('invalid'));
  assert.equal(await planRead(path.join(root, 'project'), 'a.txt'), 'hello .*\nworld');
  assert.match(await planSearch(path.join(root, 'project'), '.*'), /a.txt:1/);
  await assert.rejects(planRead(path.join(root, 'project'), '../secret'), /outside/);
  await fs.symlink(root, path.join(root, 'project', 'escape'), 'junction');
  await assert.rejects(planRead(path.join(root, 'project'), 'escape/secret'), /outside/);
});

test('Plan lifecycle, report versions, confirmed idempotent handoff and recovery', { timeout: 60000 }, async t => {
  const f = await startFixture();
  t.after(() => f.close());
  await assert.rejects(f.api('/api/tasks', { projectId: 'fixture', mode: 'invalid', prompt: 'x' }));
  const created = await f.api('/api/tasks', { projectId: 'fixture', mode: 'plan', prompt: 'Research project' });
  let task = await terminal(f.api, created.id);
  assert.equal(task.status, 'SUCCEEDED', f.logs());
  assert.equal(task.mode, 'plan');
  assert.equal(task.checkpoint, undefined);
  assert.equal(task.verificationStatus, 'NOT_APPLICABLE');
  assert.equal(task.planReports.length, 1);
  const report = await f.api(`/api/tasks/${task.id}/plan-reports/1`);
  assert.ok(report.markdown);
  await assert.rejects(f.api(`/api/tasks/${task.id}/message`, { text: 'x', files: [{ name: 'x', base64: 'eA==' }] }));
  const handoff = { version: 1, commandId: 'test-handoff', model: { provider: 'test', id: 'model' }, confirmed: false };
  await assert.rejects(f.api(`/api/tasks/${task.id}/plan-handoff`, handoff));
  handoff.confirmed = true;
  const agent = await f.api(`/api/tasks/${task.id}/plan-handoff`, handoff);
  const again = await f.api(`/api/tasks/${task.id}/plan-handoff`, handoff);
  assert.equal(agent.id, again.id);
  assert.equal(agent.mode, 'agent');
  await terminal(f.api, agent.id);
  await f.restart();
  const recovered = await f.api(`/api/tasks/${task.id}`);
  assert.equal(recovered.mode, 'plan');
  const retried = await f.api(`/api/tasks/${task.id}/plan-handoff`, handoff);
  assert.equal(agent.id, retried.id);
});
