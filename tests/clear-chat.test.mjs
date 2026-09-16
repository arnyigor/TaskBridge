import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';

const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('POST /clear erases the messages, keeps the session, and needs confirmation', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'первое' });

  // Without confirm: refused before anything is deleted.
  await assert.rejects(
    () => fixture.api(`/api/tasks/${task.id}/clear`, {}),
    error => error.status === 400 && /подтвержд/i.test(error.message)
  );

  // Wait until the session is terminal — a working session cannot be cleared.
  let current = task;
  for (let i = 0; i < 100 && !TERMINAL.includes(current.status); i++) {
    await sleep(100);
    current = await fixture.api(`/api/tasks/${task.id}`);
  }
  assert.ok(TERMINAL.includes(current.status), `session reached a terminal status (${current.status})`);

  const before = await fixture.api(`/api/tasks/${task.id}/events?limit=0`);
  assert.ok(before.length >= 1, 'the session has events to erase');

  const cleared = await fixture.api(`/api/tasks/${task.id}/clear`, { confirm: true });
  assert.equal(cleared.ok, true);

  const after = await fixture.api(`/api/tasks/${task.id}/events?limit=0`);
  assert.ok(after.length <= 1, `only the truncation marker remains, got ${after.length}`);
  if (after.length) assert.equal(after[0].type, 'TURN_TRUNCATED', 'the marker tells live clients to retract');

  const detail = await fixture.api(`/api/tasks/${task.id}`);
  assert.equal(detail.prompt, '', 'the first prompt is reset');
  assert.equal(detail.assistantText, '', 'the last answer is reset');
  assert.equal(detail.status, 'SUCCEEDED');
});
