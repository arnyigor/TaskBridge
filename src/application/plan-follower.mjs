// Durable Follow Plan state machine (PLAN-FOLLOW-01, FP-03).
//
// One cycle is an ordinary prompt that TaskBridge already knows how to send: this
// class never starts a Pi process, keeps no queue of its own and does not retry on
// its own. It decides *when* a turn may be dispatched, what the settled turn makes
// of the plan, and when to stop asking, and it records every decision in the
// runtime binding so a restart can tell "dispatched and answered" from "dispatched
// and unknown" instead of blindly replaying.
//
// Invariants that the tests below pin down:
//   * a settled turn is not a finished plan — only decideCheckpoint() can say so;
//   * one cycle per task, one audit turn per cycle, a hard budget of cycles and a
//     limit of cycles without measurable progress;
//   * STOP is stronger than auto-continue: the epoch is bumped, a checkpoint that
//     arrives afterwards is ignored, and no next step is dispatched;
//   * an unknown in-flight effect (restart with a dispatched command) pauses for
//     review and is never re-sent;
//   * the plan file is changed only through compare-and-swap on revision + hash,
//     so an outside edit stops the cycle instead of being overwritten.

import { decideCheckpoint, auditInstruction } from './plan-checkpoint.mjs';
import { planRevision } from './plan-revision.mjs';

export const FOLLOWER_STATES = Object.freeze(['IDLE', 'RUNNING_STEP', 'REVIEWING', 'PAUSED_REVIEW', 'PAUSED', 'COMPLETED']);
export const DEFAULT_LIMITS = Object.freeze({
  maxCycles: 20,
  noProgressLimit: 3,
  auditTurnsPerCycle: 1,
  budgetMs: 6 * 60 * 60 * 1000
});

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * `[SYSTEM_VERIFIED] …` / `[MODEL_REPORTED] …` — the weakest level among the
 * confirmed items, so the file itself records how the result was established.
 */
export function resultForStep(items = []) {
  if (!items.length) return '[MODEL_REPORTED] подтверждено checkpoint';
  const rank = { SYSTEM_VERIFIED: 0, MANUAL_ACCEPTED: 1, MODEL_REPORTED: 2 };
  const level = items
    .map(item => String(item.level || 'MODEL_REPORTED'))
    .sort((a, b) => (rank[b] ?? 9) - (rank[a] ?? 9))[0];
  const text = items.map(item => item.summary).filter(Boolean).join('; ');
  return `[${level}] ${text || 'подтверждено checkpoint'}`;
}

/** The next step is the highest priority among open ones; the file order breaks ties. */
export function nextOpenStep(plan) {
  const open = plan.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status === 'TODO' || step.status === 'IN_PROGRESS' || step.status === 'BLOCKED');
  if (!open.length) return null;
  open.sort((a, b) => (PRIORITY_ORDER[a.step.priority] ?? 9) - (PRIORITY_ORDER[b.step.priority] ?? 9) || a.index - b.index);
  return open[0].step;
}

/**
 * Deterministic command id: the same cycle and step always produce the same id, so
 * a repeated dispatch is recognised by the existing command ledger instead of
 * being sent twice. The epoch keeps ids from before a STOP distinct.
 */
export const stepCommandId = ({ taskId, cycleId, stepId, epoch, audit = false }) =>
  `plan:${taskId}:${cycleId}:${stepId ?? 'audit'}${audit ? ':audit' : ''}:${epoch}`;

export function stepInstruction({ path, planId, revision, cycleId, stepId }) {
  return [
    'Режим FOLLOW PLAN.',
    `Источник истины: \`${path}\` (planId ${planId}, revision ${revision}, cycle ${cycleId}).`,
    `Прежде чем действовать, перечитай файл плана и сверь его с результатами прошлого хода.`,
    `Текущий шаг: ${stepId}. Не отмечай его выполненным без критериев проверки.`,
    'Если найден относящийся к делу дефект, которого нет в плане, зарегистрируй finding с доказательством и предложи минимальный шаг с приоритетом P0/P1/P2.',
    'Не создавай второй план, не меняй цель и не расширяй объём работ.',
    'В конце хода вызови taskbridge_plan_checkpoint с решением CONTINUE, REPLAN, COMPLETE, BLOCKED или NEED_INPUT.'
  ].join(' ');
}

