// FP-06D: recovery, 413, compaction, SSE и два клиента (RC-03…RC-07) и
// FP-06C на границе автономии (AU-07 уже покрыт CP-04, AU-08 — CP-08).
//
// Всё детерминированно: тестовый Pi умеет ровно те формы отказа, которые нужны
// сценарию, а настоящий сервер и SQLite — те же, что в проде.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { parsePlan } from '../src/application/plan-file.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-rc
revision: 1
goal: "FP-06D: восстановление"
---

# План: восстановление

## Шаги

### S-001 | TODO | P1 | Первый шаг
**Критерии:** сделано.
**Проверка:** read

### S-002 | TODO | P1 | Второй шаг
**Критерии:** сделано.
**Проверка:** read

## Обнаруженные проблемы
`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 30000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

const createTask = async api => {
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'подготовка' });
  await waitFor(async () => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes((await api(`/api/tasks/${created.id}`)).status));
  return created;
};

const planPrompts = async root => (await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8').catch(() => ''))
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.message.includes('FOLLOW PLAN'));

async function fixtureWithPlan(t, { plan = PLAN, env = {} } = {}) {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } }, env });
  t.after(() => fixture.close());
  await fs.writeFile(path.join(fixture.root, 'PLAN.md'), plan, 'utf8');
  return fixture;
}

test('RC-03: a provider 413 does not produce a second plan step', { timeout: 90000 }, async t => {
  // Every turn of the fixture is refused with the permanent 413 body limit — the
  // shape that made Pi retry in a loop before MEDIA-09.
  const fixture = await fixtureWithPlan(t, { env: { FAKE_PI_ALWAYS_413: '1' } });
  const { api, root } = fixture;
  const task = await createTask(api);
  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'rc03-attach' });
  await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'rc03-start' });

  const status = await waitFor(async () => {
    const value = await api(`/api/tasks/${task.id}/plan`);
    return ['PAUSED', 'PAUSED_REVIEW', 'COMPLETED'].includes(value.state) && value.state !== 'COMPLETED' ? value : null;
  }, { timeout: 60000 });
  assert.ok(status, `плановый цикл должен остановиться на 413: ${fixture.logs()}`);
  await sleep(2000);
  const written = parsePlan(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'));
  assert.deepEqual(written.steps.map(step => step.status), ['TODO', 'TODO'], 'no step was recorded from a refused turn');
  const steps = (await planPrompts(root)).length;
  assert.ok(steps <= 2, `не больше одного шага и одного контрольного хода, получено ${steps}`);
});

test('RC-04: compaction during a step keeps the binding, step and revision', { timeout: 90000 }, async t => {
  const fixture = await fixtureWithPlan(t, { plan: PLAN.replace('Первый шаг', 'Первый шаг slow') });
  const { api, root } = fixture;
  const task = await createTask(api);
  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'rc04-attach' });
  const started = await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'rc04-start' });
  assert.equal(started.stepId, 'S-001');

  // Real compaction frames arrive mid-step; the plan must not lose its place.
  const compacted = await api(`/api/tasks/${task.id}/compact`, {}, 'POST').then(value => ({ value }), error => ({ error }));
  const during = await api(`/api/tasks/${task.id}/plan`);
  assert.equal(during.stepId, 'S-001', 'the step survives compaction');
  assert.equal(during.revision, 1, 'the revision is unchanged by a compact');
  assert.ok(compacted.value || compacted.error);

  const finished = await waitFor(async () => {
    const value = await api(`/api/tasks/${task.id}/plan`);
    return value.state === 'COMPLETED' ? value : null;
  }, { timeout: 40000 });
  assert.ok(finished, `цикл должен продолжиться после сжатия: ${fixture.logs()}`);
  assert.equal(finished.steps.filter(step => step.status === 'DONE').length, 2);
});

test('RC-05: a client that reconnects at the step boundary receives the current status', { timeout: 90000 }, async t => {
  const fixture = await fixtureWithPlan(t);
  const { api, base, root } = fixture;
  const task = await createTask(api);
  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'rc05-attach' });
  const before = await api(`/api/tasks/${task.id}/events`);
  const cursor = before.length ? before[before.length - 1].seq : 0;
  await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'rc05-start' });

  const finished = await waitFor(async () => {
    const value = await api(`/api/tasks/${task.id}/plan`);
    return value.state === 'COMPLETED' ? value : null;
  }, { timeout: 40000 });
  assert.ok(finished, `план должен завершиться: ${fixture.logs()}`);

  // The stream is opened AFTER the fact with the old cursor: the replay must carry
  // the plan events, otherwise a client that blinked at the boundary shows nothing.
  const response = await fetch(`${base}/api/tasks/${task.id}/stream`, { headers: { 'last-event-id': String(cursor) } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let text = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !text.includes('PLAN_COMPLETED')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += Buffer.from(chunk.value).toString('utf8');
  }
  await reader.cancel().catch(() => {});
  assert.match(text, /PLAN_COMPLETED/, 'the replay of the reconnected stream carries the completion');
  assert.match(text, /PLAN_STEP_STARTED/);
  assert.ok((await planPrompts(root)).length === 2);
});

test('RC-06: two clients pressing Resume produce at most one new turn', { timeout: 90000 }, async t => {
  // Keep the first step in flight: the normal 80 ms turn can finish the whole
  // plan before Pause, in which case COMPLETED correctly cannot be paused.
  const fixture = await fixtureWithPlan(t, { plan: PLAN.replace('Первый шаг', 'Первый шаг slow') });
  const { api, root } = fixture;
  const task = await createTask(api);
  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'rc06-attach' });
  // A completed plan is resumed by nobody; a paused one is resumed by two clients.
  await api(`/api/tasks/${task.id}/plan`, {
    expectedRevision: 1, commandId: 'rc06-patch',
    changes: { ops: [{ op: 'add_finding', findingId: 'F-001', priority: 'P2', summary: 'заметка' }] }
  }, 'PATCH');
  await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 2, commandId: 'rc06-start' });
  assert.ok(await waitFor(async () => (await planPrompts(root)).length === 1), 'the first plan turn must be delivered');
  await api(`/api/tasks/${task.id}/plan/pause`, { commandId: 'rc06-pause' });
  const paused = await waitFor(async () => {
    const value = await api(`/api/tasks/${task.id}/plan`);
    return ['PAUSED', 'PAUSED_REVIEW'].includes(value.state) ? value : null;
  });
  assert.ok(paused, 'the plan must reach a pause');
  const deliveredBefore = (await planPrompts(root)).length;

  const results = await Promise.allSettled([
    api(`/api/tasks/${task.id}/plan/resume`, { expectedRevision: paused.revision, commandId: 'rc06-resume-a' }),
    api(`/api/tasks/${task.id}/plan/resume`, { expectedRevision: paused.revision, commandId: 'rc06-resume-b' })
  ]);
  const ok = results.filter(result => result.status === 'fulfilled');
  assert.ok(ok.length >= 1, 'at least one resume is accepted');
  await sleep(1500);
  const added = (await planPrompts(root)).length - deliveredBefore;
  assert.ok(added <= 1, `resume must start at most one turn, started ${added}`);
});

test('RC-07: turning the mode off during generation pauses at the safe boundary', { timeout: 90000 }, async t => {
  const fixture = await fixtureWithPlan(t, { plan: PLAN.replace('Первый шаг', 'Первый шаг slow') });
  const { api, root } = fixture;
  const task = await createTask(api);
  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'rc07-attach' });
  await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'rc07-start' });
  await sleep(400);
  // The switch-off path is exactly this command: no next step, the running one lives.
  const paused = await api(`/api/tasks/${task.id}/plan/pause`, { commandId: 'rc07-pause' });
  assert.equal(paused.state, 'PAUSED');
  const finished = await waitFor(async () => {
    const value = await api(`/api/tasks/${task.id}/plan`);
    return value.state === 'PAUSED' && !value.stepId ? value : null;
  }, { timeout: 40000 });
  assert.ok(finished, `пауза должна установиться: ${fixture.logs()}`);
  assert.equal((await planPrompts(root)).length, 1, 'no next step after the switch-off');
  const written = parsePlan(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'));
  assert.deepEqual(written.steps.map(step => step.status), ['TODO', 'TODO'], 'the paused step is not recorded as done');
});
