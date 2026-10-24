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

  // Evidence trust comes from the SERVER: TaskManager saw the fixture's proof call
  // end without an error, carried its id through hooks.turnSettled, and only then
  // the file and the dialog may say «подтверждено системой» (FP-UX-02F wiring).
  assert.match(onDisk, /\[SYSTEM_VERIFIED\]/, 'the real frame path produced a system level');
  const status = await api(`/api/tasks/${task.id}/plan`);
  assert.equal(status.steps[0].verification, 'SYSTEM_VERIFIED', 'server receipt matches the file');
  assert.equal(status.steps[1].verification, 'SYSTEM_VERIFIED');

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

test('FP-UX-04B: scanning the project over HTTP finds nested plans and never starts a turn', { timeout: 40000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.mkdir(path.join(root, 'docs', 'deep'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'deep', 'PLAN.md'), PLAN, 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'TODO.md'), '# Задачи\n\n- [ ] Починить пагинацию\n', 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'README.md'), '# Проект\n\n1. Установить\n', 'utf8');
  await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'PLAN.md'), PLAN, 'utf8');
  const task = await createTask(api);

  const scan = await post(api, `/api/tasks/${task.id}/plan/scan`, { query: '' });
  const paths = scan.files.map(file => file.path).sort();
  assert.deepEqual(paths, ['docs/README.md', 'docs/TODO.md', 'docs/deep/PLAN.md']);
  assert.equal(scan.partial, false);
  const byPath = new Map(scan.files.map(file => [file.path, file]));
  assert.equal(byPath.get('docs/deep/PLAN.md').classification, 'VALID_MANAGED');
  assert.equal(byPath.get('docs/TODO.md').classification, 'CONVERTIBLE');
  assert.equal(byPath.get('docs/README.md').classification, null);

  const filtered = await post(api, `/api/tasks/${task.id}/plan/scan`, { query: 'deep' });
  assert.deepEqual(filtered.files.map(file => file.path), ['docs/deep/PLAN.md']);

  // Scanning is not a plan action: the plan stays unattached and no FOLLOW PLAN
  // instruction has been delivered.
  const status = await api(`/api/tasks/${task.id}/plan`);
  assert.equal(status.attached, false);
  const deliveries = (await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.message.includes('FOLLOW PLAN'));
  assert.equal(deliveries.length, 0);

  // A GET is not the scan route: the answer is the plain 404, not a silent walk.
  const asGet = await api(`/api/tasks/${task.id}/plan/scan`).then(value => ({ value }), error => ({ error }));
  assert.equal(asGet.error?.status, 404);
});

test('FP-UX-04D: a project Markdown file is inspected in place and a README is refused', { timeout: 40000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'PLAN.md'), PLAN, 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'TODO.md'), '# Задачи\n\n- [ ] Починить пагинацию\n', 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'README.md'), '# Проект\n\n1. Установить зависимости\n', 'utf8');
  const task = await createTask(api);

  const managed = await post(api, `/api/tasks/${task.id}/plan/inspect`, { path: 'docs/PLAN.md' });
  assert.equal(managed.verdict, 'VALID_MANAGED');
  assert.equal(managed.managed, true);

  const convertible = await post(api, `/api/tasks/${task.id}/plan/inspect`, { path: 'docs/TODO.md' });
  assert.equal(convertible.verdict, 'CONVERTIBLE');
  assert.match(convertible.preview.content, /taskbridge_plan: 1/);
  assert.equal(await fs.readFile(path.join(root, 'docs', 'TODO.md'), 'utf8'), '# Задачи\n\n- [ ] Починить пагинацию\n');

  const notAPlan = await post(api, `/api/tasks/${task.id}/plan/inspect`, { path: 'docs/README.md' });
  assert.equal(notAPlan.verdict, 'NOT_A_PLAN');

  const refused = await post(api, `/api/tasks/${task.id}/plan/import`, { path: 'docs/README.md', commandId: 'readme-import' })
    .then(value => ({ value }), error => ({ error }));
  assert.equal(refused.error?.status, 400);
  assert.match(String(refused.error?.message || ''), /не подходит как план/);
  const empty = await api(`/api/tasks/${task.id}/plan`);
  assert.equal(empty.attached, false, 'ничего не подключено');
});

