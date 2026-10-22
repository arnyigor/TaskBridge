// FP-04: автокоррекция плана — приоритеты, дедупликация, отказ от расширения объёма.
//
// Правила ТЗ §5 проверяются на чистой функции: findings из checkpoint превращаются
// в ограниченный набор правок ТОГО ЖЕ файла. P1 становится следующим шагом, P0 —
// шагом с обязательным подтверждением, P2/P3 остаются записями. Всё, что не
// сводится к этим правкам (удалить шаг, переписать DONE, сменить цель), отклоняется
// с причиной, а не выполняется молча.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, serializePlan, applyChanges } from '../src/application/plan-file.mjs';
import { nextOpenStep } from '../src/application/plan-follower.mjs';
import { planRevision, isSameFinding, DEFAULT_REVISION_LIMITS } from '../src/application/plan-revision.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-fp04
revision: 5
goal: "FP-04: автокоррекция"
---

# План: автокоррекция

## Шаги

### S-001 | DONE | P1 | Воспроизвести
**Критерии:** сценарий воспроизведён.
**Проверка:** тест
**Результат:** failing-тест, run-1

### S-002 | IN_PROGRESS | P1 | Исправить пагинацию
**Критерии:** нет дублей.
**Проверка:** node --test tests/history.test.mjs

## Обнаруженные проблемы
- F-001 | P2 | OPEN | медленный лог
`;

const plan = () => parsePlan(PLAN);
const apply = (revision) => {
  const next = applyChanges(plan(), { ops: revision.ops });
  next.revision = 6;
  return { plan: next, text: serializePlan(next) };
};

test('a P1 defect becomes the next step with its origin and checks', () => {
  const revision = planRevision({
    plan: plan(),
    currentStepId: 'S-002',
    findings: [{ id: 'F-002', priority: 'P1', blocking: true, summary: 'дубли событий при reconnect', criteria: 'событий ровно N', verification: 'тест reconnect' }]
  });
  assert.equal(revision.requiresApproval.length, 0);
  assert.ok(revision.ops.some(op => op.op === 'add_step' && op.originFindingId === 'F-002'));

  const { plan: updated } = apply(revision);
  const added = updated.steps.find(step => step.id === 'S-003');
  assert.equal(added.status, 'TODO');
  assert.equal(added.priority, 'P1');
  assert.equal(added.criteria, 'событий ровно N');
  assert.equal(added.originFindingId, 'F-002');

  // The new step runs before the rest of the open work: that is what P1 means.
  assert.deepEqual(updated.steps.map(step => step.id), ['S-001', 'S-003', 'S-002'], 'the blocking defect runs before the step it blocks');
  assert.equal(nextOpenStep(updated).id, 'S-003');
});

test('P0 asks for approval instead of silently reordering the work', () => {
  const revision = planRevision({
    plan: plan(),
    findings: [{ id: 'F-003', priority: 'P0', blocking: true, summary: 'потеря данных при повторном импорте' }]
  });
  assert.equal(revision.requiresApproval.length, 1);
  assert.equal(revision.requiresApproval[0].priority, undefined);
  assert.equal(revision.requiresApproval[0].stepId, 'S-003');
  assert.ok(revision.ops.some(op => op.op === 'add_step' && op.priority === 'P0'));
});

test('P2 and P3 stay a record and do not expand the work', () => {
  const revision = planRevision({
    plan: plan(),
    findings: [
      { id: 'F-004', priority: 'P2', summary: 'проверять размер файла лога' },
      { id: 'F-005', priority: 'P3', summary: 'переименовать кнопку в панели' }
    ]
  });
  assert.equal(revision.ops.filter(op => op.op === 'add_step').length, 0);
  assert.equal(revision.ops.filter(op => op.op === 'add_finding').length, 2);
  const { plan: updated } = apply(revision);
  assert.deepEqual(updated.steps.map(step => step.id), ['S-001', 'S-002']);
  assert.deepEqual(updated.findings.map(finding => finding.id), ['F-001', 'F-004', 'F-005']);
});

test('the same defect found twice does not multiply', () => {
  const first = planRevision({
    plan: plan(),
    findings: [{ id: 'F-002', priority: 'P1', summary: 'дубли событий при reconnect' }]
  });
  const { plan: updated } = apply(first);
  const second = planRevision({
    plan: updated,
    findings: [{ id: 'F-006', priority: 'P1', summary: 'При reconnect дублируются события' }]
  });
  assert.equal(second.ops.length, 0, 'a near-identical finding adds nothing');
  assert.match(second.rejected[0].reason, /уже есть в плане/);
  assert.ok(isSameFinding('дубли событий при reconnect', 'При reconnect дублируются события'));
  assert.equal(isSameFinding('дубли событий при reconnect', 'медленный лог'), false);
});

test('one step per cycle is the ceiling; the rest is recorded as findings', () => {
  const revision = planRevision({
    plan: plan(),
    findings: [
      { id: 'F-002', priority: 'P1', summary: 'дубли событий при reconnect' },
      { id: 'F-003', priority: 'P1', summary: 'потеря последнего сообщения' }
    ]
  });
  assert.equal(revision.added.length, 1);
  assert.equal(revision.findings.length, 2, 'both problems are on record');
  assert.equal(revision.ops.filter(op => op.op === 'add_step').length, 1);
  assert.match(revision.rejected[0].reason, /не более 1 шага/);
});

test('a proposal cannot delete, rewrite or re-goal the plan', () => {
  const revision = planRevision({
    plan: plan(),
    proposals: [
      { op: 'delete_step', stepId: 'S-001' },
      { op: 'insert_after', after: 'S-002', stepId: 'S-002', title: 'переписать завершённый шаг', priority: 'P1', criteria: 'x', verification: 'y' },
      { op: 'replace_goal', goal: 'другая цель' },
      { op: 'insert_after', after: 'S-002', stepId: 'S-004', title: 'новая функция', priority: 'P3', criteria: 'x', verification: 'y' }
    ]
  });
  assert.equal(revision.ops.length, 0);
  assert.equal(revision.rejected.length, 4);
  assert.match(revision.rejected[0].reason, /не поддерживается/);
  assert.match(revision.rejected[1].reason, /уже есть/);
  assert.match(revision.rejected[3].reason, /не расширяет объём/);
});

test('an accepted proposal still needs criteria and verification', () => {
  const revision = planRevision({
    plan: plan(),
    proposals: [{ op: 'insert_after', after: 'S-002', stepId: 'S-004', title: 'Исправить reconnect', priority: 'P1' }]
  });
  assert.equal(revision.ops.length, 0);
  assert.match(revision.rejected[0].reason, /критериев и способа проверки/);
});

test('a finding without a description is refused, not invented', () => {
  const revision = planRevision({ plan: plan(), findings: [{ id: 'F-009', priority: 'P1', summary: '   ' }] });
  assert.equal(revision.ops.length, 0);
  assert.match(revision.rejected[0].reason, /без описания/);
  assert.deepEqual([...Object.keys(DEFAULT_REVISION_LIMITS)].sort(), ['findingsPerCycle', 'similarity', 'stepsPerCycle']);
});
