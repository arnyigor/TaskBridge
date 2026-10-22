// Follow Plan: controlled revision of the SAME plan file (PLAN-FOLLOW-01, FP-04).
//
// A turn often finds a related defect. Letting the model rewrite the plan freely
// would grow the scope without limit, so every proposal is turned into the small
// set of edits the file format allows, with the ТЗ §5 priorities:
//
//   P0  blocking defect / data loss — a new step, but it needs the operator's
//       approval before the cycle continues (it can change what the plan is);
//   P1  blocks the current step or acceptance — a concrete new step that runs next;
//   P2  related useful fix — recorded as a finding, not a step;
//   P3  cosmetic / new feature — observation only, never executed automatically.
//
// What this module will not do, whatever the proposal says: rewrite a finished
// step, delete an agreed step, change the goal, or add more steps than the limit
// allows per cycle. Duplicates are recognised by meaning, so the same bug found
// twice does not multiply the plan.

import { nextStepId, nextFindingId, PRIORITIES } from './plan-file.mjs';

export const DEFAULT_REVISION_LIMITS = Object.freeze({ stepsPerCycle: 1, findingsPerCycle: 3, similarity: 0.6 });
const BLOCKING = new Set(['P0', 'P1']);

const stopWords = new Set(['и', 'в', 'на', 'не', 'с', 'по', 'для', 'что', 'как', 'при', 'из', 'the', 'a', 'of', 'to', 'in', 'is']);
// Morphology-free matching: "дубли/дублируются" and "события/событий" are the same
// word for this purpose, so a defect reported twice is recognised as one.
const sameWord = (a, b) => {
  if (a === b) return true;
  const shortest = Math.min(a.length, b.length);
  if (shortest < 4) return false;
  let common = 0;
  while (common < shortest && a[common] === b[common]) common++;
  // «событий»/«события», «дубли»/«дублируются» — одна и та же проблема для человека.
  return common >= 4 && common >= shortest - 2;
};
const tokens = value => new Set(
  String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(word => word.length > 2 && !stopWords.has(word))
);

/** Same defect said twice: token overlap, not string equality. */
export function isSameFinding(a, b, threshold = DEFAULT_REVISION_LIMITS.similarity) {
  const left = [...tokens(a)];
  const right = [...tokens(b)];
  if (!left.length || !right.length) return false;
  let shared = 0;
  const taken = new Set();
  for (const word of left) {
    const match = right.findIndex((other, index) => !taken.has(index) && sameWord(word, other));
    if (match >= 0) { taken.add(match); shared++; }
  }
  return shared / (left.length + right.length - shared) >= threshold;
}

/**
 * Builds the edits for one checkpoint. Returns the ops to apply through
 * `updatePlan`, plus what was refused and why — refusals are reported, never
 * silently dropped.
 */