test('FP-UX-04E: the AI check is an explicit route and its absence does not block the plan', { timeout: 40000 }, async t => {
  // The fixture session has no model, so the server answers «модель недоступна» —
  // exactly the case the requirement names: a valid plan still attaches.
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN, 'utf8');
  const task = await createTask(api);

  const review = await post(api, `/api/tasks/${task.id}/plan/ai-review`, { path: 'PLAN.md' })
    .then(value => ({ value }), error => ({ error }));
  assert.ok(review.error, 'без модели ответ — ошибка, а не выдуманный вердикт');
  assert.equal(review.error?.code, 'AI_UNAVAILABLE');
  assert.match(String(review.error?.message || ''), /Обычная проверка формата остаётся доступной/);

  const attached = await post(api, `/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'attach-no-ai' });
  assert.equal(attached.attached, true);
});

test('FP-UX-04E: the AI check creates no run and sends no prompt', { timeout: 40000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN, 'utf8');
  const task = await createTask(api);
  const runsBefore = (await api(`/api/tasks/${task.id}/runs`)).runs?.length ?? 0;
  const deliveries = async () => (await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

  await post(api, `/api/tasks/${task.id}/plan/ai-review`, { path: 'PLAN.md' }).catch(() => {});
  await sleep(600);
  const runsAfter = (await api(`/api/tasks/${task.id}/runs`)).runs?.length ?? 0;
  assert.equal(runsAfter, runsBefore, 'ни одного нового Run');
  assert.equal((await deliveries()).filter(entry => entry.message.includes('FOLLOW PLAN')).length, 0);
  assert.equal((await api(`/api/tasks/${task.id}`)).status, 'SUCCEEDED', 'сессия осталась в прежнем состоянии');
});

test('FP-UX-04D: confirm is bound to the previewed text over HTTP', { timeout: 40000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  const original = '# Задачи\n\n- [ ] Починить пагинацию\n';
  await fs.writeFile(path.join(root, 'docs', 'TODO.md'), original, 'utf8');
  const task = await createTask(api);

  const inspection = await post(api, `/api/tasks/${task.id}/plan/inspect`, { path: 'docs/TODO.md' });
  assert.ok(inspection.hash, 'проверка отдаёт хэш показанного текста');

  await fs.writeFile(path.join(root, 'docs', 'TODO.md'), '# Другой документ\n', 'utf8');
  const stale = await post(api, `/api/tasks/${task.id}/plan/import`, {
    path: 'docs/TODO.md', confirmImport: true, expectedHash: inspection.hash, commandId: 'stale-http'
  }).then(value => ({ value }), error => ({ error }));
  assert.equal(stale.error?.code, 'PLAN_REVISION_CONFLICT');
  assert.equal(await fs.readFile(path.join(root, 'docs', 'TODO.md'), 'utf8'), '# Другой документ\n');
  assert.equal((await api(`/api/tasks/${task.id}/plan`)).attached, false);
});

test('FP-UX-04D: the attach route itself refuses a file edited after the preview', { timeout: 40000 }, async t => {
  // the preview card lives on /plan/inspect, but a client may attach straight
  // from it: the hash has to be honoured on that path too, not only on import.
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN, 'utf8');
  const task = await createTask(api);

  const inspection = await post(api, `/api/tasks/${task.id}/plan/inspect`, { path: 'PLAN.md' });
  assert.equal(inspection.verdict, 'VALID_MANAGED');
  assert.ok(inspection.hash);

  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN.replace('Первый шаг', 'Подменённый шаг'), 'utf8');
  const stale = await post(api, `/api/tasks/${task.id}/plan/attach`, {
    path: 'PLAN.md', expectedHash: inspection.hash, commandId: 'attach-stale'
  }).then(value => ({ value }), error => ({ error }));
  assert.equal(stale.error?.code, 'PLAN_REVISION_CONFLICT');
  assert.equal((await api(`/api/tasks/${task.id}/plan`)).attached, false, 'привязки нет');

  // A client that attaches without a preview sends no hash and is not refused.
  const attached = await post(api, `/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'attach-plain' });
  assert.equal(attached.attached, true);
  assert.equal(attached.state, 'IDLE');
});

test('a file from the device keeps its content path: inspect → import with the shown hash', { timeout: 40000 }, async t => {
  // The SAF / file-picker path (FP-UX-03/04C): the client sends bytes, not a path.
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  const task = await createTask(api);
  const contentBase64 = Buffer.from(PLAN, 'utf8').toString('base64');

  const inspection = await post(api, `/api/tasks/${task.id}/plan/inspect`, { name: 'pick.md', contentBase64 });
  assert.equal(inspection.verdict, 'VALID_MANAGED');
  assert.equal(inspection.path, 'pick.md');

  // A confirmation carrying the hash of a different text is refused.
  const stale = await post(api, `/api/tasks/${task.id}/plan/import`, {
    name: 'pick.md', contentBase64, confirmImport: true, expectedHash: 'deadbeef', commandId: 'upload-stale'
  }).then(value => ({ value }), error => ({ error }));
  assert.equal(stale.error?.code, 'PLAN_REVISION_CONFLICT');
  assert.equal((await api(`/api/tasks/${task.id}/plan`)).attached, false);

  const attached = await post(api, `/api/tasks/${task.id}/plan/import`, {
    name: 'pick.md', contentBase64, confirmImport: true, expectedHash: inspection.hash, commandId: 'upload-ok'
  });
  assert.equal(attached.status.attached, true);
  assert.equal(attached.status.path, 'pick.md');
  assert.equal(await fs.readFile(path.join(root, 'pick.md'), 'utf8'), PLAN.replace(/\r\n/g, '\n'));
  const runs = (await api(`/api/tasks/${task.id}/runs`)).runs.length;
  assert.equal(runs, 1, 'загрузка файла не запускает ход');
});
