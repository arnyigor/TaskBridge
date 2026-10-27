// Follow Plan checkpoint rules (PLAN-FOLLOW-01, FP-02).
//
// The model reports what it thinks it finished; this module decides what that
// claim is worth. It never talks to Pi or the file: the caller passes the plan as
// parsed from the file and the checkpoint as validated JSON, and gets a verdict
// with reasons. That separation is what makes "the model said COMPLETE" unable to
// end a plan on its own — and what lets the negative tests run without a model.
//
// Verified vs claimed: an evidence entry of kind `manual` (or one without a
// reference where the kind needs it) does not prove the criterion was checked, so
// the step counts as unverified. Whether an unverified step may be accepted is a
// product decision (ТЗ §13.4) and is therefore an explicit policy argument, not a
// hidden default: without `manualEvidenceAccepted` COMPLETE is refused.

export const CHECKPOINT_DECISIONS = Object.freeze(['CONTINUE', 'REPLAN', 'COMPLETE', 'BLOCKED', 'NEED_INPUT', 'NO_PROGRESS']);
export const EVIDENCE_KINDS = Object.freeze(['test', 'command', 'run', 'file', 'manual']);
// Kinds that must name where the result can be re-read. `file` and `run` do the
// same through `ref`; only `manual` is allowed to stand on a summary alone.
const NEEDS_REFERENCE = new Set(['test', 'command', 'run', 'file']);
const BLOCKING_PRIORITIES = new Set(['P0', 'P1']);
const STEP_ID = /^S-\d{3,}$/;
const FINDING_ID = /^F-\d{3,}$/;

export const DEFAULT_POLICY = Object.freeze({
  // ТЗ §13.4 is not settled; until it is, a claim is not proof.
  manualEvidenceAccepted: false,
  // A finding blocks completion when it says so and is P0/P1.
  blockingFindingsStopCompletion: true
});

const text = value => String(value ?? '').trim();

/**
 * Даёт ли план для шага конкретный способ проверки. Импорт документов пишет
 * «способ проверки не задан» — такой шаг нельзя проверить машинно, и требовать
 * ссылку бессмысленно.
 */
export function hasNoCheckMethod(step) {
  const method = text(step?.verification);
  if (!method) return true;
  if (/способ проверки не задан/i.test(method)) return true;
  return /^(—|-|нет|manual|n\/a|не задан[аоы]?)$/i.test(method);
}

/**
 * Structural inspection: everything wrong with this checkpoint as data, apart
 * from whether it should complete the plan.
 */
