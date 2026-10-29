// CORE-02A: жизненный цикл checkpoint через сервис (тем же путём, каким его
// вызывает TaskManager), а не прямым вызовом PlanFollower.
//
// Задача: воспроизвести незасчитанный `CONTINUE` в активном `RUNNING_STEP` —
// и заодно зафиксировать регрессией те границы, которые работали и должны
// продолжать работать: STOP, законный BLOCKED → PAUSED_REVIEW, повторный settle,
// внешний конфликт, рестарт.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { FollowPlanService } from '../src/follow-plan-service.mjs';
import { parsePlan } from '../src/application/plan-file.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-lifecycle
revision: 1
goal: "CORE-02A: жизненный цикл checkpoint"
---

# План: жизненный цикл

## Шаги

### S-001 | TODO | P1 | Первый шаг
**Критерии:** шаг закрыт.
**Проверка:** node --test tests/a.test.mjs

### S-002 | TODO | P1 | Второй шаг
**Критерии:** шаг закрыт.
**Проверка:** node --test tests/b.test.mjs

## Обнаруженные проблемы
`;

function fakeManager({ workspace, taskId = 't-1' }) {
  const dispatched = [];
  const cancelled = [];
  const events = [];
  let runId = 'run-1';
  const task = () => ({ id: taskId, workspacePath: workspace, runId });
  return {
    dispatched, cancelled, events,
    get task() { return task(); },
    set runId(value) { runId = value; },
    getTask: id => (String(id) === taskId ? task() : null),
    listTasks: () => [{ id: taskId }],
    message: async (id, text, _mode, _files, _token, opts = {}) => {
      dispatched.push({ text, commandId: opts.commandId });
      return { id };
    },
    cancel: async (id, opts) => { cancelled.push(opts); },
    publishFollowPlanEvent: async (id, type, message, data) => { events.push({ type, message, data, at: Date.now() }); }
  };
}

const setup = async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-lifecycle-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'PLAN.md'), PLAN, 'utf8');
  const store = new TaskStore(root);
  t.after(async () => {
    store.close?.();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
  const manager = fakeManager({ workspace });
  const service = new FollowPlanService({ manager, store, config: { followPlan: { enabled: true } } });
  return { root, workspace, store, manager, service, planPath: 'PLAN.md' };
};

const readPlan = async (workspace, relPath = 'PLAN.md') =>
  parsePlan(await fs.readFile(path.join(workspace, relPath), 'utf8'));

/** Ход, который действительно выполнил шаг: команда — из binding, evidence — toolCall этого хода. */
const settleArgs = (store, { commandId, decision = 'CONTINUE', completedStepIds = [], findings = [], toolCallId = 'call-step' }) => {
  const binding = store.getPlanBinding('t-1');
  return {
    taskId: 't-1',
    commandId: commandId ?? binding.dispatchCommandId,
    checkpoint: {
      planId: 'p-lifecycle',
      revision: binding.expectedRevision,
      cycleId: binding.cycleId,
      decision,
      completedStepIds,
      findings,
      evidence: completedStepIds.map(stepId => ({
        stepId, kind: 'command', ref: toolCallId, summary: 'адресный тест шага зелёный'
      }))
    },
    toolCalls: [{ id: toolCallId, name: 'bash', isError: false, exitCode: 0 }]
  };
};

const started = async (service, store) => {
  await service.attach({ taskId: 't-1', path: 'PLAN.md', commandId: 'cmd-attach' });
  await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 'cmd-start' });
  assert.equal(store.getPlanBinding('t-1').state, 'RUNNING_STEP');
};

/** Отправки, сделанные ПОСЛЕ старта цикла: сам start тоже отправляет шаг S-001. */
const dispatchedAfterStart = manager => manager.dispatched.slice(1);

// --- основная цель CORE-02A ---------------------------------------------------

test('CORE-02A: CONTINUE в активном RUNNING_STEP закрывает шаг и отправляет следующий', async t => {
  const { service, store, manager, workspace } = await setup(t);
  await started(service, store);

  const result = await service.turnSettled(settleArgs(store, { completedStepIds: ['S-001'] }));

  assert.equal(result.code, 'DISPATCH_READY', `результат: ${result.code} / ${result.message}`);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(result.completionApplied, true, 'завершение шага действительно применено');
  assert.deepEqual(result.confirmedStepIds, ['S-001']);
  const file = await readPlan(workspace);
  assert.equal(file.steps[0].status, 'DONE', 'файл: S-001 закрыт');
  assert.match(file.steps[0].result, /адресный тест шага зелёный/, 'результат записан в файл');

  // Следующий шаг уходит только после фиксации хода.
  await service.turnCommitted({ taskId: 't-1' });
  const next = dispatchedAfterStart(manager);
  assert.equal(next.length, 1, 'отправлен ровно один следующий шаг');
  assert.match(next[0].text, /S-002/);
  assert.equal(store.getPlanBinding('t-1').state, 'RUNNING_STEP');
  assert.equal(store.getPlanBinding('t-1').dispatchStepId, 'S-002');

  const applied = manager.events.find(event => event.type === 'PLAN_CHECKPOINT_APPLIED');
  assert.ok(applied, 'событие применения опубликовано');
  assert.equal(applied.data.completionApplied, true);
  assert.deepEqual(applied.data.confirmedStepIds, ['S-001']);
});

test('CORE-02A: finding и завершение шага применяются вместе', async t => {
  const { service, store, workspace } = await setup(t);
  await started(service, store);

  const result = await service.turnSettled(settleArgs(store, {
    completedStepIds: ['S-001'],
    findings: [{ id: 'F-001', priority: 'P2', blocking: false, summary: 'попутная находка' }]
  }));

  const file = await readPlan(workspace);
  assert.equal(file.steps[0].status, 'DONE');
  assert.ok(file.findings.some(finding => finding.id === 'F-001'), 'находка записана');
  assert.equal(result.completionApplied, true);
  assert.deepEqual(result.appliedFindingIds, ['F-001']);
});

test('CORE-02A: finding без завершения шага не закрывает шаг и не отправляет S-002', async t => {
  const { service, store, manager, workspace } = await setup(t);
  await started(service, store);

  const result = await service.turnSettled(settleArgs(store, {
    completedStepIds: [],
    findings: [{ id: 'F-002', priority: 'P2', blocking: false, summary: 'только запись' }]
  }));

  const file = await readPlan(workspace);
  assert.equal(file.steps[0].status, 'TODO', 'шаг открыт');
  assert.ok(file.findings.some(finding => finding.id === 'F-002'));
  assert.equal(result.completionApplied, false);
  await service.turnCommitted({ taskId: 't-1' });
  // Следующий шаг может быть подготовлен (цикл продолжается), но это тот же S-001,
  // а не S-002: закрытого шага не было.
  const binding = store.getPlanBinding('t-1');
  assert.equal(binding.dispatchStepId, 'S-001', 'шаг не перескочил на следующий');
  assert.ok(!manager.dispatched.some(entry => /S-002/.test(entry.text)));
});

// --- границы, которые должны остаться работоспособными -----------------------

test('CORE-02A: STOP сильнее позднего settle', async t => {
  const { service, store, manager, workspace } = await setup(t);
  await started(service, store);
  const args = settleArgs(store, { completedStepIds: ['S-001'] });
  await service.stop({ taskId: 't-1', commandId: 'cmd-stop' });
  const dispatchedBefore = dispatchedAfterStart(manager).length;

  const result = await service.turnSettled(args);

  const file = await readPlan(workspace);
  assert.equal(file.steps[0].status, 'TODO', 'после STOP шаг не засчитан');
  assert.ok(result.code === 'IGNORED' || result.code === 'PAUSED_REVIEW' || result.code === 'PLAN_BLOCKED',
    `STOP сохраняет приоритет: ${result.code}`);
  await service.turnCommitted({ taskId: 't-1' });
  assert.equal(dispatchedAfterStart(manager).length, dispatchedBefore, 'поздний settle не отправляет шаг');
});

test('CORE-02A: законный BLOCKED → PAUSED_REVIEW остаётся паузой', async t => {
  const { service, store, manager, workspace } = await setup(t);
  await started(service, store);

  const result = await service.turnSettled(settleArgs(store, { decision: 'BLOCKED', completedStepIds: [] }));
  assert.equal(result.code, 'PLAN_BLOCKED');
  assert.equal(result.outcome, 'RECEIVED', 'честный BLOCKED — не отказ проверки');
  assert.equal(store.getPlanBinding('t-1').state, 'PAUSED_REVIEW');
  await service.turnCommitted({ taskId: 't-1' });
  assert.equal(dispatchedAfterStart(manager).length, 0, 'из PAUSED_REVIEW ничего не отправляется');
  assert.equal((await readPlan(workspace)).steps[0].status, 'TODO');
  const paused = manager.events.filter(event => event.type === 'PLAN_PAUSED').at(-1);
  assert.equal(paused?.data?.decision, 'BLOCKED', 'оператор видит решение, а не только код');
});

test('CORE-02A: отклонённое предложение правки плана назван в событии паузы', async t => {
  const { service, store, manager, workspace } = await setup(t);
  await started(service, store);
  const args = settleArgs(store, { decision: 'BLOCKED', completedStepIds: [] });
  // Живой прогон 2026-10-29: критерий был в тексте, отдельных criteria/verification
  // не было — шаг пропал молча, и цикл встал на недостижимом шаге.
  args.checkpoint.proposedChanges = [{ op: 'add_step', priority: 'P1', title: 'S-003', body: 'критерий в тексте' }];

  const result = await service.turnSettled(args);

  assert.equal(result.code, 'PLAN_BLOCKED');
  assert.equal(result.outcome, 'REJECTED', 'отклонённое предложение — отказ, а не «принято без изменений»');
  assert.match(result.message, /Предложения не применены: новый шаг требует критериев и способа проверки/);
  const paused = manager.events.filter(event => event.type === 'PLAN_PAUSED').at(-1);
  assert.match(paused.message, /Предложения не применены/, 'сообщение паузы говорит, что именно не принято');
  assert.equal(paused.data.rejectedProposals.length, 1, 'причина едет вместе с событием');
  assert.equal((await readPlan(workspace)).steps.length, 2, 'шаг не появился в плане');
});

test('CORE-02A: повторный settle того же хода не пишет файл второй раз', async t => {
  const { service, store, workspace } = await setup(t);
  await started(service, store);
  const args = settleArgs(store, { completedStepIds: ['S-001'] });

  await service.turnSettled(args);
  const revisionAfterFirst = (await readPlan(workspace)).revision;
  const second = await service.turnSettled(args);

  assert.equal(second.code, 'IGNORED');
  assert.equal((await readPlan(workspace)).revision, revisionAfterFirst, 'второй settle не переписал файл');
});

test('CORE-02A: внешний конфликт не перезаписывается', async t => {
  const { service, store, workspace } = await setup(t);
  await started(service, store);
  const args = settleArgs(store, { completedStepIds: ['S-001'] });
  // Чужая правка после выдачи хода.
  const current = await fs.readFile(path.join(workspace, 'PLAN.md'), 'utf8');
  await fs.writeFile(path.join(workspace, 'PLAN.md'), current.replace('revision: 1', 'revision: 2'), 'utf8');

  const result = await service.turnSettled(args);

  assert.equal(result.code, 'PLAN_REVISION_CONFLICT');
  assert.equal(result.reasonCode, 'REVISION_CONFLICT');
  assert.equal(result.outcome, 'REJECTED');
  const file = await readPlan(workspace);
  assert.equal(file.steps[0].status, 'TODO', 'файл не перезаписан');
  assert.equal(store.getPlanBinding('t-1').state, 'PAUSED_REVIEW');
});

test('CORE-02A: неуспешный ход и поздний settle не дают ложного завершения', async t => {
  const { service, store, manager, workspace } = await setup(t);
  await started(service, store);
  const args = settleArgs(store, { completedStepIds: ['S-001'] });

  // Pi упал до settle: сервис ставит план на разбор.
  await service.turnFailed({ taskId: 't-1', commandId: args.commandId, reason: 'PI_EXIT' });
  assert.equal(store.getPlanBinding('t-1').state, 'PAUSED_REVIEW');

  const late = await service.turnSettled(args);

  assert.equal(late.outcome, 'REJECTED');
  assert.equal(late.reasonCode, 'STATE_INACTIVE');
  assert.equal((await readPlan(workspace)).steps[0].status, 'TODO', 'шаг не засчитан после упавшего хода');
  await service.turnCommitted({ taskId: 't-1' });
  assert.equal(dispatchedAfterStart(manager).length, 0, 'скрытого dispatch нет');
});

test('CORE-02A: после рестарта подтверждённый шаг не исполняется повторно', async t => {
  const { service, store, manager, workspace } = await setup(t);
  await started(service, store);
  await service.turnSettled(settleArgs(store, { completedStepIds: ['S-001'] }));
  await service.turnCommitted({ taskId: 't-1' });
  const dispatchedBefore = dispatchedAfterStart(manager).length;

  // Рестарт сервера на тех же данных.
  await service.recoverAll();

  const file = await readPlan(workspace);
  assert.equal(file.steps[0].status, 'DONE', 'закрытый шаг остаётся закрытым');
  assert.equal(store.getPlanBinding('t-1').state, 'PAUSED_REVIEW', 'неизвестный ход — разбор, без повтора');
  assert.notEqual(store.getPlanBinding('t-1').dispatchStepId, 'S-001', 'S-001 не выдан повторно');
  assert.equal(dispatchedAfterStart(manager).length, dispatchedBefore, 'автоматической переотправки нет');
});

test('CORE-02A: причина отказа валидации называется, а не теряется', async t => {
  const { service, store, workspace } = await setup(t);
  await started(service, store);
  const args = settleArgs(store, { completedStepIds: ['S-001'] });
  // Цикл в checkpoint не тот, что в binding: проверка обязана отказать и назвать причину.
  args.checkpoint.cycleId = 'c-99';

  const result = await service.turnSettled(args);

  assert.equal((await readPlan(workspace)).steps[0].status, 'TODO', 'шаг не засчитан');
  assert.equal(result.outcome, 'REJECTED');
  assert.deepEqual(result.unconfirmedStepIds, ['S-001']);
  assert.ok((result.problems || []).some(problem => /cycleId/.test(problem)), `причина названа: ${JSON.stringify(result.problems)}`);
});

test('CORE-02B: чужой settle без checkpoint не оставляет цикл в RUNNING_STEP', async t => {
  const { service, store, manager, workspace } = await setup(t);
  await started(service, store);
  const dispatchCommandId = store.getPlanBinding('t-1').dispatchCommandId;

  // Живой сценарий LIVE-03: сообщение «сейчас» заменило ход, checkpoint планового
  // шага не пришёл, а settle принёс чужую команду.
  const result = await service.turnSettled({
    taskId: 't-1',
    commandId: 'chat-message-command',
    checkpoint: null,
    toolCalls: []
  });

  assert.equal(result.code, 'PAUSED_REVIEW');
  const binding = store.getPlanBinding('t-1');
  assert.equal(binding.state, 'PAUSED_REVIEW', 'цикл не висит в RUNNING_STEP');
  assert.equal(binding.dispatchCommandId, null);
  const paused = manager.events.find(event => event.type === 'PLAN_PAUSED');
  assert.ok(paused, 'пауза опубликована');
  assert.equal(paused.data.code, 'FOREIGN_SETTLE_NO_CHECKPOINT');
  assert.equal(paused.data.dispatchCommandId, dispatchCommandId);
  assert.equal((await readPlan(workspace)).steps[0].status, 'TODO', 'шаг не засчитан');

  // Из PAUSED_REVIEW ничего не отправляется само.
  const sentBefore = dispatchedAfterStart(manager).length;
  await service.turnCommitted({ taskId: 't-1' });
  assert.equal(dispatchedAfterStart(manager).length, sentBefore, 'скрытого dispatch нет');
});

test('CORE-02B: settle своего хода без checkpoint по-прежнему идёт по правилам follower', async t => {
  const { service, store, manager, workspace } = await setup(t);
  await started(service, store);
  // Своя команда, но checkpoint не пришёл: follower делает контрольный ход/паузу,
  // а не «чужой settle».
  const result = await service.turnSettled({ taskId: 't-1', commandId: store.getPlanBinding('t-1').dispatchCommandId, checkpoint: null, toolCalls: [] });
  assert.notEqual(result.reason, 'FOREIGN_SETTLE_NO_CHECKPOINT');
  const paused = manager.events.filter(event => event.type === 'PLAN_PAUSED').map(event => event.data?.code);
  assert.equal(paused.includes('FOREIGN_SETTLE_NO_CHECKPOINT'), false);
  assert.equal((await readPlan(workspace)).steps[0].status, 'TODO');
});

test('CORE-02B: checkpoint, пришедший после steering, принадлежит выданному шагу', async t => {
  const { service, store, manager, workspace } = await setup(t);
  await started(service, store);
  const binding = store.getPlanBinding('t-1');
  const dispatchCommandId = binding.dispatchCommandId;

  // Живой сценарий LIVE-03 (второй прогон): steering слил ходы, checkpoint пришёл
  // уже с командой чата, но называет текущий цикл и ревизию.
  const result = await service.turnSettled({
    ...settleArgs(store, { completedStepIds: ['S-001'] }),
    commandId: 'chat-message-command'
  });

  assert.equal(result.outcome, 'APPLIED', `checkpoint должен применяться: ${result.reasonCode || result.message}`);
  assert.equal(result.completionApplied, true);
  assert.deepEqual(result.confirmedStepIds, ['S-001']);
  const file = await readPlan(workspace);
  assert.equal(file.steps[0].status, 'DONE', 'шаг закрыт, несмотря на steering');
  assert.equal(store.getPlanBinding('t-1').dispatchStepId, 'S-002', 'следующий шаг подготовлен');
  assert.equal(manager.events.filter(event => event.type === 'PLAN_CHECKPOINT_REJECTED').length, 0,
    'ложного FOREIGN_COMMAND нет');
});

test('CORE-02B: checkpoint своего цикла со старой ревизией называет ревизию, а не чужую команду', async t => {
  const { service, store, manager, workspace } = await setup(t);
  await started(service, store);
  const binding = store.getPlanBinding('t-1');

  // Живой прогон 2026-10-29 (c-30): steering слил ходы, и checkpoint пришёл с
  // командой чата и ревизией 14, хотя файл был уже на 15. Раньше это был
  // «FOREIGN_COMMAND» с висящим RUNNING_STEP и без названной причины.
  const args = settleArgs(store, { completedStepIds: ['S-001'] });
  args.commandId = 'chat-message-command';
  args.checkpoint.revision = binding.expectedRevision + 1;

  const result = await service.turnSettled(args);

  assert.equal(result.code, 'PLAN_CHECKPOINT_REJECTED');
  assert.equal(result.reasonCode, 'PLAN_CHECKPOINT_REJECTED');
  assert.match(result.message, /revision .* не совпадает с файлом/, `названа настоящая причина: ${result.message}`);
  assert.equal(store.getPlanBinding('t-1').state, 'PAUSED_REVIEW', 'цикл не висит в RUNNING_STEP');
  assert.equal((await readPlan(workspace)).steps[0].status, 'TODO', 'старая ревизия не закрывает шаг');
  const paused = manager.events.filter(event => event.type === 'PLAN_CHECKPOINT_REJECTED').at(-1);
  assert.match(paused.message, /revision/, 'причина видна в событии');
});

test('CORE-02B: checkpoint чужого цикла не принимается как свой', async t => {
  const { service, store, workspace } = await setup(t);
  await started(service, store);
  const args = settleArgs(store, { completedStepIds: ['S-001'] });
  args.commandId = 'chat-message-command';
  args.checkpoint.cycleId = 'c-99';

  const result = await service.turnSettled(args);

  assert.equal(result.outcome, 'REJECTED');
  assert.equal(result.reasonCode, 'FOREIGN_COMMAND');
  assert.equal((await readPlan(workspace)).steps[0].status, 'TODO', 'чужой цикл не закрывает шаг');
});
