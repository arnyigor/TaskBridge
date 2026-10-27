// FP-FIX-01 (репро): почему `completedStepIds` не превращаются в DONE.
//
// Наблюдение с живого прогона (задача eaf82efde8d9, 2026-10-24 03:48Z):
// checkpoint пришёл, `PLAN_STEP_CHECKPOINT CONTINUE` опубликован, а файл плана
// остался с `S-001 | TODO` — и никакой диагностики не появилось.
//
// Здесь воспроизводится механизм: если ход, в котором пришёл checkpoint,
// завершается с чужим `commandId` (в сессию вошло обычное сообщение оператора),
// follower считает settle «другой командой» и **молча** выбрасывает checkpoint.
// Эти тесты фиксируют текущее поведение как дефект: после FP-FIX-01 ожидания
// в блоках "ДЕФЕКТ" переворачиваются (шаг должен стать DONE, а отказ — видимым).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { parsePlan, serializePlan, applyChanges, planHash } from '../src/application/plan-file.mjs';
import { PlanFollower } from '../src/application/plan-follower.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-core-repro
revision: 1
goal: "Репро: завершение шага при вклинившемся сообщении"
---

# План: репро

## Шаги

### S-001 | TODO | P1 | Первый шаг
**Критерии:** шаг закрыт один раз.
**Проверка:** read PLAN.md

### S-002 | TODO | P1 | Второй шаг
**Критерии:** шаг закрыт один раз.
**Проверка:** read PLAN.md

