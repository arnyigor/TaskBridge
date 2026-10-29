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

import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePlan, proposeImport, classifyPlan, planHash, readPlan, readPlanText, serializePlan, updatePlan, writePlanAtomic, withPlanWriteLock, PlanError, DEFAULT_MAX_BYTES } from './application/plan-file.mjs';
import { scanPlanFiles, SCAN_DEFAULTS } from './application/plan-scan.mjs';
import { AI_REVIEW_LIMITS, buildPlanReviewPrompt, parsePlanReviewAnswer, buildPlanDraftPrompt, extractManagedPlan, normalizeDraftIssues } from './application/plan-ai-review.mjs';
import { PlanFollower, resultForStep, checkpointIdentity } from './application/plan-follower.mjs';

export const FOLLOW_PLAN_EVENTS = Object.freeze([
  'PLAN_ATTACHED', 'PLAN_STEP_STARTED', 'PLAN_STEP_CHECKPOINT', 'PLAN_REVISED',
  'PLAN_PAUSED', 'PLAN_COMPLETED', 'PLAN_CONFLICT', 'PLAN_DETACHED',
  // FP-FIX-05: исход применения checkpoint. Опубликованное раньше
  // PLAN_STEP_CHECKPOINT означает «получен», а не «применён», и его имя оставлено
  // как есть ради совместимости клиентов.
  'PLAN_CHECKPOINT_APPLIED', 'PLAN_CHECKPOINT_RECEIVED', 'PLAN_CHECKPOINT_REJECTED'
]);

/** Текст причины для оператора: код — для машин, фраза — для человека. */
const CHECKPOINT_REASON_TEXT = Object.freeze({
  STATE_INACTIVE: 'цикл не активен',
  FOREIGN_COMMAND: 'подтверждение относится к другой команде',
  REVISION_CONFLICT: 'файл плана изменён во время цикла',
  INVALID_CHECKPOINT: 'checkpoint не прошёл проверку',
  NO_CHECKPOINT: 'ход завершился без checkpoint',
  APPROVAL_REQUIRED: 'нужно подтверждение оператора',
  APPLY_FAILED: 'запись в файл плана не удалась',
  NOTHING_TO_APPLY: 'подтверждённых изменений нет',
  NOT_APPLIED: 'запрошенные шаги в файле не закрыты'
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Отказ модели человеческими словами: «Модель не ответила: EMPTY» оператору ничего
 * не объясняет, а причина у каждого кода своя.
 */
const AI_FAILURE_TEXT = Object.freeze({
  EMPTY: 'модель вернула пустой ответ: лимит токенов израсходован рассуждением — попробуйте ещё раз',
  TIMEOUT: 'провайдер не ответил за отведённое время',
  UNREACHABLE: 'провайдер недоступен',
  AUTH: 'провайдер отклонил ключ',
  RATE_LIMITED: 'провайдер ограничил частоту запросов',
  MODEL_NOT_FOUND: 'провайдер не знает такую модель',
  MODEL_UNKNOWN: 'у сессии не выбрана модель',
  NO_KEY: 'у провайдера нет ключа в окружении',
  NO_ENDPOINT: 'у сессии модель по подписке (без адреса API), а локальной модели не нашлось — соберите план в чате и вставьте текст',
  REDIRECT: 'провайдер отвечает перенаправлением',
  HTTP_ERROR: 'провайдер ответил ошибкой'
});
const aiFailure = answer => {
  // У HTTP_ERROR/UNREACHABLE ценнее собственный текст отказа (хвост stderr Pi),
  // у остальных кодов — человеческая формулировка выше.
  if (['HTTP_ERROR', 'UNREACHABLE'].includes(answer?.code) && answer?.message) return answer.message;
  return AI_FAILURE_TEXT[answer?.code] || answer?.message || answer?.code || 'неизвестная причина';
};
const CONTROL_CLIENT = 'follow-plan';

const notFound = () => Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });

const MAX_PLAN_BYTES = 1024 * 1024;
// A plan is never inside these: listing them would be the project scan again.
const BROWSE_SKIP = new Set(['node_modules', 'build', 'dist', 'out', 'target', '.git', 'vendor']);

/** base64 → utf8 text, with a size guard and an honest error for a broken file. */
function decodePlanContent(contentBase64) {
  const raw = String(contentBase64 || '').replace(/^data:[^;]+;base64,/, '');
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length) throw reject('PLAN_INVALID', 'Файл плана пуст.');
  if (bytes.length > MAX_PLAN_BYTES) throw reject('PLAN_INVALID', `Файл плана больше ${MAX_PLAN_BYTES} байт.`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw reject('PLAN_INVALID', 'Файл плана не в UTF-8: перекодируйте его и попробуйте снова.');
  }
}

/**
 * Куда писать выбранный файл: только внутрь workspace, без `..`, абсолютных путей
 * и выхода через symlink/junction.
 */
