import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { resolveMisfire } from '../src/scheduler/schedule.mjs';
import { startFixture } from './server-fixture.mjs';

// MR-06: расписания, инвокации и политики. Тик вызывается с ЯВНЫМ «сейчас» — не
// потому что так короче, а потому что иначе проверка «ПК был выключен три дня»
// занимала бы три дня. Решения принимает тот же код, что работает на машине.

/** A fixture whose config knows one passing and one failing verification profile. */
async function fixtureWithProfiles(t, extraProfiles = {}) {
  const fixture = await startFixture(undefined, {
    root: {
      verificationProfiles: {
        passing: ['node -e "process.exit(0)"'],
        failing: ['node -e "process.exit(1)"'],
        ...extraProfiles,
      },
    },
  });
  t.after(() => fixture.close());
  return fixture;
}

async function setup(t, { recipe = {}, profile = null } = {}) {
  const fixture = await fixtureWithProfiles(t);
  const api = fixture.api;
  const headers = { 'content-type': 'application/json' };
  const [project] = await api('/api/projects');
  const post = async (route, body, expect = 201) => {
    const response = await fetch(fixture.base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, expect, `POST ${route} → ${response.status}: ${text}`);
    return JSON.parse(text);
  };
  const created = await post('/api/recipes', {
    projectId: project.id,
    name: 'Daily audit',
    promptTemplate: 'Проверь {{area}}.',
    parameters: { area: { type: 'enum', values: ['all', 'android'], default: 'all' } },
    ...(profile ? { verification: { required: true, command: profile } } : {}),
    ...recipe,
  });
  return { fixture, api, project, recipe: created, post, headers };
}

/**
 * The tick over HTTP with an explicit «now»: the endpoint exists for exactly this —
 * asking the machine what it would do, instead of waiting for 09:00 (and instead of
 * waiting three days for «the PC was off»).
 */
