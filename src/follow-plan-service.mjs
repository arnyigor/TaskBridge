// Follow Plan service (PLAN-FOLLOW-01, FP-05A): the only place where the
// controller touches the running TaskBridge.
//
// It is a thin adapter, on purpose:
//   * steps are executed by TaskManager's existing message path (command ledger,
//     queue, provider wait, STOP) — there is no second runner and no own retry;
//   * the plan file is read and written through plan-file.mjs (CAS on revision +
//     hash), and nothing else about the plan lives in SQLite;
//   * the controller decides with plan-follower.mjs after a turn SETTLED, and the
//     task event log carries the progress to every client;
//   * evidence is checked against the run ledger, so "test passed" cannot point at
//     a run that never happened or belonged to another session.
//
// Turning the mode off (followPlan.enabled) leaves every route readable but makes
// the mutating ones refuse: nothing silently starts generating.

import { readPlan, updatePlan, PlanError, DEFAULT_MAX_BYTES } from './application/plan-file.mjs';
import { PlanFollower } from './application/plan-follower.mjs';

export const FOLLOW_PLAN_EVENTS = Object.freeze([
  'PLAN_ATTACHED', 'PLAN_STEP_STARTED', 'PLAN_STEP_CHECKPOINT', 'PLAN_REVISED',
  'PLAN_PAUSED', 'PLAN_COMPLETED', 'PLAN_CONFLICT'
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CLIENT = 'follow-plan';

const notFound = () => Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
const reject = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export class FollowPlanService {
  constructor({ manager, store, config = {}, now = () => Date.now() }) {
    Object.assign(this, { manager, store, config, now });
    // Last checkpoint per task, for the card: it is a fact of THIS process (the
    // durable part is the file and the binding), so it is not persisted twice.
    this.checkpoints = new Map();
    this.limits = config.followPlan?.limits || {};
  }

  get enabled() {
    return this.config.followPlan?.enabled === true;
  }

  #assertEnabled() {
    if (!this.enabled) throw reject('FOLLOW_PLAN_DISABLED', 'Режим «По плану» выключен (followPlan.enabled=false).');
  }

  #task(taskId) {
    const task = this.manager.getTask(String(taskId));
    if (!task) throw notFound();
    return task;
  }

  #relativePath(task, value) {
    const relPath = String(value || '').trim();
    if (!relPath) throw reject('PLAN_INVALID', 'Не указан путь к файлу плана.');
    if (relPath.includes('\0') || /^[a-zA-Z]:[\\/]/.test(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
      throw reject('PLAN_INVALID', 'Путь плана должен быть относительным путём внутри проекта.');
    }
    return relPath;
  }

  /** The plan file, scoped to this task's workspace. */
  #plans(task) {
    const root = task.workspacePath;
    if (!root) throw reject('SESSION_UNAVAILABLE', 'Рабочий каталог сессии ещё не создан: сначала запустите задачу.');
    return {
      read: relPath => readPlan({ root, relPath, maxBytes: this.config.followPlan?.maxBytes || DEFAULT_MAX_BYTES }),
      update: input => updatePlan({ root, ...input })
    };
  }

  #follower(task) {
    // Lazily bound: recover()/pause()/stop() must work even before a workspace
    // exists, and only reading/writing the file needs one.
    const plans = {
      read: relPath => this.#plans(task).read(relPath),
      // The follower names the plan `path`; the file layer calls it `relPath`.
      update: ({ path: relPath, ...rest }) => this.#plans(task).update({ relPath, ...rest })
    };
    return new PlanFollower({
      store: this.store,
      plans,
      limits: this.limits,
      now: this.now,
      dispatch: async ({ taskId, commandId, message }) => {
        // The existing delivery path: command ledger, queue and STOP all apply.
        // The run id is named in the instruction so evidence can reference the run
        // that actually produced it instead of a made-up label.
        const runId = this.manager.getTask(taskId)?.runId || null;
        const text = runId ? `${message} Идентификатор текущего прогона для evidence.ref: ${runId}.` : message;
        const result = await this.manager.message(taskId, text, 'auto', [], null, { commandId, clientId: CONTROL_CLIENT });
        return { id: commandId, queued: Boolean(result?.pendingPrompts?.length) };
      },
      cancel: async ({ taskId, commandId }) => this.manager.cancel(taskId, { commandId: `${commandId}:stop`, hard: true })
    });
  }

  async #publish(taskId, type, message, data = {}) {
    await this.manager.publishFollowPlanEvent?.(taskId, type, message, data).catch(() => {});
  }

  // --- read ----------------------------------------------------------------

  async status(taskId) {
    const task = this.#task(taskId);
    const binding = this.store.getPlanBinding(task.id);
    const status = {
      enabled: this.enabled,
      taskId: task.id,
      attached: Boolean(binding?.path),
      state: binding?.state || 'NOT_ATTACHED',
      planId: binding?.planId || null,
      path: binding?.path || null,
      revision: binding?.revision ?? null,
      hash: binding?.hash || null,
      cycleId: binding?.cycleId || null,
      stepId: binding?.dispatchStepId || null,
      updatedAt: binding?.updatedAt || null,
      lastCheckpoint: this.checkpoints.get(task.id) || null,
      conflict: false,
      title: null,
      goal: null,
      progress: null,
      steps: [],
      findings: []
    };
    if (!binding?.path) return status;
    try {
      const file = await this.#plans(task).read(binding.path);
      const steps = file.plan.steps;
      status.revision = file.plan.revision;
      status.hash = file.hash;
      status.planId = file.plan.planId;
      status.title = file.plan.title;
      status.goal = file.plan.goal;
      status.progress = {
        done: steps.filter(step => step.status === 'DONE' || step.status === 'SKIPPED').length,
        total: steps.length
      };
      status.steps = steps.map(step => ({ id: step.id, status: step.status, priority: step.priority, title: step.title }));
      status.findings = file.plan.findings.map(finding => ({ id: finding.id, priority: finding.priority, state: finding.state, summary: finding.summary }));
      status.conflict = file.hash !== binding.hash || file.plan.revision !== binding.revision;
    } catch (error) {
      // A file that no longer parses must be visible in the card, not hidden
      // behind a 500: the operator has to see what to fix.
      status.fileError = { code: error.code || 'PLAN_INVALID', message: error.message, problems: error.problems || [] };
    }
    return status;
  }

  /** Apply the plan file exactly as it is on disk (the operator's version wins). */
  async #adopt(task, binding) {
    const file = await this.#plans(task).read(binding.path);
    this.store.savePlanBinding({
      ...binding,
      planId: file.plan.planId,
      revision: file.plan.revision,
      hash: file.hash,
      state: 'PAUSED',
      expectedRevision: file.plan.revision,
      expectedHash: file.hash,
      dispatchCommandId: null,
      dispatchStepId: null,
      updatedAt: new Date(this.now()).toISOString()
    });
    return { revision: file.plan.revision, hash: file.hash };
  }

  // --- control -------------------------------------------------------------

  async attach({ taskId, path, commandId, clientId }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const relPath = this.#relativePath(task, path);
    const follower = this.#follower(task);
    const attached = await follower.attach({ taskId: task.id, path: relPath });
    this.checkpoints.delete(task.id);
    await this.#publish(task.id, 'PLAN_ATTACHED', `План подключён: ${relPath}`, {
      path: relPath, planId: attached.plan.planId, revision: attached.plan.revision,
      steps: attached.plan.steps.length, commandId, clientId
    });
    return this.status(task.id);
  }

  async start({ taskId, expectedRevision, commandId, clientId }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const binding = this.store.getPlanBinding(task.id);
    if (!binding?.path) throw reject('PLAN_NOT_ATTACHED', 'План не подключён.');
    const file = await this.#plans(task).read(binding.path);
    if (expectedRevision != null && Number(expectedRevision) !== file.plan.revision) {
      await this.#publish(task.id, 'PLAN_CONFLICT', 'Ревизия плана изменилась', { expectedRevision, revision: file.plan.revision });
      throw reject('PLAN_REVISION_CONFLICT', `Ревизия плана ${file.plan.revision}, ожидалась ${expectedRevision}.`,
        { problems: [`expected ${expectedRevision}`, `actual ${file.plan.revision}`] });
    }
    const result = await this.#follower(task).start({ taskId: task.id, commandId });
    await this.#report(task.id, result, { commandId, clientId });
    return this.status(task.id);
  }

  async pause({ taskId, commandId, clientId }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const result = this.#follower(task).pause({ taskId: task.id });
    await this.#report(task.id, result, { commandId, clientId });
    return this.status(task.id);
  }

  async resume({ taskId, expectedRevision, commandId, clientId }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const binding = this.store.getPlanBinding(task.id);
    if (!binding?.path) throw reject('PLAN_NOT_ATTACHED', 'План не подключён.');
    if (expectedRevision != null) {
      const file = await this.#plans(task).read(binding.path);
      if (Number(expectedRevision) !== file.plan.revision) {
        throw reject('PLAN_REVISION_CONFLICT', `Ревизия плана ${file.plan.revision}, ожидалась ${expectedRevision}.`);
      }
    }
    const result = await this.#follower(task).resume({ taskId: task.id });
    await this.#report(task.id, result, { commandId, clientId });
    return this.status(task.id);
  }

  async stop({ taskId, commandId, clientId }) {
    // STOP stays available even with the flag off: an operator must always be
    // able to end a cycle that is already running.
    const task = this.#task(taskId);
    const result = await this.#follower(task).stop({ taskId: task.id });
    await this.#report(task.id, result, { commandId, clientId });
    return this.status(task.id);
  }

  /** A human edit through the API: same CAS rules as the follower's own writes. */
  async patch({ taskId, expectedRevision, expectedHash, changes, commandId, clientId }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const binding = this.store.getPlanBinding(task.id);
    if (!binding?.path) throw reject('PLAN_NOT_ATTACHED', 'План не подключён.');
    const updated = await this.#plans(task).update({
      relPath: binding.path, expectedRevision, expectedHash,
      changes: changes && Array.isArray(changes.ops) ? changes : { ops: Array.isArray(changes) ? changes : [] }
    });
    this.store.savePlanBinding({
      ...binding,
      revision: updated.plan.revision,
      hash: updated.hash,
      updatedAt: new Date(this.now()).toISOString()
    });
    await this.#publish(task.id, 'PLAN_REVISED', `План обновлён: revision ${updated.plan.revision}`, {
      revision: updated.plan.revision, hash: updated.hash, ops: (changes?.ops || changes || []).length, commandId, clientId
    });
    return this.status(task.id);
  }

  /**
   * Resolving an ambiguous state. `adopt_external` accepts the operator's file
   * (the only way a conflict is cleared without losing text); `dismiss` returns to
   * idle without touching the file.
   */
  async reconcile({ taskId, expectedRevision, action, commandId, clientId }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const binding = this.store.getPlanBinding(task.id);
    if (!binding?.path) throw reject('PLAN_NOT_ATTACHED', 'План не подключён.');
    if (action === 'adopt_external') {
      const adopted = await this.#adopt(task, binding);
      await this.#publish(task.id, 'PLAN_REVISED', `Принята версия файла: revision ${adopted.revision}`, { ...adopted, commandId, clientId });
      return this.status(task.id);
    }
    if (action === 'dismiss') {
      this.store.savePlanBinding({ ...binding, state: 'PAUSED', dispatchCommandId: null, dispatchStepId: null, updatedAt: new Date(this.now()).toISOString() });
      await this.#report(task.id, { code: 'PAUSED', message: 'Состояние разобрано оператором.' }, { commandId, clientId });
      return this.status(task.id);
    }
    throw reject('INPUT_INVALID', 'Неизвестное действие: ожидается adopt_external или dismiss.');
  }

  // --- the turn boundary ---------------------------------------------------

  /**
   * Called by TaskManager after `agent_settled` for a dispatched command. A
   * repeated settle of the same command is ignored by the follower (its command id
   * no longer matches), so an SSE reconnect or a duplicated frame cannot start
   * another cycle.
   */
  async turnSettled({ taskId, commandId = null, checkpoint = null, aborted = false, seq = null }) {
    const task = this.manager.getTask(String(taskId));
    if (!task) return { code: 'IGNORED', reason: 'task gone' };
    const binding = this.store.getPlanBinding(task.id);
    if (!binding?.path) return { code: 'IGNORED', reason: 'plan not attached' };
    if (binding.state !== 'RUNNING_STEP' && binding.state !== 'REVIEWING') {
      return { code: 'IGNORED', reason: `state ${binding.state}` };
    }
    if (aborted) {
      await this.#publish(task.id, 'PLAN_PAUSED', 'Ход отменён: разбор результата', { reason: 'aborted', commandId });
      return { code: 'IGNORED', reason: 'aborted turn' };
    }
    const checked = this.#checkEvidence({ taskId: task.id, checkpoint });
    if (checkpoint) {
      this.checkpoints.set(task.id, {
        at: new Date(this.now()).toISOString(), decision: checkpoint.decision || null,
        completed: Array.isArray(checkpoint.completedStepIds) ? checkpoint.completedStepIds : [],
        findings: Array.isArray(checkpoint.findings) ? checkpoint.findings.length : 0,
        evidence: Array.isArray(checkpoint.evidence) ? checkpoint.evidence.length : 0,
        rejectedEvidence: checked.problems
      });
      await this.#publish(task.id, 'PLAN_STEP_CHECKPOINT', `Checkpoint: ${checkpoint.decision || '—'}`, {
        decision: checkpoint.decision || null,
        completedStepIds: checkpoint.completedStepIds || [],
        findings: checkpoint.findings || [],
        evidence: checkpoint.evidence || [],
        evidenceProblems: checked.problems
      });
    }
    let result;
    try {
      result = await this.#follower(task).onSettled({
        taskId: task.id, commandId, checkpoint: checked.checkpoint, seq: seq ?? task._turn ?? null
      });
    } catch (error) {
      // A failure to read/write the plan must pause the plan, not the server.
      await this.#publish(task.id, 'PLAN_PAUSED', `Ошибка плана: ${error.message}`, { code: error.code || 'INTERNAL_ERROR' });
      this.store.savePlanBinding({ ...binding, state: 'PAUSED_REVIEW', dispatchCommandId: null, dispatchStepId: null, updatedAt: new Date(this.now()).toISOString() });
      return { code: error.code || 'INTERNAL_ERROR', message: error.message };
    }
    await this.#report(task.id, result, {});
    return result;
  }

  /**
   * Evidence refs that name a run must exist and belong to THIS session. A wrong
   * ref is stripped, so the checkpoint is refused for lack of proof instead of
   * being believed.
   */
  #checkEvidence({ taskId, checkpoint }) {
    if (!checkpoint || !Array.isArray(checkpoint.evidence)) return { checkpoint, problems: [] };
    const problems = [];
    const evidence = checkpoint.evidence.map(item => {
      const ref = String(item?.ref || '').trim();
      if (!ref) return item;
      if (String(item?.kind) === 'run' || UUID.test(ref)) {
        const run = this.store.getRun(ref);
        if (!run) { problems.push(`шаг ${item?.stepId}: run ${ref} не найден`); return { ...item, ref: '' }; }
        if (String(run.taskId) !== String(taskId)) {
          problems.push(`шаг ${item?.stepId}: run ${ref} принадлежит другой сессии`);
          return { ...item, ref: '' };
        }
      }
      return item;
    });
    return { checkpoint: { ...checkpoint, evidence }, problems };
  }

  // --- startup -------------------------------------------------------------

  /**
   * After a restart nothing is re-sent: a dispatched command whose outcome is
   * unknown goes to PAUSED_REVIEW, and the operator decides.
   */
  async recoverAll() {
    const results = [];
    for (const task of this.manager.listTasks() || []) {
      const binding = this.store.getPlanBinding(task.id);
      if (!binding?.path) continue;
      if (binding.state !== 'RUNNING_STEP' && binding.state !== 'REVIEWING') continue;
      try {
        const result = this.#follower(task).recover({ taskId: task.id });
        results.push(result);
        await this.#report(task.id, result, {});
      } catch (error) {
        results.push({ taskId: task.id, code: error.code || 'INTERNAL_ERROR', message: error.message });
      }
    }
    return results;
  }

  // --- reporting -----------------------------------------------------------

  /** Maps a follower result onto the task event log, so every client sees it once. */
  async #report(taskId, result, extra = {}) {
    const data = { code: result.code, ...extra };
    switch (result.code) {
      case 'DISPATCHED':
        await this.#publish(taskId, 'PLAN_STEP_STARTED', result.message, { ...data, stepId: result.stepId, cycleId: result.cycleId, commandId: result.commandId });
        return;
      case 'PLAN_COMPLETED':
        await this.#publish(taskId, 'PLAN_COMPLETED', result.message, data);
        return;
      case 'PLAN_REVISION_CONFLICT':
        await this.#publish(taskId, 'PLAN_CONFLICT', result.message, data);
        return;
      case 'PLAN_BLOCKED':
      case 'PLAN_UNKNOWN_OUTCOME':
      case 'PLAN_BUDGET_EXCEEDED':
        await this.#publish(taskId, 'PLAN_PAUSED', result.message, data);
        return;
      case 'PAUSED_REVIEW':
        await this.#publish(taskId, 'PLAN_PAUSED', result.message, data);
        return;
      default:
        return;
    }
  }
}

export { PlanError };
