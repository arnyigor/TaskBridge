// FP-03: durable PlanFollower — ход, проверка, следующий шаг, STOP, рестарт, лимиты.
//
// Модели нет по построению: «Pi завершил ход» здесь — это вызов `onSettled` с тем
// checkpoint, который пришёл бы из кадра `tool_execution_start`. Проверяется
// поведение контроллера: нет дублей после STOP и перезапуска, нет бесконечного
// цикла, файл меняется только через compare-and-swap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { parsePlan, serializePlan, applyChanges, planHash } from '../src/application/plan-file.mjs';
import { PlanFollower, DEFAULT_LIMITS, nextOpenStep, stepCommandId } from '../src/application/plan-follower.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-fp03
revision: 2
goal: "FP-03: цикл исполнения"
---

# План: цикл исполнения

## Шаги

### S-001 | TODO | P1 | Воспроизвести
**Критерии:** сценарий воспроизведён.
**Проверка:** node --test tests/a.test.mjs

### S-002 | TODO | P1 | Исправить
**Критерии:** нет дублей.
**Проверка:** node --test tests/b.test.mjs

## Обнаруженные проблемы
`;

/** In-memory plan file with the same CAS semantics as the real one. */
function fakePlans(initial = PLAN) {
  const state = { text: initial, hash: planHash(initial), writes: 0, conflicts: 0 };
  return {
    state,
    async read() {
      const plan = parsePlan(state.text);
      return { plan, hash: planHash(state.text), realPath: 'PLAN.md' };
    },
    async update({ expectedRevision, expectedHash, changes }) {
      if (expectedHash && expectedHash !== planHash(state.text)) {
        state.conflicts++;
        throw Object.assign(new Error('conflict'), { code: 'PLAN_REVISION_CONFLICT' });
      }
      const plan = parsePlan(state.text);
      if (expectedRevision != null && plan.revision !== expectedRevision) {
        state.conflicts++;
        throw Object.assign(new Error('conflict'), { code: 'PLAN_REVISION_CONFLICT' });
      }
      const next = applyChanges(plan, changes);
      next.revision = plan.revision + 1;
      state.text = serializePlan(next);
      state.hash = planHash(state.text);
      state.writes++;
      return { plan: next, hash: state.hash, text: state.text };
    },
    /** What a human saving the file does. */
    edit(mutate) {
      state.text = mutate(state.text);
      state.hash = planHash(state.text);
    }
  };
}

const setup = async (t, { limits, initial = PLAN } = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-follower-'));
  const store = new TaskStore(dir);
  // Close SQLite before removing the directory: on Windows the WAL files stay
  // locked otherwise and the cleanup fails the test, not the code.
  t.after(async () => {
    store.close?.();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  const plans = fakePlans(initial);
  const dispatched = [];
  const cancelled = [];
  const follower = new PlanFollower({
    store,
    plans,
    dispatch: async input => { dispatched.push(input); return { id: input.commandId }; },
    cancel: async input => { cancelled.push(input); },
    limits
  });
  await follower.attach({ taskId: 't-1', path: 'PLAN.md' });
  return { store, plans, follower, dispatched, cancelled };
};

const checkpoint = overrides => ({
  planId: 'p-fp03',
  revision: 2,
  cycleId: 'c-1',
  decision: 'CONTINUE',
  completedStepIds: [],
  evidence: [],
  findings: [],
  ...overrides
});

test('attach reads the plan and spends no turn; start dispatches the next step once', async t => {
  const { follower, dispatched, store } = await setup(t);
  assert.equal(dispatched.length, 0, 'attaching must not call the model');
  assert.equal(store.getPlanBinding('t-1').state, 'IDLE');

  const started = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });
  assert.equal(started.code, 'DISPATCHED');
  assert.equal(started.stepId, 'S-001');
  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].message, /FOLLOW PLAN/);
  assert.match(dispatched[0].message, /S-001/);
  assert.match(dispatched[0].message, /revision 2/);
  assert.equal(store.getPlanBinding('t-1').state, 'RUNNING_STEP');
  assert.equal(nextOpenStep(parsePlan(PLAN)).id, 'S-001');

  const busy = await follower.start({ taskId: 't-1', commandId: 'cmd-start-2' });
  assert.equal(busy.code, 'PLAN_BUSY', 'one active cycle per task');
  assert.equal(dispatched.length, 1);
});

test('a step settles, the file records it and the next step is dispatched', async t => {
  const { follower, plans, dispatched, store } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });

  const settled = await follower.onSettled({
    taskId: 't-1',
    commandId: start.commandId,
    seq: 11,
    checkpoint: checkpoint({ completedStepIds: ['S-001'], evidence: [{ stepId: 'S-001', kind: 'test', ref: 'run-1', summary: 'тест падает как ожидалось' }] })
  });

  assert.equal(settled.code, 'DISPATCHED');
  assert.equal(settled.stepId, 'S-002');
  const written = parsePlan(plans.state.text);
  assert.equal(written.steps[0].status, 'DONE');
  assert.equal(written.steps[0].result, 'тест падает как ожидалось');
  assert.equal(written.revision, 3);
  assert.equal(dispatched.length, 2);
  assert.match(dispatched[1].message, /S-002/);
  assert.match(dispatched[1].message, /revision 3/, 'the next turn sees the revision it must report');
  assert.equal(store.getPlanBinding('t-1').cycleId, 'c-2', 'a real step opens a new cycle');
});

test('several steps finished in one turn are all recorded', async t => {
  const { follower, plans, dispatched } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });
  await follower.onSettled({
    taskId: 't-1', commandId: start.commandId,
    checkpoint: checkpoint({
      completedStepIds: ['S-001', 'S-002'],
      evidence: [
        { stepId: 'S-001', kind: 'test', ref: 'run-1', summary: 'ok' },
        { stepId: 'S-002', kind: 'test', ref: 'run-1', summary: '29/29 pass' }
      ]
    })
  });
  const written = parsePlan(plans.state.text);
  assert.deepEqual(written.steps.map(step => step.status), ['DONE', 'DONE']);
  // Nothing is left open and the model did not say COMPLETE: exactly one audit turn,
  // not a guess that the plan is finished.
  const audit = dispatched.at(-1);
  assert.match(audit.commandId, /:audit:/);
});

test('COMPLETE ends the plan only when the file and the evidence agree', async t => {
  const { follower, plans, dispatched, store } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });

  const early = await follower.onSettled({ taskId: 't-1', commandId: start.commandId, checkpoint: checkpoint({ decision: 'COMPLETE' }) });
  assert.equal(early.code, 'PLAN_BLOCKED', 'COMPLETE with open steps is refused');
  assert.equal(parsePlan(plans.state.text).steps[0].status, 'TODO');
  assert.equal(store.getPlanBinding('t-1').state, 'PAUSED_REVIEW');
  assert.equal(dispatched.length, 1, 'a refused COMPLETE does not start another turn');

  // A fresh follower over the same store: the operator resumes from the pause.
  const again = new PlanFollower({
    store, plans,
    dispatch: async input => { dispatched.push(input); return { id: input.commandId }; }
  });
  const resumed = await again.resume({ taskId: 't-1' });
  assert.equal(resumed.code, 'DISPATCHED');
  const done = await again.onSettled({
    taskId: 't-1', commandId: resumed.commandId,
    checkpoint: checkpoint({
      revision: 2, cycleId: resumed.cycleId, decision: 'COMPLETE', completedStepIds: ['S-001', 'S-002'],
      evidence: [
        { stepId: 'S-001', kind: 'test', ref: 'run-1', summary: 'воспроизведено' },
        { stepId: 'S-002', kind: 'test', ref: 'run-2', summary: '29/29 pass' }
      ]
    })
  });
  assert.equal(done.code, 'PLAN_COMPLETED');
  assert.equal(store.getPlanBinding('t-1').state, 'COMPLETED');
  assert.deepEqual(parsePlan(plans.state.text).steps.map(step => step.status), ['DONE', 'DONE']);
  assert.equal(dispatched.length, 2, 'completion dispatches nothing');
});

test('a turn without a checkpoint gets exactly one audit turn, then a pause', async t => {
  const { follower, dispatched, store } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });

  const audited = await follower.onSettled({ taskId: 't-1', commandId: start.commandId, checkpoint: null });
  assert.equal(audited.code, 'DISPATCHED');
  assert.match(dispatched.at(-1).message, /не передал checkpoint/);
  assert.equal(dispatched.at(-1).stepId, 'S-001', 'the audit turn stays on the same step');

  const silence = await follower.onSettled({ taskId: 't-1', commandId: audited.commandId, checkpoint: null });
  assert.equal(silence.code, 'PLAN_UNKNOWN_OUTCOME');
  assert.equal(store.getPlanBinding('t-1').state, 'PAUSED');
  assert.equal(dispatched.length, 2, 'no third turn, no endless question chain');
});

test('an invalid checkpoint pauses the cycle instead of being interpreted', async t => {
  const { follower, plans, dispatched, store } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });

  const stale = await follower.onSettled({
    taskId: 't-1', commandId: start.commandId,
    checkpoint: checkpoint({ revision: 1, completedStepIds: ['S-001'], evidence: [{ stepId: 'S-001', kind: 'test', ref: 'run-1', summary: 'ok' }] })
  });
  assert.equal(stale.decision, 'CONTINUE');
  assert.equal(stale.code, 'PLAN_BLOCKED');
  assert.match(stale.message, /revision 1 не совпадает/);
  assert.equal(store.getPlanBinding('t-1').state, 'PAUSED_REVIEW');
  assert.equal(parsePlan(plans.state.text).revision, 2, 'the file was not touched');
  assert.equal(dispatched.length, 1);
});

test('no measurable progress stops the loop at the configured limit', async t => {
  const { follower, dispatched } = await setup(t, { limits: { noProgressLimit: 3 } });
  let current = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });
  const codes = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    const result = await follower.onSettled({
      taskId: 't-1', commandId: current.commandId,
      checkpoint: checkpoint({ cycleId: `c-${cycle + 1}`, decision: 'CONTINUE', completedStepIds: [] })
    });
    codes.push(result.code);
    if (result.code !== 'DISPATCHED') break;
    current = result;
  }
  assert.deepEqual(codes, ['DISPATCHED', 'DISPATCHED', 'PLAN_BUDGET_EXCEEDED']);
  assert.equal(dispatched.length, 3, 'two steps forward, then the third stall stops it');
});

test('the cycle budget stops even a productive plan', async t => {
  const extra = [
    '', '### S-003 | TODO | P2 | Третье', '**Критерии:** сделано.',
    '', '### S-004 | TODO | P3 | Четвёртое', '**Критерии:** сделано.', ''
  ].join('\n');
  const initial = PLAN.replace('## Обнаруженные проблемы', `${extra}\n## Обнаруженные проблемы`);
  const { follower, dispatched, plans } = await setup(t, { limits: { maxCycles: 2 }, initial });

  let current = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });
  const codes = [];
  for (let cycle = 0; cycle < 4 && current?.code === 'DISPATCHED'; cycle++) {
    const stepId = current.stepId;
    const revision = parsePlan(plans.state.text).revision;
    current = await follower.onSettled({
      taskId: 't-1', commandId: current.commandId,
      checkpoint: checkpoint({
        cycleId: current.cycleId, revision, decision: 'CONTINUE', completedStepIds: [stepId],
        evidence: [{ stepId, kind: 'test', ref: `run-${cycle}`, summary: 'pass' }]
      })
    });
    codes.push(current.code);
  }
  assert.deepEqual(codes, ['DISPATCHED', 'PLAN_BUDGET_EXCEEDED'], 'two productive cycles, then the limit');
  assert.match(current.message, /предел 2/);
  assert.equal(dispatched.length, 2);
});

