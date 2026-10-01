import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

async function terminal(api, id) {
  for (let i = 0; i < 200; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Task did not finish');
}

// Hermetic Pi home: the report reads ~/.pi/agent (SYSTEM.md, AGENTS.md, skills,
// settings.json), and a developer's own files must not decide the assertions.
async function fixtureEnv(t, tokens = '90000') {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-context-agent-'));
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
  return { PI_AGENT_DIR: agentDir, FAKE_PI_CONTEXT_TOKENS: tokens };
}

test('context report lists sources and takes totals from Pi', { timeout: 30000 }, async t => {
  // The fake Pi reports this as its own context estimate, so "всего" is a known number.
  const fixture = await startFixture(0, { env: await fixtureEnv(t) });
  t.after(() => fixture.close());
  const { api } = fixture;
  await fs.writeFile(path.join(fixture.root, 'AGENTS.md'), 'Проектные инструкции.\n');
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'hello' });
  const id = created.id;
  await terminal(api, id);

  const report = await api(`/api/tasks/${id}/context`);
  assert.equal(report.taskId, id);
  assert.equal(report.totalTokens, 90000, 'totals come from Pi, not from a recount here');
  assert.equal(report.usage.source, 'pi');
  assert.ok(Number.isFinite(report.model.contextWindow), 'the window of the running session model');
  assert.equal(report.limit.tokens, null);
  assert.equal(report.limit.exceeded, false);
  assert.equal(report.running, false, 'a finished turn is not running');
  // The project AGENTS.md is really on disk in the fixture root.
  const byId = Object.fromEntries(report.sources.map(source => [source.id, source]));
  assert.equal(byId.instructions.known, true);
  assert.equal(byId.instructions.chars, 'Проектные инструкции.\n'.length);
  assert.equal(byId.instructions.count, 1);
  assert.equal(byId['system-prompt'].known, false, 'nothing in the hermetic Pi home');
  assert.equal(byId['builtin-tools'].known, false, 'Pi built-ins are not measurable from outside');
  assert.equal(byId['builtin-tools'].tokens, null);
  assert.equal(byId.memory.known, false);
  assert.equal(report.measuredTokens, report.sources.filter(s => s.known).reduce((sum, s) => sum + s.tokens, 0));
  assert.equal(report.unaccountedTokens, Math.max(0, 90000 - report.measuredTokens));
  assert.equal(typeof report.compaction.reserveTokens, 'number');
  assert.equal(report.compaction.triggerAt, report.model.contextWindow - report.compaction.reserveTokens);
  assert.ok(report.conversation.userMessages >= 1);
  assert.match(report.note, /оценка/i);
});

test('a context limit is stored per session and compacts the history when exceeded', { timeout: 30000 }, async t => {
  const fixture = await startFixture(0, { env: await fixtureEnv(t) });
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'hello' });
  const id = created.id;

  // Out of range: refused, and nothing is stored.
  await assert.rejects(api(`/api/tasks/${id}/context`, { limit: 1024 }), /2048/);
  await assert.rejects(api(`/api/tasks/${id}/context`, { limit: 1.5 }), /целое/);

  const saved = await api(`/api/tasks/${id}/context`, { limit: 40000 });
  assert.equal(saved.limit.tokens, 40000);
  assert.equal((await api(`/api/tasks/${id}`)).contextLimit, 40000, 'persisted on the session record');

  await terminal(api, id);
  const events = await api(`/api/tasks/${id}/events?limit=0`);
  const reached = events.find(event => event.type === 'CONTEXT_LIMIT_REACHED');
  assert.ok(reached, `expected a CONTEXT_LIMIT_REACHED event, got ${events.map(e => e.type).join(', ')}`);
  assert.equal(reached.data.used, 90000);
  assert.equal(reached.data.limit, 40000);
  // The compaction happens BEFORE the terminal event: a client that stops reading
  // at TASK_SUCCEEDED must not miss it.
  const succeeded = events.find(event => event.type === 'TASK_SUCCEEDED');
  assert.ok(reached.seq < succeeded.seq, 'the decision to compact belongs to the turn, not after it');
  // Compaction frames themselves stream in asynchronously (the same is true for
  // the manual /compact button on a finished session), so what must hold is that
  // no second terminal event is published behind the first.
  const terminalTypes = ['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_CANCELLED'];
  assert.equal(events.filter(event => terminalTypes.includes(event.type)).length, 1);
  assert.equal(events.findIndex(event => event.type === 'TASK_SUCCEEDED'),
    events.findLastIndex(event => terminalTypes.includes(event.type)));

  const task = await api(`/api/tasks/${id}`);
  assert.equal(task.status, 'SUCCEEDED');
  assert.equal(task.compaction.count, 1);
  assert.equal(task.compaction.last.summary, 'Сжатая сводка предыдущего контекста');
  assert.equal((await api(`/api/tasks/${id}/context`)).limit.tokens, 40000);

  // Clearing the limit is explicit: null means "no limit".
  const cleared = await api(`/api/tasks/${id}/context`, { limit: null });
  assert.equal(cleared.limit.tokens, null);
  assert.equal((await api(`/api/tasks/${id}`)).contextLimit, null);
});

test('without a limit the context size never triggers a compaction', { timeout: 30000 }, async t => {
  const fixture = await startFixture(0, { env: await fixtureEnv(t) });
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'hello' });
  const id = created.id;
  const task = await terminal(api, id);
  assert.equal(task.status, 'SUCCEEDED');
  assert.equal(task.compaction.count, 0);
  const events = await api(`/api/tasks/${id}/events?limit=0`);
  assert.equal(events.filter(event => event.type === 'CONTEXT_LIMIT_REACHED').length, 0);
});
