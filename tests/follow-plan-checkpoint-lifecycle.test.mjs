// FP-06A: lifecycle checkpoint (CP-01…CP-08) на настоящем сервере и тестовом Pi.
//
// Каждый сценарий проверяет ровно одно утверждение: что считается подтверждением
// шага, а что нет. Модели здесь нет: тестовый Pi присылает кадры так, как это делает
// настоящий (tool_execution_start/end, agent_settled), и сценарии отказа задаются
// заголовком шага в PLAN.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { parsePlan } from '../src/application/plan-file.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-cp
revision: 1
goal: "FP-06A: lifecycle checkpoint"
---

# План: lifecycle

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

async function waitFor(check, { timeout = 25000, interval = 50 } = {}) {
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

const deliveries = async root => (await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8').catch(() => ''))
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.message.includes('FOLLOW PLAN'));

async function fixtureWithPlan(t, plan = PLAN) {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  await fs.writeFile(path.join(fixture.root, 'PLAN.md'), plan, 'utf8');
  return fixture;
}

const planOf = async root => parsePlan(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'));

test('CP-01: a checkpoint followed by STOP is not confirmed', { timeout: 60000 }, async t => {
  const fixture = await fixtureWithPlan(t, PLAN.replace('Первый шаг', 'Первый шаг slow'));
  const { api, root } = fixture;
  const task = await createTask(api);
  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cp01-attach' });
  await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cp01-start' });
  // The fixture sends the checkpoint tool call immediately, then keeps the turn
  // open for 10 s: STOP lands between the call and the settle.
  await waitFor(async () => Boolean((await api(`/api/tasks/${task.id}/plan`)).state));
  await sleep(400);
  await api(`/api/tasks/${task.id}/plan/stop`, { commandId: 'cp01-stop' });

  const status = await waitFor(async () => {
    const value = await api(`/api/tasks/${task.id}/plan`);
    return value.state === 'PAUSED_REVIEW' ? value : null;
  });
  assert.ok(status, 'the plan must stay paused for review');
  await sleep(1500);
  assert.equal((await planOf(root)).steps[0].status, 'TODO', 'the checkpoint from the stopped turn is not confirmed');
  assert.equal((await deliveries(root)).length, 1);
});

test('CP-02: a failed checkpoint tool does not move the cycle', { timeout: 60000 }, async t => {
  const fixture = await fixtureWithPlan(t, PLAN.replace('Первый шаг', 'Первый шаг checkpoint-error'));
  const { api, root } = fixture;
  const task = await createTask(api);
  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cp02-attach' });
  await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cp02-start' });

  const status = await waitFor(async () => {
    const value = await api(`/api/tasks/${task.id}/plan`);
    return ['PAUSED', 'PAUSED_REVIEW'].includes(value.state) ? value : null;
  });
  assert.ok(status, `the cycle must stop without a valid checkpoint: ${fixture.logs()}`);
  const written = await planOf(root);
  assert.equal(written.steps[0].status, 'TODO', 'no step transition from a failed checkpoint');
  assert.equal(written.steps[1].status, 'TODO');
  // One turn for the step, one control turn for the missing checkpoint.
  assert.equal((await deliveries(root)).length, 2);
});

test('CP-03: two identical checkpoints give one state transition', { timeout: 60000 }, async t => {
  const fixture = await fixtureWithPlan(t, PLAN.replace('Первый шаг', 'Первый шаг double-settle'));
  const { api, root } = fixture;
  const task = await createTask(api);
  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cp03-attach' });
  await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cp03-start' });

  const finished = await waitFor(async () => {
    const value = await api(`/api/tasks/${task.id}/plan`);
    return value.state === 'COMPLETED' ? value : null;
  });
  assert.ok(finished, `the plan must complete: ${fixture.logs()}`);
  await sleep(1200);
  const written = await planOf(root);
  assert.equal(written.revision, 3, 'the duplicate settle did not write again');
  assert.equal((await deliveries(root)).length, 2, 'no extra turn from the repeated settle');
});

test('CP-04: a checkpoint from an older revision is refused and pauses', { timeout: 60000 }, async t => {
  const fixture = await fixtureWithPlan(t, PLAN.replace('Первый шаг', 'Первый шаг slow'));
  const { api, root } = fixture;
  const task = await createTask(api);
  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cp04-attach' });
  await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cp04-start' });
  // The operator edits the file while the step runs: the checkpoint that comes
  // back still names revision 1, the file is already at 2.
  await sleep(400);
  const patched = await api(`/api/tasks/${task.id}/plan`, {
    expectedRevision: 1, commandId: 'cp04-patch',
    changes: { ops: [{ op: 'add_finding', findingId: 'F-001', priority: 'P2', summary: 'заметка оператора' }] }
  }, 'PATCH');
  assert.equal(patched.revision, 2);

  const status = await waitFor(async () => {
    const value = await api(`/api/tasks/${task.id}/plan`);
    return ['PAUSED', 'PAUSED_REVIEW'].includes(value.state) ? value : null;
  });
  assert.ok(status, `a checkpoint from an older revision must pause the plan: ${fixture.logs()}`);
  const written = await planOf(root);
  assert.equal(written.steps[0].status, 'TODO', 'the stale checkpoint did not move the step');
  assert.equal(written.revision, 2, 'the operator version is intact');
  assert.ok(written.findings.some(finding => finding.id === 'F-001'), 'the operator edit is not lost');
});

test('CP-07: a settle without checkpoint asks once and then pauses', { timeout: 60000 }, async t => {
  const fixture = await fixtureWithPlan(t, PLAN.replace('Первый шаг', 'Первый шаг no-checkpoint'));
  const { api, root } = fixture;
  const task = await createTask(api);
  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cp07-attach' });
  await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cp07-start' });

  const status = await waitFor(async () => {
    const value = await api(`/api/tasks/${task.id}/plan`);
    return value.state === 'PAUSED' ? value : null;
  });
  assert.ok(status, `the plan must pause after the failed control turn: ${fixture.logs()}`);
  const prompts = await deliveries(root);
  assert.equal(prompts.length, 2, 'one step turn and exactly one audit turn');
  assert.match(prompts[1].message, /не передал checkpoint/);
  const written = await planOf(root);
  assert.equal(written.steps[0].status, 'TODO', 'the file is untouched without a checkpoint');
});

test('CP-08: STOP at the settle boundary produces neither audit nor next step', { timeout: 60000 }, async t => {
  const fixture = await fixtureWithPlan(t, PLAN.replace('Первый шаг', 'Первый шаг no-checkpoint slow'));
  const { api, root } = fixture;
  const task = await createTask(api);
  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cp08-attach' });
  await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cp08-start' });
  await sleep(400);
  await api(`/api/tasks/${task.id}/plan/stop`, { commandId: 'cp08-stop' });

  const status = await waitFor(async () => {
    const value = await api(`/api/tasks/${task.id}/plan`);
    return value.state === 'PAUSED_REVIEW' ? value : null;
  });
  assert.ok(status, 'STOP leaves the plan for review');
  await sleep(2000);
  assert.equal((await deliveries(root)).length, 1, 'no audit turn and no next step after STOP');
  assert.equal((await planOf(root)).steps[0].status, 'TODO');
});

const IMPORTED = PLAN
  .replace('Первый шаг', 'Первый шаг manual-only')
  .replace('**Проверка:** read\n\n### S-002', '**Проверка:** импортировано: способ проверки не задан\n\n### S-002');

test('CP-09: план без способа проверки закрывается описанием сверки', { timeout: 60000 }, async t => {
  // Живой прогон 2026-10-27: импортированный план, у шага «способ проверки не
  // задан», модель прислала manual — и цикл встал навсегда, потому что ссылку
  // требовать не с чего. Теперь такой шаг закрывается, но помечается manual.
  const fixture = await fixtureWithPlan(t, IMPORTED);
  const { api, root } = fixture;
  const task = await createTask(api);
  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cp09-attach' });
  await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cp09-start' });

  const done = await waitFor(async () => {
    const written = await planOf(root).catch(() => null);
    return written?.steps?.[0]?.status === 'DONE' ? written : null;
  });
  assert.ok(done, `шаг должен закрыться: ${fixture.logs()}`);
  assert.match(done.steps[0].result, /сверено вручную/, 'в файле остаётся описание сверки');
});

test('CP-10: отказ проверки чекпоинта называется своим кодом, а не «заблокировано»', { timeout: 60000 }, async t => {
  // Тот же manual, но у шага ЕСТЬ способ проверки: ссылки нет — отказ, и в
  // событиях это отказ проверки, а не решение модели BLOCKED.
  const fixture = await fixtureWithPlan(t, PLAN.replace('Первый шаг', 'Первый шаг manual-only'));
  const { api, root } = fixture;
  const task = await createTask(api);
  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cp10-attach' });
  await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cp10-start' });

  const paused = await waitFor(async () => {
    const value = await api(`/api/tasks/${task.id}/plan`);
    return value.state === 'PAUSED_REVIEW' ? value : null;
  });
  assert.ok(paused, `цикл должен встать на разбор: ${fixture.logs()}`);
  assert.equal((await planOf(root)).steps[0].status, 'TODO', 'шаг не закрыт');
  const events = await api(`/api/tasks/${task.id}/events?limit=200`);
  const rejected = events.filter(event => event.type === 'PLAN_CHECKPOINT_REJECTED').at(-1);
  assert.ok(rejected, 'есть событие отказа проверки');
  assert.match(JSON.stringify(rejected.data.problems), /способ проверки/);
  const pause = events.filter(event => event.type === 'PLAN_PAUSED').at(-1);
  assert.equal(pause?.data?.code, 'PLAN_CHECKPOINT_REJECTED', 'пауза названа отказом проверки');
});