export function inspectCheckpoint({ plan, checkpoint, cycle, policy = DEFAULT_POLICY }) {
  const problems = [];
  const unverified = [];
  // Шаги, закрытые описанием сверки: в плане нет способа проверки, значит и
  // требовать ref не с чего — но и выдавать это за машинную проверку нельзя.
  const manualAccepted = [];
  const value = checkpoint && typeof checkpoint === 'object' ? checkpoint : null;
  if (!value) return { problems: ['checkpoint не передан или не является объектом'], completedSteps: [], findings: [], unverifiedStepIds: [] };

  if (text(value.planId) !== plan.planId) problems.push(`planId «${text(value.planId)}» не совпадает с планом «${plan.planId}»`);
  if (Number(value.revision) !== Number(plan.revision)) problems.push(`revision ${text(value.revision)} не совпадает с файлом (${plan.revision}) — план менялся`);
  if (cycle?.cycleId && text(value.cycleId) !== text(cycle.cycleId)) problems.push(`cycleId «${text(value.cycleId)}» не относится к текущему циклу «${cycle.cycleId}»`);
  if (!CHECKPOINT_DECISIONS.includes(value.decision)) problems.push(`неизвестное решение «${text(value.decision)}»`);
  if (cycle?.hash && plan.hash && cycle.hash !== plan.hash) problems.push('файл плана изменился после выдачи хода');

  const completed = Array.isArray(value.completedStepIds) ? value.completedStepIds.map(text) : [];
  if (value.completedStepIds != null && !Array.isArray(value.completedStepIds)) problems.push('completedStepIds должен быть массивом');
  const seen = new Set();
  for (const id of completed) {
    if (!STEP_ID.test(id)) problems.push(`неверный идентификатор шага «${id}»`);
    else if (!plan.steps.some(step => step.id === id)) problems.push(`шага ${id} нет в плане`);
    if (seen.has(id)) problems.push(`шаг ${id} указан дважды`);
    seen.add(id);
  }

  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  if (value.evidence != null && !Array.isArray(value.evidence)) problems.push('evidence должен быть массивом');
  const evidenceByStep = new Map();
  for (const item of evidence) {
    if (!item || typeof item !== 'object') { problems.push('элемент evidence не объект'); continue; }
    const stepId = text(item.stepId);
    const kind = text(item.kind);
    if (!EVIDENCE_KINDS.includes(kind)) problems.push(`шаг ${stepId}: неизвестный вид подтверждения «${kind}»`);
    if (!text(item.summary)) problems.push(`шаг ${stepId}: подтверждение без описания`);
    if (NEEDS_REFERENCE.has(kind) && !text(item.ref)) problems.push(`шаг ${stepId}: подтверждение «${kind}» без ссылки (ref)`);
    const list = evidenceByStep.get(stepId) || [];
    list.push(item);
    evidenceByStep.set(stepId, list);
  }
  for (const id of completed) {
    const items = evidenceByStep.get(id) || [];
    if (!items.length) { problems.push(`шаг ${id} отмечен выполненным без подтверждения`); continue; }
    const verified = items.some(item => text(item.kind) !== 'manual' && text(item.ref));
    if (verified) continue;
    // Живой прогон 2026-10-27: план импортирован из документа, у шага
    // «**Проверка:** импортировано: способ проверки не задан», и модель честно
    // прислала manual с описанием сверки. Отказ означал тупик: выполнить такой шаг
    // нельзя ничем, проверки в плане нет. Поэтому manual принимается там, где план
    // сам не даёт способа проверки; где даёт — по-прежнему нужен ref.
    const step = plan.steps.find(item => item.id === id);
    // Ссылку прощаем только чистому manual: если модель ссылалась на прогон или
    // файл, а ссылка не подтвердилась (чужая, старая, удалённая), это не «сверено
    // вручную», а непроверенное заявление — такой шаг не закрывается.
    const pureManual = items.every(item => text(item.kind) === 'manual');
    if (pureManual && (hasNoCheckMethod(step) || policy.manualEvidenceAccepted)) {
      manualAccepted.push(id);
      continue;
    }
    unverified.push(id);
    problems.push(`шаг ${id}: у шага есть способ проверки, но подтверждение без проверяемой ссылки — пришли ref на toolCallId этого хода`);
  }

  const findings = (Array.isArray(value.findings) ? value.findings : []).map(finding => ({
    id: text(finding?.id),
    priority: text(finding?.priority),
    blocking: finding?.blocking === true,
    summary: text(finding?.summary),
    // Which existing steps the defect belongs to: a defect covered by a step that
    // is already in the plan must not create a second, duplicate step.
    relatedStepIds: Array.isArray(finding?.relatedStepIds) ? finding.relatedStepIds.map(text).filter(Boolean) : []
  }));
  for (const finding of findings) {
    if (!FINDING_ID.test(finding.id)) problems.push(`неверный идентификатор проблемы «${finding.id}»`);
    if (!text(finding.summary)) problems.push(`проблема ${finding.id}: нет описания`);
    if (finding.blocking && !BLOCKING_PRIORITIES.has(finding.priority)) problems.push(`проблема ${finding.id}: blocking с приоритетом ${finding.priority || '—'}`);
  }

  return {
    problems, completedSteps: completed, findings, unverifiedStepIds: unverified, manualAcceptedStepIds: manualAccepted,
    decision: text(value.decision), nextStepId: text(value.nextStepId) || null,
    evidenceFor: id => evidenceByStep.get(id) || []
  };
}

/** The plan after the checkpoint's claims were written into it (still in memory). */
export function withCompletedSteps(plan, inspection) {
  const next = structuredClone(plan);
  for (const id of inspection.completedSteps) {
    const step = next.steps.find(item => item.id === id);
    if (!step) continue;
    step.status = 'DONE';
    if (!step.result) {
      // Evidence summary is the shortest honest result; the full run stays in the transcript.
      const items = inspection.evidenceFor?.(id) || [];
      step.result = items.map(item => item.summary).join('; ');
    }
  }
  return next;
}

const openBlockingFindings = (plan, inspection) => {
  const fromFile = plan.findings
    .filter(finding => finding.state === 'OPEN' && BLOCKING_PRIORITIES.has(finding.priority))
    .map(finding => finding.id);
  const fromCheckpoint = inspection.findings
    .filter(finding => finding.blocking && BLOCKING_PRIORITIES.has(finding.priority))
    .map(finding => finding.id);
  return [...new Set([...fromFile, ...fromCheckpoint])];
};