test('STOP invalidates the epoch and a late checkpoint cannot move the cycle', async t => {
  const { follower, plans, dispatched, cancelled, store } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });

  const stopped = await follower.stop({ taskId: 't-1' });
  assert.equal(stopped.code, 'PAUSED_REVIEW');
  assert.equal(stopped.epoch, 1);
  assert.deepEqual(cancelled, [{ taskId: 't-1', commandId: start.commandId }]);
  assert.equal(store.getPlanBinding('t-1').state, 'PAUSED_REVIEW');

  const late = await follower.onSettled({
    taskId: 't-1', commandId: start.commandId,
    checkpoint: checkpoint({ completedStepIds: ['S-001'], evidence: [{ stepId: 'S-001', kind: 'test', ref: 'run-1', summary: 'ok' }] })
  });
  assert.equal(late.code, 'IGNORED', 'a settle after STOP does not resume the cycle');
  assert.equal(dispatched.length, 1);
  assert.equal(parsePlan(plans.state.text).steps[0].status, 'TODO');

  const resumed = await follower.resume({ taskId: 't-1' });
  assert.equal(resumed.code, 'DISPATCHED');
  assert.notEqual(resumed.commandId, start.commandId, 'the new cycle is stamped with the new epoch');
  assert.match(resumed.commandId, /:1$/);
});