export function planRevision({ plan, findings = [], proposals = [], currentStepId = null, runId = null, limits = {} }) {
  const policy = { ...DEFAULT_REVISION_LIMITS, ...limits };
  const ops = [];
  const rejected = [];
  const added = [];
  const recordedFindings = [];
  const requiresApproval = [];

  const knownSummaries = [
    ...plan.findings.map(finding => finding.summary),
    ...plan.steps.filter(step => step.originFindingId).map(step => step.title)
  ];
  let findingsAdded = 0;
  let stepsAdded = 0;
  // Counters, not lookups: an id handed out in this loop must never be handed out
  // again, and the plan on disk does not change until the ops are applied.
  let lastFinding = Number(nextFindingId(plan).slice(2)) - 1;
  let lastStep = Number(nextStepId(plan).slice(2)) - 1;
  const takeFindingId = () => `F-${String(++lastFinding).padStart(3, '0')}`;
  const takeStepId = () => `S-${String(++lastStep).padStart(3, '0')}`;

  for (const finding of findings) {
    const priority = PRIORITIES.includes(finding?.priority) ? finding.priority : 'P2';
    const summary = String(finding?.summary || '').trim();
    const id = String(finding?.id || '').trim();
    if (!summary) { rejected.push({ id, reason: 'finding без описания' }); continue; }
    if (knownSummaries.some(existing => isSameFinding(existing, summary, policy.similarity))) {
      rejected.push({ id, reason: 'такая проблема уже есть в плане', summary });
      continue;
    }
    knownSummaries.push(summary);

    // P0/P1 become work; P2/P3 only become a record of what was noticed.
    const asStep = BLOCKING.has(priority) && (finding.blocking === true || priority === 'P1');
    if (asStep && stepsAdded < policy.stepsPerCycle) {
      const stepId = takeStepId();
      const findingId = id || takeFindingId();
      if (!plan.findings.some(item => item.id === findingId) && !recordedFindings.some(item => item.findingId === findingId)) {
        ops.push({ op: 'add_finding', findingId, priority, summary });
        recordedFindings.push({ findingId: findingId, priority, summary });
        findingsAdded++;
      }
      ops.push({
        op: 'add_step',
        stepId,
        priority,
        title: summary,
        criteria: String(finding.criteria || `дефект «${summary}» больше не воспроизводится`),
        verification: String(finding.verification || 'адресный тест на этот дефект'),
        // A defect that blocks the current step runs BEFORE it; the file shows that.
        before: String(finding.before || (finding.after ? '' : currentStepId || '')),
        after: String(finding.after || ''),
        originFindingId: findingId
      });
      added.push({ stepId, findingId, priority, summary });
      stepsAdded++;
      if (priority === 'P0') requiresApproval.push({ stepId, findingId, summary });
      continue;
    }
    if (asStep && stepsAdded >= policy.stepsPerCycle) {
      rejected.push({ id, reason: `за цикл добавляется не более ${policy.stepsPerCycle} шага; проблема записана как finding`, summary });
    }
    if (findingsAdded >= policy.findingsPerCycle) {
      rejected.push({ id, reason: `за цикл записывается не более ${policy.findingsPerCycle} проблем`, summary });
      continue;
    }
    const findingId = id || takeFindingId();
    if (plan.findings.some(item => item.id === findingId) || recordedFindings.some(item => item.findingId === findingId)) {
      rejected.push({ id, reason: 'идентификатор проблемы уже занят', summary });
      continue;
    }
    ops.push({ op: 'add_finding', findingId, priority, summary });
    recordedFindings.push({ findingId: findingId, priority, summary });
    findingsAdded++;
  }

  for (const proposal of proposals) {
    const op = String(proposal?.op || '');
    if (op !== 'insert_after' && op !== 'add_step') {
      // delete_step, replace_goal, rewrite a finished step: not ours to do.
      rejected.push({ op, reason: 'правка не поддерживается: цель и завершённые шаги не переписываются' });
      continue;
    }
    const stepId = String(proposal.stepId || '');
    if (plan.steps.some(step => step.id === stepId)) {
      rejected.push({ op, stepId, reason: 'шаг уже есть; завершённые шаги не переписываются' });
      continue;
    }
    if (stepsAdded >= policy.stepsPerCycle) {
      rejected.push({ op, stepId, reason: `за цикл добавляется не более ${policy.stepsPerCycle} шага` });
      continue;
    }
    if (!proposal.criteria || !proposal.verification) {
      rejected.push({ op, stepId, reason: 'новый шаг требует критериев и способа проверки' });
      continue;
    }
    const priority = PRIORITIES.includes(proposal.priority) ? proposal.priority : 'P2';
    if (!BLOCKING.has(priority)) {
      rejected.push({ op, stepId, reason: `${priority} не расширяет объём автоматически: записано как наблюдение` });
      continue;
    }
    ops.push({
      op: 'add_step',
      stepId,
      priority,
      title: String(proposal.title || '').trim() || 'Связанный дефект',
      criteria: String(proposal.criteria),
      verification: String(proposal.verification),
      before: String(proposal.before || ''),
      after: String(proposal.after || ''),
      originFindingId: proposal.originFindingId || null
    });
    added.push({ stepId, findingId: proposal.originFindingId || null, priority, summary: String(proposal.title || '') });
    stepsAdded++;
    if (priority === 'P0') requiresApproval.push({ stepId, reason: 'P0 меняет порядок работ — нужно подтверждение' });
  }

  return {
    ops,
    added,
    findings: recordedFindings,
    rejected,
    requiresApproval,
    runId,
    summary: `добавлено шагов: ${added.length}, проблем: ${recordedFindings.length}, отклонено: ${rejected.length}`
  };
}