const clone = value => structuredClone(value);

export class PlanFollower {
  /**
   * @param {object} ports
   * @param {{getPlanBinding: Function, savePlanBinding: Function, planCancelEpoch: Function, bumpPlanCancelEpoch: Function}} ports.store
   * @param {{read: Function, update: Function}} ports.plans  plan file, hash/revision aware
   * @param {(input: {taskId: string, commandId: string, message: string}) => Promise<{id?: string}>} ports.dispatch
   * @param {(input: {taskId: string, commandId: string}) => Promise<void>} [ports.cancel]
   */
  constructor({ store, plans, dispatch, cancel = async () => {}, now = () => Date.now(), limits = {} }) {
    Object.assign(this, { store, plans, dispatch, cancel, now });
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  #binding(taskId) {
    return this.store.getPlanBinding(String(taskId));
  }

  #save(taskId, patch) {
    const current = this.#binding(taskId) || {
      taskId: String(taskId), planId: '', path: '', revision: 0, hash: '', state: 'IDLE',
      cycleId: null, expectedRevision: null, expectedHash: null,
      dispatchCommandId: null, dispatchStepId: null, leaseUntil: null, settledSeq: null, budget: null
    };
    const next = { ...current, ...patch, updatedAt: new Date(this.now()).toISOString() };
    this.store.savePlanBinding(next);
    return next;
  }

  /** Attach reads the file and validates it. No model call, no token spent. */
  async attach({ taskId, path }) {
    const file = await this.plans.read(path);
    const binding = this.#save(taskId, {
      planId: file.plan.planId,
      path,
      revision: file.plan.revision,
      hash: file.hash,
      state: 'IDLE',
      cycleId: null,
      expectedRevision: file.plan.revision,
      expectedHash: file.hash,
      dispatchCommandId: null,
      dispatchStepId: null,
      budget: { startedAt: null, cycles: 0, noProgress: 0, audits: 0 }
    });
    return { binding, plan: file.plan };
  }

  /** Start (or resume) the first turn. The operator action is the only entry point. */
  async start({ taskId, commandId }) {
    const binding = this.#requireBinding(taskId);
    if (binding.state === 'COMPLETED') return this.#result(taskId, 'PLAN_COMPLETED', 'План уже завершён.');
    if (binding.state === 'RUNNING_STEP' || binding.state === 'REVIEWING') {
      return this.#result(taskId, 'PLAN_BUSY', 'Цикл уже выполняется: один активный цикл на задачу.');
    }
    const file = await this.plans.read(binding.path);
    if (file.hash !== binding.hash || file.plan.revision !== binding.revision) {
      // Attached file changed while idle: adopt it, but only as a new baseline.
      this.#save(taskId, { planId: file.plan.planId, revision: file.plan.revision, hash: file.hash });
    }
    return this.#openCycle({ taskId, plan: file.plan, hash: file.hash, reason: commandId ? 'start' : 'resume' });
  }

  #openCycle({ taskId, plan, hash, reason }) {
    const binding = this.#requireBinding(taskId);
    const budget = binding.budget || {};
    const startedAt = budget.startedAt || this.now();
    if (this.now() - startedAt > this.limits.budgetMs) {
      this.#save(taskId, { state: 'PAUSED', budget: { ...budget, startedAt } });
      return this.#result(taskId, 'PLAN_BUDGET_EXCEEDED', 'Бюджет времени Follow Plan исчерпан.');
    }
    if (Number(budget.cycles || 0) >= this.limits.maxCycles) {
      this.#save(taskId, { state: 'PAUSED', budget });
      return this.#result(taskId, 'PLAN_BUDGET_EXCEEDED', `Достигнут предел ${this.limits.maxCycles} автоматических циклов.`);
    }
    const step = nextOpenStep(plan);
    if (!step) {
      this.#save(taskId, { state: 'PAUSED_REVIEW' });
      return this.#result(taskId, 'PLAN_BLOCKED', 'Открытых шагов нет, но план не подтверждён как завершённый.');
    }
    return this.#dispatchStep({ taskId, plan, hash, step, reason, budget: { ...budget, startedAt } });
  }

  /**
   * Prepare the next hop without sending it. The dispatch intent becomes durable
   * only when the previous turn's terminal event is committed — a finalization
   * failure must not leave a step already on its way (FP-UX-02E).
   */
  #prepareDispatch({ taskId, plan, hash, step, audit = false, budget }) {
    const binding = this.#requireBinding(taskId);
    const epoch = this.store.planCancelEpoch(taskId);
    const cycleId = audit ? (binding.cycleId || 'c-1') : `c-${Number(budget?.cycles || 0) + 1}`;
    const commandId = stepCommandId({ taskId, cycleId, stepId: step.id, epoch, audit });
    const nextBudget = {
      ...budget,
      cycles: audit ? Number(budget?.cycles || 0) : Number(budget?.cycles || 0) + 1,
      audits: audit ? Number(budget?.audits || 0) + 1 : 0
    };
    const message = audit
      ? auditInstruction({ path: binding.path, planId: plan.planId, revision: plan.revision, cycleId, stepId: step.id })
      : stepInstruction({ path: binding.path, planId: plan.planId, revision: plan.revision, cycleId, stepId: step.id });
    return {
      taskId,
      epoch,
      cycleId,
      commandId,
      stepId: step.id,
      audit,
      message,
      revision: plan.revision,
      hash,
      budget: nextBudget
    };
  }

  async #hop(input) {
    if (!input.deferDispatch) return this.#dispatchStep(input);
    const pending = this.#prepareDispatch(input);
    // Nothing is marked as dispatched yet: the commit of the previous turn is what
    // makes this hop real, and until then a crash reads as «review», not «sent».
    this.#save(input.taskId, {
      state: 'REVIEWING',
      cycleId: pending.cycleId,
      dispatchStepId: pending.stepId,
      expectedRevision: pending.revision,
      expectedHash: pending.hash,
      budget: pending.budget
    });
    return this.#result(input.taskId, 'DISPATCH_READY', 'Следующий шаг готов к отправке после фиксации хода.', pending);
  }

  /** Send what #prepareDispatch prepared, once the turn is durably finished. */
  async dispatchPending({ taskId, pending }) {
    const binding = this.#requireBinding(taskId);
    if (Number(pending.epoch) !== this.store.planCancelEpoch(taskId)) {
      // STOP landed between the settle and the commit: the prepared hop is stale.
      return this.#result(taskId, 'IGNORED', 'Отмена пришла до отправки следующего шага.', { reason: 'epoch' });
    }
    if (pending.stepId && !pending.audit) {
      const budget = pending.budget || {};
      if (Number(budget.cycles || 0) > this.limits.maxCycles) {
        this.#save(taskId, { state: 'PAUSED', dispatchCommandId: null, dispatchStepId: null, budget });
        return this.#result(taskId, 'PLAN_BUDGET_EXCEEDED', `Достигнут предел ${this.limits.maxCycles} автоматических циклов.`);
      }
    }
    this.#save(taskId, {
      state: 'RUNNING_STEP',
      cycleId: pending.cycleId,
      dispatchCommandId: pending.commandId,
      dispatchStepId: pending.stepId,
      expectedRevision: pending.revision,
      expectedHash: pending.hash,
      budget: pending.budget
    });
    await this.dispatch({ taskId, commandId: pending.commandId, message: pending.message, stepId: pending.stepId });
    return this.#result(taskId, 'DISPATCHED', pending.audit ? 'Отправлен контрольный ход.' : `Отправлен шаг ${pending.stepId}.`, {
      commandId: pending.commandId, stepId: pending.stepId, cycleId: pending.cycleId
    });
  }

  async #dispatchStep({ taskId, plan, hash, step, audit = false, budget }) {
    const binding = this.#requireBinding(taskId);
    // The budget is checked at every dispatch, not only when a cycle is opened:
    // long cycles must stop at the limit too.
    if (!audit) {
      if (Number(budget?.cycles || 0) >= this.limits.maxCycles) {
        this.#save(taskId, { state: 'PAUSED', dispatchCommandId: null, dispatchStepId: null, budget });
        return this.#result(taskId, 'PLAN_BUDGET_EXCEEDED', `Достигнут предел ${this.limits.maxCycles} автоматических циклов.`);
      }
      if (budget?.startedAt && this.now() - budget.startedAt > this.limits.budgetMs) {
        this.#save(taskId, { state: 'PAUSED', dispatchCommandId: null, dispatchStepId: null, budget });
        return this.#result(taskId, 'PLAN_BUDGET_EXCEEDED', 'Бюджет времени Follow Plan исчерпан.');
      }
    }
    const epoch = this.store.planCancelEpoch(taskId);
    // An audit turn belongs to the cycle it audits; a real step opens a new one.
    const cycleId = audit ? (binding.cycleId || 'c-1') : `c-${Number(budget?.cycles || 0) + 1}`;
    const commandId = stepCommandId({ taskId, cycleId, stepId: step.id, epoch, audit });
    // Dispatch intent is durable BEFORE the prompt goes out: a crash between these
    // two lines is then "unknown outcome", not "nothing happened".
    this.#save(taskId, {
      state: 'RUNNING_STEP',
      cycleId,
      dispatchCommandId: commandId,
      dispatchStepId: step.id,
      expectedRevision: plan.revision,
      expectedHash: hash,
      budget: {
        ...budget,
        cycles: audit ? Number(budget?.cycles || 0) : Number(budget?.cycles || 0) + 1,
        audits: audit ? Number(budget?.audits || 0) + 1 : 0
      }
    });
    const message = audit
      ? auditInstruction({ path: binding.path, planId: plan.planId, revision: plan.revision, cycleId, stepId: step.id })
      : stepInstruction({ path: binding.path, planId: plan.planId, revision: plan.revision, cycleId, stepId: step.id });
    await this.dispatch({ taskId, commandId, message, stepId: step.id });
    return this.#result(taskId, 'DISPATCHED', audit ? 'Отправлен контрольный ход.' : `Отправлен шаг ${step.id}.`, { commandId, stepId: step.id, cycleId });
  }

  /**
   * Called after Pi settled for this task. `checkpoint` is the parsed tool
   * argument or null when the turn ended without one.
   */
  async onSettled({ taskId, commandId, checkpoint, seq = null, deferDispatch = false }) {
    const binding = this.#requireBinding(taskId);
    if (binding.state === 'IDLE' || binding.state === 'PAUSED_REVIEW' || binding.state === 'PAUSED' || binding.state === 'COMPLETED') {
      return this.#result(taskId, 'IGNORED', 'Ход завершился вне активного цикла.');
    }
    if (commandId && binding.dispatchCommandId && commandId !== binding.dispatchCommandId) {
      // A late ACK from an earlier command must not move the current cycle.
      return this.#result(taskId, 'IGNORED', 'Подтверждение относится к другой команде.');
    }
    this.#save(taskId, { state: 'REVIEWING', settledSeq: seq });
    const budget = binding.budget || {};

    if (!checkpoint) {
      if (Number(budget.audits || 0) < this.limits.auditTurnsPerCycle) {
        const file = await this.plans.read(binding.path);
        const step = nextOpenStep(file.plan) || { id: binding.dispatchStepId };
        return this.#hop({ taskId, plan: file.plan, hash: file.hash, step, audit: true, budget, deferDispatch });
      }
      this.#save(taskId, { state: 'PAUSED', dispatchCommandId: null, dispatchStepId: null });
      return this.#result(taskId, 'PLAN_UNKNOWN_OUTCOME', 'Checkpoint не получен и после контрольного хода — пауза.');
    }

    const file = await this.plans.read(binding.path);
    if (file.hash !== binding.expectedHash || file.plan.revision !== binding.expectedRevision) {
      this.#save(taskId, { state: 'PAUSED_REVIEW', dispatchCommandId: null, dispatchStepId: null });
      return this.#result(taskId, 'PLAN_REVISION_CONFLICT', 'Файл плана изменён во время цикла: нужно согласование, а не перезапись.');
    }

    const verdict = decideCheckpoint({ plan: file.plan, checkpoint, cycle: { cycleId: binding.cycleId, revision: file.plan.revision } });
    // Only a checkpoint that passed inspection may change the file. A claim that
    // failed validation leaves the plan exactly as a human left it.
    const valid = verdict.inspection.problems.length === 0;
    const completed = valid ? verdict.inspection.completedSteps : [];

    // Findings and proposals become edits of the SAME file, within the limits of
    // plan-revision: P1 runs next, P0 waits for approval, P2/P3 stay records.
    const revision = valid
      ? planRevision({
        plan: file.plan,
        findings: verdict.inspection.findings,
        proposals: Array.isArray(checkpoint.proposedChanges) ? checkpoint.proposedChanges : [],
        currentStepId: binding.dispatchStepId
      })
      : { ops: [], added: [], findings: [], rejected: [], requiresApproval: [] };
    if (revision.requiresApproval.length) {
      // A P0 defect can change what the plan is; nothing is written until the
      // operator approves it.
      this.#save(taskId, { state: 'PAUSED_REVIEW', dispatchCommandId: null, dispatchStepId: null });
      return this.#result(taskId, 'PLAN_BLOCKED', `Нужно подтверждение: ${revision.requiresApproval.map(item => item.summary || item.stepId).join('; ')}`, {
        requiresApproval: revision.requiresApproval, proposals: revision.ops
      });
    }

    const ops = [
      ...completed.map(stepId => ({
        op: 'set_step_status',
        stepId,
        status: 'DONE',
        // The level travels into the file, so history says how the step was proven
        // and a model sentence is never presented as an independent check.
        result: resultForStep(verdict.inspection.evidenceFor(stepId)),
      })),
      // A step that exists because of a finding is the verification of that
      // finding: leaving it OPEN would block the plan's COMPLETE for ever.
      ...completed
        .map(stepId => file.plan.steps.find(step => step.id === stepId)?.originFindingId)
        .filter(Boolean)
        .map(findingId => ({ op: 'set_finding_state', findingId, state: 'DONE' })),
      ...revision.ops
    ];

    let applied = null;
    if (valid && ops.length) {
      // Evidence summary is what the file records as the result; the run itself
      // stays in the transcript, and the file keeps only a reference-sized note.
      applied = await this.plans.update({
        path: binding.path,
        expectedRevision: file.plan.revision,
        expectedHash: file.hash,
        changes: { ops }
      });
    }
    const plan = applied?.plan || file.plan;
    const hash = applied?.hash || file.hash;

    if (verdict.state === 'COMPLETED') {
      this.#save(taskId, { state: 'COMPLETED', revision: plan.revision, hash, dispatchCommandId: null, dispatchStepId: null });
      return this.#result(taskId, 'PLAN_COMPLETED', 'План завершён и подтверждён.', { revision: plan.revision });
    }

    if (verdict.state === 'REPLAN' && (revision.ops.length || completed.length)) {
      // A validated replan is the sanctioned way to change the same file; after it
      // the cycle continues with the new first step, not with a new plan.
      const step = nextOpenStep(plan);
      if (step) return this.#hop({ taskId, plan, hash, step, budget: { ...budget, noProgress: 0 }, deferDispatch });
    }

    if (verdict.state !== 'CONTINUE' && verdict.state !== 'REPLAN') {
      // REPLAN (FP-04), BLOCKED, NEED_INPUT, NO_PROGRESS and malformed data all
      // stop for the operator: no silent extra cycle. What the turn did finish is
      // already written down above.
      this.#save(taskId, { state: 'PAUSED_REVIEW', revision: plan.revision, hash, dispatchCommandId: null, dispatchStepId: null });
      return this.#result(taskId, 'PLAN_BLOCKED', verdict.reasons.join('; ') || `Пауза по решению ${verdict.decision}.`, {
        decision: verdict.decision,
        rejectedProposals: revision.rejected
      });
    }

    // CONTINUE here means "the turn is validated and the plan still has work or a
    // completion claim to ask for". Progress is measurable only as finished steps.
    const noProgress = completed.length ? 0 : Number(budget.noProgress || 0) + 1;
    if (noProgress >= this.limits.noProgressLimit) {
      this.#save(taskId, {
        state: 'PAUSED', revision: plan.revision, hash,
        dispatchCommandId: null, dispatchStepId: null, budget: { ...budget, noProgress }
      });
      return this.#result(taskId, 'PLAN_BUDGET_EXCEEDED', `Нет измеримого прогресса ${noProgress} цикла подряд — пауза.`);
    }

    const step = nextOpenStep(plan);
    if (!step) {
      // Every step is DONE but the model did not say COMPLETE: ask once, do not
      // assume completion from the absence of work.
      if (Number(budget.audits || 0) < this.limits.auditTurnsPerCycle) {
        return this.#hop({
          taskId, plan, hash,
          step: { id: binding.dispatchStepId }, audit: true,
          budget: { ...budget, noProgress }, deferDispatch
        });
      }
      this.#save(taskId, { state: 'PAUSED_REVIEW', revision: plan.revision, hash });
      return this.#result(taskId, 'PLAN_BLOCKED', 'Все шаги закрыты, но COMPLETE не подтверждён.');
    }
    return this.#hop({ taskId, plan, hash, step, budget: { ...budget, noProgress }, deferDispatch });
  }

  /** Pause at the next safe boundary — the running turn is not killed. */
  pause({ taskId }) {
    const binding = this.#requireBinding(taskId);
    if (binding.state !== 'RUNNING_STEP' && binding.state !== 'REVIEWING') {
      return this.#result(taskId, 'IGNORED', 'Пауза не требуется: цикл не выполняется.');
    }
    this.#save(taskId, { state: 'PAUSED', dispatchCommandId: null, dispatchStepId: null });
    return this.#result(taskId, 'PAUSED', 'Следующий шаг не будет отправлен.');
  }

  /**
   * STOP: the epoch is bumped before anything is awaited, so a checkpoint that
   * arrives afterwards is recognisable as stale even across a restart.
   */
  async stop({ taskId }) {
    const binding = this.#requireBinding(taskId);
    const epoch = this.store.bumpPlanCancelEpoch(taskId);
    const commandId = binding.dispatchCommandId;
    this.#save(taskId, { state: 'PAUSED_REVIEW', dispatchCommandId: null, dispatchStepId: null });
    if (commandId) await this.cancel({ taskId, commandId }).catch(() => {});
    return this.#result(taskId, 'PAUSED_REVIEW', 'Цикл отменён, нужен разбор результата.', { epoch });
  }

  /** Operator continues after STOP or a pause: a new cycle, a new epoch-stamped id. */
  async resume({ taskId }) {
    const binding = this.#requireBinding(taskId);
    if (binding.state === 'COMPLETED') return this.#result(taskId, 'PLAN_COMPLETED', 'План уже завершён.');
    if (binding.state === 'RUNNING_STEP' || binding.state === 'REVIEWING') {
      return this.#result(taskId, 'PLAN_BUSY', 'Цикл уже выполняется.');
    }
    const file = await this.plans.read(binding.path);
    return this.#openCycle({ taskId, plan: file.plan, hash: file.hash, reason: 'resume' });
  }

  /**
   * Startup check. A dispatched command with no recorded settle means the turn's
   * external effects are unknown; re-sending it could repeat them.
   */
  recover({ taskId }) {
    const binding = this.#requireBinding(taskId);
    if (binding.state === 'RUNNING_STEP') {
      this.#save(taskId, { state: 'PAUSED_REVIEW' });
      return this.#result(taskId, 'PLAN_UNKNOWN_OUTCOME', 'Ход был отправлен до перезапуска; результат неизвестен, нужен разбор.', { commandId: binding.dispatchCommandId });
    }
    if (binding.state === 'REVIEWING') {
      this.#save(taskId, { state: 'PAUSED_REVIEW' });
      return this.#result(taskId, 'PLAN_UNKNOWN_OUTCOME', 'Ход завершился до перезапуска без записи вердикта.', {});
    }
    return this.#result(taskId, 'IGNORED', `Состояние ${binding.state} не требует восстановления.`);
  }

  status({ taskId }) {
    const binding = this.#binding(taskId);
    if (!binding) return this.#result(taskId, 'PLAN_NOT_ATTACHED', 'План не подключён.');
    return this.#result(taskId, 'OK', `Состояние ${binding.state}.`, {
      state: binding.state, planId: binding.planId, path: binding.path,
      revision: binding.revision, cycleId: binding.cycleId, stepId: binding.dispatchStepId
    });
  }

  #requireBinding(taskId) {
    const binding = this.#binding(taskId);
    if (!binding || !binding.path) {
      throw Object.assign(new Error('План не подключён к этой задаче.'), { code: 'PLAN_NOT_ATTACHED' });
    }
    return clone(binding);
  }

  #result(taskId, code, message, extra = {}) {
    return { taskId, code, message, ...extra };
  }
}