test('a restart with a dispatched command pauses instead of re-sending it', async t => {
  const { follower, dispatched, store } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });

  // New process: same database, nothing dispatched by this instance yet.
  const restarted = new PlanFollower({
    store,
    plans: fakePlans(),
    dispatch: async input => { dispatched.push(input); return { id: input.commandId }; }
  });
  const recovered = restarted.recover({ taskId: 't-1' });
  assert.equal(recovered.code, 'PLAN_UNKNOWN_OUTCOME');
  assert.equal(recovered.commandId, start.commandId);
  assert.equal(store.getPlanBinding('t-1').state, 'PAUSED_REVIEW');
  assert.equal(dispatched.length, 1, 'the possibly executed command is not sent again');

  const busy = await restarted.resume({ taskId: 't-1' });
  assert.equal(busy.code, 'DISPATCHED', 'an explicit operator resume is allowed');
});

test('a human edit during the cycle stops it instead of being overwritten', async t => {
  const { follower, plans, dispatched, store } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });
  plans.edit(text => text.replace('Исправить', 'Исправить (правка человека)'));

  const settled = await follower.onSettled({
    taskId: 't-1', commandId: start.commandId,
    checkpoint: checkpoint({ completedStepIds: ['S-001'], evidence: [{ stepId: 'S-001', kind: 'test', ref: 'run-1', summary: 'ok' }] })
  });
  assert.equal(settled.code, 'PLAN_REVISION_CONFLICT');
  assert.equal(store.getPlanBinding('t-1').state, 'PAUSED_REVIEW');
  assert.equal(dispatched.length, 1);
  assert.match(plans.state.text, /правка человека/);
  assert.ok(plans.state.writes === 0, 'nothing was written over the human text');
});

test('the same cycle and step produce the same command id', () => {
  const base = { taskId: 't-1', cycleId: 'c-3', stepId: 'S-004', epoch: 2 };
  assert.equal(stepCommandId(base), stepCommandId({ ...base }));
  assert.equal(stepCommandId(base), 'plan:t-1:c-3:S-004:2');
  assert.notEqual(stepCommandId(base), stepCommandId({ ...base, epoch: 3 }));
  assert.equal(stepCommandId({ ...base, audit: true }), 'plan:t-1:c-3:S-004:audit:2');
  assert.deepEqual([...Object.keys(DEFAULT_LIMITS)].sort(), ['auditTurnsPerCycle', 'budgetMs', 'maxCycles', 'noProgressLimit']);
});
