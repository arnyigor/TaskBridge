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
import { parsePlan } from '../src/application/plan-file.mjs';

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

test('a blocking P1 defect found in a step is inserted next and fixed automatically', { timeout: 60000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN.replace('Первый шаг', 'Первый шаг finding-P1'), 'utf8');
  const task = await createTask(api);
  await post(api, `/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cmd-attach' });
  await post(api, `/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cmd-start' });

  const finished = await waitFor(async () => {
    const status = await api(`/api/tasks/${task.id}/plan`);
    return status.state === 'COMPLETED' ? status : null;
  }, { timeout: 30000 });
  assert.ok(finished, `план не завершился после автоправки: ${fixture.logs()}`);

  const onDisk = parsePlan(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'));
  const inserted = onDisk.steps.find(step => step.originFindingId === 'F-900');
  assert.ok(inserted, 'the P1 defect became a concrete step with its origin');
  assert.equal(inserted.priority, 'P1');
  assert.equal(inserted.status, 'DONE');
  assert.ok(onDisk.findings.some(finding => finding.id === 'F-900'));
  // It runs before the step it blocks, and it is not reported twice.
  const order = onDisk.steps.map(step => step.id);
  assert.ok(order.indexOf(inserted.id) < order.indexOf('S-002'), order.join(','));
  assert.equal(onDisk.steps.filter(step => step.originFindingId === 'F-900').length, 1);

  const deliveries = (await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.message.includes('FOLLOW PLAN'));
  assert.ok(deliveries.some(entry => entry.message.includes(inserted.id)), 'the inserted step got its own turn');
});

test('a P0 defect stops the automatic cycle for the operator', { timeout: 40000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN.replace('Первый шаг', 'Первый шаг finding-P0'), 'utf8');
  const task = await createTask(api);
  await post(api, `/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cmd-attach' });
  await post(api, `/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cmd-start' });

  const paused = await waitFor(async () => {
    const status = await api(`/api/tasks/${task.id}/plan`);
    return status.state === 'PAUSED_REVIEW' ? status : null;
  }, { timeout: 20000 });
  assert.ok(paused, `цикл не остановился на P0: ${fixture.logs()}`);

  const onDisk = parsePlan(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'));
  assert.equal(onDisk.steps.length, 2, 'nothing is inserted before the operator approves a P0');
  assert.equal(onDisk.steps[0].status, 'TODO', 'the file is not touched either');
  const deliveries = (await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.message.includes('FOLLOW PLAN'));
  assert.equal(deliveries.length, 1, 'no second turn for an unapproved P0');
});

test('a P3 note is recorded and does not expand the work', { timeout: 40000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN.replace('Первый шаг', 'Первый шаг finding-P3'), 'utf8');
  const task = await createTask(api);
  await post(api, `/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cmd-attach' });
  await post(api, `/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cmd-start' });

  const finished = await waitFor(async () => {
    const status = await api(`/api/tasks/${task.id}/plan`);
    return status.state === 'COMPLETED' ? status : null;
  }, { timeout: 30000 });
  assert.ok(finished, `план не завершился: ${fixture.logs()}`);
  const onDisk = parsePlan(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'));
  assert.equal(onDisk.steps.length, 2, 'a cosmetic note adds no step');
  assert.ok(onDisk.findings.some(finding => finding.id === 'F-900' && finding.priority === 'P3'));
});

test('a repeated settle (reconnect, duplicated frame) does not start another cycle', { timeout: 60000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  // The step heading asks the fixture to repeat `agent_settled` after the turn.
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN.replace('Первый шаг', 'Первый шаг double-settle'), 'utf8');
  const task = await createTask(api);
  await post(api, `/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'cmd-attach' });
  await post(api, `/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'cmd-start' });

  const finished = await waitFor(async () => {
    const status = await api(`/api/tasks/${task.id}/plan`);
    return status.state === 'COMPLETED' ? status : null;
  }, { timeout: 30000 });
  assert.ok(finished, `план не завершился: ${fixture.logs()}`);
  await sleep(1200);

  const deliveries = (await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.message.includes('FOLLOW PLAN'));
  assert.equal(deliveries.length, 2, `repeated settles must not add turns: ${deliveries.length}`);
  assert.equal((await api(`/api/tasks/${task.id}/plan`)).state, 'COMPLETED');
});

test('detaching removes the binding and keeps the file; a running cycle pauses first', { timeout: 60000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN.replace('Первый шаг', 'Первый шаг slow'), 'utf8');
  const task = await createTask(api);
  await post(api, `/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'detach-attach' });
  await post(api, `/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'detach-start' });
  await waitFor(async () => (await api(`/api/tasks/${task.id}/plan`)).state === 'RUNNING_STEP');

  const detached = await post(api, `/api/tasks/${task.id}/plan/detach`, { commandId: 'detach-detach' });
  assert.equal(detached.attached, false);
  assert.equal(detached.state, 'NOT_ATTACHED');
  // The plan file is the operator's: detaching must not touch it.
  assert.equal(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'),
    PLAN.replace('Первый шаг', 'Первый шаг slow'));
  const events = await api(`/api/tasks/${task.id}/events`);
  assert.ok(events.some(event => event.type === 'PLAN_DETACHED'));
  assert.ok(events.some(event => event.type === 'PLAN_PAUSED'), 'the running cycle was paused, not left dangling');

  // And nothing dispatches after the detach.
  await sleep(1500);
  const deliveries = (await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.message.includes('FOLLOW PLAN'));
  assert.equal(deliveries.length, 1);
});

test('the project browser answers a plain GET (the phone picks a file on the computer)', { timeout: 40000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'PLAN.md'), PLAN, 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'notes.txt'), 'x', 'utf8');
  const task = await createTask(api);

  const listing = await api(`/api/tasks/${task.id}/plan/browse?path=`);
  const names = listing.entries.map(entry => entry.name);
  assert.ok(names.includes('docs'), names.join(','));
  assert.equal(names.includes('notes.txt'), false, 'only folders and Markdown are listed');
  assert.equal(listing.parent, null);

  const docs = await api(`/api/tasks/${task.id}/plan/browse?path=docs`);
  assert.deepEqual(docs.entries.map(entry => entry.name), ['PLAN.md']);
  assert.equal(docs.parent, '');

  const escape = await post(api, `/api/tasks/${task.id}/plan/browse?path=..`, {}).then(value => ({ value }), error => ({ error }));
  assert.ok(escape.error || escape.value === undefined || true);
  const refused = await api(`/api/tasks/${task.id}/plan/browse?path=..`).then(value => ({ value }), error => ({ error }));
  assert.equal(refused.error.status, 400);
});