async function tick(fixture, nowIso) {
  const response = await fetch(`${fixture.base}/api/scheduler/tick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ now: nowIso }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `tick → ${response.status}: ${text}`);
  return JSON.parse(text);
}

test('a due schedule creates an invocation, and the invocation follows its session', { timeout: 120000 }, async t => {
  const { fixture, api, recipe, post } = await setup(t);
  const schedule = await post('/api/schedules', {
    recipeId: recipe.id,
    spec: { kind: 'daily', at: '09:00' },
    parameters: { area: 'android' },
  });
  assert.match(schedule.id, /^sc-/);
  assert.equal(schedule.misfirePolicy, 'RUN_ONCE', 'по умолчанию — один пропущенный запуск');
  assert.equal(schedule.concurrencyPolicy, 'SKIP_IF_RUNNING');
  assert.equal(schedule.notify, 'action-required');
  assert.ok(schedule.nextRunAt, 'первый момент посчитан сервером, а не клиентом');

  // A tick before the moment does nothing at all.
  const early = await tick(fixture, new Date(Date.parse(schedule.nextRunAt) - 60_000).toISOString());
  assert.deepEqual(early.decisions, [], 'ещё не время');

  // The moment has come (a minute late, no missed occurrences).
  const due = new Date(Date.parse(schedule.nextRunAt) + 60_000).toISOString();
  const result = await tick(fixture, due);
  const decision = result.decisions.find(entry => entry.scheduleId === schedule.id);
  assert.equal(decision.action, 'run', JSON.stringify(result.decisions));
  const invocation = await api(`/api/invocations/${decision.invocationId}`);
  assert.equal(invocation.status, 'RUNNING');
  assert.equal(invocation.trigger, 'schedule');
  assert.equal(invocation.scheduledAt, schedule.nextRunAt);
  assert.equal(invocation.sessionId, decision.sessionId);
  assert.deepEqual(invocation.parameters, { area: 'android' }, 'параметры расписания попали в запуск');
  const session = await api(`/api/tasks/${invocation.sessionId}`);
  assert.equal(session.prompt, 'Проверь android.', 'параметры подставлены в промпт');
  assert.equal(session.recipeRun.recipeId, recipe.id);
  assert.equal(session.recipeRun.invocationId, invocation.id, 'сессия знает свой запуск');
  assert.equal(session.scheduleNotify, 'action-required', 'политика уведомлений едет с сессией');

  // The schedule moved on, and a second tick at the same time does nothing.
  const moved = await api(`/api/schedules/${schedule.id}`);
  assert.ok(moved.nextRunAt > schedule.nextRunAt, 'следующий момент — дальше');
  assert.ok(moved.lastRunAt, 'и отмечено, когда запускали');
  assert.deepEqual((await tick(fixture, due)).decisions, [], 'второй тик в тот же момент ничего не запускает');

  // The session finishes; the next tick copies its outcome into the invocation.
  await until(async () => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes((await api(`/api/tasks/${invocation.sessionId}`)).status));
  await tick(fixture, due);
  const finished = await api(`/api/invocations/${invocation.id}`);
  assert.ok(['SUCCEEDED', 'FAILED'].includes(finished.status), `итог сессии перенесён: ${finished.status}`);
  assert.ok(finished.finishedAt, 'и время окончания');
  assert.equal(finished.resultArtifact, finished.status === 'SUCCEEDED' ? 'result.md' : null);

  // The history is per recipe and per schedule.
  assert.deepEqual((await api(`/api/invocations?recipeId=${recipe.id}`)).items.map(i => i.id), [invocation.id]);
  assert.deepEqual((await api(`/api/invocations?scheduleId=${schedule.id}`)).items.map(i => i.id), [invocation.id]);
  assert.deepEqual((await api('/api/invocations?status=SUCCEEDED')).items.length, finished.status === 'SUCCEEDED' ? 1 : 0);
});

async function until(check, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('a busy schedule is skipped, not stacked', { timeout: 120000 }, async t => {
  // `fault-hang` never finishes: the previous run really is still working.
  const { fixture, api, recipe, post } = await setup(t, { recipe: { promptTemplate: 'fault-hang {{area}}' } });
  const schedule = await post('/api/schedules', { recipeId: recipe.id, spec: { kind: 'daily', at: '09:00' } });
  const first = await tick(fixture, new Date(Date.parse(schedule.nextRunAt) + 60_000).toISOString());
  const running = first.decisions.find(entry => entry.scheduleId === schedule.id);
  assert.equal(running.action, 'run');
  assert.equal((await api(`/api/invocations/${running.invocationId}`)).status, 'RUNNING');

  // The next day arrives while the first run is still going.
  const again = await tick(fixture, new Date(Date.parse(schedule.nextRunAt) + 25 * 60 * 60_000).toISOString());
  const skipped = again.decisions.find(entry => entry.scheduleId === schedule.id);
  assert.equal(skipped.action, 'busy', JSON.stringify(again.decisions));
  const history = await api(`/api/invocations?scheduleId=${schedule.id}`);
  const recorded = history.items.find(item => item.status === 'SKIPPED');
  assert.ok(recorded, `пропуск записан: ${JSON.stringify(history.items.map(i => [i.status, i.reason]))}`);
  assert.match(recorded.reason, /SKIP_IF_RUNNING/);
  assert.equal(history.items.filter(item => item.status === 'RUNNING').length, 1, 'второй запуск не создан');
  assert.equal((await api('/api/tasks')).length, 1, 'и второй сессии нет');
});

test('what happens to a run missed while the machine was off', { timeout: 120000 }, async t => {
  const { fixture, api, recipe, post } = await setup(t);
  const makeSchedule = (misfirePolicy) => post('/api/schedules', {
    recipeId: recipe.id, spec: { kind: 'daily', at: '09:00' }, misfirePolicy,
    parameters: { area: 'all' },
  });
  const threeDaysLater = (schedule) => new Date(Date.parse(schedule.nextRunAt) + 3 * 24 * 60 * 60_000 + 60_000).toISOString();

  // RUN_ONCE (default): one run, the newest missed moment, and the rest recorded as missed.
  const once = await makeSchedule('RUN_ONCE');
  const onceTick = await tick(fixture, threeDaysLater(once));
  const onceDecision = onceTick.decisions.find(entry => entry.scheduleId === once.id);
  assert.equal(onceDecision.action, 'run');
  const onceInvocation = await api(`/api/invocations/${onceDecision.invocationId}`);
  assert.equal(onceInvocation.misfire, true, 'запуск помечен как догоняющий');
  assert.equal((await api(`/api/invocations?scheduleId=${once.id}`)).items.length, 1, 'ровно один запуск, а не три');

  // SKIP: nothing runs, and the operator still sees that moments were missed.
  const skip = await makeSchedule('SKIP');
  const skipTick = await tick(fixture, threeDaysLater(skip));
  const skipDecision = skipTick.decisions.find(entry => entry.scheduleId === skip.id);
  assert.equal(skipDecision.action, 'skipped');
  assert.ok(skipDecision.missed >= 1, `видно, сколько пропущено: ${JSON.stringify(skipDecision)}`);
  const skipped = await api(`/api/invocations?scheduleId=${skip.id}`);
  assert.deepEqual(skipped.items.map(item => item.status), ['SKIPPED']);
  assert.equal((await api('/api/tasks')).length, 1, 'пропуск не создал сессию');

  // CATCH_UP asks for every missed moment, and then the CONCURRENCY policy has the
  // last word: with the default SKIP_IF_RUNNING the second moment cannot start while
  // the first is still working, and the skip is recorded rather than hidden.
  const catchUp = await makeSchedule('CATCH_UP');
  const catchUpTick = await tick(fixture, threeDaysLater(catchUp));
  const catchUpDecisions = catchUpTick.decisions.filter(entry => entry.scheduleId === catchUp.id);
  assert.deepEqual(catchUpDecisions.map(entry => entry.action), ['run', 'busy', 'busy', 'busy'], JSON.stringify(catchUpDecisions));
  assert.deepEqual(
    (await api(`/api/invocations?scheduleId=${catchUp.id}`)).items.map(item => item.status).sort(),
    ['RUNNING', 'SKIPPED', 'SKIPPED', 'SKIPPED'],
  );

  // With QUEUE the same moments all become runs (the machine's own queue serialises
  // what it cannot run at once) — that is the documented way to catch up for real.
  const queued = await post('/api/schedules', {
    recipeId: recipe.id, spec: { kind: 'daily', at: '09:00' }, misfirePolicy: 'CATCH_UP', concurrencyPolicy: 'QUEUE',
    parameters: { area: 'all' },
  });
  const queuedTick = await tick(fixture, threeDaysLater(queued));
  const queuedRuns = queuedTick.decisions.filter(entry => entry.scheduleId === queued.id && entry.action === 'run');
  assert.equal(queuedRuns.length, 4, `QUEUE не отбрасывает догон: ${JSON.stringify(queuedTick.decisions)}`);
  assert.equal((await api(`/api/invocations?scheduleId=${queued.id}`)).items.length, 4);
});

test('running by hand does not move the schedule, and a pause keeps its moment', { timeout: 120000 }, async t => {
  const { fixture, api, recipe, post } = await setup(t);
  const schedule = await post('/api/schedules', { recipeId: recipe.id, spec: { kind: 'interval', everyMinutes: 60 } });
  const before = await api(`/api/schedules/${schedule.id}`);

  const invocation = await post(`/api/schedules/${schedule.id}/run`, {});
  assert.equal(invocation.trigger, 'manual');
  assert.equal(invocation.scheduleId, schedule.id);
  assert.equal(invocation.misfire, false);
  const after = await api(`/api/schedules/${schedule.id}`);
  assert.equal(after.nextRunAt, before.nextRunAt, 'ручной запуск не сдвигает расписание');
  assert.ok(after.lastRunAt, 'но виден как последний запуск');

  // A manual run is RUNNING until a tick reconciles it — the same rule as a
  // scheduled one, and the reason the concurrency policy can see it at all.
  await until(async () => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes((await api(`/api/tasks/${invocation.sessionId}`)).status));
  await tick(fixture, new Date().toISOString());
  assert.equal((await api(`/api/invocations/${invocation.id}`)).status !== 'RUNNING', true, 'ручной запуск закрыт сверкой');

  // Pausing stops the tick and keeps the moment, so resuming does not jump a day.
  const paused = await api(`/api/schedules/${schedule.id}`, { enabled: false }, 'PATCH');
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, before.nextRunAt, 'пауза сохраняет момент');
  const late = new Date(Date.parse(before.nextRunAt) + 60_000).toISOString();
  assert.deepEqual((await tick(fixture, late)).decisions, [], 'выключенное расписание не запускается');

  const resumed = await api(`/api/schedules/${schedule.id}`, { enabled: true }, 'PATCH');
  assert.equal(resumed.enabled, true);
  const afterResume = await tick(fixture, late);
  const reason = resolveMisfire(resumed, late, { anchor: resumed.spec.kind === 'interval' ? resumed.createdAt : null });
  assert.deepEqual(
    afterResume.decisions.map(entry => entry.action),
    ['run'],
    `после включения — тот же момент; spec=${JSON.stringify(resumed.spec)} created=${resumed.createdAt} nextRunAt=${resumed.nextRunAt} late=${late}` +
      ` misfire=${JSON.stringify(reason)} decisions=${JSON.stringify(afterResume.decisions)}`,
  );

  // And a schedule for a recipe that is gone is switched off instead of failing every tick.
  await api(`/api/recipes/${recipe.id}`, {}, 'DELETE');
  const orphan = await tick(fixture, new Date(Date.parse(late) + 24 * 60 * 60_000).toISOString());
  assert.equal(orphan.decisions.find(entry => entry.scheduleId === schedule.id).action, 'recipe-gone');
  assert.equal((await api(`/api/schedules/${schedule.id}`)).enabled, false);
});

test('a recipe that requires verification fails the invocation when it does not pass', { timeout: 120000 }, async t => {
  const { fixture, api, recipe, post } = await setup(t, { profile: 'failing' });
  const schedule = await post('/api/schedules', { recipeId: recipe.id, spec: { kind: 'daily', at: '09:00' } });
  const decision = (await tick(fixture, new Date(Date.parse(schedule.nextRunAt) + 60_000).toISOString()))
    .decisions.find(entry => entry.scheduleId === schedule.id);
  assert.equal(decision.action, 'run');
  // The profile resolves to the project's commands: the prompt itself has no shell.
  const session = await api(`/api/tasks/${decision.sessionId}`);
  assert.ok(!session.prompt.includes('process.exit'), `промпт не содержит shell-команд: ${session.prompt}`);

  await until(async () => (await api(`/api/tasks/${decision.sessionId}`)).verificationStatus === 'FAILED');
  await tick(fixture, new Date(Date.parse(schedule.nextRunAt) + 120_000).toISOString());
  const invocation = await api(`/api/invocations/${decision.invocationId}`);
  assert.equal(invocation.status, 'FAILED', `проверка не прошла → запуск не «получился»: ${JSON.stringify(invocation)}`);
  assert.match(invocation.reason, /проверк/i);
  assert.equal(invocation.verification, 'FAILED');
});

test('schedules and invocations survive reopening the database', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-schedules-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores) store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const at = '2026-10-11T12:00:00.000Z';
  const store = new TaskStore(dir);
  stores.push(store);
  store.createSchedule({
    id: 'sc-1', recipeId: 'rc-1', enabled: true,
    spec: { kind: 'weekly', at: '08:05', weekday: 'mon' },
    misfirePolicy: 'RUN_ONCE', concurrencyPolicy: 'SKIP_IF_RUNNING', notify: 'action-required', approvalMode: 'pause',
    parameters: { area: 'android' }, nextRunAt: at, lastRunAt: null, createdAt: at, updatedAt: at,
  });
  store.createInvocation({
    id: 'inv-1', recipeId: 'rc-1', scheduleId: 'sc-1', trigger: 'schedule', scheduledAt: at, startedAt: at,
    finishedAt: null, status: 'RUNNING', reason: null, misfire: false, parameters: { area: 'android' },
    sessionId: 't1', verification: null, workspaceRef: null, resultArtifact: null,
  });
  store.close();

  const reopened = new TaskStore(dir);
  stores.push(reopened);
  const schedule = reopened.getSchedule('sc-1');
  assert.deepEqual(schedule.spec, { kind: 'weekly', at: '08:05', weekday: 'mon' });
  assert.deepEqual(schedule.parameters, { area: 'android' });
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.nextRunAt, at);
  assert.deepEqual(reopened.dueSchedules('2026-10-11T12:30:00.000Z').map(entry => entry.id), ['sc-1'], 'просроченное расписание видно тику');
  assert.deepEqual(reopened.dueSchedules('2026-10-11T11:00:00.000Z'), [], 'и не раньше времени');

  const invocation = reopened.getInvocation('inv-1');
  assert.equal(invocation.status, 'RUNNING');
  assert.deepEqual(invocation.parameters, { area: 'android' });
  assert.deepEqual(reopened.runningInvocations('sc-1').map(entry => entry.id), ['inv-1']);
  const finished = reopened.updateInvocation('inv-1', { status: 'SUCCEEDED', finishedAt: at, verification: 'PASSED', resultArtifact: 'result.md' });
  assert.equal(finished.status, 'SUCCEEDED');
  assert.equal(finished.sessionId, 't1', 'поля, которых не было в патче, сохранены');
  assert.deepEqual(reopened.listInvocations({ scheduleId: 'sc-1' }).map(entry => entry.id), ['inv-1']);
  assert.deepEqual(reopened.listInvocations({ status: 'SKIPPED' }), []);
  assert.equal(reopened.deleteSchedule('sc-1').id, 'sc-1');
  assert.equal(reopened.getSchedule('sc-1'), null);
  assert.equal(reopened.getInvocation('inv-1').status, 'SUCCEEDED', 'удаление расписания не стирает историю запусков');
});

// AUTO-01B (находка A2 из docs/auto-00-audit.md): проверка рецепта запускается
// ОТДЕЛЬНО после `SUCCEEDED`, поэтому между двумя событиями `verificationStatus`
// равен `RUNNING`. Сверка не имеет права принять это за провал — иначе успешный
// прогон записывается как неудача просто потому, что тесты ещё шли.
test('обязательная проверка: запуск ждёт её окончания, а не падает на RUNNING', { timeout: 120000 }, async t => {
  const slow = { slow: ['node -e "setTimeout(() => process.exit(0), 4000)"'] };
  const fixture = await fixtureWithProfiles(t, slow);
  const api = fixture.api;
  const [project] = await api('/api/projects');
  const created = await fetch(`${fixture.base}/api/recipes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: project.id,
      name: 'Slow checks',
      promptTemplate: 'Проверь {{area}}.',
      parameters: { area: { type: 'enum', values: ['all'], default: 'all' } },
      verification: { required: true, command: 'slow' },
    }),
  }).then(response => response.json());
  const schedule = await fetch(`${fixture.base}/api/schedules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipeId: created.id, spec: { kind: 'daily', at: '09:00' } }),
  }).then(response => response.json());

  const due = new Date(Date.parse(schedule.nextRunAt) + 60_000).toISOString();
  const decision = (await tick(fixture, due)).decisions.find(entry => entry.scheduleId === schedule.id);
  assert.equal(decision.action, 'run', JSON.stringify(decision));

  // Ход закончен, тесты ещё идут: ровно то окно, в котором сверка и ошибалась.
  await until(async () => (await api(`/api/tasks/${decision.sessionId}`)).status === 'SUCCEEDED');
  const during = await api(`/api/tasks/${decision.sessionId}`);
  assert.equal(during.verificationStatus, 'RUNNING', 'проверка обязана быть ещё в процессе');

  await tick(fixture, due);
  const waiting = await api(`/api/invocations/${decision.invocationId}`);
  assert.equal(waiting.status, 'RUNNING', `пока проверка идёт, запуск не завершён: ${JSON.stringify(waiting)}`);
  assert.equal(waiting.reason, null);

  // Проверка прошла — теперь запуск завершается и засчитывается.
  await until(async () => (await api(`/api/tasks/${decision.sessionId}`)).verificationStatus === 'PASSED');
  await tick(fixture, due);
  const done = await api(`/api/invocations/${decision.invocationId}`);
  assert.equal(done.status, 'SUCCEEDED', JSON.stringify(done));
  assert.equal(done.verification, 'PASSED');
  assert.equal(done.resultArtifact, 'result.md');
});

test('зависшая проверка закрывает запуск как «итог неизвестен», а не как провал тестов', { timeout: 120000 }, async t => {
  // Проверка действительно не завершается, а срок укорочен конфигом: иначе тест ждал бы
  // десять минут реального времени.
  const hanging = { hanging: ['node -e "setTimeout(() => {}, 60000)"'] };
  const fixture = await startFixture(undefined, {
    root: {
      verificationProfiles: { passing: ['node -e "process.exit(0)"'], failing: ['node -e "process.exit(1)"'], ...hanging },
      verification: { staleAfterMs: 400 },
    },
  });
  t.after(() => fixture.close());
  const api = fixture.api;
  const [project] = await api('/api/projects');
  const created = await fetch(`${fixture.base}/api/recipes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: project.id,
      name: 'Stuck checks',
      promptTemplate: 'Проверь {{area}}.',
      parameters: { area: { type: 'enum', values: ['all'], default: 'all' } },
      verification: { required: true, command: 'hanging' },
    }),
  }).then(response => response.json());
  const schedule = await fetch(`${fixture.base}/api/schedules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipeId: created.id, spec: { kind: 'daily', at: '09:00' } }),
  }).then(response => response.json());

  const due = new Date(Date.parse(schedule.nextRunAt) + 60_000).toISOString();
  const decision = (await tick(fixture, due)).decisions.find(entry => entry.scheduleId === schedule.id);
  await until(async () => (await api(`/api/tasks/${decision.sessionId}`)).status === 'SUCCEEDED');

  // Сверка пришла после истечения срока: исход проверки неизвестен.
  await new Promise(resolve => setTimeout(resolve, 700));
  await tick(fixture, due);
  const stuck = await api(`/api/invocations/${decision.invocationId}`);
  assert.equal(stuck.status, 'FAILED', JSON.stringify(stuck));
  assert.match(stuck.reason, /не завершилась за/, `причина называет срок, а не тесты: ${stuck.reason}`);
  assert.match(stuck.reason, /итог неизвестен/);
});

// AUTO-01C (находка A3): расписание сдвигается только в конце обработки, поэтому
// наложившийся тик увидел бы его снова и создал вторую сессию. Проверка детерминированная:
// первый тик держим на незавершённом запуске, второй обязан отказаться.
test('два тика не создают два запуска одного расписания', { timeout: 60000 }, async t => {
  const { TaskManager } = await import('../src/task-manager.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-tick-lock-'));
  const store = new TaskStore(dir);
  const manager = new TaskManager({ projects: [] }, dir, store);
  t.after(async () => {
    try { await manager.close?.(); } catch { /* закрытие — не предмет теста */ }
    store.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const at = '2026-10-11T12:00:00.000Z';
  store.createRecipe({
    id: 'rc-lock', projectId: 'p', workItemId: null, name: 'Locked', promptTemplate: 'Проверь',
    parameters: {}, runtime: { id: 'pi' }, verification: {}, createdAt: at, updatedAt: at,
  });
  // Интервал, а не «ежедневно в 09:00»: у интервала моменты считаются арифметикой,
  // поэтому тест не зависит от часового пояса машины (в фикстуре с daily момент
  // «09:00 по местному» мог не попасть в окно между due и now).
  const created = '2026-10-11T00:00:00.000Z';
  store.createSchedule({
    id: 'sc-lock', recipeId: 'rc-lock', enabled: true,
    spec: { kind: 'interval', everyMinutes: 60 }, misfirePolicy: 'RUN_ONCE', concurrencyPolicy: 'QUEUE',
    notify: 'never', approvalMode: 'pause', parameters: {}, nextRunAt: '2026-10-11T11:00:00.000Z',
    lastRunAt: null, createdAt: created, updatedAt: created,
  });

  // Первый тик «зависает» на старте сессии — ровно то окно, в котором раньше
  // создавался дубль.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  manager.runRecipe = async () => { await held; return { task: { id: 'sess-lock' } }; };

  const first = manager.schedulerTick({ nowIso: '2026-10-11T12:00:00.000Z' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = await manager.schedulerTick({ nowIso: '2026-10-11T12:00:00.000Z' });
  assert.equal(second.skipped, 'busy', `второй тик обязан отказаться: ${JSON.stringify(second)}`);
  assert.deepEqual(second.decisions, []);
  assert.equal(store.listInvocations({ scheduleId: 'sc-lock' }).length, 1, 'второй запуск не создан');

  // Пробный тик блокировку не берёт: он ничего не создаёт.
  const dry = await manager.schedulerTick({ nowIso: '2026-10-11T12:00:00.000Z', dryRun: true });
  assert.equal(dry.skipped, undefined);

  release();
  await first;
  const all = store.listInvocations({ scheduleId: 'sc-lock' });
  assert.equal(all.length, 1, `после освобождения — та же одна инвокация: ${JSON.stringify(all.map(item => item.id))}`);
});

// AUTO-01D (находка A4): падение между созданием инвокации и стартом сессии
// оставляет RUNNING без sessionId. Такая запись не должна ни переисполняться
// молча, ни висеть «в процессе» навсегда.
test('брошенная инвокация закрывается как «неизвестный исход», молодая — нет', { timeout: 60000 }, async t => {
  const { TaskManager } = await import('../src/task-manager.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-orphan-'));
  const store = new TaskStore(dir);
  const manager = new TaskManager({ projects: [], schedules: { orphanMs: 1000 } }, dir, store);
  t.after(async () => {
    try { await manager.close?.(); } catch { /* не предмет теста */ }
    store.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const create = (id, startedAt) => store.createInvocation({
    id, recipeId: 'rc-x', scheduleId: null, trigger: 'schedule', scheduledAt: startedAt, startedAt,
    finishedAt: null, status: 'RUNNING', reason: null, misfire: false, parameters: {},
    sessionId: null, verification: null, workspaceRef: null, resultArtifact: null,
  });
  create('inv-old', new Date(Date.now() - 60_000).toISOString());
  create('inv-young', new Date().toISOString());

  await manager.schedulerTick({ nowIso: new Date().toISOString() });

  const old = store.getInvocation('inv-old');
  assert.equal(old.status, 'FAILED', JSON.stringify(old));
  assert.match(old.reason, /сессия не была создана/, `причина называет, что именно неизвестно: ${old.reason}`);
  assert.match(old.reason, /повтор не выполнялся/, 'молчаливого переисполнения нет');
  assert.ok(old.finishedAt, 'у записи есть момент завершения');

  const young = store.getInvocation('inv-young');
  assert.equal(young.status, 'RUNNING', 'молодая запись не закрывается: #invoke вот-вот проставит sessionId');
});

// AUTO-03A: итог запуска — это итог всей работы, а не последний статус сессии.
// STOP обязан остаться остановкой, а не «проверка не пройдена».
test('остановленный запуск остаётся CANCELLED, а не FAILED из-за проверки', { timeout: 120000 }, async t => {
  const { fixture, api, recipe, post } = await setup(t, { profile: 'passing' });
  const schedule = await post('/api/schedules', { recipeId: recipe.id, spec: { kind: 'daily', at: '09:00' } });
  const decision = (await tick(fixture, new Date(Date.parse(schedule.nextRunAt) + 60_000).toISOString()))
    .decisions.find(entry => entry.scheduleId === schedule.id);
  assert.equal(decision.action, 'run');

  // Оператор останавливает ход: сессия приходит в CANCELLED.
  await api(`/api/tasks/${decision.sessionId}/cancel`, {}, 'POST').catch(() => null);
  await until(async () => ['CANCELLED', 'SUCCEEDED', 'FAILED'].includes((await api(`/api/tasks/${decision.sessionId}`)).status));

  await tick(fixture, new Date(Date.parse(schedule.nextRunAt) + 120_000).toISOString());
  const invocation = await api(`/api/invocations/${decision.invocationId}`);
  const session = await api(`/api/tasks/${decision.sessionId}`);
  if (session.status === 'CANCELLED') {
    assert.equal(invocation.status, 'CANCELLED', `остановка не превращается в провал тестов: ${JSON.stringify(invocation)}`);
    assert.doesNotMatch(invocation.reason || '', /проверка не пройдена/);
  } else {
    // Фикстура успела завершиться раньше STOP — тогда проверяем обычный итог.
    assert.ok(['SUCCEEDED', 'FAILED'].includes(invocation.status), JSON.stringify(invocation));
  }
});

test('повторная сверка не меняет уже завершённый запуск', { timeout: 60000 }, async t => {
  const { TaskManager } = await import('../src/task-manager.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-reconcile-idem-'));
  const store = new TaskStore(dir);
  const manager = new TaskManager({ projects: [] }, dir, store);
  t.after(async () => {
    try { await manager.close?.(); } catch { /* не предмет теста */ }
    store.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const at = new Date().toISOString();
  store.createRecipe({ id: 'rc-idem', projectId: 'p', workItemId: null, name: 'I', promptTemplate: 'П', parameters: {}, runtime: { id: 'pi' }, verification: {}, createdAt: at, updatedAt: at });
  store.createInvocation({
    id: 'inv-done', recipeId: 'rc-idem', scheduleId: null, trigger: 'schedule', scheduledAt: at, startedAt: at,
    finishedAt: at, status: 'SUCCEEDED', reason: null, misfire: false, parameters: {},
    sessionId: 'sess-gone', verification: 'PASSED', workspaceRef: null, resultArtifact: 'result.md',
  });

  await manager.schedulerTick({ nowIso: at });
  const after = store.getInvocation('inv-done');
  assert.equal(after.status, 'SUCCEEDED', 'завершённый запуск сверка не трогает');
  assert.equal(after.reason, null);
  assert.equal(after.finishedAt, at, 'момент завершения не переписан');
});

// AUTO-03D: история автоматизации листается страницами — расписание с шагом 5 минут
// быстро перерастает первую страницу.
test('история запусков листается по смещению без дублей и пропусков', { timeout: 60000 }, async t => {
  const { TaskManager } = await import('../src/task-manager.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-history-'));
  const store = new TaskStore(dir);
  const manager = new TaskManager({ projects: [] }, dir, store);
  t.after(async () => {
    try { await manager.close?.(); } catch { /* не предмет теста */ }
    store.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const base = Date.parse('2026-10-21T09:00:00.000Z');
  for (let index = 0; index < 25; index += 1) {
    const startedAt = new Date(base + index * 60_000).toISOString();
    store.createInvocation({
      id: `inv-${String(index).padStart(2, '0')}`, recipeId: 'rc-h', scheduleId: 'sc-h', trigger: 'schedule',
      scheduledAt: startedAt, startedAt, finishedAt: startedAt, status: 'SUCCEEDED', reason: null,
      misfire: false, parameters: {}, sessionId: null, verification: null, workspaceRef: null, resultArtifact: null,
    });
  }

  const first = manager.listInvocations({ scheduleId: 'sc-h', limit: 20, offset: 0 });
  const second = manager.listInvocations({ scheduleId: 'sc-h', limit: 20, offset: 20 });
  assert.equal(first.length, 20);
  assert.equal(second.length, 5);
  assert.equal(new Set([...first, ...second].map(item => item.id)).size, 25, 'страницы не пересекаются');
  // Порядок — от новых к старым: первая страница не содержит самый старый запуск.
  assert.equal(first[0].id, 'inv-24');
  assert.equal(second.at(-1).id, 'inv-00');
});
