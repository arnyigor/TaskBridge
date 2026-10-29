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

import { decideCheckpoint, auditInstruction, repairableProblems } from './plan-checkpoint.mjs';
import { planHash } from './plan-file.mjs';
import { planRevision } from './plan-revision.mjs';

export const FOLLOWER_STATES = Object.freeze(['IDLE', 'RUNNING_STEP', 'REVIEWING', 'PAUSED_REVIEW', 'PAUSED', 'COMPLETED']);
export const DEFAULT_LIMITS = Object.freeze({
  // Confirmed plans may run for months. Optional explicit caps remain supported.
  maxCycles: null,
  noProgressLimit: 3,
  auditTurnsPerCycle: 1,
  budgetMs: null
});

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * FP-FIX-05: у checkpoint есть видимый исход. `CHECKPOINT_RECEIVED` — получен и
 * ещё не применён, `CHECKPOINT_APPLIED` — записан в файл, `CHECKPOINT_REJECTED` —
 * не применён с названной причиной. Раньше все три случая выглядели одинаково:
 * событие «Checkpoint: CONTINUE» и тишина.
 */
export const CHECKPOINT_OUTCOMES = Object.freeze(['RECEIVED', 'APPLIED', 'REJECTED']);

export const CHECKPOINT_REASONS = Object.freeze({
  STATE_INACTIVE: 'цикл не активен: состояние не допускает применения',
  FOREIGN_COMMAND: 'подтверждение относится к другой команде',
  REVISION_CONFLICT: 'файл плана изменён во время цикла',
  INVALID_CHECKPOINT: 'checkpoint не прошёл проверку',
  NO_CHECKPOINT: 'ход завершился без checkpoint',
  APPROVAL_REQUIRED: 'нужно подтверждение оператора',
  APPLY_FAILED: 'запись в файл плана не удалась',
  NOTHING_TO_APPLY: 'подтверждённых изменений нет',
  NOT_APPLIED: 'запрошенные шаги в файле не закрыты',
  DETACHED: 'план отключён'
});

/** Стабильный идентификатор checkpoint: без часов, чтобы дубликат был узнаваем. */
export const checkpointIdentity = (binding, checkpoint) => checkpoint
  ? `cp-${planHash(JSON.stringify([
      binding?.cycleId || '',
      binding?.dispatchStepId || '',
      String(checkpoint.decision || ''),
      Array.isArray(checkpoint.completedStepIds) ? checkpoint.completedStepIds : [],
      Array.isArray(checkpoint.findings) ? checkpoint.findings.length : 0
    ])).slice(0, 12)}`
  : null;


/**
 * `[SYSTEM_VERIFIED] …` / `[MODEL_REPORTED] …` — the strongest level among the
 * confirmed items, so the file itself records how the result was established.
 */
export function resultForStep(items = []) {
  if (!items.length) return '[MODEL_REPORTED] подтверждено checkpoint';
  const rank = { SYSTEM_VERIFIED: 0, MANUAL_ACCEPTED: 1, MODEL_REPORTED: 2 };
  const level = items
    .map(item => String(item.level || 'MODEL_REPORTED'))
    .sort((a, b) => (rank[a] ?? 9) - (rank[b] ?? 9))[0];
  const text = items.map(item => item.summary).filter(Boolean).join('; ');
  return `[${level}] ${text || 'подтверждено checkpoint'}`;
}

/**
 * The next step is the FIRST open step in file order (FP-PILOT-02A).
 *
 * Priority is not an ordering key: a P1 item no longer jumps ahead of earlier
 * mandatory P2 items, which is what made the pilot run the final regression
 * before its prerequisites. A blocking P1 that the controller inserts gets its
 * turn because the insertion places it BEFORE the step it blocks — the file
 * order then says everything. BLOCKED is returned, never skipped: a blocked step
 * is not bypassed just because something further down looks easier.
 */