## Обнаруженные проблемы
`;

function fakePlans(initial = PLAN) {
  const state = { text: initial, writes: 0, conflicts: 0 };
  return {
    state,
    async read() {
      return { plan: parsePlan(state.text), hash: planHash(state.text), realPath: 'PLAN.md' };
    },
    async update({ expectedRevision, expectedHash, changes }) {
      if (expectedHash && expectedHash !== planHash(state.text)) {
        state.conflicts += 1;
        throw Object.assign(new Error('conflict'), { code: 'PLAN_REVISION_CONFLICT' });
      }
      const plan = parsePlan(state.text);
      if (expectedRevision != null && plan.revision !== expectedRevision) {
        state.conflicts += 1;
        throw Object.assign(new Error('conflict'), { code: 'PLAN_REVISION_CONFLICT' });
      }
      const next = applyChanges(plan, changes);
      next.revision = plan.revision + 1;
      state.text = serializePlan(next);
      state.writes += 1;
      return { plan: next, hash: planHash(state.text), text: state.text };
    }
  };
}

const setup = async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-core-repro-'));
  const store = new TaskStore(dir);
  t.after(async () => {
    store.close?.();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  const plans = fakePlans();
  const dispatched = [];
  const follower = new PlanFollower({
    store,
    plans,
    dispatch: async input => { dispatched.push(input); return { id: input.commandId }; },
    cancel: async () => {}
  });
  await follower.attach({ taskId: 't-1', path: 'PLAN.md' });
  return { store, plans, follower, dispatched };
};

/** Тот самый checkpoint, который пришёл с живого прогона: evidence с ref есть. */
const checkpoint = overrides => ({
  planId: 'p-core-repro',
  revision: 1,
  cycleId: 'c-1',
  decision: 'CONTINUE',
  completedStepIds: [],
  evidence: [],
  findings: [],
  ...overrides
});

const completion = checkpoint({
  completedStepIds: ['S-001'],
  evidence: [{ stepId: 'S-001', kind: 'command', ref: 'call_00_REAL_TOOL_CALL_ID', summary: 'тесты шага зелёные' }]
});

test('базовая линия: при совпадающем commandId шаг закрывается ровно один раз', async t => {
  const { follower, plans, store } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });
  assert.equal(start.code, 'DISPATCHED');

  const settled = await follower.onSettled({
    taskId: 't-1',
    commandId: start.commandId,
    seq: 10,
    checkpoint: completion
  });
  assert.equal(settled.code, 'DISPATCHED', 'следующий шаг выдан');
  assert.equal(parsePlan(plans.state.text).steps[0].status, 'DONE');
  assert.equal(plans.state.writes, 1, 'одна запись файла на один checkpoint');
  assert.equal(store.getPlanBinding('t-1').dispatchStepId, 'S-002');
});

test('вклинившееся сообщение checkpoint не съедает: чужой settle просто игнорируется', async t => {
  const { follower, plans, store } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });

  // Оператор написал в сессию во время шага: ход завершился с чужим commandId.
  const foreign = await follower.onSettled({ taskId: 't-1', commandId: 'chat-message-command', seq: 11, checkpoint: null });
  assert.equal(foreign.code, 'IGNORED');
  assert.equal(store.getPlanBinding('t-1').state, 'RUNNING_STEP', 'цикл не сдвинулся от чужого хода');

  // Свой ход приносит checkpoint с выполненным шагом — он применяется.
  const settled = await follower.onSettled({ taskId: 't-1', commandId: start.commandId, seq: 12, checkpoint: completion });
  assert.equal(settled.code, 'DISPATCHED', `шаг закрыт и выдан следующий: ${settled.message}`);
  assert.equal(parsePlan(plans.state.text).steps[0].status, 'DONE');
  assert.equal(plans.state.writes, 1);
});

test('FP-FIX-05: отказ применения виден с причиной, а файл не трогается', async t => {
  const { follower, plans, store } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });
  // Цикл уже на разборе (так было на живом прогоне: PAUSED_REVIEW с 08:29Z).
  const binding = store.getPlanBinding('t-1');
  store.savePlanBinding({ ...binding, state: 'PAUSED_REVIEW', dispatchCommandId: null, dispatchStepId: null });

  const settled = await follower.onSettled({ taskId: 't-1', commandId: start.commandId, seq: 13, checkpoint: completion });

  // Исход называет и решение, и причину: молчаливого IGNORED больше нет.
  assert.equal(settled.outcome, 'REJECTED');
  assert.equal(settled.reasonCode, 'STATE_INACTIVE');
  assert.equal(settled.state, 'PAUSED_REVIEW');
  assert.ok(settled.checkpointId, 'у checkpoint есть идентификатор');
  assert.equal(settled.cycleId, binding.cycleId);
  assert.equal(settled.stepId, null, 'шаг уже снят с dispatch — причину называет состояние');
  assert.match(settled.message, /PAUSED_REVIEW/);
  // И ничего не записано произвольно.
  assert.equal(parsePlan(plans.state.text).steps[0].status, 'TODO');
  assert.equal(plans.state.writes, 0);
});

test('FP-FIX-05: применение и «нечего применять» различаются исходом', async t => {
  const { follower } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });

  const applied = await follower.onSettled({ taskId: 't-1', commandId: start.commandId, seq: 30, checkpoint: completion });
  assert.equal(applied.outcome, 'APPLIED');
  assert.equal(applied.reasonCode, null);
  assert.equal(applied.revisionBefore, 1);
  assert.equal(applied.revisionAfter, 2, 'файл ушёл на следующую ревизию');
  assert.deepEqual(applied.appliedStepIds, ['S-001'], 'применение подтверждается закрытым шагом, а не ревизией');
  assert.deepEqual(applied.confirmedStepIds, ['S-001']);
  assert.deepEqual(applied.unconfirmedStepIds ?? [], []);
  assert.ok(applied.checkpointId);

  const second = await follower.onSettled({
    taskId: 't-1',
    commandId: applied.commandId,
    seq: 31,
    checkpoint: checkpoint({ revision: 2, cycleId: applied.cycleId, completedStepIds: [], decision: 'CONTINUE' })
  });
  assert.equal(second.outcome, 'RECEIVED', 'checkpoint принят, но подтверждённых изменений нет');
  assert.equal(second.reasonCode, 'NOTHING_TO_APPLY');
});

test('FP-FIX-05: чужой commandId отклоняется с названной причиной', async t => {
  const { follower } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });
  const foreign = await follower.onSettled({ taskId: 't-1', commandId: 'chat-message-command', seq: 40, checkpoint: completion });
  assert.equal(foreign.outcome, 'REJECTED');
  assert.equal(foreign.reasonCode, 'FOREIGN_COMMAND');
  assert.equal(foreign.dispatchCommandId, start.commandId);
});

test('checkpoint без подтверждённой ссылки шаг не закрывает и это не молчание', async t => {
  const { follower, plans } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });
  const settled = await follower.onSettled({
    taskId: 't-1',
    commandId: start.commandId,
    seq: 20,
    checkpoint: checkpoint({
      completedStepIds: ['S-001'],
      // kind manual без отказа политики не считается проверкой
      evidence: [{ stepId: 'S-001', kind: 'manual', summary: 'модель говорит, что сделала' }]
    })
  });
  assert.equal(parsePlan(plans.state.text).steps[0].status, 'TODO', 'заявление модели не закрывает шаг');
  assert.ok(
    ['DISPATCH_READY', 'DISPATCHED', 'PLAN_BLOCKED', 'PLAN_CHECKPOINT_REJECTED', 'PAUSED_REVIEW'].includes(settled.code),
    `отказ виден в результате: ${settled.code}`
  );
});

test('APPLIED не выводится из смены ревизии: находка без закрытого шага — не завершение', async t => {
  const { follower, plans } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });

  // Checkpoint приносит ТОЛЬКО находку: файл уходит на новую ревизию, шаг остаётся TODO.
  const settled = await follower.onSettled({
    taskId: 't-1',
    commandId: start.commandId,
    seq: 50,
    checkpoint: checkpoint({
      completedStepIds: [],
      findings: [{ id: 'F-001', priority: 'P2', blocking: false, summary: 'найдено по ходу шага' }]
    })
  });

  assert.equal(settled.revisionAfter, 2, 'файл записан');
  assert.deepEqual(settled.appliedStepIds, [], 'ни один шаг не закрыт');
  assert.deepEqual(settled.confirmedStepIds, []);
  assert.deepEqual(settled.appliedFindingIds, ['F-001'], 'применённая находка названа');
  assert.equal(parsePlan(plans.state.text).steps[0].status, 'TODO', 'шаг остался открытым');
  // APPLIED относится к записи файла; завершение шага подтверждает отдельный флаг.
  assert.equal(settled.outcome, 'APPLIED');
  assert.equal(settled.completionApplied, false, 'завершения шага не было, хотя файл записан');
});

test('ДЕФЕКТ-РИСК: ревизия изменилась чужой записью — шаг не считается применённым', async t => {
  const { follower, plans, store } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });

  // Между чтением «до» и чтением «после» файл правит кто-то ещё (контроллер/человек),
  // а сам checkpoint невалиден: evidence без проверяемой ссылки.
  const originalRead = plans.read.bind(plans);
  let reads = 0;
  plans.read = async () => {
    reads += 1;
    const snapshot = await originalRead();
    if (reads === 2) {
      // Чужая запись: файл уходит на следующую ревизию, шаг S-001 остаётся TODO.
      const { parsePlan: parse, serializePlan: serialize } = await import('../src/application/plan-file.mjs');
      const doc = parse(plans.state.text);
      doc.findings.push({ id: 'F-900', priority: 'P2', state: 'OPEN', summary: 'внешняя находка' });
      doc.revision += 1;
      plans.state.text = serialize(doc);
    }
    return snapshot;
  };

  const settled = await follower.onSettled({
    taskId: 't-1',
    commandId: start.commandId,
    seq: 51,
    checkpoint: checkpoint({
      completedStepIds: ['S-001'],
      evidence: [{ stepId: 'S-001', kind: 'manual', summary: 'модель говорит, что сделала' }]
    })
  });

  assert.equal(settled.revisionBefore, 1);
  assert.equal(settled.revisionAfter, 2, 'ревизию поднял чужой запись, а не этот checkpoint');
  assert.deepEqual(settled.appliedStepIds, [], 'закрытых шагов нет');
  assert.deepEqual(settled.confirmedStepIds, [], 'S-001 не подтверждён');
  assert.deepEqual(settled.unconfirmedStepIds, ['S-001'], 'неподтверждённый запрос назван');
  assert.equal(settled.completionApplied, false, 'S-001 не применён');
  assert.notEqual(settled.outcome, 'APPLIED', 'смена ревизии сама по себе — не APPLIED');
  assert.equal(parsePlan(plans.state.text).steps[0].status, 'TODO');
});
