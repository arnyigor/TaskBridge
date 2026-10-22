// FP-02: поддельный COMPLETE не заканчивает план.
//
// Модель отдаёт checkpoint; здесь проверяется, чего стоит её заявление. Ни Pi,
// ни файла этот модуль не касается — на входе уже разобранный план и валидный
// JSON, на выходе вердикт с причинами. Поэтому негативные сценарии из матрицы ТЗ
// (ложный COMPLETE, невыполненный шаг, evidence без ссылки, блокирующая проблема)
// проверяются детерминированно, без модели.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../src/application/plan-file.mjs';
import { decideCheckpoint, inspectCheckpoint, auditInstruction, CHECKPOINT_DECISIONS } from '../src/application/plan-checkpoint.mjs';

const PLAN_TEXT = `---
taskbridge_plan: 1
plan_id: p-fp02
revision: 4
goal: "FP-02: проверка завершения"
---

# План: проверка завершения

## Шаги

### S-001 | DONE | P1 | Воспроизвести
**Критерии:** сценарий воспроизведён.
**Результат:** failing-тест, run-1

### S-002 | IN_PROGRESS | P1 | Исправить
**Критерии:** нет дублей.
**Проверка:** node --test tests/history.test.mjs

## Обнаруженные проблемы
- F-001 | P2 | OPEN | косметика в логе
`;

const plan = () => parsePlan(PLAN_TEXT);
const cycle = { cycleId: 'c-12', revision: 4 };

const checkpoint = overrides => ({
  planId: 'p-fp02',
  revision: 4,
  cycleId: 'c-12',
  decision: 'COMPLETE',
  completedStepIds: ['S-002'],
  evidence: [{ stepId: 'S-002', kind: 'test', ref: 'run-123', summary: '29/29 pass' }],
  findings: [],
  ...overrides
});

test('a complete plan with checkable evidence is accepted', () => {
  const verdict = decideCheckpoint({ plan: plan(), checkpoint: checkpoint(), cycle });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.state, 'COMPLETED');
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.plan.steps[1].status, 'DONE');
  assert.equal(verdict.plan.steps[1].result, '29/29 pass', 'the evidence becomes the recorded result');
});

test('COMPLETE is refused while a step is still open', () => {
  const verdict = decideCheckpoint({
    plan: plan(),
    checkpoint: checkpoint({ completedStepIds: [], evidence: [] }),
    cycle
  });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.state, 'PAUSED_REVIEW');
  assert.match(verdict.reasons.join('\n'), /не завершены S-002 \(IN_PROGRESS\)/);
});

test('a step marked done without evidence is not done', () => {
  const noEvidence = decideCheckpoint({ plan: plan(), checkpoint: checkpoint({ evidence: [] }), cycle });
  assert.equal(noEvidence.accepted, false);
  assert.match(noEvidence.reasons.join('\n'), /без подтверждения/);

  const noRef = decideCheckpoint({
    plan: plan(),
    checkpoint: checkpoint({ evidence: [{ stepId: 'S-002', kind: 'test', summary: 'тесты прошли' }] }),
    cycle
  });
  assert.equal(noRef.accepted, false, 'a test without a run reference cannot be re-checked');
  assert.match(noRef.reasons.join('\n'), /без ссылки/);
});

test('"the model says it is verified" is a claim, not a verification', () => {
  const manual = {
    planId: 'p-fp02', revision: 4, cycleId: 'c-12', decision: 'COMPLETE', completedStepIds: ['S-002'],
    evidence: [{ stepId: 'S-002', kind: 'manual', summary: 'проверил глазами' }]
  };
  const refused = decideCheckpoint({ plan: plan(), checkpoint: manual, cycle });
  assert.equal(refused.accepted, false);
  assert.match(refused.reasons.join('\n'), /заявление, а не проверка/);

  // §13.4 is not settled: acceptance of a manual check is an explicit policy,
  // so both branches stay observable instead of being decided in the dark.
  const accepted = decideCheckpoint({ plan: plan(), checkpoint: manual, cycle, policy: { manualEvidenceAccepted: true, blockingFindingsStopCompletion: true } });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.inspection.unverifiedStepIds, ['S-002']);
});

test('an open blocking finding stops completion, P2 does not', () => {
  const blocking = decideCheckpoint({
    plan: parsePlan(PLAN_TEXT.replace('- F-001 | P2 | OPEN | косметика в логе', '- F-001 | P1 | OPEN | потеря событий')),
    checkpoint: checkpoint(),
    cycle
  });
  assert.equal(blocking.accepted, false);
  assert.match(blocking.reasons.join('\n'), /открытые блокирующие проблемы F-001/);

  const fromCheckpoint = decideCheckpoint({
    plan: plan(),
    checkpoint: checkpoint({ findings: [{ id: 'F-002', priority: 'P1', blocking: true, summary: 'дубли в reconnect' }] }),
    cycle
  });
  assert.equal(fromCheckpoint.accepted, false);
  assert.match(fromCheckpoint.reasons.join('\n'), /F-002/);
});