export function nextOpenStep(plan) {
  const open = plan.steps
    .filter(step => step.status === 'TODO' || step.status === 'IN_PROGRESS' || step.status === 'BLOCKED');
  return open[0] || null;
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
    // Живой прогон 2026-10-29 (c-30): после steering в контексте лежал прошлый
    // ход, и checkpoint ушёл с revision 14 при файле 15 — отказ был верным, но
    // работа хода потерялась. Значения надо брать из этого сообщения.
    `Значения planId, revision и cycleId в taskbridge_plan_checkpoint бери из ЭТОГО сообщения: в контексте могут лежать прошлые ходы с другими значениями.`,
    `Текущий шаг: ${stepId}. Не отмечай его выполненным без критериев проверки.`,
    'Если найден относящийся к делу дефект, которого нет в плане, зарегистрируй finding с доказательством и предложи минимальный шаг с приоритетом P0/P1/P2.',
    'Незавершённый шаг, уже присутствующий в плане, не является новой находкой: выполни его, а не создавай новый. Если ошибка отдельная — укажи в finding.relatedStepIds, какие шаги она затрагивает и почему они её не покрывают.',
    // Живой прогон 2026-10-29 (S-015): шаг требовал четырёх осей, три прошли,
    // четвёртая невоспроизводима в фикстуре. Модель ответила только BLOCKED
    // без находки и без шага — писать было нечего, файл не менялся, и каждый
    // следующий «Продолжить» отправлял тот же шаг. Теперь этот случай назван.
    `Если шаг нельзя выполнить в текущей среде (нет хука, фикстуры, API или ресурса), одного BLOCKED недостаточно: зарегистрируй finding P1 о том, чего именно не хватает и почему без этого шаг не закрывается (это находка о среде, а не повтор шага), и предложи add_step с criteria, verification и before: ${stepId}.`,
    'BLOCKED без находки и без предложенного шага оставляет план на том же шаге, поэтому возвращайся к нему, только если действительно нужен ответ человека.',
    'Не создавай второй план, не меняй цель и не расширяй объём работ.',
    // Живой прогон 2026-10-26: агент вызвал edit для PLAN.md, хэш файла разошёлся
    // с ожидаемым — следующий settle получил REVISION_CONFLICT и план встал на разбор.
    `Файл плана \`${path}\` принадлежит контроллеру: не редактируй и не переписывай его — `
      + 'статусы шагов, находки и изменения плана передаются только через taskbridge_plan_checkpoint; '
      + 'правка файла напрямую останавливает цикл.',
    'В evidence поле ref — это toolCallId того вызова инструмента в этом ходу, который дал результат: без него подтверждение не принимается.',
    'Если у шага нет способа проверки (в плане написано «способ проверки не задан»), допустимо kind=manual с описанием, что именно сверено: требовать ссылку не с чего.',
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
    // Атрибуция записи: чья именно правка сделана этим settle (FP-FIX-01/05).
    this.lastApply = null;
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

  #stillOpenable(taskId, before, epoch) {
    const current = this.#binding(taskId);
    return current && this.store.planCancelEpoch(taskId) === epoch
      && current.path === before.path && current.planId === before.planId
      && current.state === before.state && current.cycleId === before.cycleId && current.revision === before.revision
      && current.hash === before.hash && current.dispatchCommandId === before.dispatchCommandId;
  }

  /** Start (or resume) the first turn. The operator action is the only entry point. */
  async start({ taskId, commandId }) {
    const binding = this.#requireBinding(taskId);
    if (binding.state === 'COMPLETED') return this.#result(taskId, 'PLAN_COMPLETED', 'План уже завершён.');
    if (binding.state === 'RUNNING_STEP' || binding.state === 'REVIEWING') {
      return this.#result(taskId, 'PLAN_BUSY', 'Цикл уже выполняется: один активный цикл на задачу.');
    }
    const epoch = this.store.planCancelEpoch(taskId);
    const file = await this.plans.read(binding.path);
    if (!this.#stillOpenable(taskId, binding, epoch)) return this.#result(taskId, 'IGNORED', 'Состояние изменилось во время чтения плана.');
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
    if (Number.isFinite(this.limits.budgetMs) && this.now() - startedAt > this.limits.budgetMs) {
      this.#save(taskId, { state: 'PAUSED', budget: { ...budget, startedAt } });
      return this.#result(taskId, 'PLAN_BUDGET_EXCEEDED', 'Бюджет времени Follow Plan исчерпан.');
    }
    if (Number.isFinite(this.limits.maxCycles) && Number(budget.cycles || 0) - Number(budget.cycleBase || 0) >= this.limits.maxCycles) {
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
  #prepareDispatch({ taskId, plan, hash, step, audit = false, budget, normalization = null, correctionProblems = [] }) {
    const binding = this.#requireBinding(taskId);
    const epoch = this.store.planCancelEpoch(taskId);
    const cycleId = audit ? (binding.cycleId || 'c-1') : `c-${Number(budget?.cycles || 0) + 1}`;
    const commandId = stepCommandId({ taskId, cycleId, stepId: step.id, epoch, audit });
    const nextBudget = {
      ...budget,
      cycles: audit ? Number(budget?.cycles || 0) : Number(budget?.cycles || 0) + 1,
      audits: audit ? Number(budget?.audits || 0) + 1 : 0,
      pauseReason: null
    };
    const message = audit && !step.id
      ? auditInstruction({ path: binding.path, planId: plan.planId, revision: plan.revision, cycleId, correctionProblems })
      : audit
      ? auditInstruction({ path: binding.path, planId: plan.planId, revision: plan.revision, cycleId, stepId: step.id, correctionProblems })
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
      budget: nextBudget,
      // Automatic normalisations are reported, never hidden (FP-PILOT-02B).
      normalization
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
      if (Number.isFinite(this.limits.maxCycles) && Number(budget.cycles || 0) - Number(budget.cycleBase || 0) > this.limits.maxCycles) {
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
      commandId: pending.commandId, stepId: pending.stepId, cycleId: pending.cycleId,
      ...(pending.normalization ? { normalization: pending.normalization } : {})
    });
  }

  async #dispatchStep({ taskId, plan, hash, step, audit = false, budget, normalization: input_normalization = null, correctionProblems = [] }) {
    const binding = this.#requireBinding(taskId);
    // The budget is checked at every dispatch, not only when a cycle is opened:
    // long cycles must stop at the limit too.
    if (!audit) {
      if (Number.isFinite(this.limits.maxCycles) && Number(budget?.cycles || 0) - Number(budget?.cycleBase || 0) >= this.limits.maxCycles) {
        this.#save(taskId, { state: 'PAUSED', dispatchCommandId: null, dispatchStepId: null, budget });
        return this.#result(taskId, 'PLAN_BUDGET_EXCEEDED', `Достигнут предел ${this.limits.maxCycles} автоматических циклов.`);
      }
      if (Number.isFinite(this.limits.budgetMs) && budget?.startedAt && this.now() - budget.startedAt > this.limits.budgetMs) {
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
        audits: audit ? Number(budget?.audits || 0) + 1 : 0,
        pauseReason: null
      }
    });
    const message = audit
      ? auditInstruction({ path: binding.path, planId: plan.planId, revision: plan.revision, cycleId, stepId: step.id, correctionProblems })
      : stepInstruction({ path: binding.path, planId: plan.planId, revision: plan.revision, cycleId, stepId: step.id });
    await this.dispatch({ taskId, commandId, message, stepId: step.id });
    return this.#result(taskId, 'DISPATCHED', audit ? 'Отправлен контрольный ход.' : `Отправлен шаг ${step.id}.`, {
      commandId, stepId: step.id, cycleId,
      // Automatic normalisations travel with the dispatch, never silently.
      ...(input_normalization ? { normalization: input_normalization } : {})
    });
  }

  /**
   * Called after Pi settled for this task. `checkpoint` is the parsed tool
   * argument or null when the turn ended without one.
   */
  /**
   * FP-FIX-05: обёртка вокруг ядра settle. Исход применения checkpoint считается
   * здесь по фактической ревизии файла (изменилась — APPLIED, нет — RECEIVED или
   * REJECTED с причиной), поэтому клиенту не нужно угадывать по коду ответа, был
   * ли шаг действительно записан. Ядро ниже не меняет своего поведения.
   */
  async onSettled(input) {
    const bindingBefore = this.store.getPlanBinding(input.taskId);
    const before = await this.#planSnapshot(input.taskId);
    const result = await this.#onSettledCore(input);
    const after = await this.#planSnapshot(input.taskId);
    const binding = this.store.getPlanBinding(input.taskId) || bindingBefore;
    const checkpoint = input.checkpoint || null;

    // Применение доказывается НЕ изменением ревизии: файл может уйти вперёд из-за
    // finding или чужой записи, а закрытые шаги останутся прежними. Считаем ровно
    // то, что стало по-другому в самом файле — но только по собственной записи:
    // снимок «до/после» не отличает нашу запись от чужой, атрибуция нужна честная.
    const own = this.lastApply && this.lastApply.taskId === input.taskId ? this.lastApply : null;
    this.lastApply = null;
    const appliedStepIds = own ? own.stepIds : [];
    const appliedFindingIds = own ? own.findingIds : [];
    const externalRevisionChange = !own && before?.revision != null && after?.revision != null
      && after.revision !== before.revision;
    const requested = Array.isArray(checkpoint?.completedStepIds) ? checkpoint.completedStepIds.map(String) : [];
    // Если применения не было, а завершение запрашивалось — назвать причину отказа
    // проверки (planId/revision/cycleId/evidence), а не молчать: именно этот случай
    // на живом прогоне выглядел как «checkpoint принят».
    let validationProblems = [];
    if (!own && requested.length && after) {
      try {
        const file = await this.plans.read(binding.path);
        const verdict = decideCheckpoint({
          plan: file.plan,
          checkpoint,
          cycle: { cycleId: binding.cycleId, revision: file.plan.revision }
        });
        validationProblems = verdict.inspection.problems || [];
      } catch { /* диагностика не должна ломать settle */ }
    }
    const confirmedStepIds = requested.filter(stepId => appliedStepIds.includes(stepId));
    // PLAN_BLOCKED здесь не «отказ проверки», а решение модели: пауза для оператора.
    // Отказом оно считается только тогда, когда отклонены предложенные правки плана.
    const rejectedCodes = new Set([
      'IGNORED', 'PLAN_REVISION_CONFLICT', 'PLAN_CHECKPOINT_REJECTED', 'PLAN_UNKNOWN_OUTCOME',
      'PLAN_BUDGET_EXCEEDED', 'PLAN_NO_PROGRESS', 'PLAN_CONFLICT', 'PLAN_WRITE_FAILED'
    ]);
    const refusedProposals = Array.isArray(result.rejectedProposals) && result.rejectedProposals.length > 0;
    const changed = Boolean(own);
    const outcome = (result.outcome && result.outcome !== 'RECEIVED')
      ? result.outcome
      : changed ? 'APPLIED' : (rejectedCodes.has(result.code) || refusedProposals) ? 'REJECTED' : 'RECEIVED';
    const unconfirmed = requested.filter(stepId => !confirmedStepIds.includes(stepId));
    const reasonCode = result.reasonCode || (outcome === 'REJECTED'
      ? (result.code === 'IGNORED' ? 'STATE_INACTIVE' : result.code)
      : outcome === 'RECEIVED' ? 'NOTHING_TO_APPLY' : null);
    return {
      ...result,
      ...this.#outcome(binding, checkpoint, outcome, reasonCode, {
        planRevision: after?.revision ?? result.planRevision ?? null,
        revisionBefore: before?.revision ?? null,
        revisionAfter: after?.revision ?? null,
        ...(externalRevisionChange ? { externalRevisionChange: true } : {}),
        appliedStepIds,
        appliedFindingIds,
        confirmedStepIds,
        // APPLIED — про запись файла вообще; состоялось ли завершение шага, отвечает
        // этот флаг (FP-FIX-05/FP-FIX-01: ревизия этого не доказывает).
        completionApplied: requested.length > 0 && confirmedStepIds.length === requested.length,
        // Запрошенные, но не закрытые шаги: именно этот случай на живом прогоне
        // выглядел как «checkpoint применён».
        ...(unconfirmed.length
          ? {
            unconfirmedStepIds: unconfirmed,
            problems: [
              ...validationProblems,
              ...(validationProblems.length ? [] : [`не применены: ${unconfirmed.join(', ')}`])
            ]
          }
          : {})
      })
    };
  }

  /** Что в файле плана сейчас: ревизия, закрытые шаги и находки. */
  async #planSnapshot(taskId) {
    const binding = this.store.getPlanBinding(taskId);
    if (!binding?.path) return null;
    try {
      const file = await this.plans.read(binding.path);
      return {
        revision: file.plan.revision,
        doneSteps: new Set(file.plan.steps.filter(step => step.status === 'DONE' || step.status === 'SKIPPED').map(step => step.id)),
        doneFindings: new Set(file.plan.findings.filter(finding => finding.state === 'DONE').map(finding => finding.id)),
        findingIds: new Set(file.plan.findings.map(finding => finding.id))
      };
    } catch {
      return null;
    }
  }

  async #onSettledCore({ taskId, commandId, checkpoint, seq = null, deferDispatch = false }) {
    const binding = this.#requireBinding(taskId);
    if (binding.state === 'IDLE' || binding.state === 'PAUSED_REVIEW' || binding.state === 'PAUSED' || binding.state === 'COMPLETED') {
      // Не молчание: применение отклонено, и причина названа вместе с состоянием.
      return this.#result(taskId, 'IGNORED', `Ход завершился вне активного цикла (${binding.state}).`,
        this.#outcome(binding, checkpoint, 'REJECTED', 'STATE_INACTIVE', { state: binding.state }));
    }
    if (commandId && binding.dispatchCommandId && commandId !== binding.dispatchCommandId) {
      // A late ACK from an earlier command must not move the current cycle.
      return this.#result(taskId, 'IGNORED', 'Подтверждение относится к другой команде.',
        this.#outcome(binding, checkpoint, 'REJECTED', 'FOREIGN_COMMAND', { dispatchCommandId: binding.dispatchCommandId || null }));
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
      return this.#result(taskId, 'PLAN_UNKNOWN_OUTCOME', 'Checkpoint не получен и после контрольного хода — пауза.',
        this.#outcome(binding, null, 'REJECTED', 'NO_CHECKPOINT'));
    }

    const file = await this.plans.read(binding.path);
    if (file.hash !== binding.expectedHash || file.plan.revision !== binding.expectedRevision) {
      this.#save(taskId, { state: 'PAUSED_REVIEW', dispatchCommandId: null, dispatchStepId: null });
      return this.#result(taskId, 'PLAN_REVISION_CONFLICT', 'Файл плана изменён во время цикла: нужно согласование, а не перезапись.',
        this.#outcome(binding, checkpoint, 'REJECTED', 'REVISION_CONFLICT', { planRevision: file.plan.revision }));
    }

    const verdict = decideCheckpoint({ plan: file.plan, checkpoint, cycle: { cycleId: binding.cycleId, revision: file.plan.revision } });
    // Only a checkpoint that passed inspection may change the file. A claim that
    // failed validation leaves the plan exactly as a human left it.
    const valid = verdict.inspection.problems.length === 0;
    const completed = valid ? verdict.inspection.completedSteps : [];

    // Ошибка в поле отчёта — это исправимые данные, а не отказ модели: один
    // контрольный ход на цикл просит исправить именно перечисленные поля.
    // Придумка о чужом/старом прогоне и чужой цикл сюда не входят (см.
    // repairableProblems): там решение за оператором, а не повторный вопрос.
    if (repairableProblems(verdict.inspection.problems) && Number(budget.audits || 0) < this.limits.auditTurnsPerCycle) {
      return this.#hop({ taskId, plan: file.plan, hash: file.hash,
        step: { id: binding.dispatchStepId }, audit: true, budget, deferDispatch,
        correctionProblems: verdict.inspection.problems });
    }

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
      return this.#result(taskId, 'PLAN_BLOCKED', `Нужно подтверждение: ${revision.requiresApproval.map(item => item.summary || item.stepId).join('; ')}`,
        this.#outcome(binding, checkpoint, 'REJECTED', 'APPROVAL_REQUIRED', {
          requiresApproval: revision.requiresApproval, proposals: revision.ops
        }));
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
      // Что записала ИМЕННО эта операция: по этому признаку обёртка onSettled
      // отличает своё применение от чужой записи в файл (FP-FIX-01/05).
      this.lastApply = {
        taskId,
        revision: applied.plan.revision,
        stepIds: completed,
        findingIds: ops
          .filter(op => op.op === 'add_finding' || (op.op === 'set_finding_state' && op.state === 'DONE'))
          .map(op => op.findingId)
      };
    }
    const plan = applied?.plan || file.plan;
    const hash = applied?.hash || file.hash;
    // Record our own successful CAS before any budget/dispatch guard can pause.
    // Otherwise the new file is misreported as an external revision conflict.
    if (applied) this.#save(taskId, { revision: plan.revision, hash });

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

    if (verdict.state === 'REPLAN_UNRESOLVED') {
      // The model asked for a replan but sent no operations. Priority is not an
      // ordering key any more, so «REPLAN» with an open step usually means «my
      // order was wrong» — and the file order is already right. Two cases:
      //   1. nothing new was found and the plan has the next step → continue;
      //   2. the controller formed valid edits from the findings → apply them.
      // A change the model wants but did not express cannot be guessed: with an
      // open step the file order stands, with none the operator decides.
      const findings = verdict.inspection.findings.length;
      const normalized = findings === 0 || revision.ops.length > 0;
      if (normalized) {
        const step = nextOpenStep(plan);
        if (step) {
          return this.#hop({
            taskId, plan, hash, step, budget: { ...budget, noProgress: 0 }, deferDispatch,
            normalization: findings === 0
              ? 'REPLAN без изменений: план уже содержит нужный шаг — продолжаем по файлу'
              : 'REPLAN: изменения сформированы контроллером из находок'
          });
        }
      }
      // Nothing to run and nothing to change: the operator decides. The model
      // cannot answer "REPLAN" into an empty queue a second time (FP-PILOT-02B).
      this.#save(taskId, { state: 'PAUSED_REVIEW', revision: plan.revision, hash, dispatchCommandId: null, dispatchStepId: null });
      return this.#result(taskId, 'PLAN_BLOCKED', 'REPLAN без изменений, а открытых шагов нет — нужен разбор.', { decision: verdict.decision });
    }

    if (!valid) {
      // Проверка чекпоинта не пройдена — это не «модель сказала BLOCKED», а отказ
      // валидации: оператору нужен отдельный код, иначе причину не отличить.
      this.#save(taskId, { state: 'PAUSED_REVIEW', revision: plan.revision, hash, dispatchCommandId: null, dispatchStepId: null });
      return this.#result(taskId, 'PLAN_CHECKPOINT_REJECTED',
        verdict.reasons.join('; ') || 'Проверка чекпоинта не пройдена: шаг не закрыт.',
        { decision: verdict.decision, problems: verdict.reasons });
    }

    if (verdict.state !== 'CONTINUE' && verdict.state !== 'REPLAN') {
      // REPLAN (FP-04), BLOCKED, NEED_INPUT, NO_PROGRESS and malformed data all
      // stop for the operator: no silent extra cycle. What the turn did finish is
      // already written down above.
      // Отклонённое предложение — тоже причина паузы: без неё «BLOCKED» выглядел
      // как тупик на недостижимом шаге, а ответ (что именно не принято в
      // правке плана) не видел ни оператор, ни следующий ход.
      const rejectedNote = revision.rejected.length
        ? ` Предложения не применены: ${[...new Set(revision.rejected.map(item => item.reason))].join('; ')}.`
        : '';
      // Ход ничего не записал — шаг остаётся первым открытым, и режим из этого
      // сам не выйдет. Живой прогон 2026-10-29: четыре «Продолжить» подряд
      // отправляли один и тот же S-015, а карточка молчала.
      const stuckNote = !applied && !completed.length
        ? ` В файл ничего не записано: текущий шаг остаётся тем же — нужен шаг-разблокировка (finding P1 + add_step) или правка плана.`
        : '';
      this.#save(taskId, { state: 'PAUSED_REVIEW', revision: plan.revision, hash, dispatchCommandId: null, dispatchStepId: null });
      return this.#result(taskId, 'PLAN_BLOCKED', `${verdict.reasons.join('; ') || `Пауза по решению ${verdict.decision}.`}${rejectedNote}${stuckNote}`, {
        decision: verdict.decision,
        rejectedProposals: revision.rejected,
        ...(rejectedNote || stuckNote ? { problems: [rejectedNote, stuckNote].filter(Boolean).map(item => item.trim()) } : {})
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
      return this.#result(taskId, 'PLAN_NO_PROGRESS', `Нет измеримого прогресса ${noProgress} цикла подряд — пауза.`);
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
  async resume({ taskId, renewTimeBudget = false, renewBudget = false }) {
    const binding = this.#requireBinding(taskId);
    if (binding.state === 'COMPLETED') return this.#result(taskId, 'PLAN_COMPLETED', 'План уже завершён.');
    if (binding.state === 'RUNNING_STEP' || binding.state === 'REVIEWING') {
      return this.#result(taskId, 'PLAN_BUSY', 'Цикл уже выполняется.');
    }
    const epoch = this.store.planCancelEpoch(taskId);
    const file = await this.plans.read(binding.path);
    if (!this.#stillOpenable(taskId, binding, epoch)) return this.#result(taskId, 'IGNORED', 'Состояние изменилось во время чтения плана.');
    // Only an explicit operator confirmation grants more wall-clock time.
    // Preserve cycle/no-progress counters and command identities: this must not
    // turn resume into a way around the automatic-loop safeguards.
    if ((renewTimeBudget || renewBudget) && binding.state === 'PAUSED') {
      this.#save(taskId, { budget: {
        ...(binding.budget || {}), startedAt: this.now(),
        ...(renewBudget ? { cycleBase: Number(binding.budget?.cycles || 0) } : {})
      } });
    }
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
    if (code === 'PLAN_BUDGET_EXCEEDED' || code === 'PLAN_NO_PROGRESS' || code === 'PLAN_CHECKPOINT_REJECTED') {
      const binding = this.#binding(taskId);
      this.#save(taskId, { budget: { ...(binding?.budget || {}), pauseReason: { code, message } } });
    }
    return { taskId, code, message, ...extra };
  }

  /**
   * Поля исхода checkpoint, которые уходят и клиенту, и в событие: без них
   * «принят» и «применён» неразличимы (FP-FIX-05).
   */
  #outcome(binding, checkpoint, outcome, reasonCode, extra = {}) {
    return {
      outcome,
      reasonCode: reasonCode || null,
      checkpointId: checkpointIdentity(binding, checkpoint),
      cycleId: binding?.cycleId || null,
      stepId: binding?.dispatchStepId || null,
      planRevision: extra.planRevision ?? binding?.expectedRevision ?? null,
      ...extra
    };
  }
}