async function safeTarget(workspace, relPath, { write = false } = {}) {
  if (!workspace) throw reject('SESSION_UNAVAILABLE', 'Рабочий каталог сессии ещё не создан.');
  const root = await fs.realpath(workspace).catch(() => path.resolve(workspace));
  const target = path.resolve(root, relPath);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw reject('PLAN_INVALID', 'Путь плана выходит за пределы рабочего каталога.', [relPath]);
  }
  if (write) {
    const parent = await fs.realpath(path.dirname(target)).catch(() => null);
    if (parent && path.relative(root, parent).startsWith('..')) {
      throw reject('PLAN_INVALID', 'Каталог плана указывает за пределы проекта (symlink).', [relPath]);
    }
  }
  return target;
}
const reject = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export class FollowPlanService {
  constructor({ manager, store, config = {}, now = () => Date.now(), askModel = null }) {
    Object.assign(this, { manager, store, config, now, askModel });
    // Last checkpoint per task, for the card: it is a fact of THIS process (the
    // durable part is the file and the binding), so it is not persisted twice.
    this.checkpoints = new Map();
    // The next hop is prepared at settle and sent only after the turn's terminal
    // event is durable (FP-UX-02E). Runtime-only: a restart loses it and the cycle
    // stays in REVIEWING, which recovery turns into «разбор», never a replay.
    this.pendingDispatches = new Map();
    // Which turn each task has already settled: a duplicated `agent_settled` of the
    // same command must not be read as «a turn without a checkpoint» (that once sent
    // an audit turn for a checkpoint that had already arrived).
    this.settledTurns = new Map();
    // AI-проверка (FP-UX-04E) — редкое действие по нажатию: времена запросов
    // держим в памяти процесса, чтобы кнопка не стала способом жечь токены.
    this.aiReviewTimes = new Map();
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
      // Text of any Markdown document: the verdict «is this a plan» is decided
      // after reading, not by parsePlan refusing an ordinary document.
      text: relPath => readPlanText({ root, relPath, maxBytes: this.config.followPlan?.maxBytes || DEFAULT_MAX_BYTES }),
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
        // The run id is deliberately NOT named in the instruction: the run of this
        // turn starts after the prompt is delivered, so any id known here belongs
        // to the previous turn — and evidence must come from the turn that ran the
        // step (see #checkEvidence).
        const result = await this.manager.message(taskId, message, 'auto', [], null, { commandId, clientId: CONTROL_CLIENT });
        return { id: commandId, queued: Boolean(result?.pendingPrompts?.length) };
      },
      cancel: async ({ taskId, commandId }) => this.manager.cancel(taskId, { commandId: `${commandId}:stop`, hard: true })
    });
  }

  async #publish(taskId, type, message, data = {}) {
    await this.manager.publishFollowPlanEvent?.(taskId, type, message, data).catch(() => {});
  }

  /**
   * Исход применения checkpoint отдельным событием (FP-FIX-05): APPLIED — запись
   * в файл состоялась, RECEIVED — принят без изменений, REJECTED — не применён с
   * причиной. Без этого «Checkpoint: CONTINUE» читался как успех.
   */
  async #publishCheckpointOutcome(task, result) {
    if (!result?.outcome) return;
    const event = result.outcome === 'APPLIED' ? 'PLAN_CHECKPOINT_APPLIED'
      : result.outcome === 'RECEIVED' ? 'PLAN_CHECKPOINT_RECEIVED'
        : 'PLAN_CHECKPOINT_REJECTED';
    const reason = result.reasonCode ? (CHECKPOINT_REASON_TEXT[result.reasonCode] || result.reasonCode) : '';
    // Называем ЗАКРЫТЫЕ шаги, а не dispatchStepId: после подготовки следующего хода
    // dispatchStepId уже указывает вперёд и вводил в заблуждение («шаг S-002», хотя
    // закрыт S-001).
    const closed = Array.isArray(result.appliedStepIds) ? result.appliedStepIds : [];
    const where = closed.length ? `шаг ${closed.join(', ')}` : result.stepId ? `шаг ${result.stepId}` : 'шаг не назван';
    const message = event === 'PLAN_CHECKPOINT_APPLIED'
      ? `Checkpoint применён: ${where}, revision ${result.planRevision ?? '—'}`
      : event === 'PLAN_CHECKPOINT_RECEIVED'
        ? `Checkpoint принят без изменений: ${reason || where}`
        : `Checkpoint не применён: ${reason || result.code || 'без причины'}`;
    await this.#publish(task.id, event, message, {
      checkpointId: result.checkpointId || null,
      runId: task.runId || null,
      cycleId: result.cycleId || null,
      stepId: result.stepId || null,
      outcome: result.outcome,
      reasonCode: result.reasonCode || null,
      planRevision: result.planRevision ?? null,
      revisionBefore: result.revisionBefore ?? null,
      revisionAfter: result.revisionAfter ?? null,
      appliedStepIds: result.appliedStepIds || [],
      closedStepIds: result.appliedStepIds || [],
      appliedFindingIds: result.appliedFindingIds || [],
      confirmedStepIds: result.confirmedStepIds || [],
      completionApplied: result.completionApplied === true,
      unconfirmedStepIds: result.unconfirmedStepIds || [],
      problems: result.problems || [],
      dispatchCommandId: result.dispatchCommandId || null
    });
  }

  #receiptKey(taskId, relPath, planId, stepId) {
    return `plan_evidence:${planHash(JSON.stringify([String(taskId), relPath, planId, stepId]))}`;
  }

  #verification(taskId, relPath, planId, step) {
    const stored = this.store.getMeta(this.#receiptKey(taskId, relPath, planId, step.id));
    if (!stored) return 'MODEL_REPORTED';
    try {
      const receipt = JSON.parse(stored);
      return receipt.fingerprint === planHash(JSON.stringify(step)) && receipt.level === 'SYSTEM_VERIFIED'
        ? 'SYSTEM_VERIFIED' : 'MODEL_REPORTED';
    } catch { return 'MODEL_REPORTED'; }
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
      cycleNumber: Number(String(binding?.cycleId || '').replace(/^c-/, '')) || null,
      stepId: binding?.dispatchStepId || null,
      // Where the session itself is (Pi turn), separate from the plan's own state.
      stage: task.status === 'RUNNING' ? (task.turnState?.phase || 'RUNNING') : task.status,
      updatedAt: binding?.updatedAt || null,
      lastCheckpoint: this.checkpoints.get(task.id) || null,
      pauseReason: ['PAUSED', 'PAUSED_REVIEW'].includes(binding?.state) ? binding?.budget?.pauseReason || null : null,
      conflict: false,
      title: null,
      goal: null,
      progress: null,
      steps: [],
      file: null,
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
      // The dialog shows the current step and, on demand, the whole list: the
      // confirmed result travels with it (trimmed — the full log is in the chat).
      status.steps = steps.map(step => {
        // «Результат» carries the evidence level as a prefix: expose it apart from
        // the text, so the dialog can say «подтверждено системой» vs «заявлено моделью».
        const raw = String(step.result || '');
        const match = /^\[(SYSTEM_VERIFIED|MANUAL_ACCEPTED|MODEL_REPORTED|UNVERIFIED)\]\s*(.*)$/s.exec(raw);
        return {
          id: step.id, status: step.status, priority: step.priority, title: step.title,
          // Markdown is a claim, not a trust store. Only a server receipt for
          // this exact step (criteria, verification and result included) grants trust.
          verification: raw ? this.#verification(task.id, binding.path, file.plan.planId, step) : null,
          result: (match ? match[2] : raw).slice(0, 240)
        };
      });
      status.findings = file.plan.findings.map(finding => ({ id: finding.id, priority: finding.priority, state: finding.state, summary: finding.summary }));
      status.conflict = file.hash !== binding.hash || file.plan.revision !== binding.revision;
      // The file has a state of its own, and it decides what the operator sees:
      // a plan whose steps are all DONE is finished even if the cycle is not
      // running any more (re-attached file, restart). Reported apart from the
      // binding and the running cycle, so the UI can tell them apart.
      const blocking = file.plan.findings.filter(finding => finding.state === 'OPEN' && (finding.priority === 'P0' || finding.priority === 'P1'));
      const open = file.plan.steps.filter(step => step.status === 'TODO' || step.status === 'IN_PROGRESS' || step.status === 'BLOCKED');
      status.file = {
        open: open.length,
        blocking: blocking.length,
        revision: file.plan.revision,
        // «Выполнен» — это про файл, а не про то, что цикл где-то работает.
        complete: open.length === 0 && blocking.length === 0 && file.plan.steps.length > 0
      };
      // Effective state for the dialog: an active cycle always wins, otherwise a
      // finished file reads as finished, not as «готов к запуску».
      const active = binding.state === 'RUNNING_STEP' || binding.state === 'REVIEWING' || binding.state === 'PAUSED';
      if (!active && status.file.complete) status.state = 'COMPLETED';
      else if (!active && binding.state === 'COMPLETED' && !status.file.complete) status.state = 'PAUSED_REVIEW';
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

  async attach({ taskId, path, commandId, clientId, expectedHash = null }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const relPath = this.#relativePath(task, path);
    // The same guarantee as import: a confirmation belongs to the text the
    // operator saw, so attach refuses a file edited after the preview instead of
    // binding a verdict nobody confirmed. Clients that attach without a preview
    // simply send no hash and keep the old behaviour.
    if (expectedHash) {
      const current = await this.#plans(task).text(relPath);
      if (planHash(current.text) !== expectedHash) {
        throw reject('PLAN_REVISION_CONFLICT',
          `Файл ${relPath} изменился после проверки. Откройте его заново и подтвердите подключение заново.`,
          [`expected ${expectedHash}`, `actual ${planHash(current.text)}`]);
      }
    }
    const follower = this.#follower(task);
    const attached = await follower.attach({ taskId: task.id, path: relPath });
    this.checkpoints.delete(task.id);
    await this.#publish(task.id, 'PLAN_ATTACHED', `План подключён: ${relPath}`, {
      path: relPath, planId: attached.plan.planId, revision: attached.plan.revision,
      steps: attached.plan.steps.length, commandId, clientId
    });
    return this.status(task.id);
  }

  /** Содержимое привязанного файла для редактора: чтение, ничего не пишет. */
  async content({ taskId }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const binding = this.store.getPlanBinding(task.id);
    if (!binding?.path) throw reject('PLAN_NOT_ATTACHED', 'План не подключён.');
    const file = await this.#plans(task).read(binding.path);
    return { path: binding.path, revision: file.plan.revision, hash: file.hash, content: file.text };
  }

  /**
   * Правка содержимого того же файла (FP-UX-02C). Ревизию двигает сервис, а не
   * клиент: присланная строка `revision:` игнорируется, CAS идёт по
   * expectedRevision/expectedHash. Завершённые шаги, их подтверждения и цель
   * защищены — их нельзя потерять незаметной правкой.
   */
  async writeContent(input) {
    this.#assertEnabled();
    const task = this.#task(input.taskId);
    const binding = this.store.getPlanBinding(task.id);
    if (!binding?.path) throw reject('PLAN_NOT_ATTACHED', 'План не подключён.');
    return withPlanWriteLock(path.resolve(task.workspacePath, binding.path), () => this.#writeContent(input));
  }

  async #writeContent({ taskId, content, expectedRevision = null, expectedHash = null, allowGoalChange = false, commandId, clientId }) {
    this.#assertEnabled();
    if (!Number.isInteger(expectedRevision) || !expectedHash) {
      throw reject('PLAN_REVISION_CONFLICT', 'Для сохранения нужны ревизия и хэш исходного черновика. Откройте файл заново.');
    }
    const task = this.#task(taskId);
    const binding = this.store.getPlanBinding(task.id);
    if (!binding?.path) throw reject('PLAN_NOT_ATTACHED', 'План не подключён.');
    if (['RUNNING_STEP', 'REVIEWING'].includes(binding.state)) throw reject('PLAN_BLOCKED', 'Сначала приостановите выполнение плана.');
    const file = await this.#plans(task).read(binding.path);
    if (expectedHash && expectedHash !== file.hash) {
      throw reject('PLAN_REVISION_CONFLICT', 'Файл плана изменён вне TaskBridge: сверьте версии.', [`expected ${expectedHash}`, `actual ${file.hash}`]);
    }
    if (expectedRevision != null && Number(expectedRevision) !== file.plan.revision) {
      throw reject('PLAN_REVISION_CONFLICT', `Ревизия плана ${file.plan.revision}, ожидалась ${expectedRevision}.`);
    }

    let next;
    try {
      next = parsePlan(String(content ?? ''));
    } catch (error) {
      throw reject('PLAN_INVALID', `Правка не сохранена: ${error.message}`, error.problems || []);
    }
    const problems = [];
    if (next.planId !== file.plan.planId) problems.push(`planId менять нельзя (${file.plan.planId} → ${next.planId})`);
    if (!allowGoalChange && next.goal !== file.plan.goal) {
      problems.push('цель плана меняется только отдельным подтверждением (allowGoalChange)');
    }
    for (const was of file.plan.steps) {
      const now = next.steps.find(step => step.id === was.id);
      if (!now) { problems.push(`шаг ${was.id} удалён: завершённые шаги не удаляются`); continue; }
      if (was.status === 'DONE' && !String(now.result || '').trim()) {
        problems.push(`шаг ${was.id}: подтверждение выполненного шага нельзя стереть`);
      }
      if (was.originFindingId && now.originFindingId !== was.originFindingId) {
        problems.push(`шаг ${was.id}: происхождение (${was.originFindingId}) менять нельзя`);
      }
    }
    if (problems.length) throw reject('PLAN_INVALID', `Правка не сохранена: ${problems[0]}`, problems);

    // The service owns the revision counter; the content carries the rest.
    next.revision = file.plan.revision + 1;
    const text = serializePlan(next);
    const absolute = await safeTarget(task.workspacePath, binding.path, { write: true });
    await writePlanAtomic({ file: absolute, text, expectedHash: file.hash });
    const hash = planHash(text);
    this.store.savePlanBinding({ ...binding, revision: next.revision, hash, updatedAt: new Date(this.now()).toISOString() });
    await this.#publish(task.id, 'PLAN_REVISED', `План отредактирован: revision ${next.revision}`, {
      revision: next.revision, hash, commandId, clientId
    });
    return this.status(task.id);
  }

  /**
   * Markdown-файлы проекта по явному запросу оператора (FP-UX-04B). Ничего не
   * пишет, не привязывает и не запускает: это чтение дерева workspace с
   * ограничениями из plan-scan.mjs. Ни Pi, ни Run здесь не участвуют.
   */
  async scan({ taskId, query = '', limit = null } = {}) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    if (!task.workspacePath) throw reject('SESSION_UNAVAILABLE', 'Рабочий каталог сессии ещё не создан: сначала запустите задачу.');
    const configured = this.config.followPlan?.scan || {};
    const maxResults = Number.isInteger(limit) && limit > 0
      ? Math.min(limit, configured.maxResults || SCAN_DEFAULTS.maxResults)
      : configured.maxResults || SCAN_DEFAULTS.maxResults;
    const result = await scanPlanFiles({
      root: task.workspacePath,
      query,
      maxResults,
      maxDepth: configured.maxDepth || SCAN_DEFAULTS.maxDepth,
      maxDirs: configured.maxDirs || SCAN_DEFAULTS.maxDirs,
      maxMs: configured.maxMs || SCAN_DEFAULTS.maxMs,
      maxClassified: configured.maxClassified || SCAN_DEFAULTS.maxClassified
    });
    // Абсолютный серверный путь клиенту не отдаётся: интерфейсу нужно имя проекта,
    // а не адрес на компьютере хоста.
    return { ...result, enabled: this.enabled };
  }

  /**
   * «Проверить с помощью ИИ» (FP-UX-04E): совет модели по выбранному файлу.
   *
   * Только по нажатию, без инструментов, без Run и без перезаписи содержимого.
   * Структурный вердикт (`classifyPlan`) считается здесь же и возвращается рядом:
   * модель его не заменяет, а его отсутствие/ошибка не мешает обычному
   * подключению валидного плана.
   */
  async aiReview({ taskId, path: relPath = null, name = null, contentBase64 = null }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    if (typeof this.askModel !== 'function') {
      throw reject('AI_UNAVAILABLE', 'Проверка с помощью ИИ недоступна: сервер не может запросить модель.');
    }
    const now = this.now();
    const recent = (this.aiReviewTimes.get(task.id) || []).filter(at => now - at < 60_000);
    if (recent.length >= AI_REVIEW_LIMITS.requestsPerMinute) {
      throw reject('AI_RATE_LIMITED', 'Слишком часто: проверка ИИ — не больше трёх раз в минуту. Обычная проверка формата работает без ограничений.');
    }
    this.aiReviewTimes.set(task.id, [...recent, now]);

    let target;
    let text;
    if (contentBase64 != null) {
      target = this.#targetPath(relPath || name || '');
      text = decodePlanContent(contentBase64);
    } else {
      target = this.#relativePath(task, relPath);
      text = (await this.#plans(task).text(target)).text;
    }
    const classified = classifyPlan(text, { planId: this.#planIdFor(target) });
    const capped = text.slice(0, AI_REVIEW_LIMITS.maxChars);
    const truncated = capped.length < text.length;
    const answer = await this.askModel({
      taskId: task.id,
      prompt: buildPlanReviewPrompt({ path: target, text: capped, truncated }),
      // Рассуждающие модели тратят лимит на reasoning: 400 токенов давали пустой ответ.
      maxTokens: Math.max(AI_REVIEW_LIMITS.maxTokens, 800),
      timeoutMs: AI_REVIEW_LIMITS.timeoutMs
    });
    if (!answer?.ok) {
      // Отказ модели — не ошибка плана: клиент показывает его отдельно и даёт
      // подключить файл, если структурная проверка его приняла.
      throw reject('AI_UNAVAILABLE', `Модель не ответила: ${aiFailure(answer)}. Обычная проверка формата остаётся доступной.`);
    }
    const parsed = parsePlanReviewAnswer(answer.text);
    if (!parsed.ok) throw reject('AI_UNAVAILABLE', `${parsed.message} Обычная проверка формата остаётся доступной.`);
    return {
      path: target,
      truncated,
      charsSent: capped.length,
      structural: { verdict: classified.verdict, reason: classified.reason || '', problems: classified.problems || [] },
      ai: { verdict: parsed.verdict, looksLikePlan: parsed.looksLikePlan, reasons: parsed.reasons },
      model: { provider: answer.provider || null, id: answer.model || null, local: answer.local === true },
      ms: answer.ms ?? null
    };
  }

  /**
   * «Собрать план с помощью ИИ»: модель превращает свободный текст в файл
   * `taskbridge_plan: 1`. Ничего не пишет — оператор видит результат в редакторе и
   * сам нажимает «Сохранить как план» (там CAS и проверка формата).
   */
  async aiDraft({ taskId, path: relPath = null, name = null, contentBase64 = null, hint = '' }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    if (typeof this.askModel !== 'function') {
      throw reject('AI_UNAVAILABLE', 'Сборка плана с помощью ИИ недоступна: сервер не может запросить модель.');
    }
    const now = this.now();
    const recent = (this.aiReviewTimes.get(task.id) || []).filter(at => now - at < 60_000);
    if (recent.length >= AI_REVIEW_LIMITS.requestsPerMinute) {
      throw reject('AI_RATE_LIMITED', 'Слишком часто: обращения к модели — не больше трёх раз в минуту.');
    }
    this.aiReviewTimes.set(task.id, [...recent, now]);

    let target;
    let text;
    if (contentBase64 != null) {
      target = this.#targetPath(relPath || name || '');
      text = decodePlanContent(contentBase64);
    } else {
      target = this.#relativePath(task, relPath);
      text = (await this.#plans(task).text(target)).text;
    }
    const capped = text.slice(0, AI_REVIEW_LIMITS.maxChars);
    const truncated = capped.length < text.length;
    const answer = await this.askModel({
      taskId: task.id,
      prompt: buildPlanDraftPrompt({ path: target, text: capped, truncated, hint: String(hint || '').slice(0, 500) }),
      maxTokens: 2000,
      // Подписочная модель отвечает через `pi --print`: это отдельный процесс,
      // десятки секунд на запуск и генерацию. 30 секунд обзора здесь не хватает.
      timeoutMs: Math.max(AI_REVIEW_LIMITS.timeoutMs, 150_000)
    });
    if (!answer?.ok) {
      throw reject('AI_UNAVAILABLE', `Модель не ответила: ${aiFailure(answer)}.`);
    }
    const draft = normalizeDraftIssues(extractManagedPlan(answer.text));
    const classified = classifyPlan(draft, { planId: this.#planIdFor(target) });
    if (classified.verdict !== 'VALID_MANAGED') {
      throw reject('AI_INVALID_PLAN',
        `Модель вернула текст, который не является планом: ${classified.reason || (classified.problems || [])[0] || 'формат не распознан'}`,
        classified.problems || []);
    }
    return {
      path: target,
      text: draft,
      verdict: classified.verdict,
      steps: classified.plan.steps.length,
      goal: classified.plan.goal,
      truncated,
      charsSent: capped.length,
      model: { provider: answer.provider || null, id: answer.model || null, local: answer.local === true },
      ms: answer.ms ?? null
    };
  }

  /** Текст выбранного файла проекта: только чтение, для правки формата. */
  async readFile({ taskId, path: relPath }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const target = this.#relativePath(task, relPath);
    const file = await this.#plans(task).text(target);
    return { path: target, text: file.text, hash: file.hash };
  }

  /**
   * «Исправить формат»: сохранить отредактированный текст как план в проекте.
   * Пишется только валидный управляемый план — иначе оператор увидит, что именно
   * не так, а исходник останется нетронутым. CAS по хэшу и запрет молчаливой
   * перезаписи другого файла повторяют правила import/attach.
   */
  async saveFile({ taskId, path: relPath, content, expectedHash = null, overwrite = false }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const target = this.#relativePath(task, relPath);
    if (!/\.(md|markdown)$/i.test(target)) throw reject('PLAN_INVALID', 'План — это файл .md или .markdown.');
    const text = String(content ?? '');
    const classified = classifyPlan(text, { planId: this.#planIdFor(target) });
    if (classified.verdict !== 'VALID_MANAGED') {
      throw reject('PLAN_INVALID',
        `Сохранение отклонено: ${classified.reason || 'файл не соответствует формату плана.'}`,
        classified.problems || []);
    }
    const absolute = await safeTarget(task.workspacePath, target, { write: true });
    const existing = await fs.readFile(absolute, 'utf8').catch(() => null);
    if (existing != null) {
      const currentHash = planHash(existing);
      if (expectedHash && currentHash !== expectedHash) {
        throw reject('PLAN_REVISION_CONFLICT',
          `Файл ${target} изменён после открытия. Откройте его заново и повторите правку.`,
          [`expected ${expectedHash}`, `actual ${currentHash}`]);
      }
      if (!overwrite && planHash(text) !== currentHash) {
        throw reject('PLAN_FILE_EXISTS', `Файл ${target} уже есть в проекте: подтвердите перезапись.`, [target]);
      }
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const written = await writePlanAtomic({
      file: absolute, text,
      expectedHash: existing == null ? null : planHash(existing)
    });
    return {
      path: target, hash: written.hash, revision: classified.plan.revision,
      verdict: classified.verdict, steps: classified.plan.steps.length
    };
  }

  /**
   * Что будет, если подключить этот файл: ничего не пишет и не привязывает.
   * Нужно, чтобы показать формат, ошибки и импорт ДО согласия оператора.
   */
  async inspect({ taskId, path: relPath = null, name = null, contentBase64 = null }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    let target;
    let text;
    if (contentBase64 != null) {
      target = this.#targetPath(relPath || name || '');
      text = decodePlanContent(contentBase64);
    } else {
      target = this.#relativePath(task, relPath);
      const file = await this.#plans(task).text(target);
      text = file.text;
    }
    return this.#inspectText({ task, target, text });
  }

  #inspectText({ task, target, text }) {
    // Вердикт (FP-UX-04D) считается в одном месте — plan-file.mjs — чтобы
    // сканирование, проверка и импорт не расходились в правилах.
    const classified = classifyPlan(text, { planId: this.#planIdFor(target), goal: '' });
    const binding = this.store.getPlanBinding(task.id);
    const common = {
      path: target,
      // Хэш показанного текста: подтверждение подключения сверяется с ним, чтобы
      // внешняя правка между предпросмотром и attach обнаруживалась (VALID-06).
      hash: planHash(text),
      verdict: classified.verdict,
      reason: classified.reason || '',
      problems: classified.problems || [],
      // Another plan of this session is replaced, not merged; the dialog says so
      // before the operator agrees.
      replaces: binding?.path && binding.path !== target ? binding.path : null,
      alreadyAttached: binding?.path === target
    };
    if (classified.verdict === 'VALID_MANAGED') {
      const plan = classified.plan;
      return {
        ...common,
        managed: true,
        steps: plan.steps.length,
        planId: plan.planId,
        revision: plan.revision,
        goal: plan.goal
      };
    }
    if (classified.verdict === 'CONVERTIBLE') {
      // Free-form Markdown is imported as a preview only; the file stays untouched
      // until the operator confirms. `content` is the managed file the operator is
      // about to agree to — nothing is written to disk before that click.
      const preview = classified.preview;
      return {
        ...common,
        managed: false,
        freeForm: true,
        preview: {
          steps: preview.plan.steps.map(step => ({ id: step.id, title: step.title, status: step.status })),
          unmapped: preview.unmapped,
          problems: preview.problems,
          content: preview.content
        }
      };
    }
    // NOT_A_PLAN / INVALID: нет ни одного шага — значит и импортировать нечего.
    return { ...common, managed: false, freeForm: true, preview: null };
  }

  #planIdFor(target) {
    const slug = String(target).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
    return `p-${slug || 'plan'}`;
  }

  /**
   * Подключить файл, выбранный в системном диалоге (base64), или уже лежащий в
   * проекте (`path`). Управляемый план пишется как есть; свободный Markdown —
   * только после `confirmImport`, и тогда он преобразуется в управляемый.
   */
  async importPlan({ taskId, path: relPath = null, name = null, contentBase64 = null, confirmImport = false, overwrite = false, expectedHash = null, commandId, clientId }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    let target;
    let text;
    if (contentBase64 != null) {
      target = this.#targetPath(relPath || name || '');
      text = decodePlanContent(contentBase64);
    } else {
      target = this.#relativePath(task, relPath);
      const file = await this.#plans(task).text(target);
      text = file.text;
    }
    // The operator confirmed a specific text. If the file changed after that
    // preview, attaching would silently apply a verdict for content nobody saw.
    if (expectedHash && planHash(text) !== expectedHash) {
      throw reject('PLAN_REVISION_CONFLICT',
        `Файл ${target} изменился после проверки. Откройте его заново и подтвердите подключение заново.`,
        [`expected ${expectedHash}`, `actual ${planHash(text)}`]);
    }

    const binding = this.store.getPlanBinding(task.id);
    if (binding?.path && binding.path !== target) {
      // Name the plan that is already there: the operator decides, nothing is detached.
      throw reject('PLAN_ALREADY_ATTACHED',
        `Уже подключён план ${binding.path}. Отключите его в панели управления, если хотите выбрать другой файл.`,
        { attachedPath: binding.path });
    }
    const inspection = this.#inspectText({ task, target, text });
    if (!inspection.managed && !inspection.preview) {
      // A plain document is not a plan, and an unparsable managed file is not a
      // conversion candidate: say so instead of silently attaching a README.
      throw reject('PLAN_INVALID', `Файл не подходит как план: ${inspection.reason || inspection.problems[0] || 'нет шагов'}`, inspection.problems || []);
    }
    const absolute = await safeTarget(task.workspacePath, target, { write: true });
    let toWrite = text;
    let imported = null;
    if (!inspection.managed) {
      if (!confirmImport) {
        // Preview first: the operator sees the steps that would be created and only
        // then agrees to convert the file.
        return { status: await this.status(task.id), needsConfirmation: true, inspection };
      }
      const preview = proposeImport(text, { planId: this.#planIdFor(target) });
      if (!preview.content) {
        throw reject('PLAN_INVALID', 'Из этого файла не получилось собрать план.', preview.problems);
      }
      toWrite = preview.content;
      imported = { steps: preview.plan.steps.length, unmapped: preview.unmapped.length };
    }

    // A file that already lives in the project is converted in place — the operator
    // just confirmed exactly that. A file from the device must not replace a
    // different project file without a second, explicit confirmation.
    const fromDevice = contentBase64 != null;
    const exists = await fs.stat(absolute).then(stat => stat.isFile(), () => false);
    const current = exists ? await fs.readFile(absolute, 'utf8') : null;
    const identical = current != null && planHash(current) === planHash(toWrite);
    if (fromDevice && exists && !identical && !overwrite) {
      throw reject('PLAN_FILE_EXISTS', `Файл ${target} уже есть в проекте и отличается: подтвердите перезапись.`, [target]);
    }
    // A repeated selection of identical bytes does not rewrite the file or reset
    // a running binding. It simply shows the existing control panel.
    if (identical && binding?.path === target) {
      return { status: await this.status(task.id), needsConfirmation: false };
    }
    // A managed file that already lives in the project is attached where it is:
    // rewriting identical bytes would only bump its mtime (FP-UX-03). An upload
    // and a converted free-form file do have to be written.
    const alreadyManaged = contentBase64 == null && inspection.managed;
    if (!alreadyManaged && !identical) {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await writePlanAtomic({ file: absolute, text: toWrite, expectedHash: current == null ? null : planHash(current) });
    }
    const attached = await this.attach({ taskId: task.id, path: target, commandId, clientId });
    if (imported) {
      await this.#publish(task.id, 'PLAN_REVISED', `Импортировано шагов: ${imported.steps}`, { path: target, ...imported, commandId, clientId });
    }
    return { status: { ...attached, imported }, needsConfirmation: false };
  }

  /**
   * Один каталог проекта по запросу: папки и .md-файлы. Именно по запросу —
   * рекурсивного обхода нет, поэтому телефон может выбрать файл на компьютере,
   * не сканируя весь проект.
   */
  async browse({ taskId, path: relPath = '' }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    if (!task.workspacePath) throw reject('SESSION_UNAVAILABLE', 'Рабочий каталог сессии ещё не создан.');
    const root = await fs.realpath(task.workspacePath);
    const raw = String(relPath || '').replace(/\\/g, '/');
    // `..` is refused outright instead of being silently folded into the root:
    // the answer must say the path is wrong, not pretend it was fine.
    if (raw.split('/').includes('..')) throw reject('PLAN_INVALID', 'Путь не может выходить за пределы проекта.', [relPath]);
    const rel = raw.replace(/^\.?\/*/, '').replace(/\/+$/, '');
    const dir = await safeTarget(task.workspacePath, rel || '.');
    const real = await fs.realpath(dir).catch(() => null);
    if (!real) throw reject('PLAN_NOT_ATTACHED', `Каталог не найден: ${rel || '.'}`);
    if (path.relative(root, real).startsWith('..')) {
      throw reject('PLAN_INVALID', 'Каталог указывает за пределы проекта (symlink).', [rel]);
    }
    const entries = await fs.readdir(real, { withFileTypes: true }).catch(() => []);
    const dirs = [];
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (BROWSE_SKIP.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) dirs.push({ name: entry.name, path: childRel, isFile: false });
      // Only Markdown can be a plan; showing everything would be the scan the
      // operator asked to remove.
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push({ name: entry.name, path: childRel, isFile: true });
    }
    const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return {
      path: rel,
      parent: rel ? (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '') : null,
      entries: [...dirs.sort(byName), ...files.sort(byName)]
    };
  }

  /** Безопасное имя файла плана: только .md/.markdown, без пути и мусора. */
  #targetPath(value) {
    const raw = String(value || '').trim().replace(/\\/g, '/');
    const base = raw.split('/').pop() || '';
    const name = base.replace(/[^\w.\- ]+/g, '_');
    if (!/\.md$/i.test(name)) throw reject('PLAN_INVALID', 'План — это файл .md или .markdown.');
    return name;
  }

  async start({ taskId, expectedRevision, commandId, clientId }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const binding = this.store.getPlanBinding(task.id);
    if (!binding?.path) throw reject('PLAN_NOT_ATTACHED', 'План не подключён.');
    const epoch = this.store.planCancelEpoch(task.id);
    const file = await this.#plans(task).read(binding.path);
    if (epoch !== this.store.planCancelEpoch(task.id) || JSON.stringify(binding) !== JSON.stringify(this.store.getPlanBinding(task.id))) return this.status(task.id);
    if (expectedRevision != null && Number(expectedRevision) !== file.plan.revision) {
      await this.#publish(task.id, 'PLAN_CONFLICT', 'Ревизия плана изменилась', { expectedRevision, revision: file.plan.revision });
      throw reject('PLAN_REVISION_CONFLICT', `Ревизия плана ${file.plan.revision}, ожидалась ${expectedRevision}.`,
        { problems: [`expected ${expectedRevision}`, `actual ${file.plan.revision}`] });
    }
    const result = await this.#follower(task).start({ taskId: task.id, commandId });
    await this.#report(task.id, result, { commandId, clientId });
    if (result.code === 'PLAN_BUDGET_EXCEEDED') throw reject(result.code, result.message);
    return this.status(task.id);
  }

  async pause({ taskId, commandId, clientId }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const result = this.#follower(task).pause({ taskId: task.id });
    await this.#report(task.id, result, { commandId, clientId });
    return this.status(task.id);
  }

  async resume({ taskId, expectedRevision, commandId, clientId, renewTimeBudget = false, renewBudget = false }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const binding = this.store.getPlanBinding(task.id);
    if (!binding?.path) throw reject('PLAN_NOT_ATTACHED', 'План не подключён.');
    const epoch = this.store.planCancelEpoch(task.id);
    if (expectedRevision != null) {
      const file = await this.#plans(task).read(binding.path);
      if (epoch !== this.store.planCancelEpoch(task.id) || JSON.stringify(binding) !== JSON.stringify(this.store.getPlanBinding(task.id))) return this.status(task.id);
      if (Number(expectedRevision) !== file.plan.revision) {
        throw reject('PLAN_REVISION_CONFLICT', `Ревизия плана ${file.plan.revision}, ожидалась ${expectedRevision}.`);
      }
    }
    const result = await this.#follower(task).resume({ taskId: task.id, renewTimeBudget, renewBudget });
    await this.#report(task.id, result, { commandId, clientId });
    if (result.code === 'PLAN_BUDGET_EXCEEDED') throw reject(result.code, result.message);
    return this.status(task.id);
  }

  async stop({ taskId, commandId, clientId }) {
    // STOP stays available even with the flag off: an operator must always be
    // able to end a cycle that is already running.
    const task = this.#task(taskId);
    this.pendingDispatches.delete(task.id);
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
   * Stop following a plan. The file itself stays where it is — detaching only
   * removes the binding, so nothing the operator wrote is deleted. A cycle that is
   * still running is paused first: otherwise the next settle would dispatch a step
   * for a plan nobody follows any more.
   *
   * «Удалить файл с сервера» (FP-UX-04F) намеренно не реализовано: файл плана —
   * исходный файл проекта, а отключение привязки и удаление файла не одно и то же.
   * Кнопки удаления в интерфейсе нет именно поэтому, а не по недосмотру.
   */
  async detach({ taskId, commandId, clientId }) {
    this.#assertEnabled();
    const task = this.#task(taskId);
    const binding = this.store.getPlanBinding(task.id);
    if (!binding?.path) throw reject('PLAN_NOT_ATTACHED', 'План не подключён.');
    if (binding.state === 'RUNNING_STEP' || binding.state === 'REVIEWING') {
      const paused = this.#follower(task).pause({ taskId: task.id });
      await this.#report(task.id, paused, { commandId, clientId, reason: 'detach' });
    }
    this.pendingDispatches.delete(task.id);
    this.settledTurns.delete(task.id);
    this.store.deletePlanBinding(task.id);
    this.checkpoints.delete(task.id);
    await this.#publish(task.id, 'PLAN_DETACHED', `План отключён: ${binding.path}`, { path: binding.path, commandId, clientId });
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
  async turnSettled({ taskId, commandId = null, checkpoint = null, aborted = false, seq = null, toolCalls = [] }) {
    const task = this.manager.getTask(String(taskId));
    if (!task) return { code: 'IGNORED', reason: 'task gone' };
    const binding = this.store.getPlanBinding(task.id);
    if (!binding?.path) return { code: 'IGNORED', reason: 'plan not attached' };
    if (binding.state !== 'RUNNING_STEP' && binding.state !== 'REVIEWING') {
      // FP-FIX-05: «ход завершился вне цикла» — это отклонённый checkpoint, а не
      // тишина: оператор должен видеть, что шаг не закрыт и почему.
      const rejected = {
        outcome: 'REJECTED',
        reasonCode: 'STATE_INACTIVE',
        checkpointId: checkpointIdentity(binding, checkpoint),
        cycleId: binding.cycleId || null,
        stepId: binding.dispatchStepId || null,
        planRevision: binding.revision ?? null,
        state: binding.state,
        code: 'IGNORED'
      };
      await this.#publishCheckpointOutcome(task, rejected);
      return { code: 'IGNORED', reason: `state ${binding.state}`, ...rejected };
    }
    if (aborted) {
      await this.#publish(task.id, 'PLAN_PAUSED', 'Ход отменён: разбор результата', { reason: 'aborted', commandId });
      return { code: 'IGNORED', reason: 'aborted turn' };
    }
    // One settle per command, before anything else is decided.
    if (commandId && this.settledTurns.get(task.id) === commandId) {
      return { code: 'IGNORED', reason: 'this turn already settled' };
    }
    // Живой прогон LIVE-03 (2026-10-26): сообщение «сейчас» во время шага
    // заменяет ход, Pi заканчивает ответ, checkpoint планового шага не приходит, а
    // settle приносит чужую команду. Раньше такой settle только отклонялся, и цикл
    // навсегда оставался в RUNNING_STEP: ни паузы, ни разбора, ни следующего шага.
    // Теперь это явная пауза с причиной — шаг не засчитывается, решение за оператором.
    if (!checkpoint && commandId && binding.dispatchCommandId && commandId !== binding.dispatchCommandId) {
      this.pendingDispatches.delete(task.id);
      this.store.savePlanBinding({
        ...binding,
        state: 'PAUSED_REVIEW',
        dispatchCommandId: null,
        dispatchStepId: null,
        updatedAt: new Date(this.now()).toISOString()
      });
      await this.#publish(task.id, 'PLAN_PAUSED',
        'Плановый ход завершился без checkpoint: шаг не засчитан, нужен разбор.',
        {
          code: 'FOREIGN_SETTLE_NO_CHECKPOINT',
          stepId: binding.dispatchStepId || null,
          cycleId: binding.cycleId || null,
          commandId,
          dispatchCommandId: binding.dispatchCommandId
        });
      return { code: 'PAUSED_REVIEW', reason: 'FOREIGN_SETTLE_NO_CHECKPOINT', stepId: binding.dispatchStepId || null };
    }
    // Вклинившееся сообщение сливает чат-ход с плановым: Pi продолжает тот же ход и
    // присылает checkpoint уже после steering, поэтому settle приходит с командой
    // чата (LIVE-03, 2026-10-26). Если checkpoint называет текущий цикл и ревизию,
    // он принадлежит выданному шагу — принимаем подтверждение у него, а не у чата.
    let settleCommandId = commandId;
    if (checkpoint && commandId && binding.dispatchCommandId && commandId !== binding.dispatchCommandId
      && String(checkpoint.cycleId || '') === String(binding.cycleId || '')
      && Number(checkpoint.revision) === Number(binding.expectedRevision)) {
      settleCommandId = binding.dispatchCommandId;
    }
    const checked = this.#checkEvidence({ taskId: task.id, checkpoint, toolCalls });
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
        taskId: task.id, commandId: settleCommandId, checkpoint: checked.checkpoint, seq: seq ?? task._turn ?? null,
        deferDispatch: true
      });
      await this.#publishCheckpointOutcome(task, result);
    } catch (error) {
      // A failure to read/write the plan must pause the plan, not the server.
      await this.#publish(task.id, 'PLAN_PAUSED', `Ошибка плана: ${error.message}`, { code: error.code || 'INTERNAL_ERROR' });
      this.store.savePlanBinding({ ...binding, state: 'PAUSED_REVIEW', dispatchCommandId: null, dispatchStepId: null, updatedAt: new Date(this.now()).toISOString() });
      return { code: error.code || 'INTERNAL_ERROR', message: error.message };
    }
    // Receipts are server runtime evidence, never imported from the Markdown.
    // A failed checkpoint must not certify a previously completed step.
    if (checked.checkpoint?.completedStepIds?.length) {
      const file = await this.#plans(task).read(binding.path);
      if (file.plan.revision > checked.checkpoint.revision) {
        for (const stepId of checked.checkpoint.completedStepIds) {
          const evidence = checked.checkpoint.evidence.filter(item => item.stepId === stepId);
          const step = file.plan.steps.find(item => item.id === stepId);
          const certified = resultForStep(evidence);
          if (step?.status === 'DONE' && evidence.length
            && certified.startsWith('[SYSTEM_VERIFIED]')
            && step.result === certified) {
            this.store.setMeta(this.#receiptKey(task.id, binding.path, file.plan.planId, stepId), JSON.stringify({
              level: 'SYSTEM_VERIFIED', fingerprint: planHash(JSON.stringify(step)),
              runId: task.runId || null, commandId, toolCallIds: evidence.map(item => item.ref)
            }));
          }
        }
      }
    }
    if (commandId) this.settledTurns.set(task.id, commandId);
    if (result.code === 'DISPATCH_READY') {
      this.pendingDispatches.set(task.id, result);
      return result;
    }
    await this.#report(task.id, result, {});
    return result;
  }

  /**
   * The turn's terminal event is durable: now the prepared hop may go out. If the
   * turn failed, cancelled or the plan was detached in between, nothing is sent.
   */
  async turnCommitted({ taskId }) {
    const pending = this.pendingDispatches.get(String(taskId));
    if (!pending) return { code: 'IGNORED', reason: 'no prepared hop' };
    this.pendingDispatches.delete(String(taskId));
    const task = this.manager.getTask(String(taskId));
    if (!task) return { code: 'IGNORED', reason: 'task gone' };
    const binding = this.store.getPlanBinding(task.id);
    if (!binding?.path || !['RUNNING_STEP', 'REVIEWING'].includes(binding.state)) {
      return { code: 'IGNORED', reason: `state ${binding?.state || 'none'}` };
    }
    let result;
    try {
      result = await this.#follower(task).dispatchPending({ taskId: task.id, pending });
    } catch (error) {
      this.store.savePlanBinding({ ...binding, state: 'PAUSED_REVIEW', dispatchCommandId: null, dispatchStepId: null, updatedAt: new Date(this.now()).toISOString() });
      await this.#publish(task.id, 'PLAN_PAUSED', `Следующий шаг не отправлен: ${error.message}`, { code: error.code || 'INTERNAL_ERROR' });
      return { code: error.code || 'INTERNAL_ERROR', message: error.message };
    }
    await this.#report(task.id, result, {});
    return result;
  }

  /**
   * The turn failed or was cancelled without a settle: nothing about the step is
   * known, so the plan pauses for the operator. Re-sending it would repeat a
   * possible side effect.
   */
  async turnFailed({ taskId, commandId = null, reason = 'FAILED' }) {
    // A hop prepared for a turn that never committed must not be sent later.
    this.pendingDispatches.delete(String(taskId));
    this.settledTurns.delete(String(taskId));
    const binding = this.store.getPlanBinding(String(taskId));
    if (!binding?.path) return { code: 'IGNORED', reason: 'plan not attached' };
    if (!['RUNNING_STEP', 'REVIEWING'].includes(binding.state)) return { code: 'IGNORED', reason: `state ${binding.state}` };
    this.store.savePlanBinding({
      ...binding,
      state: 'PAUSED_REVIEW',
      dispatchCommandId: null,
      dispatchStepId: null,
      updatedAt: new Date(this.now()).toISOString()
    });
    await this.#publish(taskId, 'PLAN_PAUSED', `Ход не завершился (${reason}): нужен разбор`, { reason, commandId });
    return { code: 'PAUSED_REVIEW', reason };
  }

  /**
   * Evidence refs that name a run must exist and belong to THIS session. A wrong
   * ref is stripped, so the checkpoint is refused for lack of proof instead of
   * being believed.
   */
  #checkEvidence({ taskId, checkpoint, toolCalls = [] }) {
    if (!checkpoint || !Array.isArray(checkpoint.evidence)) return { checkpoint, problems: [] };
    // What counts as proof (FP-UX-02F):
    //   SYSTEM_VERIFIED  — a tool call of this very turn finished without an error,
    //                      or a run of this session produced the result;
    //   MANUAL_ACCEPTED  — the operator said so;
    //   MODEL_REPORTED   — everything else, including a written-out command string.
    const finished = new Map(toolCalls.map(call => [String(call.id), call]));
    const levelOf = (item, runRef) => {
      if (runRef) return 'SYSTEM_VERIFIED';
      const call = finished.get(String(item?.ref || ''));
      if (call) return call.name !== 'taskbridge_plan_checkpoint' && call.isError === false
        && (call.exitCode == null || call.exitCode === 0) ? 'SYSTEM_VERIFIED' : 'MODEL_REPORTED';
      // A model-supplied manual claim is not an operator acceptance.
      if (String(item?.kind) === 'manual') return 'MODEL_REPORTED';
      return 'MODEL_REPORTED';
    };
    const problems = [];
    // The turn being settled is the only one that could have produced this
    // evidence: a run from an earlier turn of the same session proves nothing
    // about the step that just ran (CP-06).
    const currentRun = this.store.getRun(String(this.manager.getTask(taskId)?.runId || ''));
    const evidence = checkpoint.evidence.map(item => {
      const ref = String(item?.ref || '').trim();
      if (!ref) return { ...item, level: 'MODEL_REPORTED' };
      if (String(item?.kind) === 'run' || UUID.test(ref)) {
        const run = this.store.getRun(ref);
        if (!run) { problems.push(`шаг ${item?.stepId}: run ${ref} не найден`); return { ...item, ref: '', level: levelOf(item, false) }; }
        if (String(run.taskId) !== String(taskId)) {
          problems.push(`шаг ${item?.stepId}: run ${ref} принадлежит другой сессии`);
          return { ...item, ref: '', level: levelOf(item, false) };
        }
        if (currentRun && ref !== currentRun.id && String(run.startedAt || '') < String(currentRun.startedAt || '')) {
          problems.push(`шаг ${item?.stepId}: run ${ref} старше текущего хода — он не подтверждает этот шаг`);
          return { ...item, ref: '', level: levelOf(item, false) };
        }
        // Run identity confirms provenance, not the model's result summary.
        return { ...item, level: 'MODEL_REPORTED' };
      }
      return { ...item, level: levelOf(item, false) };
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
        await this.#publish(taskId, 'PLAN_STEP_STARTED', result.message, {
          ...data, stepId: result.stepId, cycleId: result.cycleId, commandId: result.commandId,
          ...(result.normalization ? { normalization: result.normalization } : {})
        });
        return;
      case 'PLAN_COMPLETED':
        await this.#publish(taskId, 'PLAN_COMPLETED', result.message, data);
        return;
      case 'PLAN_REVISION_CONFLICT':
        await this.#publish(taskId, 'PLAN_CONFLICT', result.message, data);
        return;
      case 'PLAN_CHECKPOINT_REJECTED':
      case 'PLAN_BLOCKED':
      case 'PLAN_UNKNOWN_OUTCOME':
      case 'PLAN_BUDGET_EXCEEDED':
      case 'PLAN_NO_PROGRESS':
        await this.#publish(taskId, 'PLAN_PAUSED', result.message, data);
        return;
      case 'PAUSED':
      case 'PAUSED_REVIEW':
        await this.#publish(taskId, 'PLAN_PAUSED', result.message, data);
        return;
      default:
        return;
    }
  }
}

export { PlanError };
