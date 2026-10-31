import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

// docs/context-compaction-plan.md P2 (не сжимать «вслепую») и P5 (проверка
// последствий сжатия). Стенд — фикстура с тестовым Pi, у которого есть три
// предсказуемых исхода `compact`: успешный, пустая сводка и «Nothing to compact».

async function terminal(api, id) {
  for (let i = 0; i < 200; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Task did not finish');
}

async function fixture(t, env = {}) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-compact-agent-'));
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
  const started = await startFixture(0, { env: { PI_AGENT_DIR: agentDir, ...env } });
  t.after(() => started.close());
  const created = await started.api('/api/tasks', { projectId: 'fixture', prompt: 'hello' });
  await terminal(started.api, created.id);
  return { ...started, id: created.id };
}

test('a successful compact reports what was verified, not just that it finished', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  const response = await f.api(`/api/tasks/${f.id}/compact`, {});
  const result = response.result;
  assert.ok(result, 'the Pi result is still returned as `result`');
  assert.equal(result.summary.length > 0, true);
  assert.ok(result.verification, 'verification travels with the result');
  assert.equal(result.verification.checks.summaryPresent, true);
  assert.equal(result.verification.checks.boundaryRecorded === true || result.verification.checks.boundaryRecorded === false, true);
  assert.deepEqual(result.verification.failed.includes('summaryPresent'), false);
  // The prediction from the session file is advisory and named as such.
  assert.equal(typeof result.advice, 'string');
  assert.match(result.advice, /хвост|История|Прогноз|измерена/);
});

test('an empty summary fails verification instead of looking like success', { timeout: 40000 }, async t => {
  const f = await fixture(t, { FAKE_PI_COMPACT_EMPTY: '1' });
  const response = await f.api(`/api/tasks/${f.id}/compact`, {});
  const verification = response.result.verification;
  assert.equal(verification.passed, false);
  assert.deepEqual(verification.failed, ['summaryPresent']);
});

test('«Nothing to compact» becomes a readable reason with the tail budget', { timeout: 40000 }, async t => {
  const f = await fixture(t, { FAKE_PI_COMPACT_SMALL: '1' });
  await assert.rejects(f.api(`/api/tasks/${f.id}/compact`, {}), error => {
    assert.equal(error.code, 'NOTHING_TO_COMPACT');
    assert.match(error.message, /keepRecentTokens/);
    assert.match(error.message, /История|история/);
    return true;
  });
});