test('a checkpoint from another revision or cycle is rejected, not interpreted', () => {
  const stale = decideCheckpoint({ plan: plan(), checkpoint: checkpoint({ revision: 3 }), cycle });
  assert.equal(stale.accepted, false);
  assert.match(stale.reasons.join('\n'), /revision 3 не совпадает с файлом \(4\)/);

  const foreignCycle = decideCheckpoint({ plan: plan(), checkpoint: checkpoint({ cycleId: 'c-11' }), cycle });
  assert.equal(foreignCycle.accepted, false);
  assert.match(foreignCycle.reasons.join('\n'), /не относится к текущему циклу/);

  const otherPlan = decideCheckpoint({ plan: plan(), checkpoint: checkpoint({ planId: 'p-other' }), cycle });
  assert.equal(otherPlan.accepted, false);
  assert.match(otherPlan.reasons.join('\n'), /planId/);
});

test('unknown or duplicated steps are a data error, not a shortcut', () => {
  const unknown = decideCheckpoint({ plan: plan(), checkpoint: checkpoint({ completedStepIds: ['S-009'], evidence: [{ stepId: 'S-009', kind: 'run', ref: 'run-1', summary: 'ok' }] }), cycle });
  assert.equal(unknown.accepted, false);
  assert.match(unknown.reasons.join('\n'), /шага S-009 нет в плане/);

  const duplicated = decideCheckpoint({
    plan: plan(),
    checkpoint: checkpoint({
      completedStepIds: ['S-002', 'S-002'],
      evidence: [{ stepId: 'S-002', kind: 'test', ref: 'run-1', summary: 'ok' }]
    }),
    cycle
  });
  assert.equal(duplicated.accepted, false);
  assert.match(duplicated.reasons.join('\n'), /указан дважды/);
});

test('a plan that says DONE without a result cannot be completed by a checkpoint', () => {
  assert.throws(() => parsePlan(PLAN_TEXT.replace('**Результат:** failing-тест, run-1\n', '')), /DONE без результата/);
  // The parser already refuses it; the controller's own guard is the second line:
  const sneaky = plan();
  sneaky.steps[0].result = '';
  const verdict = decideCheckpoint({ plan: sneaky, checkpoint: checkpoint(), cycle });
  assert.equal(verdict.accepted, false);
  assert.match(verdict.reasons.join('\n'), /DONE без доказательства у S-001/);
});

test('CONTINUE and REPLAN map to the next cycle instead of finishing', () => {
  const cont = decideCheckpoint({ plan: plan(), checkpoint: checkpoint({ decision: 'CONTINUE', completedStepIds: [], evidence: [] }), cycle });
  assert.equal(cont.accepted, false);
  assert.equal(cont.state, 'CONTINUE');
  assert.deepEqual(cont.openSteps, ['S-002']);

  const empty = decideCheckpoint({ plan: plan(), checkpoint: checkpoint({ decision: 'CONTINUE' }), cycle });
  assert.equal(empty.state, 'PAUSED_REVIEW', 'CONTINUE with nothing left contradicts the file');

  const replan = decideCheckpoint({ plan: plan(), checkpoint: checkpoint({ decision: 'REPLAN', completedStepIds: [], evidence: [] }), cycle });
  assert.equal(replan.state, 'PAUSED_REVIEW');
  assert.match(replan.reasons.join('\n'), /REPLAN без предложенных изменений/);

  const replanWithProposal = decideCheckpoint({
    plan: plan(),
    checkpoint: checkpoint({
      decision: 'REPLAN', completedStepIds: [], evidence: [],
      proposedChanges: [{ op: 'insert_after', after: 'S-002', stepId: 'S-003', title: 'Исправить reconnect', priority: 'P1' }]
    }),
    cycle
  });
  assert.equal(replanWithProposal.state, 'REPLAN');
  assert.equal(replanWithProposal.proposals.length, 1);
});

test('BLOCKED, NEED_INPUT and NO_PROGRESS pause for the operator', () => {
  for (const decision of ['BLOCKED', 'NEED_INPUT', 'NO_PROGRESS']) {
    const verdict = decideCheckpoint({ plan: plan(), checkpoint: checkpoint({ decision, completedStepIds: [], evidence: [] }), cycle });
    assert.equal(verdict.accepted, false, decision);
    assert.equal(verdict.state, 'PAUSED_REVIEW', decision);
  }
  assert.deepEqual([...CHECKPOINT_DECISIONS], ['CONTINUE', 'REPLAN', 'COMPLETE', 'BLOCKED', 'NEED_INPUT', 'NO_PROGRESS']);
});

test('the single audit instruction names the file, revision and cycle', () => {
  const instruction = auditInstruction({ path: 'docs/PLAN.md', planId: 'p-fp02', revision: 4, cycleId: 'c-12', stepId: 'S-002' });
  assert.match(instruction, /FOLLOW PLAN/);
  assert.match(instruction, /docs\/PLAN\.md/);
  assert.match(instruction, /revision 4/);
  assert.match(instruction, /cycle c-12/);
  assert.match(instruction, /taskbridge_plan_checkpoint/);
  assert.match(instruction, /S-002/);
  assert.equal(inspectCheckpoint({ plan: plan(), checkpoint: null, cycle }).problems[0], 'checkpoint не передан или не является объектом');
});
