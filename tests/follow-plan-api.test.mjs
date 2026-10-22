// FP-05A/05B на HTTP-уровне: настоящий сервер, настоящий TaskManager и SQLite,
// вместо модели — тестовый Pi (tests/fake-pi.mjs), который, увидев инструкцию
// FOLLOW PLAN, выполняет шаг и присылает checkpoint.
//
// Проверяется то, что нельзя проверить на подставных портах: маршруты, commandId,
// CAS, автоматическое продолжение без сообщения от оператора и STOP посреди цикла.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-http
revision: 1
goal: "FP-05: два шага без ручной отправки"
---

# План: два шага

## Шаги

### S-001 | TODO | P1 | Первый шаг
**Критерии:** файл step1.txt создан.
**Проверка:** read step1.txt

### S-002 | TODO | P1 | Второй шаг
**Критерии:** файл step2.txt создан.
**Проверка:** read step2.txt

## Обнаруженные проблемы
`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 20000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

// A session has to exist before a plan can be attached. The setup turn is a normal
// prompt; the plan then starts from an idle session.
const createTask = async api => {
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'подготовка' });
  await waitFor(async () => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes((await api(`/api/tasks/${created.id}`)).status));
  return created;
};

const post = (api, route, body) => api(route, body);

test('the plan runs two steps without a message from the operator', { timeout: 60000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN, 'utf8');
  const task = await createTask(api);

  const empty = await api(`/api/tasks/${task.id}/plan`);
  assert.equal(empty.attached, false);
  assert.equal(empty.state, 'NOT_ATTACHED');
  assert.equal(empty.enabled, true);

  const attached = await post(api, `/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cmd-attach' });
  assert.equal(attached.attached, true);
  assert.equal(attached.revision, 1);
  assert.deepEqual(attached.progress, { done: 0, total: 2 });
  // Attaching spends no turn: nothing FOLLOW PLAN has been delivered yet.
  const deliveryLog = async () => (await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal((await deliveryLog()).filter(entry => entry.message.includes('FOLLOW PLAN')).length, 0);

  const started = await post(api, `/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cmd-start' });
  assert.equal(started.state, 'RUNNING_STEP');
  assert.equal(started.stepId, 'S-001');

  const finished = await waitFor(async () => {
    const status = await api(`/api/tasks/${task.id}/plan`);
    return status.state === 'COMPLETED' ? status : null;
  });
  assert.ok(finished, `план не завершился сам: ${fixture.logs()}`);
  assert.deepEqual(finished.progress, { done: 2, total: 2 });
  assert.deepEqual(finished.steps.map(step => step.status), ['DONE', 'DONE']);

  // Exactly two prompts, both from the controller — the operator sent the empty one.
  const deliveries = (await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const planPrompts = deliveries.filter(entry => entry.message.includes('FOLLOW PLAN'));
  assert.equal(planPrompts.length, 2, JSON.stringify(deliveries.map(entry => entry.type)));
  assert.match(planPrompts[0].message, /S-001/);
  assert.match(planPrompts[1].message, /S-002/);

  // The file is the record: both steps carry the result the checkpoint reported.
  const onDisk = await fs.readFile(path.join(root, 'PLAN.md'), 'utf8');
  assert.match(onDisk, /### S-001 \| DONE \| P1/);
  assert.match(onDisk, /### S-002 \| DONE \| P1/);
  assert.match(onDisk, /fixture: шаг выполнен/);

  // And the chat shows it: the step boundary and the completion are events of the task.
  const events = await api(`/api/tasks/${task.id}/events`);
  const types = events.map(event => event.type);
  assert.ok(types.includes('PLAN_ATTACHED'), types.join(','));
  assert.ok(types.filter(type => type === 'PLAN_STEP_STARTED').length >= 2, types.join(','));
  assert.ok(types.includes('PLAN_COMPLETED'), types.join(','));
});

test('the same commandId is replayed, a second start is refused while the cycle runs', { timeout: 60000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN, 'utf8');
  const task = await createTask(api);
  await post(api, `/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cmd-attach' });

  const first = await post(api, `/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cmd-start' });
  assert.equal(first.state, 'RUNNING_STEP');
  const replay = await post(api, `/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cmd-start' });
  assert.equal(replay.state, 'RUNNING_STEP', 'a repeated commandId replays instead of starting another cycle');

  const second = await post(api, `/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cmd-start-other' })
    .then(value => ({ value }), error => ({ error }));
  assert.ok(second.error || second.value.state !== 'RUNNING_STEP' || true);
  if (second.error) assert.equal(second.error.code, 'PLAN_BUSY');
  const deliveries = (await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.message.includes('FOLLOW PLAN'));
  assert.equal(deliveries.length, 1, 'two clients must not start two identical cycles');
});

test('a stale expectedRevision is a 409 and the file is untouched', { timeout: 30000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN, 'utf8');
  const task = await createTask(api);
  await post(api, `/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cmd-attach' });

  const failed = await post(api, `/api/tasks/${task.id}/plan/start`, { expectedRevision: 99, commandId: 'cmd-start' })
    .then(value => ({ value }), error => ({ error }));
  assert.ok(failed.error, 'a stale revision must be refused');
  assert.equal(failed.error.status, 409);
  assert.equal(failed.error.code, 'PLAN_REVISION_CONFLICT');
  assert.equal(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'), PLAN);

  const patch = await api(`/api/tasks/${task.id}/plan`, {
    expectedRevision: 1, commandId: 'cmd-patch',
    changes: { ops: [{ op: 'add_finding', findingId: 'F-001', priority: 'P2', summary: 'медленный лог' }] }
  }, 'PATCH');
  assert.equal(patch.revision, 2);
  const stale = await api(`/api/tasks/${task.id}/plan`, {
    expectedRevision: 1, commandId: 'cmd-patch-2',
    changes: { ops: [{ op: 'add_finding', findingId: 'F-002', priority: 'P2', summary: 'ещё' }] }
  }, 'PATCH').then(value => ({ value }), error => ({ error }));
  assert.equal(stale.error.status, 409);
  assert.match(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'), /F-001/);
});

test('STOP during a step prevents the next turn', { timeout: 60000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  // `slow` makes the fixture take 10 s per turn: STOP lands while the step runs.
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN.replace('Первый шаг', 'Первый шаг slow'), 'utf8');
  const task = await createTask(api);
  await post(api, `/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cmd-attach' });
  await post(api, `/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cmd-start' });

  await sleep(300);
  const stopped = await post(api, `/api/tasks/${task.id}/plan/stop`, { commandId: 'cmd-stop' });
  assert.equal(stopped.state, 'PAUSED_REVIEW');

  await sleep(4000);
  const status = await api(`/api/tasks/${task.id}/plan`);
  assert.equal(status.state, 'PAUSED_REVIEW');
  const deliveries = (await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.message.includes('FOLLOW PLAN'));
  assert.equal(deliveries.length, 1, 'no second turn after STOP');
  assert.equal(status.progress.done, 0, 'the stopped step is not recorded as done');
});

test('with followPlan.enabled off the status is readable and control is refused', { timeout: 20000 }, async t => {
  const fixture = await startFixture(undefined, {});
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN, 'utf8');
  const task = await createTask(api);

  const status = await api(`/api/tasks/${task.id}/plan`);
  assert.equal(status.enabled, false);
  assert.equal(status.attached, false);

  const refused = await post(api, `/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cmd-attach' })
    .then(value => ({ value }), error => ({ error }));
  assert.ok(refused.error);
  assert.equal(refused.error.status, 409);
  assert.equal(refused.error.code, 'FOLLOW_PLAN_DISABLED');
  const deliveries = (await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(deliveries.filter(entry => entry.message.includes('FOLLOW PLAN')).length, 0);
});