/**
 * What the controller does with this checkpoint. `COMPLETED` requires a clean
 * inspection, evidence for every claimed step, no open blocking finding and every
 * step (except SKIPPED) DONE in the file. Everything else maps to the FSM state —
 * the caller then pauses, continues or asks for input.
 */
export function decideCheckpoint({ plan, checkpoint, cycle, policy = DEFAULT_POLICY }) {
  const inspection = inspectCheckpoint({ plan, checkpoint, cycle, policy });
  const base = { decision: inspection.decision, inspection };
  if (inspection.problems.length) {
    return { ...base, accepted: false, state: 'PAUSED_REVIEW', reasons: inspection.problems };
  }

  const after = withCompletedSteps(plan, inspection);
  // Open work is judged against the file BEFORE this turn's claims: CONTINUE means
  // "there is still work", and whether the last step is finished is the follower's
  // question (it may need one completion claim instead of another step).
  const open = plan.steps.filter(step => step.status !== 'DONE' && step.status !== 'SKIPPED').map(step => step.id);
  const reasons = [];

  switch (inspection.decision) {
    case 'COMPLETE': {
      const notDone = after.steps
        .filter(step => step.status !== 'DONE' && step.status !== 'SKIPPED')
        .map(step => `${step.id} (${step.status})`);
      if (notDone.length) reasons.push(`COMPLETE отклонён: не завершены ${notDone.join(', ')}`);
      const withoutResult = after.steps.filter(step => step.status === 'DONE' && !text(step.result)).map(step => step.id);
      if (withoutResult.length) reasons.push(`COMPLETE отклонён: DONE без доказательства у ${withoutResult.join(', ')}`);
      const blocking = openBlockingFindings(plan, inspection);
      if (blocking.length && policy.blockingFindingsStopCompletion) reasons.push(`COMPLETE отклонён: открытые блокирующие проблемы ${blocking.join(', ')}`);
      if (inspection.unverifiedStepIds.length && !policy.manualEvidenceAccepted) {
        reasons.push(`COMPLETE отклонён: без проверяемого подтверждения ${inspection.unverifiedStepIds.join(', ')}`);
      }
      if (reasons.length) return { ...base, accepted: false, state: 'PAUSED_REVIEW', reasons, openSteps: notDone };
      return { ...base, accepted: true, state: 'COMPLETED', reasons: [], plan: after };
    }
    case 'CONTINUE':
      return { ...base, accepted: false, state: open.length ? 'CONTINUE' : 'PAUSED_REVIEW', reasons: open.length ? [] : ['CONTINUE, но открытых шагов нет — решение противоречит файлу'], openSteps: open, plan: after };
    case 'REPLAN': {
      const proposal = Array.isArray(checkpoint.proposedChanges) ? checkpoint.proposedChanges : [];
      // No operations is not automatically a stop: the follower first checks
      // whether the plan actually needs a change (FP-PILOT-02B).
      if (!proposal.length) return { ...base, accepted: false, state: 'REPLAN_UNRESOLVED', reasons: [], plan: after, openSteps: open };
      return { ...base, accepted: false, state: 'REPLAN', reasons: [], proposals: proposal, plan: after, openSteps: open };
    }
    case 'BLOCKED':
    case 'NEED_INPUT':
    case 'NO_PROGRESS':
      return { ...base, accepted: false, state: 'PAUSED_REVIEW', reasons: [], plan: after, openSteps: open };
    default:
      return { ...base, accepted: false, state: 'PAUSED_REVIEW', reasons: [`неизвестное решение «${inspection.decision}»`] };
  }
}

/**
 * The one control instruction the controller may send when a turn settled without
 * a checkpoint (ТЗ: не более одного проверочного хода).
 */
export function auditInstruction({ path, planId, revision, cycleId, stepId }) {
  return `Режим FOLLOW PLAN. Ты закончил ход, но не передал checkpoint. `
    + `Сверь файл плана \`${path}\` (planId ${planId}, revision ${revision}, cycle ${cycleId}) и результаты этого хода: `
    + `что действительно выполнено и чем это подтверждено. `
    + `Передай taskbridge_plan_checkpoint с решением CONTINUE, REPLAN, COMPLETE, BLOCKED или NEED_INPUT`
    + `${stepId ? ` для шага ${stepId}` : ''}. Не отмечай шаг выполненным без критериев проверки и не начинай новых работ.`;
}
