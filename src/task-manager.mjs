import { restoreSessions } from './application/session-recovery.mjs';
import { EventEmitter } from 'node:events';
import { TerminalPublication } from './domain/terminal-publication.mjs';
import { RunCoordinator } from './application/run-coordinator.mjs';
import { QueuePump } from './application/queue-pump.mjs';
import { CommandCoordinator } from './application/command-coordinator.mjs';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PiRpcSession } from './pi-rpc.mjs';
import { deliveryMetrics } from './delivery-metrics.mjs';
import { prepareProjectWorkspace, createScratchWorkspace, collectGitState, collectGitStateForCompletion, runVerification, applyTaskPatch, removeWorktree, git } from './git.mjs';
import { RuntimeManager } from './runtime-manager.mjs';
import { restoreSessionFile, sessionContainsUserMessage } from './session-history.mjs';
import { validateFiles, validateUploadRefs, metadata, stageFiles, rollbackFiles, snapshotWorkspace, captureOutputs } from './files.mjs';
import { UploadStore } from './uploads.mjs';
import { NativeSessionService, acquireNativeLease, sweepOrphanLocks } from './native-sessions.mjs';
import { classifyEngineError } from './engine.mjs';
import { humanizeError } from '../web/errors.mjs';
import { chooseEngine, usesLocalRuntime, resolveRouterModel, resolveLocalProviderId, localProviderIds } from './dispatcher.mjs';
import { ModelCatalog } from './model-catalog.mjs';
import { syncProviderModels } from './provider-models.mjs';
import { ModelLatency } from './model-latency.mjs';
import { ExternalLocalServers, LocalModelService, quantFromPath } from './local-models.mjs';
import { HuggingFaceService } from './huggingface.mjs';
import { DownloadManager } from './download-manager.mjs';
import { ModelLibrary, idForEntry } from './model-library.mjs';
import { modelsPresetPath, registerLibraryPreset, patchPresetContext, patchPresetVision, parsePresets, removePreset } from './router-presets.mjs';
import { quantFromFilename } from './huggingface.mjs';
import { McpManager, MCP_MODES } from './mcp-manager.mjs';
import { TEXT_TAIL, THINKING_TAIL, tailText, headText, appendTail, stripMcpAdapterNoise } from './text-tail.mjs';
import { toolResultText, isBrokenToolLog, tailBytes } from './tool-output.mjs';
import { generationWindowMs, generationMetrics, accumulateSessionSpeeds } from './system-metrics.mjs';
import { ApprovalManager } from './cloud/approval-manager.mjs';
import { classifyToolCall, resolveApprovalConfig } from './approvals/policy.mjs';
import { deriveRuntimeState, transitionAllowed } from './runtime-state.mjs';
import { listProcesses, processesUsingFile, sameProcess } from './process-info.mjs';
import { piAgentDir } from './pi-settings.mjs';
import { deriveRecap, readSavedRecap, writeRecap, removeRecap, reconcileVerification, RECAP_MD } from './resume/recap.mjs';
import { buildResumeContext, sessionSummary, WORKSPACE_STRATEGIES, MEMORY_MODES } from './resume/resume-builder.mjs';
import { buildResumePreview } from './resume/resume-preview.mjs';
import { renderResumePrompt } from './resume/resume-renderer.mjs';
import { contextFingerprint, validateResume, describeChanges } from './resume/resume-validator.mjs';
import { PiMemoryMdProvider, resumeMemoryQueries, memoryCollisions, INDEX_BUDGET_TOKENS, GLOBAL_BUDGET_TOKENS } from './memory/project-memory-provider.mjs';
import { memoryMetrics } from './memory/memory-metrics.mjs';
import { MERGE_THRESHOLD_DEFAULT, findMergeCandidates, mergeProposalText } from './memory/memory-consolidator.mjs';
import { PROBE_DEFAULTS, ProbeCooldown, probeAvailability, probeLatency } from './model-probe.mjs';
import { WakeChannel } from './wake-channel.mjs';
import { apiKey as providerApiKey } from './provider-models.mjs';
import { listProposals, createProposal, acceptProposal, rejectProposal, validateProposal, proposalCounts } from './memory/memory-proposals.mjs';
import { projectFileIndex } from './memory/path-patterns.mjs';
import { validateRecipe, renderRecipe } from './recipes/recipe.mjs';
import { normalizeSchedule, nextRunAfter, resolveMisfire, describeSchedule } from './scheduler/schedule.mjs';
import { trustProjectDirectory } from './project-trust.mjs';
import {
  assertContextLimit, buildContextReport, collectContextSources, estimateTokens, readCompactionSettings,
} from './context-report.mjs';

function now() { return new Date().toISOString(); }

// Work Items (MR-02, ROADMAP_NEXT_1110.md): six statuses, deliberately not a
// project tracker. The vocabulary and the validation live in one place, so POST,
// PATCH and the store cannot disagree about what is a legal value — an unknown
// status is refused instead of being silently replaced by a default.
const WORK_ITEM_STATUSES = Object.freeze(['BACKLOG', 'READY', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED']);

// How a session relates to its work item (MR-03). Growth here is cheap; the
// point is that a review or a verification run is not the same as the work.
const WORK_ITEM_RELATIONS = Object.freeze(['implementation', 'investigation', 'review', 'verification', 'resume']);

// Сессия, которая остановилась НЕ успешно: её работа где-то оборвалась, и Resume
// обязан сказать, где именно. Живые сессии (QUEUED/RUNNING/WAITING_USER) сюда не
// входят: они ещё идут, а не оборвались.
const INTERRUPTED_STATUSES = Object.freeze(['FAILED', 'CANCELLED']);

/** Одна формулировка для предпросмотра и для инспектора: почему памяти нет. */
export function ambiguousMemoryWarning(collisions = []) {
  const roots = collisions.flatMap(entry => entry.projects.map(project => project.root)).filter(Boolean);
  return `память проекта делится с другим репозиторием (${roots.join(', ')}) — знания могут быть чужими, долговременная память для этой сессии не читается`;
}

const WorkItem = {
  statuses: WORK_ITEM_STATUSES,
  relations: WORK_ITEM_RELATIONS,
  parseRelation(value) {
    const relation = String(value ?? '').trim().toLowerCase() || 'implementation';
    if (!WORK_ITEM_RELATIONS.includes(relation)) {
      throw Object.assign(new Error(`Связь сессии с задачей — одна из: ${WORK_ITEM_RELATIONS.join(', ')}.`), { code: 'INPUT_INVALID' });
    }
    return relation;
  },
  parseStatus(value) {
    const status = String(value ?? '').trim().toUpperCase();
    if (!WORK_ITEM_STATUSES.includes(status)) {
      throw Object.assign(new Error(`Статус задачи — один из: ${WORK_ITEM_STATUSES.join(', ')}.`), { code: 'INPUT_INVALID' });
    }
    return status;
  },
  priority(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 9) {
      throw Object.assign(new Error('Приоритет — целое от 0 до 9.'), { code: 'INPUT_INVALID' });
    }
    return number;
  },
  /** Criteria and tags: lists of short strings, trimmed and bounded. */
  stringList(value, maxItems, maxLength) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw Object.assign(new Error('Ожидается список строк.'), { code: 'INPUT_INVALID' });
    return value
      .map(item => String(item ?? '').trim())
      .filter(Boolean)
      .slice(0, maxItems)
      .map(item => item.slice(0, maxLength));
  },
};
function shortId() { return crypto.randomUUID().replaceAll('-', '').slice(0, 12); }
// The command that produced a prompt, as recorded on its queue entry and its
// USER_MESSAGE. Absent fields are left out rather than stored as null.
function originOf(commandId, clientId, deviceId) {
  const origin = {};
  if (commandId) origin.commandId = String(commandId);
  if (clientId) origin.clientId = String(clientId);
  // The paired device the server authenticated (R1.2) — unlike clientId, a
  // client cannot claim someone else's.
  if (deviceId) origin.deviceId = String(deviceId);
  return Object.keys(origin).length ? origin : null;
}
// Pi's extension UI (docs/rpc-extension-ui.md): dialogs block the extension
// until a client answers; the rest are fire-and-forget.
const UI_DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);
const uiText = (value, max = 4000) => (typeof value === 'string' ? value.slice(0, max) : undefined);
import { RETRY_IN_PROGRESS_NOTICE, GIVE_UP_NOTICE, parseProviderWait, parseProviderWaitStatus, parseProviderGiveUp, providerGiveUpMessage, noteProviderWait, clearProviderWait, sameProviderWait } from './provider-wait.mjs';
// Kill a whole process tree by pid (an orphan from a previous TaskBridge run).
/**
 * Принадлежит ли записанный Pi ЭТОМУ каталогу данных.
 *
 * Сборщик осиротевших Pi убивает процессы, оставшиеся от упавшего TaskBridge. Копия
 * базы данных (бэкап, второй стенд, замер) несёт pids ЖИВЫХ Pi другого каталога — их
 * убийство обрывает чужие сессии. Признак принадлежности: файл сессии Pi, записанный
 * в задаче, лежит внутри нашего каталога данных; он всегда абсолютный и всегда внутри
 * него (data/pi-sessions/<taskId>/…).
 *
 * Записи без файла сессии считаются «нашими»: доказать обратное нечем, а исходная
 * задача сборщика — убрать Pi, оставшийся от нашего же падения.
 */
export function piBelongsToDataRoot(task, dataRoot) {
  const sessionFile = typeof task?.piSessionFile === 'string' && task.piSessionFile.trim() ? task.piSessionFile : null;
  if (!sessionFile) return true;
  const resolvedRoot = path.resolve(String(dataRoot || ''));
  const resolvedFile = path.resolve(sessionFile);
  const relative = path.relative(resolvedRoot, resolvedFile);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function killTreeByPid(pid) {
  const { execFile } = await import('node:child_process');
  await new Promise(resolve => {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } resolve(); }
  });
}
// #message options for delivering a queue entry: its id and original sender.
function pendingOrigin(pending) {
  return { pendingId: pending.id, origin: originOf(pending.commandId, pending.clientId, pending.deviceId) };
}
function safeFileName(name) {
  const base = path.basename(String(name || 'file.bin'));
  return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180) || 'file.bin';
}

// Pi's `agent_end` repeats the WHOLE conversation (messages, base64 images and
// all) after every turn: 16.3 MB for a 42-message thread, 307 MB of such copies
// in the real database. Nothing reads them — the clients drop exactly this field
// before rendering (ChatEventLighteningTest in the KMP client pins that) — so the
// copy is not worth storing, nor worth pushing to every attached client over SSE
// once per turn. Everything else in the frame is kept as it came.
function storedPiFrame(frame) {
  if (!frame || typeof frame !== 'object') return frame;
  if (frame.type === 'agent_end' && frame.messages) {
    const rest = { ...frame };
    delete rest.messages;
    return rest;
  }
  // Шаг C-B (нагрузка): результат инструмента не читает НИ ОДИН клиент — web и KMP
  // выбрасывают его при разборе (ChatEventLighteningTest это фиксирует), а в событии
  // он стоил больше всего: одна bash-команда с выводом — 222 КБ из 4.6 МБ событий
  // сессии, и всё это уходило по SSE на телефон, где UI захлёбывался аллокациями
  // (GC каждые 2 с, heap 90–110 МБ, 2026-10-14). Остаётся признак размера — он
  // нужен диагностике, а содержимое нет: полный вывод лежит в tool-*.log.
  if (frame.type === 'tool_execution_end' && frame.result != null) {
    const text = typeof frame.result === 'string' ? frame.result : JSON.stringify(frame.result);
    const rest = { ...frame, resultDropped: { bytes: text.length } };
    delete rest.result;
    return rest;
  }
  // Накопительный partialResult нужен только прогрессу субагента (KMP,
  // subagentProgress); у остальных инструментов это копия всего вывода на каждом
  // кадре — ровно то, что делает поток кадров тяжёлым.
  if (frame.type === 'tool_execution_update' && frame.partialResult != null && frame.toolName !== 'subagent') {
    const rest = { ...frame };
    delete rest.partialResult;
    return rest;
  }
  return frame;
}

// Budgets for ONE session inside a LIST response (GET /api/tasks, the project
// dashboard). Those endpoints ship every session at once, so a field that is
// unbounded per session makes a body no client can read: 168 sessions reached
// 16.96 MB on 2026-10-13 — of that, verification stdout 6.0, assistantText 3.3,
// thinkingText 2.0, prompt 1.8, git.status 0.6, compaction summary 0.3 MB —
// and the phone refuses a JSON body over 16 MB (TaskBridgeApi.MAX_BODY_BYTES) —
// the session LIST, the first thing the app loads, did not open at all:
// «Ответ сервера слишком большой (16 МБ)». Nothing on screen needs the copies:
// the list shows a title line, the last line of the answer for a notification,
// and counts; the chat screen reads the session itself from /api/tasks/:id.
const LIST_PROMPT_CHARS = 300;
const LIST_ANSWER_CHARS = 300;
const LIST_VERIFICATION_CHARS = 512;
const LIST_GIT_CHARS = 300;
const LIST_SUMMARY_CHARS = 300;
// Списки файлов и правок — это тоже мегабайты на ровном месте: у одной сессии
// (сборка Unreal) 433 записи outputFiles = 122 КБ, а git.changedFiles давал ещё
// 23 КБ на сессию. Телефон качает список на 50 КБ/с и открывал его десятки секунд
// (2026-10-14: 1098 КБ на 70 сессий — «список папок тормозит»). Экрану списка нужны
// счётчики, а сам список файлов читается из /api/tasks/:id.
const LIST_OUTPUT_FILES = 3;
const LIST_CHANGED_FILE_SAMPLE = 3;
const LIST_ATTACHMENTS = 2;

/** One session as the list endpoints ship it: the same task, with the per-session megabytes cut to previews. */
// Подпись модели для строки списка: provider/id/name. Всё остальное описание
// (окно контекста, стоимость, уровни размышлений) нужно экрану сессии.
function briefModel(model) {
  return Object.fromEntries(['provider', 'id', 'name']
    .filter(key => model[key] !== undefined)
    .map(key => [key, model[key]]));
}

export function briefTask(task) {
  return {
    ...task,
    // Строка сессии: заголовок, статус, проект, модель, время, счётчики. Всё, что
    // нужно только экрану сессии (метрики, скорости, usage, параметры хода), из списка
    // убирается: список — первое, что грузит телефон, и он тянет его каждые 5 с.
    prompt: headText(task.prompt, LIST_PROMPT_CHARS),
    // The notification preview takes the LAST non-blank line (SessionAlerts).
    assistantText: tailText(task.assistantText, LIST_ANSWER_CHARS),
    // Only the chat screen shows reasoning, and it reads the session itself.
    thinkingText: null,
    metrics: null,
    speeds: null,
    lastUsage: null,
    parameters: null,
    verification: Array.isArray(task.verification)
      ? task.verification.slice(0, 5).map(entry => entry && typeof entry === 'object'
        ? {
          ...entry,
          stdout: tailText(entry.stdout, LIST_VERIFICATION_CHARS),
          stderr: tailText(entry.stderr, LIST_VERIFICATION_CHARS),
        }
        : entry)
      : task.verification,
    // Модель строки — это её подпись: provider/id/name (KMP показывает model.label,
    // он вычисляется из этих полей). Остальное описание модели (contextWindow, cost,
    // уровни размышлений) нужно экрану сессии, а не списку.
    ...(task.model ? { model: briefModel(task.model) } : {}),
    ...(task.requestedModel ? { requestedModel: briefModel(task.requestedModel) } : {}),
    // Длинные списки заменяются счётчиком: «256 изменённых файлов» вместо 256 строк.
    git: task.git && typeof task.git === 'object'
      ? {
        ...task.git,
        status: headText(task.git.status, LIST_GIT_CHARS),
        changedFiles: Array.isArray(task.git.changedFiles) ? task.git.changedFiles.slice(0, LIST_CHANGED_FILE_SAMPLE) : task.git.changedFiles,
        changedFileCount: Array.isArray(task.git.changedFiles) ? task.git.changedFiles.length : null,
        changedFilesTruncated: Array.isArray(task.git.changedFiles) && task.git.changedFiles.length > LIST_CHANGED_FILE_SAMPLE,
      }
      : task.git,
    // Файлы сессии: строка списка показывает число, а сами записи читает экран
    // сессии. Нет списка — нет и счётчика: форма снимка остаётся чистой.
    ...(Array.isArray(task.outputFiles) ? { outputFiles: task.outputFiles.slice(0, LIST_OUTPUT_FILES), outputFileCount: task.outputFiles.length } : {}),
    ...(Array.isArray(task.attachments) ? { attachments: task.attachments.slice(0, LIST_ATTACHMENTS), attachmentCount: task.attachments.length } : {}),
    ...(Array.isArray(task.files) ? { files: task.files.slice(0, LIST_ATTACHMENTS), fileCount: task.files.length } : {}),
    compaction: task.compaction?.last
      ? { ...task.compaction, last: { ...task.compaction.last, summary: headText(task.compaction.last.summary, LIST_SUMMARY_CHARS) } }
      : task.compaction,
  };
}

function summarizePiEvent(frame) {
  switch (frame.type) {
    case 'agent_start': return 'Pi started processing';
    case 'agent_settled': return 'Pi settled';
    case 'tool_execution_start': {
      const arg = frame.args?.command || frame.args?.path || frame.args?.file_path || '';
      return `tool: ${frame.toolName}${arg ? ` — ${String(arg).slice(0, 180)}` : ''}`;
    }
    case 'tool_execution_end': return `tool done: ${frame.toolName}${frame.isError ? ' (error)' : ''}`;
    case 'compaction_start': return `compaction started (${frame.reason || 'unknown'})`;
    case 'compaction_end': return frame.result
      ? `compaction: ${frame.result.tokensBefore ?? '?'} → ${frame.result.estimatedTokensAfter ?? '?'}`
      : `compaction ended${frame.errorMessage ? `: ${frame.errorMessage}` : ''}`;
    case 'auto_retry_start': return `auto retry ${frame.attempt}/${frame.maxAttempts}`;
    case 'extension_error': return `extension error: ${frame.error || ''}`;
    default: return frame.type;
  }
}

// Statuses that end a run (TZ stage 2 telemetry).
const RUN_TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

// "Continue" has no RPC in Pi, so the request is an explicit instruction. It is
// delivered with announce:false, and what the model writes next is appended to
// the answer it continues — the operator sees the same message grow.
const CONTINUE_PROMPT = 'Продолжи свой предыдущий ответ ровно с того места, где он оборвался. Не повторяй уже написанное и не добавляй вступлений — продолжай текст сразу.';

// How a waiting session describes itself (task.current and the QUEUE_WAITING
// message). One place, so the queueReason the clients branch on and the text the
// operator reads cannot drift apart; KMP maps the same reasons in
// DisplayState.activityOf.
const WAIT_TEXT = {
  MODEL_BUSY: 'Ждёт освобождения локальной модели',
  MODEL_LOADING: 'Ждёт загрузки локальной модели',
  WORKSPACE_BUSY: 'Ждёт освобождения рабочей папки'
};
const waitText = (reason) => WAIT_TEXT[reason] || (reason ? 'В очереди' : null);

// Recursive byte size of a directory. Tolerant of missing folders (a scratch
// session has no pi-sessions/workspaces entry at all) and of files that vanish
// mid-scan (a concurrent delete). Used to report a session's on-disk footprint.
async function dirBytes(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return 0; }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirBytes(full);
    else if (entry.isFile()) {
      try { total += (await fs.stat(full)).size; } catch { /* deleted mid-scan */ }
    }
  }
  return total;
}

export class TaskManager extends EventEmitter {
  #terminalPublication = new TerminalPublication();

  constructor(config, dataRoot, store) {
    super();
    this.config = config;
    this.dataRoot = dataRoot;
    this.store = store;
    this.projects = new Map((config.projects || []).map((p) => [p.id, p]));
    this.memoryProvider = new PiMemoryMdProvider({
      root: config.memory?.projectMemoryRoot,
      // Этап M1: индекс памяти — кэш поиска, рядом с остальными данными TaskBridge.
      // Файлы .md остаются источником правды: удаление этого файла ничего не теряет.
      indexPath: path.join(dataRoot, 'memory-index.db'),
    });
    this.memoryConsolidationTimer = null;
    this.memoryConsolidationRunning = false;
    this.#startMemoryConsolidationScheduler();
    this.tasks = new Map();
    this.runtimes = new Map();
    this.queue = [];
    this.activeTaskIds = new Set();
    this.maxParallelSessions = Math.max(1, Math.min(16, Number(config.queue?.maxConcurrentSessions) || 4));
    // How many sessions of ONE working directory may run at once. 0 (the default)
    // adds no limit of its own: a project without worktrees hands the same folder
    // to every session and the operator decides whether to serialize there (1) or
    // to accept two agents editing one tree. Worktrees and other projects are
    // never affected. Set 1 for the strict "one writer per folder" rule of
    // docs/TASKBRIDGE_PARALLEL_SESSIONS_PLAN.md.
    this.maxSessionsPerDirectory = Math.max(0, Math.min(16, Number(config.queue?.maxSessionsPerDirectory) || 0));
    this.providerConcurrency = Object.fromEntries(Object.entries(config.queue?.providerConcurrency || {})
      .map(([provider, limit]) => [provider, Math.max(1, Math.min(16, Number(limit) || 1))]));
    this.providerCooldownUntil = new Map();
    this.queueSince = new Map();
    this.queueWaitSamples = [];
    this.runCoordinator = new RunCoordinator(store);
    // Files of prompts queued before their workspace existed: raw input kept in
    // memory only, never written into the task record where every save would
    // carry them.
    this.pendingFiles = new Map();
    // capacity 1: a task that cannot start yet (local model busy) is kept in
    // the queue and retried, instead of rejecting the operator's prompt.
    this.queuePollMs = Number(config.queue?.pollMs) > 0 ? Number(config.queue.pollMs) : 1000;
    this.queuePump = new QueuePump({
      isClosing: () => this.closing,
      hasQueued: () => this.queue.length > 0,
      hasCapacity: () => this.activeTaskIds.size < this.maxParallelSessions,
      dispatch: () => this.#pumpOnce(),
      pollMs: () => this.queuePollMs,
    });
    this.closing = false;
    // commandId → { hash, done, result, at }: dedupes operator commands so a
    // retry / second client / double-click cannot fire a prompt twice. TTL is
    // bounded by memory (see #dedupeCommand); persistence across a process
    // restart is a deliberate follow-up.
    this.commandCoordinator = new CommandCoordinator(store);
    this.commandLedger = this.commandCoordinator.cache;
    this.admitting = false;
    this.admissionKeys = new Set();
    // Task id whose pending prompt the pump is delivering right now (delegating
    // delivery). Read by sendPendingNow to refuse cutting into it.
    this.dispatching = null;
    this.deleted = new Set();
    this.eventWrites = new Map();
    // On-disk footprint per session (task folder + pi-sessions + workspaces).
    // Recomputed lazily from listTasks(); the map is what the API reads so a
    // list request never blocks on the filesystem.
    this.sessionSizes = new Map();
    this.sessionSizesAt = 0;
    this.sessionSizesScanning = false;
    this.runtimeManager = new RuntimeManager(config.localRuntime || {}, dataRoot);
    // Router mode: one always-on llama.cpp server that loads presets on demand
    // (see docs). When configured it replaces the single-model RuntimeManager
    // for every health/busy/ensure check; the old object stays for the legacy
    // profile restart endpoints.
    this.localModels = new LocalModelService(config.localRuntime || {}, dataRoot);
    this.localServers = new ExternalLocalServers(config.localRuntime || {}, { agentDir: piAgentDir(process.env) });
    this.local = this.localModels.enabled ? this.localModels : this.runtimeManager;
    this.#initModelLibrary(config, dataRoot);
    this.mcp = new McpManager(config.pi || {}, dataRoot);
    this.modelCatalog = new ModelCatalog({ pi: config.pi, cwd: dataRoot, env: this.#llamaEnv() });
    // Per-model TTFT history (local + cloud): the UI shows "this model usually
    // answers in ~N s" before the prompt is even sent.
    this.modelLatency = new ModelLatency(dataRoot);
    // Кулдаун проб модели: кнопку жмут повторно, но бить по провайдеру часто нельзя,
    // а проба с токенами ещё и стоит денег (пункт §3.3 плана).
    this.probeCooldown = new ProbeCooldown({ cooldownMs: Number(config.modelProbe?.cooldownMs) || PROBE_DEFAULTS.cooldownMs });
    // Одновременные пробы одной модели: второй запрос получает COOLDOWN, а не
    // свою платную попытку (см. probeModel).
    this.probeInFlight = new Set();
    // Свой push в локальной сети (4.3): завершение хода будит телефон, вместо
    // того чтобы тот опрашивал список каждые N секунд.
    this.wakeChannel = new WakeChannel();
    this.nativeSessions = new NativeSessionService(this);
    this.runtimeChanging = false;
    // Tool output bounding (§38): the full log stays in the task artifacts; only
    // a bounded window is streamed to the cloud.
    this.toolOutput = {
      maxFullBytes: Math.max(1024, Math.floor(Number(config.cloud?.toolOutput?.maxFullMb ?? 4) * 1048576))
    };
    this.toolLogs = new Map();
    // Interactive tool approvals (§52). Owned by TaskManager so both the local
    // UI and the cloud command path resolve the same pending request.
    this.approvalsConfig = resolveApprovalConfig(config);
    this.approvals = new ApprovalManager({
      timeoutMinutes: this.approvalsConfig.timeoutMinutes,
      timeoutPolicy: this.approvalsConfig.timeoutPolicy
    });
    this.approvalTokens = new Map();
    this.approvalBaseUrl = null;          // set by the HTTP server
    this.approvalExtensionPath = null;    // set by the HTTP server
    // Injected by the server; lets AUTO restart the managed runtime when the
    // chosen profile differs from the one currently loaded.
    this.runtimeSwitcher = null;
    const uploadMb = Number(config.server?.maxUploadMb || 0);
    this.uploads = new UploadStore(dataRoot, uploadMb > 0
      ? { maxFileBytes: uploadMb * 1048576, maxTotalBytes: uploadMb * 2 * 1048576 }
      : {});
  }

  // Backwards-compatible singular view used by health/restart code and older
  // tests. Internally the scheduler owns a set: independent remote sessions can
  // run together, while one task id still represents at most one generation.
  get activeTaskId() { return this.activeTaskIds.values().next().value || null; }
  set activeTaskId(value) {
    this.activeTaskIds.clear();
    if (value) this.activeTaskIds.add(value);
  }

  #claimSlot(id) { this.activeTaskIds.add(id); }
  #releaseSlot(id) { this.activeTaskIds.delete(id); }
  #enqueue(id) {
    if (this.queue.includes(id)) return;
    this.queue.push(id);
    if (!this.queueSince.has(id)) this.queueSince.set(id, Date.now());
  }
  #removeQueued(id) {
    this.queue = this.queue.filter(entry => entry !== id);
    this.queueSince.delete(id);
  }
  #providerForTask(task) { return task?.requestedModel?.provider || task?.model?.provider || this.#providerFor(task?.requestedModel); }
  #activeProviderCount(provider) {
    let count = 0;
    for (const id of this.activeTaskIds) if (this.#providerForTask(this.tasks.get(id)) === provider) count++;
    return count;
  }
  #providerHasCapacity(task) {
    const provider = this.#providerForTask(task);
    const cooldown = this.providerCooldownUntil.get(provider) || 0;
    if (cooldown > Date.now()) return false;
    if (cooldown) this.providerCooldownUntil.delete(provider);
    const limit = this.providerConcurrency[provider];
    return !limit || this.#activeProviderCount(provider) < limit;
  }
  #hasActiveLocalSession(exceptId = null) {
    for (const id of this.activeTaskIds) {
      if (id !== exceptId && this.#usesLocalRuntime(this.tasks.get(id))) return true;
    }
    return false;
  }
  // The directory a session writes into, known even before its workspace exists.
  // A project without worktrees hands its own folder to every session; this path
  // is what `queue.maxSessionsPerDirectory` limits, from admission on — checking
  // only `workspacePath` saw nothing for a fresh session (its workspace is
  // prepared later) and saw a permanent conflict for a session that had already
  // prepared the folder. A worktree project or a scratch session gets a directory
  // of its own and is never limited here.
  #workspaceDir(task) {
    if (!task) return null;
    if (task.workspacePath) return path.resolve(task.workspacePath);
    if (!task.projectId || task.projectId === '__scratch__') return null;
    const project = this.projects.get(task.projectId);
    if (!project?.path) return null;
    const useWorktree = project.useWorktree ?? this.config.workspace?.useGitWorktreeByDefault ?? true;
    return useWorktree ? null : path.resolve(project.path);
  }
  // Two sessions in one directory share the same files and the same git state.
  // Whether that is allowed is the operator's call: `queue.maxSessionsPerDirectory`
  // (0 = no extra limit, N = at most N sessions of that directory at once). The
  // check is by the directory the session WILL use, computed before the workspace
  // exists — looking only at `workspacePath` let a fresh session slip into a
  // folder another one was already writing in, while a session that had already
  // prepared the folder waited on a conflict with those very sessions forever.
  #workspaceOwner(task) {
    if (!this.maxSessionsPerDirectory) return null;
    const mine = this.#workspaceDir(task);
    if (!mine) return null;
    let taken = 0;
    for (const id of this.activeTaskIds) {
      if (id === task.id) continue;
      if (this.#workspaceDir(this.tasks.get(id)) !== mine) continue;
      if (++taken >= this.maxSessionsPerDirectory) return id;
    }
    return null;
  }
  #hasWorkspaceConflict(task) { return this.#workspaceOwner(task) !== null; }
  // Why a task with no free slot must wait, in the clients' vocabulary: «модель
  // занята» and «папка занята» need different actions from the operator, and a
  // bare BUSY explains neither.
  #waitReason(task) {
    if (this.#usesLocalRuntime(task) && this.#hasActiveLocalSession(task.id)) return 'MODEL_BUSY';
    if (this.#hasWorkspaceConflict(task)) return 'WORKSPACE_BUSY';
    return 'BUSY';
  }
  #hasCapacityFor(task) {
    if (this.activeTaskIds.has(task.id)) return false;
    if (this.activeTaskIds.size >= this.maxParallelSessions) return false;
    if (!this.#providerHasCapacity(task)) return false;
    if (this.#usesLocalRuntime(task) && this.#hasActiveLocalSession(task.id)) return false;
    if (this.#hasWorkspaceConflict(task)) return false;
    return true;
  }

  schedulerInfo() {
    const providers = {};
    const names = new Set([...Object.keys(this.providerConcurrency), ...this.providerCooldownUntil.keys(), ...[...this.activeTaskIds].map(id => this.#providerForTask(this.tasks.get(id))).filter(Boolean)]);
    for (const provider of names) providers[provider] = {
      active: this.#activeProviderCount(provider),
      limit: this.providerConcurrency[provider] ?? this.maxParallelSessions,
      cooldownUntil: (this.providerCooldownUntil.get(provider) || 0) > Date.now() ? new Date(this.providerCooldownUntil.get(provider)).toISOString() : null
    };
    const waiting = [...this.queueSince.values()].map(at => Math.max(0, Date.now() - at));
    const samples = [...this.queueWaitSamples, ...waiting];
    return {
      activeTasks: this.activeTaskIds.size,
      maxConcurrentSessions: this.maxParallelSessions,
      maxSessionsPerDirectory: this.maxSessionsPerDirectory,
      queuedTasks: this.queue.length,
      providers,
      queueWaitMs: {
        currentMax: waiting.length ? Math.max(...waiting) : 0,
        average: samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : 0,
        samples: this.queueWaitSamples.length
      }
    };
  }

  async init() {
    await this.uploads.cleanup().catch(() => {});
    await this.mcp.ensureReady().catch(() => {});
    const previous = await this.store.list();
    this.runCoordinator.recover();
    const trimmed = await restoreSessions(previous, {
      store: this.store,
      enqueue: id => this.#enqueue(id),
      restorePendingFiles: id => this.#restorePendingFiles(id),
      onRestored: task => {
        this.tasks.set(task.id, task);
        task._runtimeState = this.#runtimeFacts(task).state;
      },
      continuePrompt: CONTINUE_PROMPT,
    });
    if (trimmed) await this.store.vacuum().catch(() => {});
    else await this.#maybeVacuum();
    await this.#sweepOrphans();
    await this.#killOrphanPis(previous);
    if (this.queue.length) this.#schedulePump();
  }

  #memoryConsolidationSettings() {
    const cfg = this.config.memory?.consolidation || {};
    return {
      enabled: cfg.enabled === true,
      everyMs: Math.max(60_000, Math.min(7 * 86400_000, (Number(cfg.everyHours) || 24) * 3600_000)),
      maxProposalsPerRun: Math.max(1, Math.min(50, Number(cfg.maxProposalsPerRun) || 10)),
      maxProposalsPerProject: Math.max(1, Math.min(10, Number(cfg.maxProposalsPerProject) || 3)),
    };
  }

  #startMemoryConsolidationScheduler() {
    const cfg = this.#memoryConsolidationSettings();
    if (!cfg.enabled) return;
    this.memoryConsolidationTimer = setInterval(() => {
      this.runMemoryConsolidationSchedule().catch(error => console.warn('[TaskBridge] memory consolidation scheduler failed:', error?.message || error));
    }, cfg.everyMs);
    this.memoryConsolidationTimer.unref?.();
  }

  /**
   * Scheduled M3 consolidator: only creates pending proposals, never edits core memory.
   * It is exposed as a method for tests and future admin UI; the timer calls the same path.
   */
  async runMemoryConsolidationSchedule() {
    if (this.memoryConsolidationRunning) return { skipped: 'running', projects: 0, proposals: 0 };
    this.memoryConsolidationRunning = true;
    const cfg = this.#memoryConsolidationSettings();
    const stats = { projects: 0, candidates: 0, proposals: 0, existing: 0, errors: 0 };
    try {
      for (const projectId of this.projects.keys()) {
        if (stats.proposals >= cfg.maxProposalsPerRun) break;
        stats.projects += 1;
        let view;
        try {
          view = await this.memoryConsolidation(projectId, { limit: cfg.maxProposalsPerProject });
        } catch {
          stats.errors += 1;
          continue;
        }
        for (const candidate of view.candidates || []) {
          if (stats.proposals >= cfg.maxProposalsPerRun) break;
          const sources = (candidate.notes || []).map(note => note.source).filter(Boolean);
          if (sources.length < 2) continue;
          stats.candidates += 1;
          try {
            const result = await this.proposeMerge(projectId, { first: sources[0], second: sources[1], reason: 'консолидация: scheduler' });
            if (result.existing) stats.existing += 1;
            else stats.proposals += 1;
          } catch {
            stats.errors += 1;
          }
        }
      }
      return stats;
    } finally {
      this.memoryConsolidationRunning = false;
    }
  }

  // R3.6: a Pi left running by a previous TaskBridge (crash, taskkill of the
  // parent only) would keep writing the session file behind our back. Its pid
  // and start time are in the task; the start time tells it apart from an
  // unrelated process that got the same pid later.
  async #killOrphanPis(tasks) {
    const recorded = tasks.filter(task => Number.isInteger(task.piPid) && task.piStartedAt);
    if (!recorded.length) return;
    const list = await listProcesses({ fresh: true });
    for (const task of recorded) {
      // Запись может прийти из ЧУЖОГО каталога данных: копия базы (бэкап, замер,
      // второй стенд) несёт pids Pi, которые живы и принадлежат работающему
      // TaskBridge. Убить их — значит оборвать живые сессии в другом каталоге.
      // Признак принадлежности: файл сессии Pi лежит внутри НАШЕГО dataRoot.
      // 2026-10-14 это стоило двух оборванных сессий при замере на копии базы.
      const foreign = !piBelongsToDataRoot(task, this.dataRoot);
      if (foreign) {
        console.warn(`[TaskBridge] не убиваю Pi задачи ${task.id} (pid ${task.piPid}): её файл сессии лежит вне этого каталога данных (${task.piSessionFile})`);
      } else {
        const alive = await sameProcess(task.piPid, task.piStartedAt, { list });
        if (alive) {
          console.warn(`[TaskBridge] killing orphan Pi of task ${task.id}: pid ${task.piPid}`);
          await killTreeByPid(task.piPid);
        }
      }
      task.piPid = null;
      task.piStartedAt = null;
      await this.store.save(this.#publicTask(task)).catch(() => {});
    }
  }

  // Graceful shutdown of the agent side: stop taking new work, stop the queue
  // timer, drain any pump that is already in flight (so it cannot write to the
  // store after we close it), then close each live Pi session (close stdin,
  // force-kill the process tree if it does not exit in time, mirroring
  // RuntimeControl.closePi) and stop the always-on router. Tolerant by design:
  // shutdown must never throw its way to process.exit. The cloud worker / relay
  // are owned by the caller (the server / future host) and are closed separately.
  async close() {
    this.closing = true;
    try { this.memoryProvider?.closeIndex(); } catch { /* индекс — кэш, его потеря не важна */ }
    if (this.memoryConsolidationTimer) { clearInterval(this.memoryConsolidationTimer); this.memoryConsolidationTimer = null; }
    this.queuePump.stopPolling();
    await this.#drainPump(2000);
    // A queued #event write that is still pending here would fire after the
    // caller closes the SQLite handle and crash ("reading 'exec' of null"),
    // so close() waits for the event chains to drain first.
    await Promise.allSettled([...this.eventWrites.values()]);
    for (const [taskId, entry] of this.runtimes) {
      try {
        if (entry?.eventChain) await entry.eventChain;
        const pi = entry?.pi;
        if (!pi || pi.closed) continue;
        // EOF is an intentional server shutdown, not a Pi crash. Raise the
        // guard before closeStdin(): Pi may emit close(code=0) immediately.
        entry.retired = true;
        entry.cancelRequested = true;
        const proc = pi.proc;
        pi.closeStdin();
        if (proc) {
          const exited = await this.#waitProcessClose(proc, 2500);
          if (!exited) await pi.killTree();
        }
      } catch { /* best effort during shutdown */ }
      if (this.runtimes.get(taskId) === entry) this.runtimes.delete(taskId);
    }
    try {
      if (this.localModels?.enabled) await this.localModels.stop();
    } catch { /* best effort */ }
    // eventChain drained above may have enqueued more #event writes; a second
    // pass keeps close() from returning in front of its own background writes.
    await Promise.allSettled([...this.eventWrites.values()]);
  }

  // Waits until an in-flight pump has finished (bounded), so store.write from a
  // pump cannot race store.close(). The pump aborts promptly because closing is
  // latched and #executeInitial/#setStatus early-return on it.
  async #drainPump(timeoutMs) { return this.queuePump.drain(timeoutMs); }

  // Resolves when a child process has exited, else false after `ms`.
  #waitProcessClose(proc, ms) {
    if (!proc || proc.exitCode != null || proc.signalCode != null) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = result => { clearTimeout(timer); proc.removeListener('close', onClose); resolve(result); };
      const onClose = () => finish(true);
      const timer = setTimeout(() => finish(false), ms);
      proc.once('close', onClose);
      if (proc.exitCode != null || proc.signalCode != null) finish(true);
    });
  }

  // Directories left behind by a crash or by an older version that did not clean
  // up on delete. Only entries whose id is unknown to the store are touched.
  async #sweepOrphans() {
    for (const area of ['pi-sessions', 'workspaces', 'worktrees']) {
      const root = path.join(this.dataRoot, area);
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || this.tasks.has(entry.name)) continue;
        await fs.rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => {});
      }
    }
    // Lock sidecars live next to the *native* Pi sessions in the operator's home,
    // not under dataRoot, so the loop above never sees them. A crash leaves one
    // behind and no other code path removes it (acquireNativeLease recovers only
    // when the same pid is reused), permanently blocking that session.
    await sweepOrphanLocks(this.nativeSessions.allRoots()).catch(() => 0);
  }

  // VACUUM rewrites the entire database and needs exclusive access, so it is
  // only worth doing when nothing is running. The size check is what keeps an
  // ordinary delete cheap: without it every removal would pay for a full
  // rewrite of a multi-gigabyte file. Threshold is configurable; 512 MiB matches
  // the observed steady state where a stale 2 GiB file still weighs more than
  // the sessions it holds.
  async #maybeVacuum() {
    const thresholdMb = Number(this.config.storage?.vacuumThresholdMb) || 512;
    if (this.runtimes.size || this.queue.length || this.admitting) return;
    let stat;
    try { stat = await fs.stat(this.store.dbPath); } catch { return; }
    if (stat.size < thresholdMb * 1024 * 1024) return;
    await this.store.vacuum().catch(() => {});
  }

  // Never recurse outside the given root, even if a task carries a bogus path.
  async #removeInside(root, target) {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    const relative = path.relative(resolvedRoot, resolvedTarget);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
    await fs.rm(resolvedTarget, { recursive: true, force: true }).catch(() => {});
  }

  listProjects() {
    return Array.from(this.projects.values()).map(({ id, name, path: projectPath, useWorktree }) => ({
      id, name, path: projectPath, useWorktree: useWorktree !== false
    }));
  }

  registerProject(project) {
    if (this.projects.has(project.id)) throw Object.assign(new Error('Проект с таким именем уже существует.'), { code: 'INPUT_INVALID' });
    this.projects.set(project.id, project);
    this.config.projects = [...(this.config.projects || []), project];
  }

  // Only removes the registration, never the folder on disk. Existing tasks
  // for this project keep working (they already have their own
  // workspacePath); only creating a *new* task under this id stops working.
  removeProject(id) {
    if (!this.projects.has(id)) throw Object.assign(new Error('Проект не найден.'), { code: 'NOT_FOUND' });
    this.projects.delete(id);
    this.config.projects = (this.config.projects || []).filter(p => p.id !== id);
  }

  listTasks() {
    // `events` lets the sessions screen show and sort by size; one grouped count
    // keeps it cheap even with hundreds of sessions. `sizeBytes` is the on-disk
    // footprint of the session (tasks + pi-sessions + workspaces folders); it is
    // read from the cache and refreshed in the background so this call stays
    // synchronous and cheap, even with hundreds of sessions.
    this.#refreshSessionSizes().catch(() => {});
    const counts = this.store.eventCounts();
    const sizes = this.sessionSizes;
    return Array.from(this.tasks.values())
      .map(t => ({ ...this.#publicTask(t), events: counts.get(t.id) || 0, sizeBytes: sizes.get(t.id) ?? null }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // --- project dashboard (MR-01) ----------------------------------------------
  //
  // Everything the dashboard needs is computed from the two things that already
  // exist — the project registry and the sessions — so there is no second source
  // of truth: only the view preferences (pinned/archived) are stored, and they
  // live in SQLite so they survive a restart of the server.

  /** A session is "working" while its status is not terminal — the same rule the clients use. */
  static #isWorking(status) {
    return !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status);
  }

  /**
   * The dashboard's «needs attention»: sessions that will not move without the
   * operator — a session that failed, and one waiting for an answer of its own
   * (a dialog or an approval). A running session is not attention, it is «working».
   */
  static #needsAttention(status) {
    return status === 'FAILED' || status === 'WAITING_USER';
  }

  /** Read-only view of pi-memory-md for the Knowledge Inspector and resume preview. */
  async projectMemory(projectId, { query = null } = {}) {
    const project = this.projects.get(projectId);
    if (!project) throw Object.assign(new Error('Проект не найден.'), { code: 'PROJECT_NOT_FOUND' });
    const overview = await this.memoryProvider.inspect(project);
    const collisions = await this.#memoryCollisions(project.id);
    const ambiguous = collisions.length > 0;
    const proposals = proposalCounts(await listProposals(overview.memoryDir));
    // Этап M2: инспектору нужны не только имена файлов, но и то, чем живёт
    // инъекция — сколько раз запись использовалась, когда в последний раз, и в
    // какой бюджет она обязана влезть. Это метаданные индекса, не содержимое.
    const started = Date.now();
    const notes = await this.memoryProvider.indexedNotes(project).catch(() => []);
    const global = await this.memoryProvider.globalEntries({ limit: 200 }).catch(() => []);
    // M3: метрики памяти — «сколько заметок» и «сколько предложений ждёт человека»
    // видны в /api/metrics, а не только на экране.
    memoryMetrics.recordSearch(Date.now() - started);
    memoryMetrics.setGauge('notes_total', notes.length + global.length);
    memoryMetrics.setGauge('proposals_pending', proposals.pending ?? 0);
    const found = {
      ...overview,
      collisions,
      proposals,
      notes,
      index: await this.memoryProvider.indexStatus(project).catch(error => ({ available: false, error: error.message })),
      budget: {
        indexTokens: Number(this.config.memory?.indexBudgetTokens) > 0
          ? Number(this.config.memory.indexBudgetTokens)
          : INDEX_BUDGET_TOKENS,
        globalTokens: Number(this.config.memory?.globalBudgetTokens) > 0
          ? Number(this.config.memory.globalBudgetTokens)
          : GLOBAL_BUDGET_TOKENS,
        approxTokens: overview.approxTokens,
        // Предупреждение о бюджете: индекс проекта больше того, что уйдёт в контекст.
        overBudget: Number(overview.approxTokens || 0) > (Number(this.config.memory?.indexBudgetTokens) > 0
          ? Number(this.config.memory.indexBudgetTokens)
          : INDEX_BUDGET_TOKENS),
      },
      global: { entries: global.length, approxTokens: global.reduce((sum, entry) => sum + (entry.estimatedTokens || 0), 0) },
      // The inspector is the same read path the resume uses: what is not safe to
      // hand to an agent is not shown here as «the project's knowledge» either.
      ...(ambiguous ? { status: 'ambiguous', warnings: [ambiguousMemoryWarning(collisions)] } : {}),
    };
    // No `q` at all is the overview — the inspector asks for a search explicitly.
    // An EMPTY `q` is still a search (the input field the operator just cleared),
    // and answers with the first entries rather than with a different shape.
    if (query === null || query === undefined) return found;
    if (ambiguous) return { ...found, query: String(query), hits: [] };
    const hits = await this.memoryProvider.search(project, query, { limit: 20 });
    return { ...found, query: String(query), hits };
  }

  /**
   * Кандидаты на слияние заметок (этап M3). Только чтение: файлы памяти не меняются,
   * решение принимает человек через гейт предложений.
   */
  async memoryConsolidation(projectId, { threshold = null, limit = 10 } = {}) {
    const { project } = await this.#memoryProject(projectId);
    const entries = await this.memoryProvider.searchableEntries(project).catch(() => []);
    // Пустой параметр — это «порог по умолчанию», а не ноль: `Number(null)` равен 0, и
    // без этой проверки в кандидаты попадало всё подряд (поймано проверкой API).
    const requested = threshold === null || threshold === undefined || String(threshold).trim() === ''
      ? null
      : Number(threshold);
    const effective = requested !== null && Number.isFinite(requested) ? requested : MERGE_THRESHOLD_DEFAULT;
    const started = Date.now();
    const candidates = findMergeCandidates(entries, { threshold: effective, limit });
    memoryMetrics.recordSearch(Date.now() - started);
    return {
      projectId,
      notes: entries.length,
      threshold: effective,
      candidates,
      // План прямо говорит: консолидатор создаёт ПРЕДЛОЖЕНИЕ, а не правку. Поэтому в
      // ответе нет ни одного признака «уже изменено».
      action: 'propose',
    };
  }

  /**
   * Оформляет пару кандидатов предложением на слияние — тем же гейтом, что и всё
   * остальное в памяти. Ничего не пишется в core/ до явного «Принять».
   */
  async proposeMerge(projectId, { first, second, reason = null } = {}) {
    const sources = [first, second].map(value => String(value || '').trim()).filter(Boolean);
    if (sources.length !== 2) {
      throw Object.assign(new Error('Нужны две заметки: first и second.'), { code: 'INPUT_INVALID' });
    }
    const { project } = await this.#memoryProject(projectId);
    const entries = await this.memoryProvider.searchableEntries(project).catch(() => []);
    // Пару ищем без порога (нужна её оценка), а порог проверяем здесь: иначе «слить»
    // можно было бы любые две заметки, и предложение стало бы шумом.
    const pair = findMergeCandidates(entries, { threshold: 0, limit: 200 })
      .find(candidate => sources.every(source => candidate.notes.some(note => note.source === source)));
    if (!pair) {
      throw Object.assign(new Error('Одна из заметок не найдена в памяти проекта.'), { code: 'NOT_FOUND' });
    }
    if (pair.score < MERGE_THRESHOLD_DEFAULT) {
      throw Object.assign(
        new Error(`Заметки не похожи (сходство ${pair.score} < ${MERGE_THRESHOLD_DEFAULT}) — слияние не предлагается.`),
        { code: 'NOT_SIMILAR', score: pair.score },
      );
    }
    const existing = await this.#pendingMergeProposal(projectId, sources);
    if (existing) return { proposal: existing, existing: true, problems: [] };
    return this.createMemoryProposal(projectId, {
      text: mergeProposalText(pair),
      category: pair.notes[0].category,
      paths: [],
      reason: reason ? String(reason) : `консолидация: ${sources[0]} + ${sources[1]}`,
    });
  }

  async #pendingMergeProposal(projectId, sources) {
    const normalized = sources.map(source => String(source || '').trim()).filter(Boolean).sort();
    if (normalized.length !== 2) return null;
    const { proposals } = await this.listMemoryProposals(projectId);
    return proposals.find(proposal => proposal.status === 'proposed'
      && String(proposal.reason || '').startsWith('консолидация:')
      && normalized.every(source => String(proposal.text || '').includes(source))) || null;
  }

  /**
   * Очередь предложений по всем проектам (этап M2): человеку нужен один список  /**
   * Очередь предложений по всем проектам (этап M2): человеку нужен один список
   * «что ждёт решения», а не обход проектов по одному. `projectId` сужает выборку.
   */
  async listAllMemoryProposals({ projectId = null } = {}) {
    const projects = projectId
      ? [[projectId, this.projects.get(projectId)]]
      : [...this.projects.entries()];
    if (projectId && !this.projects.has(projectId)) {
      throw Object.assign(new Error('Проект не найден.'), { code: 'PROJECT_NOT_FOUND' });
    }
    const items = [];
    const totals = { pending: 0, accepted: 0, rejected: 0, projects: 0 };
    for (const [id, project] of projects) {
      if (!project) continue;
      const resolved = await this.memoryProvider.resolveProject(project).catch(() => null);
      if (!resolved || !fsSync.existsSync(resolved.memoryDir)) continue;
      const proposals = await listProposals(resolved.memoryDir).catch(() => []);
      if (!proposals.length) continue;
      totals.projects += 1;
      const counts = proposalCounts(proposals);
      totals.pending += counts.pending || 0;
      totals.accepted += counts.accepted || 0;
      totals.rejected += counts.rejected || 0;
      for (const proposal of proposals) items.push({ ...proposal, projectId: id });
    }
    return { proposals: items, counts: totals };
  }

  /**
   * Поиск по индексу памяти (этап M2): `scope=project|global|all`.
   *
   * `all` — это режим cross-project: он не инжектится в контекст сам по себе
   * (риск загрязнения), но человеку и тулзе виден — с пометкой происхождения.
   */
  async searchMemory({ query = '', scope = 'project', projectId = null, limit = 20 } = {}) {
    const text = String(query || '').trim();
    if (!text) throw Object.assign(new Error('Нужен запрос: ?q='), { code: 'INPUT_INVALID' });
    if (!['project', 'global', 'all'].includes(scope)) {
      throw Object.assign(new Error('Скоуп — project, global или all.'), { code: 'INPUT_INVALID' });
    }
    const project = projectId ? this.projects.get(projectId) : null;
    if (projectId && !project) throw Object.assign(new Error('Проект не найден.'), { code: 'PROJECT_NOT_FOUND' });
    const searchStarted = Date.now();
    const hits = await this.memoryProvider.searchScope(text, { scope, project, limit });
    memoryMetrics.recordSearch(Date.now() - searchStarted);
    const global = scope === 'project'
      ? await this.memoryProvider.globalEntries({ limit: 0 }).catch(() => [])
      : [];
    return {
      query: text,
      scope,
      projectId: project?.id ?? null,
      hits,
      // Происхождение пометок видно вызывающему: это не «всё подряд», а выбор
      // оператора (этап M2 — индикатор «в этом чате использовано N заметок»).
      counts: {
        hits: hits.length,
        project: hits.filter(hit => hit.scope !== 'global').length,
        global: hits.filter(hit => hit.scope === 'global').length,
        globalAvailable: global.length,
      },
    };
  }

  // --- memory suggestions (MEM-08) --------------------------------------------
  //
  // Один путь записи — и он не агентский: предложение падает в изолированный буфер
  // (`.memory-proposals/`, вне `core`), в `pi-memory-md` его заносит только явное
  // принятие человеком, и только если детерминированные проверки чисты.

  async #memoryProject(projectId) {
    const project = this.projects.get(projectId);
    if (!project) throw Object.assign(new Error('Проект не найден.'), { code: 'PROJECT_NOT_FOUND' });
    const resolved = await this.memoryProvider.resolveProject(project);
    return { project, resolved };
  }

  async listMemoryProposals(projectId) {
    const { resolved } = await this.#memoryProject(projectId);
    const proposals = await listProposals(resolved.memoryDir);
    return { proposals, counts: proposalCounts(proposals) };
  }

  async createMemoryProposal(projectId, input = {}) {
    const { resolved } = await this.#memoryProject(projectId);
    const proposal = await createProposal(resolved.memoryDir, input);
    // Что не пройдёт проверку при принятии — видно сразу, но ничего не отменяет:
    // предложение уже лежит в буфере и ждёт человека.
    const { existingText } = await this.#memoryTexts(resolved);
    const fileIndex = await projectFileIndex(resolved.projectPath);
    return { proposal, problems: validateProposal(proposal, { existingText, projectPath: resolved.projectPath, fileIndex }).problems };
  }

  async acceptMemoryProposal(projectId, proposalId) {
    const { resolved } = await this.#memoryProject(projectId);
    const { existingText } = await this.#memoryTexts(resolved);
    const fileIndex = await projectFileIndex(resolved.projectPath);
    const result = await acceptProposal(resolved.memoryDir, proposalId, { existingText, projectPath: resolved.projectPath, fileIndex });
    if (!result.ok) {
      const code = result.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INPUT_INVALID';
      throw Object.assign(new Error(result.problems.map(problem => problem.message).join('; ')), {
        code,
        problems: result.problems,
      });
    }
    return result;
  }

  async rejectMemoryProposal(projectId, proposalId, { reason = null } = {}) {
    const { resolved } = await this.#memoryProject(projectId);
    const result = await rejectProposal(resolved.memoryDir, proposalId, { reason });
    if (!result.ok) {
      throw Object.assign(new Error(result.problems.map(problem => problem.message).join('; ')), { code: 'INPUT_INVALID' });
    }
    return result;
  }

  /** Нормализованные тексты того, что проект уже знает: только для проверки дублей. */
  async #memoryTexts(resolved) {
    const entries = await this.memoryProvider.allEntries({ path: resolved.projectPath }).catch(() => []);
    return { existingText: entries.map(entry => String(entry.text || '').toLowerCase().replace(/\s+/gu, ' ').trim()) };
  }

  /**
   * Projects of this machine whose canonical roots share one memory directory.
   * Only two DIFFERENT repositories count — a project registered twice under the
   * same root is not a collision, it is the same project.
   */
  async #memoryCollisions(projectId) {
    const resolved = await this.memoryProvider.resolveProjects([...this.projects.values()]).catch(() => []);
    return memoryCollisions(resolved).filter(entry => entry.projects.some(project => project.projectId === projectId));
  }

  /**
   * One row per registered project plus the sessions of projects that are not in
   * the registry any more. Removing a registration never deletes its sessions
   * (see `removeProject`), so those sessions are counted instead of hidden:
   * `unassignedSessions` is what the operator would otherwise think they lost.
   */
  projectOverview() {
    const preferences = this.store.projectViewPreferences();
    const workItems = this.store.workItemCounts();
    const sessions = new Map();
    let unassigned = 0;
    for (const task of this.tasks.values()) {
      const id = task.projectId || null;
      if (!id) { unassigned += 1; continue; }
      const row = sessions.get(id) || { sessions: 0, working: 0, needsAttention: 0, lastActivityAt: null };
      row.sessions += 1;
      if (TaskManager.#isWorking(task.status)) row.working += 1;
      if (TaskManager.#needsAttention(task.status)) row.needsAttention += 1;
      const at = task.updatedAt || task.createdAt || null;
      if (at && (row.lastActivityAt === null || at > row.lastActivityAt)) row.lastActivityAt = at;
      sessions.set(id, row);
    }
    const projects = Array.from(this.projects.values()).map(project => {
      const row = sessions.get(project.id) || { sessions: 0, working: 0, needsAttention: 0, lastActivityAt: null };
      sessions.delete(project.id);
      const preference = preferences.get(project.id);
      const work = workItems.get(project.id) || { total: 0, open: 0 };
      return {
        id: project.id,
        name: project.name,
        path: project.path,
        useWorktree: project.useWorktree !== false,
        pinned: preference?.pinned === true,
        archived: preference?.archived === true,
        sessions: row.sessions,
        working: row.working,
        needsAttention: row.needsAttention,
        // MR-02: what the roadmap calls «Active work» — the work items still open.
        workItems: work.total,
        activeWork: work.open,
        lastActivityAt: row.lastActivityAt,
      };
    });
    // What is left over belongs to projects removed from the registry.
    for (const row of sessions.values()) unassigned += row.sessions;
    projects.sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || ''))
      || a.name.localeCompare(b.name));
    const openWork = Array.from(workItems.values()).reduce((sum, counts) => sum + counts.open, 0);
    return {
      projects,
      unassignedSessions: unassigned,
      totals: {
        projects: projects.length,
        pinned: projects.filter(project => project.pinned).length,
        archived: projects.filter(project => project.archived).length,
        sessions: Array.from(this.tasks.values()).length,
        working: Array.from(this.tasks.values()).filter(task => TaskManager.#isWorking(task.status)).length,
        needsAttention: Array.from(this.tasks.values()).filter(task => TaskManager.#needsAttention(task.status)).length,
        workItems: Array.from(workItems.values()).reduce((sum, counts) => sum + counts.total, 0),
        activeWork: openWork,
      },
    };
  }

  /**
   * The sessions of one project, filtered, sorted and paged server-side so a phone
   * does not pull every conversation of a big project to show a list.
   *
   * An id the registry does not know is NOT a 404: sessions of a removed project
   * must stay reachable, and the answer says so with `registered: false`.
   */
  projectSessions(projectId, { query = null, status = null, sort = null, limit = 50, offset = 0 } = {}) {
    const id = String(projectId);
    const needle = String(query || '').trim().toLowerCase();
    const wanted = String(status || '').trim().toUpperCase();
    let rows = this.listTasks().filter(task => (task.projectId || '') === id);
    if (wanted) rows = rows.filter(task => String(task.status || '').toUpperCase() === wanted);
    if (needle) {
      rows = rows.filter(task => `${task.title || ''}\n${task.prompt || ''}`.toLowerCase().includes(needle));
    }
    if (sort === 'created') rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    else if (sort === 'title') rows.sort((a, b) => String(a.title || a.prompt || '').localeCompare(String(b.title || b.prompt || ''), 'ru'));
    else if (sort === 'size') rows.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    else rows.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    const total = rows.length;
    const items = rows.slice(offset, offset + limit).map(briefTask);
    return {
      projectId: id,
      registered: this.projects.has(id),
      items,
      total,
      offset,
      limit,
      endReached: offset + items.length >= total,
    };
  }

  /** Pinned/archived of one project. Refuses an id the registry does not know. */
  setProjectPreferences(projectId, patch = {}) {
    const id = String(projectId);
    if (!this.projects.has(id)) throw Object.assign(new Error('Проект не найден.'), { code: 'NOT_FOUND' });
    return this.store.setProjectViewPreferences(id, patch);
  }

  // --- work items (MR-02) -----------------------------------------------------
  //
  // A Work Item is the semantic state of the work: what we are trying to do, the
  // criteria of done, and where it stands. It is deliberately NOT a container:
  // no prompt, no chat history, no diff, no tool output, no resumeContext (see
  // docs/api-contract.md). The sessions that did the work are linked separately
  // (MR-03).

  /** The statuses that mean «still to do» — what the dashboard counts as open work. */
  static #isOpenWork(status) {
    return status !== 'DONE' && status !== 'CANCELLED';
  }

  listWorkItems({ projectId = null, status = null, includeClosed = true } = {}) {
    const wanted = status ? WorkItem.parseStatus(status) : null;
    return this.store.listWorkItems(projectId)
      .filter(item => (wanted === null || item.status === wanted))
      .filter(item => includeClosed || TaskManager.#isOpenWork(item.status));
  }

  getWorkItem(id) {
    const item = this.store.getWorkItem(id);
    if (!item) throw Object.assign(new Error('Задача не найдена.'), { code: 'NOT_FOUND' });
    return item;
  }

  /**
   * Creates a Work Item. [projectId] must be a registered project — a work item
   * nobody can open is worse than a refusal — but the item outlives the
   * registration, exactly like a session does.
   */
  createWorkItem(input = {}) {
    const projectId = String(input.projectId || '').trim();
    if (!projectId) throw Object.assign(new Error('Укажите проект.'), { code: 'INPUT_INVALID' });
    if (!this.projects.has(projectId)) throw Object.assign(new Error('Проект не найден.'), { code: 'PROJECT_NOT_FOUND' });
    const title = String(input.title || '').trim();
    if (!title) throw Object.assign(new Error('У задачи должен быть заголовок.'), { code: 'INPUT_INVALID' });
    const at = now();
    const status = input.status === undefined ? 'BACKLOG' : WorkItem.parseStatus(input.status);
    return this.store.createWorkItem({
      id: `wi-${shortId()}`,
      projectId,
      title: title.slice(0, 300),
      goal: input.goal === undefined || input.goal === null ? null : String(input.goal).slice(0, 4000),
      status,
      priority: WorkItem.priority(input.priority),
      acceptanceCriteria: WorkItem.stringList(input.acceptanceCriteria, 50, 500),
      tags: WorkItem.stringList(input.tags, 20, 60),
      createdAt: at,
      updatedAt: at,
      completedAt: status === 'DONE' ? at : null,
    });
  }

  /** A partial update: an absent field keeps its value, `null` clears a nullable one. */
  updateWorkItem(id, patch = {}) {
    const current = this.store.getWorkItem(id);
    if (!current) throw Object.assign(new Error('Задача не найдена.'), { code: 'NOT_FOUND' });
    const fields = {};
    if (patch.title !== undefined) {
      const title = String(patch.title || '').trim();
      if (!title) throw Object.assign(new Error('У задачи должен быть заголовок.'), { code: 'INPUT_INVALID' });
      fields.title = title.slice(0, 300);
    }
    if (patch.goal !== undefined) fields.goal = patch.goal === null ? null : String(patch.goal).slice(0, 4000);
    if (patch.status !== undefined) fields.status = WorkItem.parseStatus(patch.status);
    if (patch.priority !== undefined) fields.priority = WorkItem.priority(patch.priority);
    if (patch.acceptanceCriteria !== undefined) fields.acceptanceCriteria = WorkItem.stringList(patch.acceptanceCriteria, 50, 500);
    if (patch.tags !== undefined) fields.tags = WorkItem.stringList(patch.tags, 20, 60);
    const updated = this.store.updateWorkItem(id, fields);
    if (!updated) throw Object.assign(new Error('Задача не найдена.'), { code: 'NOT_FOUND' });
    return updated;
  }

  deleteWorkItem(id) {
    const removed = this.store.deleteWorkItem(id);
    if (!removed) throw Object.assign(new Error('Задача не найдена.'), { code: 'NOT_FOUND' });
    this.store.removeWorkItemLinks(id);
    return removed;
  }

  // --- work item ↔ sessions (MR-03) -------------------------------------------
  //
  // One work item outlives several independent sessions, and this is NOT the
  // `runs` table: runs belong to one session (a session has many runs), while a
  // work item groups sessions. Keeping them apart is what makes «continue this
  // work in a clean session» possible later (MR-04).

  /**
   * Links a session to a work item. Both sides must exist: a link to a session
   * nobody can open is a broken promise for the whole work item.
   */
  linkWorkItemSession(workItemId, sessionId, relation = null) {
    const item = this.store.getWorkItem(workItemId);
    if (!item) throw Object.assign(new Error('Задача не найдена.'), { code: 'NOT_FOUND' });
    const id = String(sessionId || '').trim();
    if (!id) throw Object.assign(new Error('Укажите сессию.'), { code: 'INPUT_INVALID' });
    if (!this.tasks.has(id)) throw Object.assign(new Error('Сессия не найдена.'), { code: 'SESSION_NOT_FOUND' });
    return this.store.linkWorkItemSession(item.id, id, WorkItem.parseRelation(relation));
  }

  /** Removes one link. A link that is not there is not an error — the outcome asked for. */
  unlinkWorkItemSession(workItemId, sessionId) {
    if (!this.store.getWorkItem(workItemId)) throw Object.assign(new Error('Задача не найдена.'), { code: 'NOT_FOUND' });
    const removed = this.store.unlinkWorkItemSession(workItemId, String(sessionId || ''));
    return { removed: removed !== null };
  }

  /**
   * A work item with the sessions that did the work: the shape the UI and the
   * resume preview need. Session facts stay facts — status, title, when it last
   * moved — and nothing is copied into the work item.
   */
  workItemDetail(id) {
    const item = this.getWorkItem(id);
    return { ...item, sessions: this.#workItemSessionViews(item.id) };
  }

  #workItemSessionViews(workItemId) {
    return this.store.workItemSessions(workItemId).map(link => {
      const task = this.tasks.get(link.sessionId);
      const events = task ? this.store.eventCounts().get(task.id) : null;
      return {
        ...link,
        // A session deleted behind our back (another device, a wiped data dir)
        // must be visible as such instead of silently vanishing from the list.
        available: Boolean(task),
        status: task?.status ?? null,
        title: task?.title ?? null,
        prompt: task ? (task.prompt || '').slice(0, 200) : null,
        projectId: task?.projectId ?? null,
        updatedAt: task?.updatedAt ?? null,
        events: events ?? 0,
      };
    });
  }

  // --- resume engine (MR-04) --------------------------------------------------
  //
  // «Continue this work in a clean session»: build the context from the work item,
  // its sessions and their recaps, show it, then start a NEW short session from a
  // rendered brief. The context is computed every time and never stored — the only
  // durable trace is the new session's own `resumeFrom`.

  /** Reads every input a resume context is built from. No model, no invention. */
  async resumeInputs(workItemId, { strategy = 'fresh-worktree', memoryMode = 'native', sessionIds = null } = {}) {
    const item = this.getWorkItem(workItemId);
    const wanted = Array.isArray(sessionIds) && sessionIds.length ? new Set(sessionIds.map(String)) : null;
    const links = this.store.workItemSessions(item.id).filter(link => !wanted || wanted.has(link.sessionId));
    const sessions = [];
    const artifacts = [];
    const missingWorkspaces = [];
    const interrupted = [];
    let chosen = null;

    for (const link of links) {
      const task = this.tasks.get(link.sessionId);
      if (!task) {
        // A session deleted elsewhere: the link stays visible and says so, and it is
        // NOT replaced by the project's main checkout — that would hide the loss.
        sessions.push(sessionSummary({ sessionId: link.sessionId, relation: link.relation, available: false }));
        continue;
      }
      const saved = readSavedRecap(this.store.taskDir(task.id));
      const derived = deriveRecap(task, { recap: saved });
      // The same marking as in the recap view: what the session claims stays a claim
      // unless TaskBridge observed that very command itself.
      const recap = {
        ...derived.recap,
        verification: reconcileVerification(derived.recap.verification, task.verification),
        source: derived.source,
        updatedAt: saved?.updatedAt ?? null,
      };
      const files = await this.#artifactIndex(task.id);
      const diff = files.find(entry => entry.name === 'diff.patch');
      const workspacePath = task.workspacePath && fsSync.existsSync(task.workspacePath) ? task.workspacePath : null;
      if (task.workspacePath && !workspacePath) missingWorkspaces.push(task.id);
      // The newest session that still has a workspace is what «current state» means:
      // its worktree is where the unfinished work actually is.
      if (workspacePath && !chosen) chosen = { path: workspacePath, task };
      sessions.push(sessionSummary({
        sessionId: link.sessionId,
        relation: link.relation,
        available: true,
        title: task.title,
        prompt: task.prompt,
        status: task.status,
        updatedAt: task.updatedAt,
        changedFiles: task.git?.changedFiles,
        verification: (task.verification || []).map(entry => `${entry.ok ? 'PASS' : 'FAIL'}: ${entry.command}`),
      }, { recap, diffBytes: diff?.bytes ?? null }));
      for (const entry of files) artifacts.push({ sessionId: task.id, name: entry.name, bytes: entry.bytes });
      // A session that stopped WITHOUT success is where the work was left half-done.
      // Nothing extra is written for this: the facts are the session's own record
      // plus the state of the folder it worked in — an «crash journal» that cannot
      // go stale because it is not a copy.
      if (INTERRUPTED_STATUSES.includes(task.status)) {
        interrupted.push(await this.#interruptedAttempt(task, { workspacePath }));
      }
    }

    // Git facts come from the chosen workspace, and only from it. When there is
    // none, the context says so instead of showing an empty «current state».
    let workspace = { path: null, head: null, worktree: false, changedFiles: [], truncated: false };
    if (chosen) {
      const state = await collectGitState(chosen.path);
      workspace = {
        path: chosen.path,
        head: await this.#headOf(chosen.path),
        worktree: chosen.task.worktree === true,
        sourcePath: chosen.task.sourcePath ?? null,
        changedFiles: state.changedFiles || [],
        truncated: state.truncated === true,
      };
    }

    const newest = sessions.find(session => session.available) ?? null;
    const commands = (newest?.verification ?? []).map(text => {
      const [mark, ...rest] = String(text).split(':');
      return { ok: mark === 'PASS', command: rest.join(':').trim() };
    });
    const project = this.projects.get(item.projectId) || { id: item.projectId };
    // Two different repositories sharing one memory directory is not a curiosity to
    // mention in passing: whichever hits came out of it may belong to the OTHER
    // project. So the retrieval is skipped rather than filtered — an empty memory
    // with an honest reason is worth more than knowledge of unknown ownership.
    const collisions = memoryMode === 'native' ? await this.#memoryCollisions(item.projectId) : [];
    const memoryFacts = memoryMode !== 'native' ? null
      : collisions.length ? {
        overview: {
          provider: 'pi-memory-md',
          status: 'ambiguous',
          write: 'SAVE_DISABLED',
          problems: ['project memory directory is shared with another repository'],
          collisions,
        },
        hits: [],
        estimatedTokens: 0,
        warnings: [ambiguousMemoryWarning(collisions)],
      } : await this.memoryProvider.relevant(project, {
        queries: resumeMemoryQueries(item, sessions, workspace),
        // Этап M1: бюджет инъекции из конфига (memory.indexBudgetTokens, дефолт 2000).
        // Не влезшие заметки не теряются — они доступны поиском, а причина видна
        // в warnings и в overflow.
        budgetTokens: Number(this.config.memory?.indexBudgetTokens) > 0
          ? Number(this.config.memory.indexBudgetTokens)
          : INDEX_BUDGET_TOKENS,
        // Глобальные знания идут своим мини-бюджетом (план §1.5): они не вытесняют
        // знание проекта и не теряются за ним.
        globalBudgetTokens: Number(this.config.memory?.globalBudgetTokens) > 0
          ? Number(this.config.memory.globalBudgetTokens)
          : GLOBAL_BUDGET_TOKENS,
        limit: 8,
      }).catch(error => ({
        overview: { provider: 'pi-memory-md', status: 'error', write: 'SAVE_DISABLED', problems: [error.message] },
        hits: [],
        warnings: [error.message],
      }));
    // Метрики памяти: «работает ли память» и «упирается ли в бюджет» перестают быть
    // гаданием (план §1.5). Счётчики видны в /api/metrics → memory. Записываются
    // только когда память действительно опрашивалась (native-режим).
    if (memoryFacts) {
      memoryMetrics.recordInjection({
        notes: (memoryFacts.hits || []).filter(hit => hit.scope !== 'global').length,
        tokens: memoryFacts.estimatedTokens || 0,
        globalNotes: (memoryFacts.hits || []).filter(hit => hit.scope === 'global').length,
        globalTokens: memoryFacts.globalTokens || 0,
      });
      if (memoryFacts.overflow) memoryMetrics.recordOverflow(memoryFacts.overflow);
    }
    const context = buildResumeContext({
      workItem: item,
      sessions,
      workspace: { ...workspace, strategy },
      verification: {
        // The outcome belongs to the session the workspace came from, which is the
        // one whose work the new session continues.
        status: commands.length ? (chosen?.task?.verificationStatus ?? null) : null,
        commands,
      },
      artifacts,
      interrupted,
      memory: memoryFacts ? { mode: memoryMode, ...memoryFacts } : { mode: memoryMode },
      strategy,
    });
    return {
      item,
      context,
      missingWorkspaces,
      interrupted,
      sessionsWithoutRecap: sessions.filter(session => session.recap?.source !== 'saved').map(session => session.sessionId),
    };
  }


  /**
   * Where a stopped session left the work: its own last event, its error and the
   * current state of the folder it was working in. Read, not stored — a copy would
   * be one more thing that can disagree with reality.
   */
  async #interruptedAttempt(task, { workspacePath = null } = {}) {
    const last = await this.store.readEvents(task.id, 1).catch(() => []);
    const event = last.at(-1) ?? null;
    const state = workspacePath ? await collectGitState(workspacePath).catch(() => null) : null;
    const startHead = task.checkpoint?.head ?? null;
    const head = workspacePath ? await this.#headOf(workspacePath).catch(() => null) : null;
    return {
      sessionId: task.id,
      title: task.title ?? null,
      status: task.status,
      error: task.error ?? null,
      errorCode: task.errorCode ?? null,
      startedAt: task.checkpoint?.at ?? null,
      updatedAt: task.updatedAt ?? null,
      lastEvent: event ? { type: event.type ?? null, message: typeof event.message === 'string' ? event.message.slice(0, 300) : null, at: event.at ?? null } : null,
      workspacePath,
      workspaceMissing: Boolean(task.workspacePath) && !workspacePath,
      startHead,
      head,
      // Что появилось, пока шла (и оборвалась) эта попытка — только факты Git.
      commitsSince: await this.#commitsBetween(workspacePath, startHead, head),
      changedFiles: state?.changedFiles ?? (task.git?.changedFiles ?? []),
      truncated: state?.truncated === true,
    };
  }

  /** Коммиты между базой чекпоинта и текущим состоянием: `base..head`, не больше двадцати. */
  async #commitsBetween(workspacePath, from, to) {
    if (!workspacePath || !from || !to || from === to) return [];
    try {
      const { stdout } = await git(['log', '--oneline', '--max-count=20', `${from}..${to}`], workspacePath);
      return stdout.split('\n').map(line => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Где началась работа: commit, время, рабочая папка. Записывается один раз —
   * первый старт и есть база сравнения. Дальше чекпоинт НЕ переписывается шагами
   * модели: журнал — это события TaskBridge (WORKSPACE_READY, TOOL_*, TASK_*) плюс
   * живое состояние Git, а не поток текста от модели.
   */
  async #checkpointStart(task) {
    if (task.checkpoint) return task.checkpoint;
    if (!task.workspacePath) return null;
    task.checkpoint = {
      at: task.startedAt ?? now(),
      head: await this.#headOf(task.workspacePath).catch(() => null),
      workspacePath: task.workspacePath,
      worktree: task.worktree === true,
      baseCommit: task.baseCommit ?? null,
    };
    return task.checkpoint;
  }

  /** `provider/id` or a bare id, as a recipe stores it. */
  #parseModelSelection(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const slash = text.indexOf('/');
    if (slash <= 0) return { provider: null, id: text };
    return { provider: text.slice(0, slash), id: text.slice(slash + 1) };
  }

  async #headOf(dir) {
    try {
      const { stdout } = await git(['rev-parse', '--verify', 'HEAD'], dir);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** Artifacts of one session with their sizes; a missing directory is not an error. */
  async #artifactIndex(id) {
    const dir = path.join(this.store.taskDir(id), 'artifacts');
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
      files.push({ name: entry.name, bytes: stat ? stat.size : null });
    }
    return files.slice(0, 50);
  }

  /**
   * The preview: what the operator sees before Start. Built from the same context
   * the launch sends, so the screen cannot promise one thing and the session
   * receive another.
   */
  async resumePreview(workItemId, { strategy = null, memoryMode = null } = {}) {
    const chosenStrategy = WORKSPACE_STRATEGIES.includes(strategy) ? strategy : 'fresh-worktree';
    const chosenMemory = MEMORY_MODES.includes(memoryMode) ? memoryMode : 'native';
    const { context, missingWorkspaces, sessionsWithoutRecap } = await this.resumeInputs(workItemId, {
      strategy: chosenStrategy, memoryMode: chosenMemory,
    });
    const preview = buildResumePreview(context, {
      strategies: WORKSPACE_STRATEGIES,
      memoryModes: MEMORY_MODES,
      defaultStrategy: chosenStrategy,
    });
    preview.fingerprint = contextFingerprint(context);
    // A missing workspace is the one warning the operator must not miss: it means
    // the unfinished work is not on this machine any more.
    preview.warnings.push(...missingWorkspaces.map(id => `рабочая папка сессии ${id} удалена — состояние работы взять неоткуда`));
    preview.sessionsWithoutRecap = sessionsWithoutRecap;
    preview.promptChars = renderResumePrompt(context).length;
    return preview;
  }

  /**
   * Start: re-read the facts, compare them with what the operator saw, and only
   * then create the session. A mismatch is a refusal with the list of changes.
   */
  async startResume(workItemId, { strategy = null, memoryMode = null, preview = null, sessionIds = null, clientId = null, deviceId = null } = {}) {
    const chosenStrategy = WORKSPACE_STRATEGIES.includes(strategy) ? strategy : (strategy ? null : 'fresh-worktree');
    if (chosenStrategy === null) {
      throw Object.assign(new Error(`Стратегия рабочей папки — одна из: ${WORKSPACE_STRATEGIES.join(', ')}.`), { code: 'INPUT_INVALID' });
    }
    const chosenMemory = memoryMode === null || memoryMode === undefined ? 'native' : memoryMode;
    if (!MEMORY_MODES.includes(chosenMemory)) {
      throw Object.assign(new Error(`Режим памяти — один из: ${MEMORY_MODES.join(', ')}.`), { code: 'INPUT_INVALID' });
    }
    if (chosenStrategy === 'reuse' && !preview) {
      // Reuse is a choice about someone else's working copy: it needs the preview
      // the operator confirmed, not a guess made here.
      throw Object.assign(new Error('Переиспользование рабочей папки требует предпросмотра.'), { code: 'INPUT_INVALID' });
    }
    const { item, context, missingWorkspaces } = await this.resumeInputs(workItemId, {
      strategy: chosenStrategy, memoryMode: chosenMemory, sessionIds,
    });
    const current = contextFingerprint(context);
    if (preview) {
      const verdict = validateResume({ preview, current, requested: { strategy: chosenStrategy, memory: chosenMemory } });
      if (!verdict.ok) {
        throw Object.assign(new Error(`Контекст изменился с момента предпросмотра: ${describeChanges(verdict.changes)}`), {
          code: 'CONTEXT_CHANGED',
          changes: verdict.changes,
        });
      }
    }
    if (chosenStrategy === 'reuse' && !(context.workspace.path && this.#isReusableWorkspace(context.workspace.path))) {
      throw Object.assign(new Error('Нечего переиспользовать: рабочей папки предыдущей сессии нет.'), { code: 'INPUT_INVALID' });
    }

    const prompt = renderResumePrompt(context);
    const task = await this.createTask({
      projectId: item.projectId,
      prompt,
      title: `${item.title} (продолжение)`,
    }, { clientId, deviceId });
    const stored = this.tasks.get(task.id);
    if (stored) {
      // Where the session came from is the session's own metadata: the context is
      // not stored anywhere, and this is the only durable trace of the decision.
      stored.resumeFrom = {
        workItemId: item.id,
        sessionIds: (context.previousSessions || []).map(session => session.sessionId),
        sourceCommit: context.workspace.head ?? null,
        workspaceStrategy: chosenStrategy,
        memoryMode: chosenMemory,
      };
      if (chosenStrategy === 'reuse' && context.workspace.path) stored.resumeWorkspacePath = context.workspace.path;
      stored.updatedAt = now();
      await this.store.save(this.#publicTask(stored)).catch(() => {});
      try {
        await this.#event(stored, 'RESUME_STARTED', `Продолжение задачи «${item.title}» в новой сессии`, {
          workItemId: item.id,
          strategy: chosenStrategy,
          missingWorkspaces,
        });
      } catch { /* the session is what matters; a failed note must not lose it */ }
      // Этап M2: факт инъекции памяти виден в ленте самой сессии: «работает ли
      // память» перестаёт быть гаданием, а числа (заметки и токены) лежат рядом
      // с ходом, к которому они относились.
      const memoryHits = Array.isArray(context.memory?.hits) ? context.memory.hits : [];
      const globalHits = memoryHits.filter(hit => hit.scope === 'global');
      if (memoryHits.length) {
        try {
          await this.#event(stored, 'MEMORY_INJECTED',
            `Память: ${memoryHits.length} заметок (~${context.memory.estimatedTokens || 0} токенов)`, {
              notes: memoryHits.length,
              tokens: context.memory.estimatedTokens || 0,
              globalNotes: globalHits.length,
              globalTokens: context.memory.globalTokens || 0,
              sources: memoryHits.slice(0, 20).map(hit => hit.source),
            });
        } catch { /* a failed note must not lose the session */ }
      }
    }
    // The new session belongs to the same work item, and that link is a `resume`.
    // A work item deleted between the two steps must not take the session with it.
    try {
      this.linkWorkItemSession(item.id, task.id, 'resume');
    } catch { /* see above */ }
    return { task: stored ? this.#publicTask(stored) : task, context };
  }

  /** Only a TaskBridge-managed worktree may be reused — never an arbitrary path. */
  #isReusableWorkspace(target) {
    const root = path.resolve(this.dataRoot, 'worktrees');
    const resolved = path.resolve(target);
    const relative = path.relative(root, resolved);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative) && fsSync.existsSync(resolved);
  }

  /** Saves a recap written by an agent or the operator (MR-08, «Session Recap»; в ROADMAP_FULL.md — отдельный от Resume Engine пункт). */
  async saveRecap(id, recap) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    const saved = await writeRecap(this.store.taskDir(id), recap, { source: 'saved' });
    task.recap = { source: 'saved', updatedAt: saved.updatedAt };
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task)).catch(() => {});
    return saved;
  }

  /**
   * The recap of one session: the saved one, else what TaskBridge can derive.
   *
   * The recap of a saved session is the SESSION's word; what TaskBridge observed —
   * the commit, the files Git saw, the verification it ran — is attached next to it
   * as `observed`, and every claim that names an observed command carries the
   * observation's status instead of «verified» it never got.
   */
  async sessionRecap(id) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    const saved = readSavedRecap(this.store.taskDir(id));
    const observed = await this.#observedState(task);
    if (saved) {
      return {
        ...saved.recap,
        verification: reconcileVerification(saved.recap.verification, task.verification),
        source: 'saved',
        updatedAt: saved.updatedAt,
        sessionId: id,
        observed,
      };
    }
    const derived = deriveRecap(task);
    return { ...derived.recap, source: 'derived', updatedAt: null, sessionId: id, observed };
  }

  /** The part of a session's state TaskBridge checked itself — never a summary. */
  async #observedState(task) {
    const state = task.workspacePath ? await collectGitState(task.workspacePath).catch(() => null) : null;
    return {
      head: task.workspacePath ? await this.#headOf(task.workspacePath).catch(() => null) : null,
      changedFiles: Array.isArray(task.git?.changedFiles) ? task.git.changedFiles : (state?.changedFiles ?? []),
      verification: (task.verification || []).map(entry => ({ command: entry.command, ok: entry.ok === true })),
    };
  }

  /** Drops a saved recap, so the derived one is used again. */
  async forgetRecap(id) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    await removeRecap(this.store.taskDir(id));
    delete task.recap;
    return { ok: true };
  }

  // --- run recipes (MR-05) ----------------------------------------------------
  //
  // A recipe is HOW to do a recurring piece of work: its parameters, the agent and
  // model, the context profile, the workspace strategy and the verification. WHEN
  // it runs is a schedule (MR-06); the fact that it ran is the session it created.

  listRecipes({ projectId = null } = {}) {
    return this.store.listRecipes(projectId);
  }

  getRecipe(id) {
    const recipe = this.store.getRecipe(id);
    if (!recipe) throw Object.assign(new Error('Рецепт не найден.'), { code: 'NOT_FOUND' });
    return recipe;
  }

  createRecipe(input = {}) {
    const validated = validateRecipe(input);
    if (!validated.projectId) throw Object.assign(new Error('Укажите проект.'), { code: 'INPUT_INVALID' });
    if (!this.projects.has(validated.projectId)) {
      throw Object.assign(new Error('Проект не найден.'), { code: 'PROJECT_NOT_FOUND' });
    }
    // A recipe that names a work item must name a real one: a run has to be
    // attachable to something the operator can open.
    if (validated.workItemId && !this.store.getWorkItem(validated.workItemId)) {
      throw Object.assign(new Error('Задача не найдена.'), { code: 'NOT_FOUND' });
    }
    const at = now();
    return this.store.createRecipe({ id: `rc-${shortId()}`, ...validated, createdAt: at, updatedAt: at });
  }

  updateRecipe(id, patch = {}) {
    const current = this.getRecipe(id);
    const validated = validateRecipe({
      ...current,
      ...patch,
      parameters: patch.parameters === undefined ? current.parameters : patch.parameters,
      runtime: { ...current.runtime, ...(patch.runtime ?? {}) },
      context: { ...current.context, ...(patch.context ?? {}) },
      workspace: { ...current.workspace, ...(patch.workspace ?? {}) },
      verification: { ...current.verification, ...(patch.verification ?? {}) },
      limits: { ...current.limits, ...(patch.limits ?? {}) },
    });
    if (!this.projects.has(validated.projectId)) {
      throw Object.assign(new Error('Проект не найден.'), { code: 'PROJECT_NOT_FOUND' });
    }
    if (validated.workItemId && !this.store.getWorkItem(validated.workItemId)) {
      throw Object.assign(new Error('Задача не найдена.'), { code: 'NOT_FOUND' });
    }
    return this.store.updateRecipe(id, { ...validated, updatedAt: now() });
  }

  deleteRecipe(id) {
    const removed = this.store.deleteRecipe(id);
    if (!removed) throw Object.assign(new Error('Рецепт не найден.'), { code: 'NOT_FOUND' });
    return removed;
  }

  /**
   * The recipe as it would run right now: parameters resolved, substitutable
   * fields rendered. The preview and the run use the same function, so a phone
   * cannot show one thing and the machine run another.
   */
  previewRecipe(id, { parameters = {} } = {}) {
    return renderRecipe(this.getRecipe(id), parameters);
  }

  /**
   * Runs a recipe: creates a session from the rendered prompt. The invocation IS
   * that session — the roadmap is explicit that a separate `scheduled_runs` table
   * would be a second source of truth about the same thing.
   */
  async runRecipe(id, { parameters = {}, clientId = null, deviceId = null, trigger = 'manual', invocationId = null } = {}) {
    const recipe = this.getRecipe(id);
    const rendered = renderRecipe(recipe, parameters);
    if (recipe.workItemId && !this.store.getWorkItem(recipe.workItemId)) {
      throw Object.assign(new Error('Задача рецепта не найдена.'), { code: 'NOT_FOUND' });
    }
    const model = rendered.runtime?.model
      ? this.#parseModelSelection(rendered.runtime.model)
      : null;
    const task = await this.createTask({
      projectId: rendered.projectId,
      prompt: rendered.prompt,
      title: `${rendered.name}`,
      model,
      thinkingLevel: rendered.runtime?.thinking ?? null,
    }, { clientId, deviceId });
    const stored = this.tasks.get(task.id);
    if (stored) {
      // Which recipe produced this session, with which parameters: the only durable
      // trace of the invocation, and what «run again with parameters» reads back.
      stored.recipeRun = {
        recipeId: recipe.id,
        recipeName: recipe.name,
        trigger,
        invocationId,
        parameters: rendered.parameters,
        at: now(),
      };
      // A verification profile is a NAME the project owns, so the prompt never
      // carries shell commands (ROADMAP_FULL.md, «Verification profiles»).
      const profile = rendered.verification?.command ? String(rendered.verification.command) : null;
      if (profile && this.config.verificationProfiles?.[profile]) {
        stored.verificationCommands = [...this.config.verificationProfiles[profile]];
      } else if (profile) {
        stored.verificationCommands = [profile];
      }
      stored.updatedAt = now();
      await this.store.save(this.#publicTask(stored)).catch(() => {});
      try {
        await this.#event(stored, 'RECIPE_RUN', `Запуск рецепта «${recipe.name}»`, {
          recipeId: recipe.id,
          trigger,
          parameters: rendered.parameters,
        });
      } catch { /* the session is what matters */ }
    }
    // A recipe tied to a work item makes its run part of that work.
    if (recipe.workItemId) {
      try {
        this.linkWorkItemSession(recipe.workItemId, task.id, 'implementation');
      } catch { /* see above */ }
    }
    return { task: stored ? this.#publicTask(stored) : task, invocation: stored?.recipeRun ?? null, rendered };
  }

  // --- schedules and the scheduler tick (MR-06) --------------------------------
  //
  // The scheduler lives on the PC, not on the phone and not in the relay: a phone
  // that is off changes nothing about whether 09:00 happens. Every tick is one
  // decision per due schedule, and each decision is recorded as an invocation —
  // including the ones that were skipped, because «no run» is information too.

  listSchedules({ recipeId = null } = {}) {
    return this.store.listSchedules(recipeId);
  }

  getSchedule(id) {
    const schedule = this.store.getSchedule(id);
    if (!schedule) throw Object.assign(new Error('Расписание не найдено.'), { code: 'NOT_FOUND' });
    return schedule;
  }

  createSchedule(input = {}) {
    const recipeId = String(input.recipeId ?? '').trim();
    if (!recipeId) throw Object.assign(new Error('Укажите рецепт.'), { code: 'INPUT_INVALID' });
    const recipe = this.getRecipe(recipeId);
    const normalized = normalizeSchedule(input, { recipe });
    const at = now();
    // The first moment is computed from the spec, not from the client: two clients
    // computing «09:00» differently is how a job runs twice.
    const anchor = normalized.spec.kind === 'interval' ? at : null;
    return this.store.createSchedule({
      id: `sc-${shortId()}`,
      ...normalized,
      nextRunAt: nextRunAfter(normalized.spec, at, { anchor }),
      lastRunAt: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  updateSchedule(id, patch = {}) {
    const current = this.getSchedule(id);
    const merged = normalizeSchedule({
      ...current,
      ...patch,
      spec: patch.spec === undefined ? current.spec : patch.spec,
      parameters: patch.parameters === undefined ? current.parameters : patch.parameters,
    }, { recipe: this.getRecipe(current.recipeId) });
    // A changed schedule gets its next moment recomputed; a pause keeps it, so
    // resuming does not silently skip to tomorrow.
    const specChanged = JSON.stringify(merged.spec) !== JSON.stringify(current.spec);
    const resumed = merged.enabled && !current.enabled;
    const at = now();
    // One anchor for the whole life of a schedule: an interval must stay on ITS grid,
    // or `nextRunAt` stops being one of its own occurrences and the tick sees a due
    // moment that no occurrence matches (the missed run then silently disappears).
    const nextRunAt = (specChanged || resumed)
      ? nextRunAfter(merged.spec, at, { anchor: merged.spec.kind === 'interval' ? current.createdAt : null })
      : current.nextRunAt;
    return this.store.updateSchedule(id, { ...merged, nextRunAt, updatedAt: at });
  }

  deleteSchedule(id) {
    const removed = this.store.deleteSchedule(id);
    if (!removed) throw Object.assign(new Error('Расписание не найдено.'), { code: 'NOT_FOUND' });
    return removed;
  }

  /** «Запустить сейчас»: тот же путь, что у расписания, только повод — оператор. */
  async runScheduleNow(id, { clientId = null, deviceId = null } = {}) {
    const schedule = this.getSchedule(id);
    const recipe = this.getRecipe(schedule.recipeId);
    const invocation = await this.#invoke(recipe, {
      schedule,
      scheduledAt: now(),
      trigger: 'manual',
      misfire: false,
      parameters: schedule.parameters,
      clientId,
      deviceId,
    });
    // Running by hand does not move the schedule's own clock.
    await this.store.updateSchedule(id, { ...schedule, lastRunAt: invocation.startedAt, updatedAt: now() });
    return invocation;
  }

  listInvocations(options = {}) {
    return this.store.listInvocations(options);
  }

  getInvocation(id) {
    const invocation = this.store.getInvocation(id);
    if (!invocation) throw Object.assign(new Error('Запуск не найден.'), { code: 'NOT_FOUND' });
    return invocation;
  }

  /**
   * One scheduler tick. [opts.dryRun] answers what WOULD happen without creating
   * anything — the same decision code, so a test can ask instead of waiting.
   */
  async schedulerTick({ nowIso = now(), dryRun = false } = {}) {
    const decisions = [];
    for (const schedule of this.store.dueSchedules(nowIso)) {
      const recipe = this.store.getRecipe(schedule.recipeId);
      if (!recipe) {
        decisions.push({ scheduleId: schedule.id, action: 'recipe-gone' });
        if (!dryRun) {
          await this.store.updateSchedule(schedule.id, {
            ...schedule,
            enabled: false,
            nextRunAt: null,
            updatedAt: nowIso,
          });
        }
        continue;
      }
      const misfire = resolveMisfire(schedule, nowIso, {
        anchor: schedule.spec?.kind === 'interval' ? schedule.createdAt : null,
      });
      // `lastRunAt` moves with the runs this tick created, so it is kept here and
      // not read back from the schedule object captured before the loop — that
      // object is stale by the second write and would erase the mark.
      let lastRunAt = schedule.lastRunAt;
      const advance = async () => {
        if (dryRun) return;
        await this.store.updateSchedule(schedule.id, { ...schedule, nextRunAt: misfire.nextRunAt, lastRunAt, updatedAt: nowIso });
      };

      if (!misfire.runs.length) {
        // SKIP (or nothing actually missed): the moment is consumed and recorded, so
        // the operator sees «пропущено», not a silent gap.
        decisions.push({ scheduleId: schedule.id, action: 'skipped', missed: misfire.missed, reason: misfire.policy });
        if (!dryRun && misfire.missed > 0) {
          await this.store.createInvocation({
            id: `inv-${shortId()}`,
            recipeId: recipe.id,
            scheduleId: schedule.id,
            trigger: 'schedule',
            scheduledAt: schedule.nextRunAt,
            startedAt: nowIso,
            finishedAt: nowIso,
            status: 'SKIPPED',
            reason: `пропущено по политике ${misfire.policy}`,
            misfire: true,
            parameters: schedule.parameters,
          });
        }
        await advance();
        continue;
      }

      for (const moment of misfire.runs) {
        const running = this.store.runningInvocations(schedule.id);
        if (running.length && schedule.concurrencyPolicy === 'SKIP_IF_RUNNING') {
          decisions.push({ scheduleId: schedule.id, action: 'busy', reason: schedule.concurrencyPolicy });
          if (!dryRun) {
            await this.store.createInvocation({
              id: `inv-${shortId()}`,
              recipeId: recipe.id,
              scheduleId: schedule.id,
              trigger: 'schedule',
              scheduledAt: moment,
              startedAt: nowIso,
              finishedAt: nowIso,
              status: 'SKIPPED',
              reason: 'предыдущий запуск ещё идёт (SKIP_IF_RUNNING)',
              misfire: moment !== schedule.nextRunAt,
              parameters: schedule.parameters,
            });
          }
          continue;
        }
        if (running.length && schedule.concurrencyPolicy === 'REPLACE') {
          decisions.push({ scheduleId: schedule.id, action: 'replace', replaced: running.map(item => item.id) });
          if (!dryRun) {
            for (const previous of running) {
              if (previous.sessionId && this.tasks.has(previous.sessionId)) {
                await this.cancel(previous.sessionId, {}).catch(() => {});
              }
              await this.store.updateInvocation(previous.id, {
                status: 'FAILED',
                reason: 'заменён новым запуском (REPLACE)',
                finishedAt: nowIso,
              });
            }
          }
        }
        // QUEUE and PARALLEL both create the session: TaskBridge's own queue
        // serialises what the machine cannot run at once, and PARALLEL is only safe
        // with independent worktrees (the workspace strategy decides that).
        if (dryRun) {
          decisions.push({ scheduleId: schedule.id, action: 'run', scheduledAt: moment, policy: schedule.concurrencyPolicy });
          continue;
        }
        const invocation = await this.#invoke(recipe, {
          schedule,
          scheduledAt: moment,
          trigger: 'schedule',
          misfire: moment !== schedule.nextRunAt || misfire.missed > 0,
          parameters: schedule.parameters,
        });
        decisions.push({ scheduleId: schedule.id, action: 'run', invocationId: invocation.id, sessionId: invocation.sessionId, scheduledAt: moment });
        lastRunAt = invocation.startedAt;
      }
      await advance();
    }
    // Sessions that finished while an invocation was still marked RUNNING: the
    // invocation follows its session, even across a restart of the server.
    const reconciled = dryRun ? [] : await this.#reconcileInvocations(nowIso);
    return { at: nowIso, decisions, reconciled };
  }

  /** Creates the invocation and the session it describes. */
  async #invoke(recipe, { schedule = null, scheduledAt = null, trigger = 'manual', misfire = false, parameters = {}, clientId = null, deviceId = null } = {}) {
    const at = now();
    const draft = {
      id: `inv-${shortId()}`,
      recipeId: recipe.id,
      scheduleId: schedule?.id ?? null,
      trigger,
      scheduledAt,
      startedAt: at,
      finishedAt: null,
      status: 'RUNNING',
      reason: null,
      misfire: misfire === true,
      parameters,
      sessionId: null,
      verification: null,
      workspaceRef: null,
      resultArtifact: null,
    };
    await this.store.createInvocation(draft);
    try {
      const started = await this.runRecipe(recipe.id, { parameters, clientId, deviceId, trigger, invocationId: draft.id });
      const session = started.task;
      await this.store.updateInvocation(draft.id, { sessionId: session.id });
      const stored = this.tasks.get(session.id);
      // The notification policy of the SCHEDULE decides whether this run is worth
      // waking anyone up for: the session carries the answer into the push path, and
      // it is saved so a restart does not lose the policy mid-run.
      if (stored && schedule) {
        stored.scheduleNotify = schedule.notify;
        await this.store.save(this.#publicTask(stored)).catch(() => {});
      }
      return this.store.getInvocation(draft.id);
    } catch (failure) {
      // A recipe that cannot start (unknown project, bad parameters) is a finished
      // invocation with a reason, not a missing one.
      return this.store.updateInvocation(draft.id, {
        status: 'FAILED',
        reason: String(failure?.message ?? failure).slice(0, 500),
        finishedAt: now(),
      });
    }
  }

  /**
   * Copies the outcome of finished sessions into their invocations: the status,
   * the verification result and the artifact a human would open. `verification
   * required` turns a session that ran but did not pass into a failed invocation —
   * otherwise «запустилось» would read as «получилось».
   */
  async #reconcileInvocations(nowIso = now()) {
    const finished = [];
    for (const invocation of this.store.runningInvocations()) {
      const session = invocation.sessionId ? this.tasks.get(invocation.sessionId) : null;
      if (!session) {
        if (invocation.sessionId) {
          // The session is gone (deleted by hand, wiped data dir): say so instead of
          // leaving a run that is «in progress» forever.
          await this.store.updateInvocation(invocation.id, {
            status: 'FAILED',
            reason: 'сессия запуска больше не существует',
            finishedAt: nowIso,
          });
          finished.push(invocation.id);
        }
        continue;
      }
      if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(session.status)) continue;
      const recipe = this.store.getRecipe(invocation.recipeId);
      const verification = session.verificationStatus ?? null;
      const failedVerification = recipe?.verification?.required === true && verification !== 'PASSED';
      const status = failedVerification ? 'FAILED' : session.status;
      const reason = failedVerification
        ? `проверка не пройдена (${verification ?? 'не запускалась'}), хотя рецепт её требует`
        : (session.error ? String(session.error).slice(0, 300) : null);
      await this.store.updateInvocation(invocation.id, {
        status,
        reason,
        verification,
        finishedAt: session.updatedAt ?? nowIso,
        // Where the work happened is only known once the session actually ran.
        workspaceRef: session.workspacePath ?? invocation.workspaceRef,
        resultArtifact: session.status === 'SUCCEEDED' ? 'result.md' : null,
      });
      finished.push(invocation.id);
    }
    return finished;
  }

  /** Work items a session belongs to — the chat screen shows this. */
  workItemsOfSession(sessionId) {
    const links = this.store.workItemsOfSession(String(sessionId));
    return links
      .map(link => ({ ...link, item: this.store.getWorkItem(link.workItemId) }))
      .filter(entry => entry.item !== null)
      .map(entry => ({ ...entry.item, relation: entry.relation }));
  }

  // On-disk footprint per session, recomputed at most every 30 seconds. Only
  // known task ids are inspected, so the scan is bounded; the list endpoint
  // keeps returning the previous numbers while a fresh scan runs in the
  // background (the client polls often, so it picks them up on the next tick).
  async #refreshSessionSizes() {
    if (this.sessionSizesScanning) return;
    if (Date.now() - this.sessionSizesAt < 30_000) return;
    this.sessionSizesScanning = true;
    try {
      const bases = [
        path.join(this.dataRoot, 'tasks'),
        path.join(this.dataRoot, 'pi-sessions'),
        path.join(this.dataRoot, 'workspaces'),
      ];
      const map = new Map();
      for (const id of this.tasks.keys()) {
        let total = 0;
        for (const base of bases) total += await dirBytes(path.join(base, id));
        map.set(id, total);
      }
      this.sessionSizes = map;
      this.sessionSizesAt = Date.now();
    } finally {
      this.sessionSizesScanning = false;
    }
  }

  getTask(id) {
    const task = this.tasks.get(id);
    return task ? this.#publicTask(task) : null;
  }

  async #admit(action, key = 'global') {
    if (this.admissionKeys.has(key)) throw Object.assign(new Error('Другой запрос этой сессии ещё отправляется. Повторите позже.'), { code: 'BUSY' });
    this.admissionKeys.add(key);
    this.admitting = true;
    try { return await action(); }
    finally {
      this.admissionKeys.delete(key);
      this.admitting = this.admissionKeys.size > 0;
    }
  }

  async createTask(input, options = {}) {
    const commandId = options && options.commandId ? String(options.commandId) : null;
    if (!commandId) return this.#admit(() => this.#createTask(input, options));
    return this.#withCommand(commandId, options && options.clientId ? String(options.clientId) : null, () => this.#payloadHash(input), () => this.#admit(() => this.#createTask(input, options)));
  }

  // Accepts { provider, id } from the client; returns null when the shape is
  // unusable instead of throwing on an optional field.
  #normalizeModelSelection(model) {
    if (!model || typeof model !== 'object') return null;
    const provider = typeof model.provider === 'string' ? model.provider.trim() : '';
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    if (!provider || !id) return null;
    return { provider, id };
  }

  #normalizeThinkingLevel(level) {
    const value = typeof level === 'string' ? level.trim() : '';
    if (!value) return null;
    if (!/^[a-z]+$/.test(value)) throw Object.assign(new Error('Некорректный thinking level.'), { code: 'INPUT_INVALID' });
    return value;
  }

  // Per-task MCP override. Only meaningful in managed/off mode (see #mcpArgs).
  #normalizeMcp(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const disabledServers = Array.isArray(value.disabledServers)
      ? [...new Set(value.disabledServers.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()))]
      : [];
    const mode = MCP_MODES.includes(value.mode) ? value.mode : undefined;
    if (!disabledServers.length && !mode) return null;
    return { ...(mode ? { mode } : {}), ...(disabledServers.length ? { disabledServers } : {}) };
  }

  #providerFor(requestedModel) {
    return requestedModel?.provider || this.modelCatalog.peek()?.defaultModel?.provider || null;
  }

  #localAutostart() {
    return this.localModels.enabled || this.config.localRuntime?.managed?.enabled === true;
  }

  // Config fed to chooseEngine. In router mode the legacy single-model
  // `profiles` list must not validate AUTO's vision/text targets — in router
  // mode those are router preset ids, not profiles.
  #engineConfig() {
    const local = this.config.localRuntime || {};
    return this.localModels.enabled ? { ...local, profiles: [] } : local;
  }

  #selectionUsesLocalRuntime(requestedModel) {
    return usesLocalRuntime(this.config.localRuntime || {}, this.#providerFor(requestedModel));
  }

  // Whether a task's model is served by the managed local runtime. Unknown
  // models fall back to the previous behaviour (local runtime required).
  #usesLocalRuntime(task) {
    return this.#selectionUsesLocalRuntime(task?.requestedModel || task?.model || null);
  }

  // Model/thinking flags appended after config pi.args so an explicit per-task
  // selection wins over the global default, exactly like `pi --provider ...`.
  #selectionArgs(task) {
    const args = [];
    const model = task?.requestedModel;
    if (model?.provider) args.push('--provider', String(model.provider));
    if (model?.id) args.push('--model', String(model.id));
    if (task?.thinkingLevel) args.push('--thinking', String(task.thinkingLevel));
    return args;
  }

  // Pi's built-in `llama.cpp` provider only exposes router models when it can
  // find the server URL. We supply it as an env var so the router catalog shows
  // up in the unified model picker without a manual `/login llama.cpp`.
  #llamaEnv() {
    const env = { ...(this.config.pi?.env || {}) };
    if (this.localModels?.enabled && !env.LLAMA_BASE_URL) env.LLAMA_BASE_URL = this.localModels.baseUrl;
    return Object.keys(env).length ? env : undefined;
  }

  // Full env for a task's Pi process: llama endpoint + TaskBridge MCP scoping.
  #piEnv() {
    const env = { ...(this.config.pi?.env || {}) };
    if (this.localModels?.enabled && !env.LLAMA_BASE_URL) env.LLAMA_BASE_URL = this.localModels.baseUrl;
    Object.assign(env, this.mcp.launch().env);
    return Object.keys(env).length ? env : undefined;
  }

  // MCP args for this task. In managed/off mode the base args point at the
  // TaskBridge config; per-task `disabledServers` get a derived copy so a single
  // task can opt out of specific servers without touching the shared file.
  async #mcpArgs(task) {
    const launch = this.mcp.launch();
    const disabledServers = Array.isArray(task?.mcp?.disabledServers) ? task.mcp.disabledServers : [];
    if (!launch.args.length || !disabledServers.length) return launch.args;
    const config = await this.mcp.read();
    const map = { ...(config.mcpServers || {}) };
    for (const name of disabledServers) if (map[name]) map[name] = { ...map[name], disabled: true };
    const file = path.join(this.store.taskDir(task.id), 'mcp.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ ...config, mcpServers: map }, null, 2)}\n`, 'utf8');
    return ['--mcp-config', file];
  }

  // The router model that Pi is about to use. Only meaningful for local tasks;
  // with no explicit selection we fall back to Pi's default when it is local.
  #localModelFor(task) {
    if (task.requestedModel?.id) return task.requestedModel.id;
    const fallback = this.modelCatalog.peek()?.defaultModel;
    if (fallback?.provider === this.#localProviderId()) return fallback.id;
    return task.engine?.profileId || null;
  }

  // Router preflight: start the server and preload the model Pi is about to
  // use, streaming load progress as task events. Router autoload would load it
  // on the first request anyway; this exists so the UI can show progress and
  // the user can see what is happening instead of a silent hang.
  async #prepareLocalModel(task) {
    const onLog = text => { this.store.appendRaw(task.id, 'runtime.log', text).catch(() => {}); };
    const modelId = this.#localModelFor(task);
    const onProgress = event => {
      this.#event(task, 'LOCAL_MODEL_PROGRESS', event.message || `Загрузка ${event.model || modelId || ''}`.trim(), { model: event.model || modelId || null, ratio: event.ratio ?? null }, false).catch(() => {});
    };
    this.localModels.on('progress', onProgress);
    try {
      const info = await this.localModels.ensureRunning(onLog, modelId);
      if (task.status === 'CANCELLED' || this.deleted.has(task.id)) return;
      await this.#event(task, 'RUNTIME_READY', `Router: ${info.state}${modelId ? ` · ${modelId}` : ''}`, { state: info.state, model: modelId || null });
    } catch (error) {
      // The router could not load the preset: an external llama-server manages
      // the model itself (no /models/load, or the preset id is not in its list).
      // The model that IS running can still answer — Pi talks to it directly —
      // so the turn proceeds with an honest note instead of failing the
      // operator's message with «Ответ не был получен».
      const recoverable = ['LOCAL_HTTP_ERROR', 'LOCAL_NOT_ROUTER', 'LOCAL_LOAD_FAILED', 'LOCAL_LOAD_TIMEOUT', 'LOCAL_LOAD_CANCELLED'].includes(error.code);
      if (recoverable && await this.localModels.isReady().catch(() => false)) {
        await this.#event(task, 'RUNTIME_READY', `Модель управляется внешним сервером — продолжаю с тем, что запущено (${error.message}).`, { model: modelId || null });
        return;
      }
      throw error;
    } finally {
      this.localModels.off('progress', onProgress);
    }
  }

  async #resolveFiles(items, token) {
    if (!Array.isArray(items) || !items.length) return [];
    const inline = items.filter(item => item && typeof item.base64 === 'string');
    const refs = items.filter(item => item && !item.base64 && item.id);
    if (inline.length && refs.length) throw Object.assign(new Error('Нельзя смешивать встроенные и загруженные файлы в одном запросе.'), { code: 'INPUT_INVALID' });
    if (!refs.length) return validateFiles(items);
    if (!token) throw Object.assign(new Error('Не указан идентификатор загрузки.'), { code: 'INPUT_INVALID' });
    return validateUploadRefs(refs, await this.uploads.resolve(token, refs));
  }

  async #createTask(input, options) {
    const requestedId = options.requestedId;
    if (requestedId !== undefined && (typeof requestedId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(requestedId))) {
      throw Object.assign(new Error('Некорректный cloud taskId.'), { code: 'INPUT_INVALID' });
    }
    if (requestedId && this.tasks.has(requestedId)) throw Object.assign(new Error('Cloud taskId уже существует.'), { code: 'ID_CONFLICT' });
    // The machine runs one generation at a time. A session created while another
    // one holds it waits in the queue instead of being refused: the operator's
    // prompt must never be lost to a timing race (the same rule as messages).
    let requestedModel = this.#normalizeModelSelection(input.model);
    const ownerBusy = this.activeTaskIds.size >= this.maxParallelSessions
      || (this.#selectionUsesLocalRuntime(requestedModel) && this.#hasActiveLocalSession());
    const thinkingLevel = this.#normalizeThinkingLevel(input.thinkingLevel);
    // The model list is a Pi concern; if it is already cached (the picker was
    // just open) reject an unknown selection early. Otherwise trust the client
    // and let Pi resolve it when the session starts.
    const knownModels = this.modelCatalog.peek()?.models;
    if (requestedModel && knownModels && !knownModels.some(m => m.provider === requestedModel.provider && m.id === requestedModel.id)) {
      throw Object.assign(new Error(`Модель не найдена: ${requestedModel.provider}/${requestedModel.id}`), { code: 'MODEL_NOT_FOUND' });
    }
    // Remote providers are not served by the local llama.cpp runtime, so its
    // health/busy gate only applies when the chosen model actually lives there.
    // A busy local model no longer rejects the request: the task is accepted and
    // starts as soon as the model is free (queue, capacity 1). Losing an
    // operator's prompt to a timing race is never acceptable.
    let waitingReason = ownerBusy ? 'BUSY' : null;
    if (this.#selectionUsesLocalRuntime(requestedModel)) {
      if (!this.#localAutostart() && !(await this.local.isReady())) throw Object.assign(new Error('Локальная модель недоступна.'), { code: 'LOCAL_RUNTIME_FAILED' });
      // The owning session is the more useful reason when both apply.
      if (!waitingReason && (await this.local.getBusyStatus()).busy) waitingReason = 'MODEL_BUSY';
    }
    const incomingFiles = await this.#resolveFiles(input.files || [], input.uploadToken);
    const prompt = String(input.prompt || '').trim() || (incomingFiles.length ? 'Прикреплённые файлы' : '');
    if (!prompt) throw Object.assign(new Error('Добавьте сообщение или файл.'), { code: 'INPUT_INVALID' });
    const engine = chooseEngine(this.#engineConfig(), { files: incomingFiles, prompt });
    // In router mode a task must name a real preset, otherwise Pi's default
    // model (which may still point at the old single-model provider) would send
    // an id the router does not know. AUTO picks the vision preset for images;
    // otherwise the configured default preset is used.
    if (this.localModels.enabled && !requestedModel) {
      requestedModel = resolveRouterModel(engine, this.config.localRuntime || {}, this.#localProviderId());
    }
    const projectId = String(input.projectId || this.projects.keys().next().value || '');
    if (projectId !== '__scratch__' && !this.projects.has(projectId)) {
      throw Object.assign(new Error(`Unknown project: ${projectId}`), { code: 'PROJECT_NOT_FOUND' });
    }
    // The project's own folder may already be taken by a running session: say so
    // now, instead of starting the session and parking it a moment later with a
    // reason the operator cannot act on.
    if (!waitingReason && this.#hasWorkspaceConflict({ id: requestedId, projectId })) waitingReason = 'WORKSPACE_BUSY';

    const task = {
      id: requestedId || shortId(),
      ...(originOf(null, options.clientId, options.deviceId) ? { source: originOf(null, options.clientId, options.deviceId) } : {}),
      createdAt: now(),
      updatedAt: now(),
      status: 'QUEUED',
      queueReason: waitingReason,
      projectId,
      prompt,
      // A session may be named when it is created (a resumed one is «<задача>
      // (продолжение)»); an empty name stays empty and the client falls back to
      // the first line of the prompt.
      title: String(input.title || '').trim().slice(0, 300) || null,
      workspacePath: null,
      sourcePath: null,
      worktree: false,
      current: waitText(waitingReason) || 'Queued',
      assistantText: '',
      thinkingText: '',
      error: null,
      errorCode: null,
      engine,
      requestedModel,
      thinkingLevel,
      mcp: this.#normalizeMcp(input.mcp),
      verification: null,
      git: null,
      compaction: { count: 0, last: null },
      lastUsage: null,
      metrics: null,
      speeds: null,
      model: null,
      autoCompactionEnabled: null,
      pendingPrompts: [],
      files: incomingFiles.map(metadata),
      attachments: [],
      outputFiles: []
    };

    await this.store.create(task);
    this.tasks.set(task.id, task);
    task._incomingFiles = incomingFiles;
    task._uploadToken = input.uploadToken;
    this.#enqueue(task.id);
    await this.#event(task, waitingReason ? 'QUEUE_WAITING' : 'TASK_QUEUED',
      waitText(waitingReason) || 'Task queued',
      waitingReason ? { reason: waitingReason } : {});
    this.#pump();
    return this.#publicTask(task);
  }

  async importSession(input) {
    return this.#admit(() => this.nativeSessions.importSession(input));
  }

  async renameTask(id, title) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    const name = String(title ?? '').trim().slice(0, 200);
    task.title = name || null;
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    return this.#publicTask(task);
  }

  #publicTask(task, includeUnpublished = false) {
    // Terminal status is prepared before its event writes finish. Keep reads
    // on the preceding snapshot until the terminal event has been persisted.
    const pendingTerminal = this.#terminalPublication.snapshot(task);
    if (pendingTerminal && !includeUnpublished) return pendingTerminal;
    const { _incomingFiles, _modelError, _baseline, _turn, _nativeLease, _uploadToken,
      _firstDeltaAt, _lastDeltaAt, _promptStartedAt, _promptMs, _firstTokenAt, _lastProgressAt,
      _runtimeState, _starting, _sleeping, _sessionLost, _compacting, _compactingSince, _toolsRunning, _uiTimer, _lastPiExitAt, _snapshotSeq, ...safe } = task;
    const runtime = this.runtimes.get(task.id);
    return {
      ...safe,
      // Шаг C-B: версия снимка — seq последнего событие-факта этой сессии. Клиент
      // сравнивает её со своим курсором и не даёт старому GET откатить «лицо» хода
      // (фазу, стадию, статус), которую уже принесло SSE.
      snapshotSeq: Number(_snapshotSeq || 0),
      runtime: this.#runtimeFacts(task),
      turnState: this.#turnState(task),
      // Ожидание провайдера существует только пока живёт процесс, который его
      // объявил: после падения TaskBridge сохранённое значение — уже история.
      providerWait: runtime && !runtime.pi.closed ? safe.providerWait || null : null,
      assistantText: tailText(safe.assistantText, TEXT_TAIL),
      thinkingText: tailText(safe.thinkingText, THINKING_TAIL),
      sessionAvailable: Boolean(task.workspacePath || (runtime && !runtime.pi.closed))
    };
  }

  // Шаг C-A: точка последнего прогресса хода для клиентского таймера молчания.
  // Аддитивное поле снимка: heartbeat SSE ≠ прогресс модели — мерцать должно
  // именно «живое» движение (кадр Pi/стадия/инструмент), а не транспорт.
  #turnState(task) {
    const lastProgressAt = task._lastProgressAt
      ? new Date(task._lastProgressAt).toISOString()
      : null;
    return {
      phase: task._turnPhase || null,
      turn: task._turn ?? null,
      stage: task.current || null,
      lastProgressAt,
      // Считается на сервере в момент снимка: клиент опрашивает метаданные
      // раз в 2 с и не должен вычитать часы другого устройства.
      silentMs: task._lastProgressAt && !RUN_TERMINAL.has(task.status)
        ? Math.max(0, Date.now() - task._lastProgressAt)
        : null
    };
  }

  // Retry the queue later instead of spinning: the model is owned by someone
  // else for an unknown time.
  #schedulePump() { this.queuePump.schedule(); }

  // One event per transition, so the UI (and the cloud) can explain why nothing
  // is happening yet.
  async #markWaiting(task, reason) {
    // A session that is streaming right now keeps its RUNNING status: the prompt
    // waits for the turn to end, and the status must not claim otherwise (a
    // QUEUED status on the session that owns the slot also made "Отправить
    // сейчас" look like a second generation and refuse).
    if (this.activeTaskIds.has(task.id) && task.status === 'RUNNING') {
      task.updatedAt = now();
      await this.store.save(this.#publicTask(task));
      return;
    }
    if (task.queueReason === reason && task.status === 'QUEUED') return;
    if (task.status !== 'QUEUED') task.statusChangedAt = now();
    task.status = 'QUEUED';
    task.queueReason = reason;
    task.current = waitText(reason) || 'В очереди';
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#event(task, 'QUEUE_WAITING', task.current, { reason });
  }

  // A prompt accepted while the model was busy is sent here, unchanged.
  // Taking a prompt out of the queue must never lose it. `restore` puts it back in
  // front and makes the session wait again, so a failure (the model got busy in a
  // race, an RPC error) costs time, not the operator's text.
  async #takePending(task, pendingId = null) {
    const items = task.pendingPrompts || [];
    const index = pendingId ? items.findIndex(p => p.id === pendingId) : 0;
    const pending = items[index];
    const rest = items.filter((_, i) => i !== index);
    if (!pending) throw Object.assign(new Error('Нет сообщения в очереди.'), { code: 'INPUT_INVALID' });
    task.pendingPrompts = rest;
    await this.store.save(this.#publicTask(task));
    return {
      pending,
      restore: async () => {
        const restored = [...(task.pendingPrompts || [])];
        restored.splice(Math.min(index, restored.length), 0, pending);
        task.pendingPrompts = restored;
        if (!this.queue.includes(task.id)) this.queue.unshift(task.id);
        await this.#markWaiting(task, 'QUEUED');
      }
    };
  }

  #pendingFilesPath(taskId) {
    return path.join(this.store.taskDir(taskId), 'pending-files.json');
  }

  async #savePendingFiles(taskId, pendingId, data) {
    this.pendingFiles.set(pendingId, data);
    try {
      const file = this.#pendingFilesPath(taskId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      let map = {};
      try { map = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
      map[pendingId] = data;
      await fs.writeFile(file, JSON.stringify(map, null, 2), 'utf8');
    } catch { /* best effort disk persistence */ }
  }

  async #getPendingFiles(taskId, pendingId) {
    if (this.pendingFiles.has(pendingId)) return this.pendingFiles.get(pendingId);
    try {
      const file = this.#pendingFilesPath(taskId);
      const map = JSON.parse(await fs.readFile(file, 'utf8'));
      const data = map[pendingId];
      if (data) { this.pendingFiles.set(pendingId, data); return data; }
    } catch {}
    return null;
  }

  async #deletePendingFiles(taskId, pendingId) {
    this.pendingFiles.delete(pendingId);
    try {
      const file = this.#pendingFilesPath(taskId);
      let map = {};
      try { map = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
      delete map[pendingId];
      if (Object.keys(map).length) await fs.writeFile(file, JSON.stringify(map, null, 2), 'utf8');
      else await fs.unlink(file).catch(() => {});
    } catch {}
  }

  async #restorePendingFiles(taskId) {
    try {
      const file = this.#pendingFilesPath(taskId);
      const map = JSON.parse(await fs.readFile(file, 'utf8'));
      for (const [pendingId, data] of Object.entries(map || {})) {
        if (!this.pendingFiles.has(pendingId)) this.pendingFiles.set(pendingId, data);
      }
    } catch {}
  }

  // A queued prompt that never ran releases the files that were waiting with it.
  async #releasePendingFiles(taskId, prompts) {
    for (const prompt of prompts || []) {
      const waiting = await this.#getPendingFiles(taskId, prompt?.id);
      if (!waiting) continue;
      await this.#deletePendingFiles(taskId, prompt.id);
      if (waiting.uploadToken) this.uploads.discard(waiting.uploadToken).catch(() => {});
    }
  }

  async #deliverPending(task) {
    const { pending, restore } = await this.#takePending(task);
    // The next prompt waits for this turn to end, which is what capacity 1 means.
    if ((task.pendingPrompts || []).length) this.#enqueue(task.id);
    try {
      const waiting = (await this.#getPendingFiles(task.id, pending.id)) || { files: [], uploadToken: null };
      await this.#message(task.id, pending.text, pending.mode || 'auto', waiting.files, waiting.uploadToken, { immediate: true, fromQueue: true, staged: pending.files || [], announce: pending.announce, ...pendingOrigin(pending) });
      await this.#deletePendingFiles(task.id, pending.id);
      return true;
    } catch (error) {
      // Never die silently inside the pump: explain the retry and keep the text.
      await this.#event(task, 'QUEUE_RETRY', `Не удалось отправить из очереди: ${error.message}. Сообщение осталось в очереди.`).catch(() => {});
      await restore();
      return false;
    }
  }


  async #pump() { return this.queuePump.wake(); }

  async #pumpOnce() {
    if (this.queue.length === 0) return false;
    // The first entry that can actually run — not simply the first entry. A
    // session waiting for a busy local model must not hold up one that needs a
    // remote model (or no model at all): that head-of-line block is what made a
    // queue look stuck long after the model had answered.
    let index = 0;
    let task = null;
    while (index < this.queue.length) {
      const candidate = this.tasks.get(this.queue[index]);
      if (!candidate || candidate.status === 'CANCELLED' || this.deleted.has(this.queue[index])) {
        const [removed] = this.queue.splice(index, 1);
        this.queueSince.delete(removed);
        continue;
      }
      if (!this.#hasCapacityFor(candidate)) {
        await this.#markWaiting(candidate, this.#waitReason(candidate));
        index++;
        continue;
      }
      // capacity 1: never start a request the local runtime would refuse.
      if (this.#usesLocalRuntime(candidate) && (await this.local.getBusyStatus()).busy) {
        await this.#markWaiting(candidate, 'MODEL_BUSY');
        index++;
        continue;
      }
      // capacity 1 for the session itself: a queued prompt waits for the turn in
      // flight to end. Delivering it while that answer is still streaming turned
      // it into a steer — the queue emptied the instant it was filled, which is
      // exactly what "the message does not wait in the queue" looked like.
      // (An explicit «Отправить сейчас» / Ctrl+Enter interrupts on purpose and
      // does not go through the queue.)
      const liveRuntime = this.runtimes.get(candidate.id);
      if (liveRuntime && !liveRuntime.pi.closed) {
        const liveState = await liveRuntime.pi.getState().catch(() => null);
        // The prompt stays queued, but the status is left alone: the session that
        // owns the slot is the one generating, and flipping it to QUEUED made a
        // working session look like a stuck queue.
        if (liveState?.isStreaming) { index++; continue; }
      }
      task = candidate;
      break;
    }
    if (!task) { if (this.queue.length) this.#schedulePump(); return false; }

    const id = this.queue[index];
    this.queue.splice(index, 1);
    const queuedAt = this.queueSince.get(id);
    this.queueSince.delete(id);
    if (queuedAt) {
      this.queueWaitSamples.push(Math.max(0, Date.now() - queuedAt));
      if (this.queueWaitSamples.length > 100) this.queueWaitSamples.shift();
    }
    task.queueReason = null;
    // A stored prompt is delivered through #message, which claims the slot
    // itself: the queue must not hold it meanwhile, nor release it afterwards.
    const delegating = Boolean(task.pendingPrompts?.length);
    if (delegating) {
      let delivered = true;
      try {
        // A delegating delivery claims its slot only inside #message, so this
        // flag is what tells sendPendingNow (see there) that the machine is
        // busy with a delivery activeTaskId cannot represent.
        this.dispatching = id;
        delivered = await this.#deliverPending(task);
      } finally {
        this.dispatching = null;
        if (delivered) setImmediate(() => this.#pump());
        else this.#schedulePump();
      }
    } else {
      this.#claimSlot(id);
      this.#executeInitial(task).catch(error => console.error(error)).finally(() => {
        this.#pump();
      });
    }
    return true;
  }

  async #executeInitial(task) {
    if (this.closing) return;
    const deliveryStartedAt = Date.now();
    let ownedTurn = null;
    try {
      await this.#setStatus(task, 'PREPARING', 'Preparing workspace');
      const prepared = await this.#prepareWorkspace(task);
      if (task.status === 'CANCELLED' || this.deleted.has(task.id)) return;
      Object.assign(task, prepared);
      // Аварийный чекпоинт ставит инфраструктура, а не модель: она в этот момент
      // ничего не генерирует, и спрашивать её о состоянии бессмысленно. Здесь есть
      // только факты: commit, время, рабочая папка.
      await this.#checkpointStart(task);
      await this.store.save(this.#publicTask(task));
      await this.#event(task, 'WORKSPACE_READY', `Workspace: ${task.workspacePath}`);

      await this.#setStatus(task, 'PREFLIGHT', 'Checking local model runtime');
      if (this.#usesLocalRuntime(task)) {
        if (this.localModels.enabled) {
          await this.#prepareLocalModel(task);
        } else {
          const profileId = task.engine?.profileId || undefined;
          if (profileId && task.engine?.auto && this.config.localRuntime?.auto?.enabled === true && this.runtimeSwitcher) {
            const active = this.runtimeManager.activeProfileId;
            if (active && active !== profileId) {
              await this.#event(task, 'ENGINE_SWITCH', `AUTO: ${active} → ${profileId} (${task.engine.reason})`);
              await this.runtimeSwitcher(profileId);
            }
          }
          const runtimeInfo = await this.runtimeManager.ensureRunning((text) => {
            this.store.appendRaw(task.id, 'runtime.log', text).catch(() => {});
          }, profileId);
          if (task.status === 'CANCELLED' || this.deleted.has(task.id)) return;
          await this.#event(task, 'RUNTIME_READY', `Local runtime: ${runtimeInfo.state}`);

          const busy = await this.runtimeManager.getBusyStatus();
          if (busy.busy === true) {
            throw Object.assign(new Error('Локальная модель сейчас занята другим запросом. Повторите чуть позже.'), { code: 'MODEL_BUSY' });
          }
        }
      } else {
        const label = [task.requestedModel?.provider, task.requestedModel?.id].filter(Boolean).join('/');
        await this.#event(task, 'RUNTIME_SKIPPED', `Локальный runtime не требуется для модели ${label || '(Pi default)'}`);
      }

      const pi = await this.#createPi(task);
      await this.#captureModelInfo(task, pi);
      // Snapshot and turn token belong to this turn only: a follow-up that
      // starts while this turn finalizes must not overwrite them.
      const turn = this.#beginTurn(task);
      ownedTurn = turn;
      const baseline = await snapshotWorkspace(task.workspacePath);
      if (task.status === 'CANCELLED' || this.deleted.has(task.id) || this.runtimes.get(task.id)?.cancelRequested) {
        await pi.killTree();
        return;
      }
      const settled = this.#waitForSettle(task.id, 12 * 60 * 60 * 1000);
      settled.catch(() => {});
      try {
        await this.#setStatus(task, 'RUNNING', 'Pi starting');
        await this.#turnStateEvent(task, 'DISPATCHING');
        if (task.status === 'CANCELLED' || this.runtimes.get(task.id)?.cancelRequested) { this.#resolveSettle(task.id); return; }
        // The in-flight marker (see #deliverMessage): persisted before the RPC so
        // a restart between here and the turn's end finishes the command instead
        // of reporting a failure. Cleared when the turn reaches a terminal state.
        task.inFlightPrompt = { text: this.#buildPrompt(task), initial: true, at: now() };
        await this.store.save(this.#publicTask(task)).catch(() => {});
        const dispatchedAt = Date.now();
        let ackError = null;
        try {
          await pi.prompt(this.#buildPrompt(task));
        } catch (error) {
          ackError = error?.code || 'RPC_FAILED';
          throw error;
        } finally {
          // Шаг C-C: факт «prompt ушёл в Pi» и «ACK получен/не получен» с
          // временными отметками остаётся в raw-журнале даже при сбое.
          const ackedAt = Date.now();
          this.#recordTurnTiming(task, {
            phase: 'initial', dispatchMs: dispatchedAt - deliveryStartedAt,
            ackMs: ackError ? null : Math.max(0, ackedAt - dispatchedAt), ackError
          });
        }
        // The initial prompt has no USER_MESSAGE frame (it is stored on the task).
        // Publish the RPC acknowledgement so clients can distinguish "created on
        // the server" from "Pi accepted the prompt".
        await this.#event(task, 'PROMPT_ACCEPTED', 'Первый запрос принят Pi', { initial: true });
        await this.#turnStateEvent(task, 'ACKED');
        await settled;
      } catch (error) {
        this.#resolveSettle(task.id);
        throw error;
      }

      const runtime = this.runtimes.get(task.id);
      if (task.status === 'CANCELLED' || this.deleted.has(task.id)) {
        return;
      }
      if (runtime?.cancelRequested) {
        await this.#finalizeCancelled(task);
      } else if (task.status !== 'FAILED') {
        await this.#verifyAndFinalize(task, { turn, baseline });
      }
    } catch (error) {
      if (['PI_RPC_HUNG', 'PI_RPC_EXITED'].includes(error?.code)) await this.#recoverRpcFailure(task, error);
      else await this.#fail(task, error);
    } finally {
      delete task._incomingFiles;
      // A follow-up can start while finalization writes artifacts. It then owns
      // the same task id with a newer turn token; the older initial run must not
      // release that slot underneath it.
      if (ownedTurn == null || task._turn === ownedTurn) this.#releaseSlot(task.id);
    }
  }

  async #prepareWorkspace(task) {
    let prepared;
    // A resumed session may be told to reuse the working copy the previous one
    // left behind (MR-04). Only a TaskBridge-managed worktree qualifies: anything
    // else would let a request name an arbitrary directory as a workspace.
    if (task.resumeWorkspacePath && this.#isReusableWorkspace(task.resumeWorkspacePath)) {
      prepared = { workspacePath: task.resumeWorkspacePath, sourcePath: task.sourcePath ?? null, worktree: true, baseCommit: null };
    } else if (task.projectId === '__scratch__') {
      prepared = await createScratchWorkspace(task.id, this.dataRoot);
    } else {
      const project = this.projects.get(task.projectId);
      prepared = await prepareProjectWorkspace(project, task.id, this.dataRoot, this.config.workspace || {});
    }

    const files = await stageFiles({ ...task, ...prepared }, this.store.taskDir(task.id), task._incomingFiles || []);
    if (files.length) { task.files = files; task.attachments = [...(task.attachments || []), ...files]; }
    if (task._uploadToken) { await this.uploads.discard(task._uploadToken).catch(() => {}); delete task._uploadToken; }
    return prepared;
  }

  #buildPrompt(task) {
    const attachmentNote = task.files?.length
      ? `\n\nAdditional files from the phone are in .taskbridge-input/:\n${task.files.map((f) => `- ${f.path || '.taskbridge-input/' + f.name}`).join('\n')}`
      : '';
    return `${task.prompt}${attachmentNote}\n\nWork only inside the current working directory. Read attached files as needed. At the end, summarize what you changed and what checks you ran. Link deliverable files using Markdown relative paths, e.g. [Download report](report.pdf).`;
  }

  async #createPi(task, sessionFile) {
    const sessionDir = path.join(this.dataRoot, 'pi-sessions', task.id);
    const args = [...(this.config.pi?.args || []), ...this.#selectionArgs(task), ...await this.#mcpArgs(task)];
    const env = { ...(this.#piEnv() || {}) };
    if (this.approvalsConfig.enabled && this.approvalBaseUrl && this.approvalExtensionPath) {
      // A missing extension file must not break every task: log it and continue
      // without the gate rather than spawning Pi with a broken --extension.
      const available = await fs.access(this.approvalExtensionPath).then(() => true, () => false);
      if (!available) {
        console.error(`[TaskBridge] approvals enabled but the Pi extension is missing: ${this.approvalExtensionPath}`);
      } else {
        const token = crypto.randomBytes(24).toString('hex');
        this.approvalTokens.set(task.id, token);
        args.push('-e', this.approvalExtensionPath);
        Object.assign(env, {
          TASKBRIDGE_APPROVAL_URL: this.approvalBaseUrl,
          TASKBRIDGE_TASK_ID: task.id,
          TASKBRIDGE_APPROVAL_TOKEN: token,
          TASKBRIDGE_APPROVAL_FAILSAFE: this.approvalsConfig.failsafe,
          TASKBRIDGE_APPROVAL_WAIT_MS: String(Math.max(1000, this.approvalsConfig.timeoutMinutes * 60000)),
          TASKBRIDGE_APPROVAL_POLL_MS: '1000'
        });
      }
    }
    const pi = new PiRpcSession({
      command: this.config.pi?.command || 'pi',
      args,
      cwd: task.workspacePath,
      sessionDir,
      sessionName: `task-${task.id}`,
      sessionFile,
      persistSessions: this.config.pi?.persistSessions !== false,
      // A persisted per-workspace decision must be allowed to reach Pi's trust
      // store; --approve/--no-approve would override it for this launch.
      projectTrust: task.workspaceTrusted ? 'saved' : (this.config.pi?.projectTrust || 'approve'),
      env: Object.keys(env).length ? env : undefined
    });

    const runtime = {
      pi,
      settleResolvers: [],
      cancelRequested: false,
      turn: 0,
      eventChain: Promise.resolve()
    };
    this.runtimes.set(task.id, runtime);

    pi.on('event', (frame) => {
      if (this.deleted.has(task.id) || runtime.retired) return;
      // C-C: сколько кадр ждал в очереди eventChain до обработки — сюда попадает
      // и удержание ACK-барьером (#deliverMessage), и медленные соседние кадры.
      const receivedAt = Date.now();
      runtime.eventChain = runtime.eventChain
        .then(() => {
          if (runtime.retired) return undefined;
          deliveryMetrics.observe('eventchain_wait_ms', Math.max(0, Date.now() - receivedAt));
          return this.#handlePiEvent(task, frame, runtime);
        })
        .catch(async (error) => { await this.#fail(task, error); this.#resolveSettle(task.id); });
    });
    pi.on('stderr', (text) => {
      this.store.appendRaw(task.id, 'pi.stderr.log', text).catch(() => {});
      this.#event(task, 'PI_STDERR', text.slice(-1000), { raw: text.slice(-4000) }).catch(() => {});
    });
    pi.on('protocol_error', (data) => {
      this.#event(task, 'PI_PROTOCOL_ERROR', data.error, { line: data.line?.slice(0, 2000) }).catch(() => {});
    });
    pi.on('error', error => {
      if (runtime.retired) return;
      runtime.eventChain = runtime.eventChain.then(() => this.#fail(task, error)).finally(() => this.#resolveSettle(task.id));
      runtime.eventChain.catch(() => {});
    });
    pi.on('close', ({ code, signal }) => {
      if (runtime.retired) return;
      task.piPid = null;
      task.piStartedAt = null;
      task._lastPiExitAt = Date.now();
      task._toolsRunning = 0;
      task._compacting = false;
      task._compactingSince = 0;
      // Ожидание провайдера живёт в retired процессе вместе с его повтором.
      task.providerWait = null;
      if (task.pendingUiRequest) this.#closeUiRequest(task, task.pendingUiRequest.id, { cancelled: true, reason: 'pi_closed' }).catch(() => {});
      this.#syncRuntime(task, 'pi_closed');
      if (this.deleted.has(task.id) || runtime.cancelRequested) { this.#resolveSettle(task.id); return; }
      if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) {
        runtime.eventChain = runtime.eventChain.then(() => this.#fail(task, Object.assign(new Error(`Pi process exited unexpectedly: code=${code}, signal=${signal}`), { code: 'PI_SESSION_FAILED' }))).finally(() => this.#resolveSettle(task.id));
        runtime.eventChain.catch(() => {});
      }
    });

    await pi.start();
    // R3.6: enough to find this process again after a TaskBridge crash.
    task.piPid = pi.proc?.pid ?? null;
    task.piStartedAt = task.piPid ? new Date().toISOString() : null;
    // A cold Pi loads its extensions/MCP adapter for >15s before its RPC loop
    // serves the first command (measured ~17-19s on 2026-09-28). A get_state
    // sent earlier times out with zero output and the operator's message is
    // reported as hung although the process is merely booting. Probe readiness
    // before returning; a failure falls through so the callers' own error
    // handling stays unchanged.
    await pi.request({ type: 'get_state' }, PiRpcSession.PROBE_TIMEOUT_MS).catch(() => {});
    return pi;
  }

  async #captureModelInfo(task, pi) {
    try {
      const state = await pi.getState(PiRpcSession.PROBE_TIMEOUT_MS);
      if (state?.sessionFile) task.piSessionFile = state.sessionFile;
      task.model = this.#taskModel(state?.model);
      task.autoCompactionEnabled = state?.autoCompactionEnabled ?? null;
      task.thinkingLevelActual = state?.thinkingLevel ?? null;
      await this.store.save(this.#publicTask(task));
    } catch {}
  }

  // Lists the models Pi currently considers usable (all providers, not just the
  /**
   * Короткая проверка модели по кнопке (пункт §3.3 плана).
   *
   * Два уровня, и токены тратит только второй:
   *   `mode: 'availability'` (по умолчанию) — бесплатный round-trip к списку моделей;
   *   `mode: 'latency'` — по явному нажатию: один запрос с `max_tokens: 1` и стримом,
   *   замер до первого чанка, соединение обрывается сразу после него.
   *
   * Результат НЕ пишется в ModelLatency: там статистика настоящих ходов, и подмешивать
   * к ней пробу на «ping» значило бы врать в оценке «модель обычно отвечает за N с».
   */
  async probeModel({ provider = null, id = null, mode = 'availability' } = {}) {
    const providerId = String(provider || '').trim();
    const modelId = String(id || '').trim();
    if (!providerId || !modelId) {
      throw Object.assign(new Error('Нужны provider и id модели.'), { code: 'INPUT_INVALID' });
    }
    if (!['availability', 'latency'].includes(mode)) {
      throw Object.assign(new Error('Режим проверки — availability или latency.'), { code: 'INPUT_INVALID' });
    }
    const key = `${providerId}/${modelId}`;
    const retryInMs = this.probeCooldown.remaining(key);
    if (retryInMs > 0) {
      return { provider: providerId, id: modelId, mode, ok: false, code: 'COOLDOWN', retryInMs };
    }
    // Резерв до первого await: два одновременных нажатия не должны оба пройти
    // remaining() и дважды списать токены. Снимается при отказе цели; успех
    // дальше mark() ставит обычный кулдаун.
    if (this.probeInFlight.has(key)) {
      return { provider: providerId, id: modelId, mode, ok: false, code: 'COOLDOWN', retryInMs: this.probeCooldown.cooldownMs };
    }
    this.probeInFlight.add(key);
    try {
      const target = await this.#probeTarget(providerId, modelId);
      if (!target.ok) return { provider: providerId, id: modelId, mode, ok: false, code: target.code, message: target.message };

      this.probeCooldown.mark(key);
      const result = mode === 'latency'
        ? await probeLatency({ baseUrl: target.baseUrl, id: modelId, apiKey: target.apiKey })
        : await probeAvailability({ baseUrl: target.baseUrl, apiKey: target.apiKey });
      return { provider: providerId, id: modelId, mode, ...result, cooldownMs: this.probeCooldown.cooldownMs };
    } finally {
      this.probeInFlight.delete(key);
    }
  }

  /**
   * Где искать модель: внешний локальный сервер (его собственный адрес), локальный
   * llama.cpp-роутер (с его ключом) или провайдер из Pi-каталога. Отказ вместо
   * догадки: нет адреса или ключа — код NO_ENDPOINT/NO_KEY.
   */
  async #probeTarget(providerId, modelId) {
    // Strata и другие externalServers — НЕ llama.cpp router: у каждого свой port.
    // Ищем и по provider, и по model, как в телеметрии рабочего хода.
    // Пара обязана совпасть атомарно: совпадение только по модели уводило бы
    // облачную модель с тем же id на чужой локальный сервер.
    const byProvider = this.localServers.find(providerId);
    const external = (byProvider && byProvider.model === modelId ? byProvider : null)
      || this.localServers.find(modelId);
    if (external) {
      // Обнаруженные серверы несут исходный apiBaseUrl из Pi models.json (/v1);
      // сконфигурированные — baseUrl как есть.
      const baseUrl = external.apiBaseUrl || external.baseUrl;
      if (!baseUrl) return { ok: false, code: 'NO_ENDPOINT', message: `у локального сервера ${providerId} нет адреса` };
      return { ok: true, baseUrl, apiKey: providerApiKey(external.apiKey, process.env) };
    }
    const localIds = localProviderIds(this.config.localRuntime || {}, this.localServers.servers);
    if (localIds.has(providerId)) {
      const baseUrl = this.localModels.baseUrl;
      if (!baseUrl) return { ok: false, code: 'NO_ENDPOINT', message: 'локальный роутер не найден: укажите адрес в настройках' };
      return { ok: true, baseUrl, apiKey: this.localModels.apiKey };
    }
    let doc;
    try {
      doc = JSON.parse(await fs.readFile(path.join(piAgentDir(process.env), 'models.json'), 'utf8'));
    } catch {
      return { ok: false, code: 'NO_ENDPOINT', message: 'каталог моделей Pi не читается (models.json)' };
    }
    const entry = doc?.providers?.[providerId];
    if (!entry?.baseUrl) return { ok: false, code: 'NO_ENDPOINT', message: `у провайдера ${providerId} нет адреса в models.json` };
    const catalog = Array.isArray(entry.models) ? entry.models : [];
    if (catalog.length && !catalog.some(model => model?.id === modelId)) {
      return { ok: false, code: 'MODEL_UNKNOWN', message: `модель ${modelId} не описана у провайдера ${providerId}` };
    }
    const key = providerApiKey(entry.apiKey, process.env);
    if (!key && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(String(entry.baseUrl))) {
      return { ok: false, code: 'NO_KEY', message: `нет ключа провайдера ${providerId} в окружении` };
    }
    return { ok: true, baseUrl: entry.baseUrl, apiKey: key };
  }

  // local llama.cpp profiles). Refresh forces a fresh Pi probe. The rolling
  // per-model TTFT history is merged in so the picker can show real response
  // latency for every model, cloud ones included.
  // Refresh also syncs the model lists of the providers opted in via
  // config.modelSync.providers (wormsoft today): their lists in Pi's
  // models.json are hand-written, and models the provider added later only
  // reach Pi after the file gains them. Only-add merge, see provider-models.mjs.
  async listModels({ refresh = false } = {}) {
    if (refresh) {
      const sync = await syncProviderModels({
        agentDir: piAgentDir(process.env),
        only: this.config.modelSync?.providers ?? [],
      }).catch(error => ({ changed: false, providers: [], error: String(error.message || error) }));
      if (sync.error) console.log(`[TaskBridge] provider model sync skipped: ${sync.error}`);
      else if (sync.changed) console.log(`[TaskBridge] provider model sync: ${sync.providers.filter(p => p.added).map(p => `${p.provider} +${p.added}`).join(', ')}`);
    }
    const catalog = await this.modelCatalog.list({ refresh });
    await this.modelLatency.load();
    // `local` is a grouping fact for the pickers: llama.cpp presets and the
    // configured external servers (Strata) carry different Pi provider ids but
    // are the same machine, so the client shows them as one group. The real
    // provider stays untouched — it is what Pi has to be given to select a model.
    const local = localProviderIds(this.config.localRuntime || {}, this.localServers.servers);
    const models = (catalog.models || []).map(model =>
      model && local.has(model.provider) ? { ...model, local: true } : model);
    return { ...catalog, models, latency: this.modelLatency.stats() };
  }

  // ---- local llama.cpp router (router mode) ----

  // `probeCatalog` is for the endpoint the user opens deliberately (the local
  // models dialog): the id Pi can serve is only knowable from Pi's own catalog,
  // and probing costs a short Pi start, so the polled /api/info must not do it.
  async localStatus({ probeCatalog = false, fresh = false } = {}) {
    if (probeCatalog && !this.modelCatalog.peek()) await this.modelCatalog.list().catch(() => {});
    // Advertise the id Pi can really serve: with the hand-written provider
    // renamed (e.g. "llamacpp") the configured one may no longer exist, and
    // selecting a model under a dead id makes Pi answer
    // "Provider is not configured".
    // Configured external servers (Strata и др.) merge into the same dialog:
    // their rows carry their own provider, and load/unload routes to the
    // server's start/stop instead of the llama.cpp router API.
    const [status, external] = await Promise.all([
      this.local.getStatus(),
      this.localServers.status({ fresh })
    ]);
    const merged = external.configured
      ? { ...status, models: [...(status.models || []), ...external.models] }
      : status;
    // Пресеты роутера теперь тоже правим: их ctx-size лежит в секции models.ini
    // (см. patchPresetContext). Флаг нужен клиенту, чтобы показать кнопку «Контекст».
    const models = (await this.#annotateRouterPresets(merged.models || [])).map(m =>
      m.contextEditable === undefined && this.localModels.enabled ? { ...m, contextEditable: true } : m);
    // Скрытые найденные строки: клиент показывает их отдельно и может вернуть.
    return { ...merged, provider: this.#localProviderId(), models, hidden: this.localServers.hidden };
  }

  /**
   * Строки пресетов роутера дополняются тем, что видно только в models.ini:
   * есть ли файлы модели на диске, включён ли vision (mmproj) и можно ли это
   * править отсюда. Строка, которой в файле нет (роутер поднят с --models-dir),
   * остаётся как есть: править нечего, и врать про её конфиг нельзя.
   *
   * Права на правку — по наличию секции: models.ini пишет только TaskBridge
   * (прописывание моделей библиотеки), поэтому строка с секцией — его запись, и
   * её можно убрать («Убрать» у пресета с удалёнными весами).
   */
  async #annotateRouterPresets(models) {
    if (!models.length || !this.localModels.enabled) return models;
    const file = modelsPresetPath(this.config.localRuntime?.router?.args);
    if (!file) return models;
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text == null) return models;
    const presets = new Map(parsePresets(text).map(preset => [preset.id, preset]));
    const rows = [];
    for (const model of models) {
      const preset = model.external === true ? null : presets.get(model.id);
      if (!preset) { rows.push(model); continue; }
      let missingFile = null;
      for (const entry of preset.paths) {
        try { await fs.stat(entry.value); }
        catch { missingFile = entry.value; break; }
      }
      rows.push({
        ...model,
        filesPresent: missingFile === null,
        missingFile,
        vision: preset.vision,
        visionEditable: true,
        removable: true,
      });
    }
    return rows;
  }

  // The local provider id Pi actually exposes (see resolveLocalProviderId).
  #localProviderId() {
    return resolveLocalProviderId({
      configured: this.localModels.provider,
      catalog: this.modelCatalog.peek()?.models
    });
  }

  // ---- MCP (pi-mcp-adapter) ----

  async mcpStatus() {
    return this.mcp.status();
  }

  async setMcpServer(name, enabled) {
    await this.mcp.setDisabled(name, enabled !== true);
    return this.mcp.status();
  }

  async setMcpTool(server, tool, enabled) {
    await this.mcp.setToolExcluded(server, tool, enabled !== true);
    return this.mcp.status();
  }

  async probeMcp(server = null) {
    return this.mcp.probe(server);
  }

  async upsertMcpServer(name, definition) {
    await this.mcp.upsertServer(name, definition);
    return this.mcp.status();
  }

  async removeMcpServer(name) {
    await this.mcp.removeServer(name);
    return this.mcp.status();
  }

  async importMcp() {
    await this.mcp.importFromPi();
    return this.mcp.status();
  }

  async loadLocalModel(id) {
    // Configured external servers (Strata): the model IS the server, so loading
    // is starting its process — the router path below cannot do that.
    const external = this.localServers.find(id);
    if (external) {
      await this.localServers.start(external);
      return this.localStatus();
    }
    if (!this.localModels.enabled) throw Object.assign(new Error('Router не настроен (localRuntime.router).'), { code: 'NOT_CONFIGURED' });
    await this.localModels.ensureRunning(() => {}, id);
    return this.localModels.getStatus();
  }

  async startLocal() {
    if (!this.localModels.enabled) throw Object.assign(new Error('Router не настроен (localRuntime.router).'), { code: 'NOT_CONFIGURED' });
    await this.localModels.ensureRunning(() => {});
    return this.localModels.getStatus();
  }

  async unloadLocalModel(id) {
    const external = this.localServers.find(id);
    if (external) {
      await this.localServers.stop(external);
      return this.localStatus();
    }
    if (!this.localModels.enabled) throw Object.assign(new Error('Router не настроен (localRuntime.router).'), { code: 'NOT_CONFIGURED' });
    await this.localModels.unloadModel(id);
    return this.localModels.getStatus();
  }

  /**
   * Размер контекста внешней локальной модели (Strata) — параметр ЗАГРУЗКИ,
   * поэтому он пишется в `--max-context` файла, из которого сервер стартует
   * движок, а не в конфиг TaskBridge (тот лишь показывает прочитанное число).
   * Пресеты роутера llama.cpp сюда не попадают: у них контекст в ctx-size
   * пресета models.ini, и подменить его при загрузке нечем.
   */
  async setLocalContext(id, context) {
    const external = this.localServers.find(id);
    if (external) return this.localServers.setContext(id, context);
    // Пресет роутера llama.cpp: ctx-size живёт в его секции models.ini — правим
    // её. Живой роутер перечитывает models.ini только при старте, поэтому правка
    // подхватывается после перезапуска роутера (об этом говорит restartRequired).
    const status = await this.localModels.getStatus();
    const model = (status.models || []).find(m => m.id === id);
    // Модель из библиотеки, чей пресет ещё не виден живому роутеру: путь весов
    // берём из её записи — секция в models.ini всё равно ищется по файлу.
    // id может быть как id записи библиотеки, так и именем её пресета.
    let libraryEntry = model ? null : this.modelLibrary.get(id);
    if (!libraryEntry) {
      for (const candidate of await this.modelLibrary.list()) {
        if (candidate.runtime?.preset === id) { libraryEntry = candidate; break; }
      }
    }
    const modelPath = model?.modelPath || model?.path
      || (libraryEntry?.runtime?.preset ? libraryEntry.files.find(f => !/mmproj/i.test(f.path))?.path : null);
    if (!model && !(libraryEntry?.runtime?.preset)) {
      throw Object.assign(new Error(`${id} — ни внешний сервер, ни модель роутера, ни прописанная модель библиотеки.`), { code: 'NOT_FOUND' });
    }
    if (!modelPath) {
      throw Object.assign(new Error(`Для ${id} не найден файл весов — контекст править негде.`), { code: 'LOCAL_CONTEXT_UNSUPPORTED' });
    }
    const file = modelsPresetPath(this.config.localRuntime?.router?.args);
    if (!file) {
      throw Object.assign(new Error('Роутер запущен без --models-preset: контекст менять негде.'), { code: 'LOCAL_CONTEXT_UNSUPPORTED' });
    }
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text == null) {
      throw Object.assign(new Error(`Файл ${file} не найден — контекст менять негде.`), { code: 'LOCAL_CONTEXT_UNSUPPORTED' });
    }
    const patched = patchPresetContext(text, modelPath, context);
    if (!patched) {
      throw Object.assign(new Error(`В ${file} нет секции с model = ${modelPath}: контекст правится только у пресетов из models.ini.`), { code: 'LOCAL_CONTEXT_UNSUPPORTED' });
    }
    if (patched.changed) {
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, patched.text, 'utf8');
      await fs.rename(tmp, file);
    }
    return {
      provider: this.#localProviderId(),
      model: model?.id || id,
      file,
      context,
      previous: patched.previous,
      changed: patched.changed,
      restartRequired: patched.changed && await this.localModels.isReady()
    };
  }

  /**
   * Vision пресета роутера — это ключи `mmproj`/`no-mmproj` его секции в
   * models.ini (llama.cpp читает файл при старте), поэтому правка устроена как
   * «Контекст»: меняется конфиг, значение подхватит следующий запуск роутера.
   *
   * Путь проектора при включении берётся из самой секции, иначе — из другой
   * секции с теми же весами, иначе из файла рядом с весами. Выдумывать проектор
   * нельзя: если ничего не нашлось — честная ошибка, а не правка файла вслепую.
   */
  async setLocalVision(id, vision) {
    if (typeof vision !== 'boolean') {
      throw Object.assign(new Error('Поле vision — это true или false.'), { code: 'INPUT_INVALID' });
    }
    if (this.localServers.find(id)) {
      throw Object.assign(new Error(`Vision у ${id} задаётся конфигом самого движка, а не models.ini.`), { code: 'LOCAL_VISION_UNSUPPORTED' });
    }
    const file = modelsPresetPath(this.config.localRuntime?.router?.args);
    if (!file) {
      throw Object.assign(new Error('Роутер запущен без --models-preset: пресет менять негде.'), { code: 'LOCAL_VISION_UNSUPPORTED' });
    }
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text == null) {
      throw Object.assign(new Error(`Файл ${file} не найден — пресет менять негде.`), { code: 'LOCAL_VISION_UNSUPPORTED' });
    }
    const presets = parsePresets(text);
    const preset = presets.find(candidate => candidate.id === id);
    if (!preset) {
      throw Object.assign(new Error(`В ${file} нет секции [${id}]: это не пресет роутера, vision правится только у них.`), { code: 'LOCAL_VISION_UNSUPPORTED' });
    }
    const projector = preset.mmproj || await this.#findProjector(preset, presets);
    if (vision === true && !projector) {
      throw Object.assign(new Error(`Для [${id}] не нашёл mmproj-проектор ни в другой секции с теми же весами, ни рядом с весами — добавьте строку mmproj = <файл> в models.ini.`), { code: 'LOCAL_VISION_UNSUPPORTED' });
    }
    const patched = patchPresetVision(text, id, { vision, mmproj: projector });
    if (!patched) {
      throw Object.assign(new Error(`В ${file} нет секции [${id}].`), { code: 'LOCAL_VISION_UNSUPPORTED' });
    }
    if (patched.changed) {
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, patched.text, 'utf8');
      await fs.rename(tmp, file);
    }
    return {
      provider: this.#localProviderId(),
      model: id,
      file,
      vision,
      previous: patched.previous,
      mmproj: patched.mmproj,
      changed: patched.changed,
      restartRequired: patched.changed && await this.localModels.isReady(),
    };
  }

  /** Проектор для пресета, у которого строки mmproj нет: сначала соседняя секция
   *  с тем же файлом весов, затем файл mmproj*.gguf рядом с весами. */
  async #findProjector(preset, presets) {
    const weights = preset.paths.find(entry => entry.key === 'model')?.value;
    if (!weights) return null;
    const sameWeights = presets.find(candidate => candidate.id !== preset.id && candidate.mmproj
      && candidate.paths.some(entry => entry.key === 'model' && entry.value.toLowerCase() === weights.toLowerCase()));
    if (sameWeights) return sameWeights.mmproj;
    const dir = path.dirname(weights);
    const names = await fs.readdir(dir).catch(() => []);
    const found = names.find(name => /mmproj/i.test(name) && /\.gguf$/i.test(name));
    return found ? path.join(dir, found) : null;
  }

  /**
   * Убрать внешний сервер из списка: запись TaskBridge из config.json (её можно
   * удалить) либо найденную автоматически строку — скрытием ([hideLocalServer]).
   * Возврат null означает «в конфиге нет»: строку надо скрывать, а не удалять.
   *
   * Сам config.json сохраняет вызывающий (у менеджера нет rootDir).
   */
  forgetLocalServer(id) {
    return this.localServers.forget(id);
  }

  /** Убрать ИЗ СПИСКА найденную автоматически строку (Pi/каталог установки): она скрывается. */
  hideLocalServer(id) {
    return this.localServers.hide(id);
  }

  /** Вернуть скрытую строку в список. */
  unhideLocalServer(id) {
    return this.localServers.unhide(id);
  }

  /**
   * Убрать пресет роутера из models.ini — это вторая половина «Убрать»: у строки
   * роутера нет записи в config.json, её конфиг — секция в models.ini. Веса могли
   * удалить, а секция осталась: без правки файла строка возвращалась бы после
   * каждого перезапуска роутера. Файлы модели не трогаются.
   *
   * Возвращает { preset, file, changed } или null — если секции нет (тогда и
   * убирать нечего: строка не из этого файла).
   */
  async forgetLocalPreset(id) {
    const file = modelsPresetPath(this.config.localRuntime?.router?.args);
    if (!file) return null;
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text == null || !parsePresets(text).some(preset => preset.id === id)) return null;
    // Живой роутер держит пресет в памяти: убрать секцию под ним — оставить
    // строку без конфига. Сначала «Остановить».
    const status = this.localModels.enabled ? await this.localModels.getStatus().catch(() => null) : null;
    const model = (status?.models || []).find(entry => entry.id === id);
    if (model && ['loaded', 'loading', 'sleeping'].includes(model.status)) {
      throw Object.assign(new Error(`${id} сейчас запущена — сначала остановите модель.`), { code: 'MODEL_BUSY' });
    }
    const removed = removePreset(text, id);
    if (!removed) return null;
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, removed.text, 'utf8');
    await fs.rename(tmp, file);
    return { preset: id, file, changed: true };
  }

  async stopLocal() {
    if (!this.localModels.enabled) throw Object.assign(new Error('Router не настроен (localRuntime.router).'), { code: 'NOT_CONFIGURED' });
    return this.localModels.stop();
  }

  // ---- локальная библиотека моделей + Hugging Face ----

  /**
   * Настройки — config.modelLibrary: { root: каталог для скачанных моделей }.
   * Токен HF берётся из env HF_TOKEN/HUGGING_FACE_HUB_TOKEN или из файла
   * <dataRoot>/hf-token (data/ вне git) — в config.json токен не пишется.
   */
  #initModelLibrary(config, dataRoot) {
    const settings = config.modelLibrary || {};
    const root = settings.root || path.join(dataRoot, 'models');
    const token = process.env.HF_TOKEN
      || process.env.HUGGING_FACE_HUB_TOKEN
      || (() => { try { return fsSync.readFileSync(path.join(dataRoot, 'hf-token'), 'utf8').trim(); } catch { return null; } })();
    this.hf = new HuggingFaceService({ token, baseUrl: settings.baseUrl });
    this.modelLibrary = new ModelLibrary(dataRoot);
    this.downloads = new DownloadManager(dataRoot, {
      downloadHeaders: () => token ? { authorization: `Bearer ${token}` } : {},
      onInstalled: (job) => this.modelLibrary.addFromJob(job)
    });
    this.modelLibraryRoot = root;
  }

  hfSearch(query) {
    return this.hf.search(query, { limit: 20 });
  }

  /** Репозиторий, разобранный на кванты/проекторы. */
  hfRepo(repo, revision) {
    return this.hf.analyze(repo, revision);
  }

  /**
   * Начать загрузку: { repo, revision?, files: [path], vision?: bool, projectorPath? }.
   * Размеры файлов сервер берёт сам из дерева репозитория — клиент присылает
   * только пути. Для vision скачивается один выбранный mmproj-проектор, а не
   * все проекторы из репозитория.
   */
  async hfDownload({ repo, revision = 'main', files, vision = true, projectorPath = null } = {}) {
    if (!repo || !Array.isArray(files) || !files.length) {
      throw Object.assign(new Error('Нужны repo и список файлов.'), { code: 'INPUT_INVALID' });
    }
    const tree = await this.hf.repoTree(repo, revision);
    const requested = [...files];
    if (vision !== false) {
      const projector = projectorPath || this.#chooseProjector(tree);
      if (projector && !requested.includes(projector)) requested.push(projector);
    }
    const plan = this.hf.plan(tree, requested);
    if (!plan) throw Object.assign(new Error('Часть файлов из запроса отсутствует в дереве репозитория.'), { code: 'INPUT_INVALID' });
    // id записи библиотеки известен уже здесь (квант и ревизия определены):
    // UI сможет предложить «Прописать в Pi» сразу после установки.
    const weightPath = plan.files.map(f => f.path).find(p => !/mmproj/i.test(p) && /\.gguf$/i.test(p)) || '';
    const libraryId = idForEntry({ repo, revision, quant: quantFromFilename(weightPath.split('/').pop()) });
    const slug = repo.split('/').pop();
    const dir = this.#downloadDirFor(repo, revision);
    return this.downloads.start({ repo, revision, files: plan.files, dir, label: slug, libraryId });
  }

  #chooseProjector(tree) {
    const projectors = (Array.isArray(tree) ? tree : [])
      .filter(entry => /\.gguf$/i.test(String(entry.path)) && /mmproj/i.test(String(entry.path)));
    if (!projectors.length) return null;
    const rank = (entry) => {
      const name = String(entry.path);
      if (/Q5_K_M/i.test(name)) return 0;
      if (/Q4_K_M/i.test(name)) return 1;
      if (/Q8_0/i.test(name)) return 2;
      if (/BF16/i.test(name)) return 3;
      if (/F16|FP16/i.test(name)) return 4;
      return 10;
    };
    return projectors
      .sort((a, b) => rank(a) - rank(b) || Number(a.lfs?.size ?? a.size ?? Infinity) - Number(b.lfs?.size ?? b.size ?? Infinity))
      [0].path;
  }

  #downloadDirFor(repo, revision) {
    const safe = (value) => String(value || 'main')
      .replace(/[<>:"\\|?*\x00-\x1F]+/g, '-')
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 120) || 'main';
    const parts = String(repo).split('/').filter(Boolean).map(safe);
    return path.join(this.modelLibraryRoot, ...parts, safe(revision));
  }

  hfDownloads() {
    return { jobs: this.downloads.list() };
  }

  /** Очистить завершённые задания из списка загрузок (файлы не трогаются). */
  hfDownloadsClear() {
    return { removed: this.downloads.clearFinished() };
  }

  hfCancelDownload(id) {
    return this.downloads.cancel(id);
  }

  hfRetryDownload(id) {
    return this.downloads.retry(id);
  }

  async libraryStatus({ fresh = false } = {}) {
    const models = await this.modelLibrary.list({ fresh });
    const standalone = await this.modelLibrary.scan(this.modelLibraryRoot);
    return { models, standalone, root: this.modelLibraryRoot };
  }

  async libraryScan() {
    return this.libraryStatus({ fresh: true });
  }

  libraryForget(id) {
    const removed = this.modelLibrary.remove(id);
    if (!removed) throw Object.assign(new Error('Модели нет в библиотеке.'), { code: 'NOT_FOUND' });
    return this.libraryStatus();
  }

  /**
   * Удалить скачанную модель из библиотеки — аккуратно:
   *   1. запущенную/загружаемую модель не трогаем (сначала «Остановить»);
   *   2. пресет убирается из models.ini;
   *   3. удаляются ТОЛЬКО файлы этой записи, на которые не ссылается другая
   *      запись (vision-проектор может быть общим с соседним квантом);
   *   4. каталог записи убирается, только если опустел.
   */
  async libraryDelete(id) {
    const entry = this.modelLibrary.get(id);
    if (!entry) throw Object.assign(new Error('Модели нет в библиотеке.'), { code: 'NOT_FOUND' });

    // 1. Не удалять то, чем пользуются прямо сейчас.
    if (this.localModels.enabled) {
      const status = await this.localModels.getStatus();
      const preset = entry.runtime?.preset;
      const samePath = (a, b) => a && b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
      const busy = (status.models || []).find(m =>
        (preset && m.id === preset) || (m.modelPath && (entry.files || []).some(f => samePath(f.path, m.modelPath))));
      if (busy && ['loaded', 'sleeping', 'loading'].includes(busy.status)) {
        throw Object.assign(new Error(`Модель ${busy.id} сейчас запущена — сначала остановите её.`), { code: 'MODEL_BUSY' });
      }
    }

    // 2. Пресет из models.ini.
    let presetRemoved = false;
    const iniFile = modelsPresetPath(this.config.localRuntime?.router?.args);
    if (entry.runtime?.preset && iniFile) {
      const text = await fs.readFile(iniFile, 'utf8').catch(() => null);
      if (text != null) {
        const removed = removePreset(text, entry.runtime.preset);
        if (removed) {
          const tmp = `${iniFile}.tmp`;
          await fs.writeFile(tmp, removed.text, 'utf8');
          await fs.rename(tmp, iniFile);
          presetRemoved = true;
        }
      }
    }

    // 3. Файлы записи, кроме тех, на которые ссылается другая запись.
    const others = await this.modelLibrary.list({ fresh: true });
    const usedElsewhere = new Set(others.filter(e => e.id !== id)
      .flatMap(e => (e.files || []).map(f => path.resolve(f.path).toLowerCase())));
    const removed = [];
    const kept = [];
    let freedBytes = 0;
    for (const file of entry.files || []) {
      if (usedElsewhere.has(path.resolve(file.path).toLowerCase())) { kept.push(file.path); continue; }
      try {
        const stat = await fs.stat(file.path);
        await fs.unlink(file.path);
        freedBytes += stat.size;
        removed.push(file.path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    // 4. Каталог записи — только если опустел (rm без recursive падает на
    // непустом каталоге: чужие файлы рядом остаются целыми).
    if (entry.dir) {
      const root = path.resolve(this.modelLibraryRoot);
      const dir = path.resolve(entry.dir);
      if (dir.startsWith(root) && dir !== root) {
        await fs.rm(dir, { force: true }).catch(() => {});
      }
    }

    // 5. Из реестра.
    this.modelLibrary.remove(id);
    return { removed, kept, freedBytes, presetRemoved };
  }

  /**
   * «Запустить» для модели из библиотеки: пресет уже в models.ini (или будет
   * добавлен сейчас), роутер при необходимости перезапускается, чтобы перечитать
   * пресеты, и модель грузится. Управляемый роутер перезапускаем сами; запущенный
   * извне не трогаем — честная ошибка вместо убийства чужого процесса.
   */
  async libraryRun(id) {
    const entry = this.modelLibrary.get(id);
    if (!entry) throw Object.assign(new Error('Модели нет в библиотеке.'), { code: 'NOT_FOUND' });
    if (!this.localModels.enabled) throw Object.assign(new Error('Router не настроен (localRuntime.router).'), { code: 'NOT_CONFIGURED' });
    let preset = entry.runtime?.preset;
    if (!preset) ({ preset } = await this.libraryRegister(id));
    const status = await this.localModels.getStatus();
    const known = (status.models || []).some(m => m.id === preset);
    if (!known && status.state === 'EXTERNAL_RUNNING') {
      throw Object.assign(new Error('Роутер запущен извне и не знает нового пресета — перезапустите его вручную, models.ini уже обновлён.'), { code: 'LOCAL_RUNTIME_FAILED' });
    }
    if (!known && status.state === 'MANAGED_RUNNING') {
      await this.localModels.stop();
    }
    // ensureRunning поднимает остановленный роутер (перечитывая models.ini)
    // и загружает пресет; если пресет уже известен живому роутеру — просто грузит.
    await this.localModels.ensureRunning(() => {}, preset);
    this.modelLibrary.add({ ...entry, runtime: { ...(entry.runtime || {}), preset, lastRunAt: Date.now() } });
    return this.localStatus({});
  }

  /**
   * «Прописать в Pi»: пресет в models.ini роутера llama.cpp. Pi перечисляет
   * модели роутера через свой провайдер — после перезапуска роутера модель
   * появляется в его пикере. В ~/.pi/agent/models.json TaskBridge не пишет:
   * это файл Pi (то же правило, что у внешних серверов).
   */
  async libraryRegister(id, { ctxSize } = {}) {
    const entry = this.modelLibrary.get(id);
    if (!entry) throw Object.assign(new Error('Модели нет в библиотеке.'), { code: 'NOT_FOUND' });
    const file = modelsPresetPath(this.config.localRuntime?.router?.args);
    // Живой роутер читает models.ini только при старте: новый пресет он увидит
    // после перезапуска, и пользователь должен об этом знать.
    const routerAlive = this.localModels.enabled && await this.localModels.isReady();
    const result = await registerLibraryPreset({
      entry,
      file,
      ctxSize: Number.isInteger(ctxSize) && ctxSize > 0 ? ctxSize : undefined,
      routerAlive
    });
    this.modelLibrary.add({
      ...entry,
      runtime: { ...(entry.runtime || {}), preferred: 'llama.cpp', preset: result.preset }
    });
    return result;
  }

  // Translates a raw file path or alias into the exact model id Pi lists in its
  // catalog (e.g. G:\...\Qwen3.8-27B-UD-Q3_K_XL.gguf -> qwen-27b-q3).
  // probe=false keeps the caller on cached catalog ids only and never spawns a
  // Pi probe: a fresh probe takes seconds, and with an expired cache (60s TTL)
  // the model switch would hang on it. The picker always sends an exact
  // provider/id that exists in the catalog, so anything not in the cache is
  // passed as-is — Pi itself validates the model at switch time.
  async #resolvePiModelId(provider, modelId, { probe = true } = {}) {
    if (!modelId) return modelId;
    let known = this.modelCatalog.peek()?.models || [];
    if (!known.length && probe) {
      const catalog = await this.modelCatalog.list().catch(() => null);
      known = catalog?.models || [];
    }
    if (known.some(m => m.provider === provider && m.id === modelId)) return modelId;

    const isPath = modelId.includes('\\') || modelId.includes('/') || modelId.endsWith('.gguf');
    const baseName = isPath ? modelId.split(/[\\/]/).pop().replace(/\.gguf$/i, '').toLowerCase() : modelId.toLowerCase();
    const parts = baseName.split(/[-_]/);
    const quant = (parts[parts.length - 1] || quantFromPath(modelId) || '').toLowerCase();
    const providerModels = known.filter(m => m.provider === provider);

    const match = providerModels.find(m => {
      const mid = m.id.toLowerCase();
      const mname = (m.name || '').toLowerCase();
      return mid === baseName || baseName.includes(mid) || mname.includes(baseName) || (quant && (mid.includes(quant) || mname.includes(quant)));
    });
    if (match) return match.id;

    return modelId;
  }

  // Switches the model of an existing session, starting (or restoring) the Pi
  // session if needed. Mirrors Pi's own /model: the switch is written into the
  // session transcript, so it survives the next TaskBridge restart.
  async setModel(id, provider, modelId) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    const model = this.#normalizeModelSelection({ provider, id: modelId });
    if (!model) throw Object.assign(new Error('Укажите provider и id модели.'), { code: 'INPUT_INVALID' });
    // Cached ids only: the selection must not wait on a catalog probe.
    const targetModelId = await this.#resolvePiModelId(model.provider, model.id, { probe: false });
    // A session whose Pi is dead (or gone) has nothing to apply the switch to
    // over RPC. Failing here made a dead session unfixable — the operator could
    // not even point it at a working model (observed 2026-10-01: Strata was
    // unloaded, Pi exited code=0, and the switch answered "Pi RPC session is
    // not writable"). The selection is persisted instead: the next start uses
    // it. This is also what makes a model switch a way OUT of a hung session.
    const live = this.runtimes.get(id);
    if (!live || live.pi.closed || live.pi.canSend?.() === false) {
      task.requestedModel = { provider: model.provider, id: targetModelId };
      task.model = this.#taskModel({ id: targetModelId, provider: model.provider, contextWindow: null, maxTokens: null });
      task.updatedAt = now();
      await this.store.save(this.#publicTask(task));
      await this.#event(task, 'MODEL_SWITCH', `Модель: ${model.provider}/${task.requestedModel.id} (применится при следующем запуске сессии)`, { provider: model.provider, modelId: task.requestedModel.id });
      return this.#publicTask(task);
    }
    const runtime = await this.#ensureSession(task);
    const state = await runtime.pi.getState().catch(async error => {
      await this.#recoverRpcFailure(task, error);
      throw error;
    });
    if (state?.isStreaming || state?.isCompacting) throw Object.assign(new Error('Дождитесь завершения ответа перед сменой модели.'), { code: 'BUSY' });
    // Cached ids only: the selection must not wait on a catalog probe.
    const applied = await runtime.pi.setModel(model.provider, targetModelId).catch(async (error) => {
      if (['PI_RPC_HUNG', 'PI_RPC_EXITED'].includes(error?.code)) {
        await this.#recoverRpcFailure(task, error);
        throw error;
      }
      throw Object.assign(new Error(`Pi не принял модель ${model.provider}/${targetModelId}: ${error.message}`), { code: 'MODEL_NOT_FOUND' });
    });
    task.requestedModel = { provider: model.provider, id: applied?.id || targetModelId };
    task.model = this.#taskModel(applied
      ? { id: applied.id, provider: applied.provider, contextWindow: applied.contextWindow ?? null, maxTokens: applied.maxTokens ?? null }
      : { id: targetModelId, provider: model.provider, contextWindow: null, maxTokens: null });
    const nextState = await runtime.pi.getState().catch(() => null);
    task.thinkingLevelActual = nextState?.thinkingLevel ?? task.thinkingLevelActual ?? null;
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#event(task, 'MODEL_SWITCH', `Модель: ${model.provider}/${task.requestedModel.id}`, { provider: model.provider, modelId: task.requestedModel.id });
    return this.#publicTask(task);
  }

  async setThinkingLevel(id, level) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    const value = this.#normalizeThinkingLevel(level);
    if (!value) throw Object.assign(new Error('Укажите thinking level.'), { code: 'INPUT_INVALID' });
    // The levels of THIS model, not the catalogue-wide list: the latter belongs
    // to Pi's current default model, and a local Strata model takes a different
    // set (no «minimal», no «max»). Rejecting an unsupported level is honest —
    // Pi itself would silently clamp it to a neighbour.
    const model = task.model || task.requestedModel;
    const levels = this.#thinkingLevelsFor(model);
    if (levels.length && !levels.includes(value)) {
      const name = model?.id ? `${model.provider ? `${model.provider}/` : ''}${model.id}` : 'модель сессии';
      throw Object.assign(new Error(`Модель ${name} не поддерживает уровень размышлений «${value}». Доступно: ${levels.join(', ')}.`), { code: 'INPUT_INVALID' });
    }
    task.thinkingLevel = value;
    const runtime = this.runtimes.get(id);
    if (runtime && !runtime.pi.closed) {
      await runtime.pi.setThinkingLevel(value);
      // Read back what Pi really applied: it clamps a level the model cannot
      // take, and the UI must show the effective value, not the request.
      const nextState = await runtime.pi.getState(PiRpcSession.PROBE_TIMEOUT_MS).catch(() => null);
      task.thinkingLevelActual = nextState?.thinkingLevel ?? value;
    } else {
      // A stopped session has no live Pi to apply the level: it is saved here
      // and picked up when the session starts again (#selectionArgs passes
      // --thinking), so the effective level is the saved one right away —
      // showing the stale old value reads as «кнопка не работает».
      task.thinkingLevelActual = value;
    }
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#event(task, 'THINKING_LEVEL', `Thinking level: ${value}`, { level: value, actual: task.thinkingLevelActual ?? null });
    return this.#publicTask(task);
  }

  // The session's model as the clients need it. Pi's own state carries only the
  // id/provider/window of what is running, while the per-model facts live in the
  // catalogue — above all the thinking map: without it the UI offered the
  // catalogue-wide levels to every model, so a local Strata model got «minimal»
  // (null in its map) and «Глубоко» without the note that the engine receives
  // «xhigh». Cached ids only, this runs on hot paths.
  #taskModel(model) {
    if (!model?.id) return null;
    const entry = this.modelCatalog.peek()?.models?.find(candidate =>
      candidate.id === model.id && (!model.provider || candidate.provider === model.provider));
    if (entry) {
      return {
        ...entry,
        contextWindow: model.contextWindow ?? entry.contextWindow ?? null,
        maxTokens: model.maxTokens ?? entry.maxTokens ?? null
      };
    }
    return { id: model.id, provider: model.provider ?? null, contextWindow: model.contextWindow ?? null, maxTokens: model.maxTokens ?? null };
  }

  // Levels the model accepts, from the catalogue entry for it. Empty when the
  // catalogue is not loaded (or the model is missing from it) — callers then
  // leave the request alone and let Pi clamp.
  #thinkingLevelsFor(model) {
    // A task restored from the store may carry the leaner model shape of an
    // older payload, so the catalogue lookup stays as the fallback.
    if (Array.isArray(model?.thinkingLevels) && model.thinkingLevels.length) return model.thinkingLevels;
    const catalog = this.modelCatalog.peek();
    const entry = model?.id
      ? catalog?.models?.find(candidate => candidate.id === model.id && (!model.provider || candidate.provider === model.provider))
      : null;
    if (Array.isArray(entry?.thinkingLevels) && entry.thinkingLevels.length) return entry.thinkingLevels;
    return Array.isArray(catalog?.thinkingLevels) ? catalog.thinkingLevels : [];
  }

  async setAutoCompaction(id, enabled) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' });
    // Keep the preference for the next process too; opening history need not
    // start a model process just to change this setting.
    const runtime = this.runtimes.get(id);
    if (runtime && !runtime.pi.closed) await runtime.pi.setAutoCompaction(Boolean(enabled));
    task.autoCompactionEnabled = Boolean(enabled);
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    return this.#publicTask(task);
  }

  // ---- «откуда контекст» и лимит контекста сессии --------------------------

  // Разбор запроса к модели по источникам (см. context-report.mjs). Живые числа
  // берутся у Pi (`get_session_stats`), поэтому открывать сессию не нужно, а если
  // она открыта — числа относятся к ней, а не к файлу на диске.
  async contextReport(id) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    const cwd = task.workspacePath || null;
    const mcp = await this.mcp.status().catch(() => null);
    const [sources, compaction] = await Promise.all([
      collectContextSources({ cwd, mcp }),
      readCompactionSettings({ cwd }),
    ]);
    const runtime = this.runtimes.get(id);
    const live = runtime && !runtime.pi.closed && runtime.pi.canSend?.() !== false;
    const stats = live ? await runtime.pi.getSessionStats().catch(() => null) : null;
    const model = task.model || task.requestedModel || null;
    return buildContextReport({
      taskId: task.id,
      model: model ? { provider: model.provider ?? null, id: model.id ?? null, contextWindow: model.contextWindow ?? null } : null,
      contextWindow: model?.contextWindow ?? null,
      stats,
      sources,
      compaction: { ...compaction, auto: task.autoCompactionEnabled },
      limit: task.contextLimit ?? null,
      running: !RUN_TERMINAL.has(task.status),
    });
  }

  // Лимит контекста этой сессии. Не настройка Pi: Pi знает только своё окно
  // модели, а лимит — верхняя граница, после которой TaskBridge сам сжимает
  // историю (см. #enforceContextLimit). `null` — без лимита.
  async setContextLimit(id, value) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    const limit = assertContextLimit(value);
    task.contextLimit = limit;
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#event(task, 'CONTEXT_LIMIT_SET',
      limit === null ? 'Лимит контекста снят' : `Лимит контекста: ${limit} токенов`,
      { limit });
    return this.contextReport(id);
  }

  async #handlePiEvent(task, frame, runtime = null) {
    if (this.deleted.has(task.id)) return;
    // Шаг C-A: любой кадр от Pi — это прогресс хода. Ставится до фильтров
    // (в т.ч. до отбрасывания хвоста после STOP): клиентский таймер молчания
    // считает от последнего признака жизни модели, а не от последнего
    // отрисованного сообщения.
    task._lastProgressAt = Date.now();
    await this.store.appendRaw(task.id, 'pi-events.jsonl', JSON.stringify(frame) + '\n').catch(() => {});
    // STOP must stick. Pi keeps sending the frames it had already queued when the
    // abort arrived — the tail of the half-finished message, or an `agent_start`
    // for a turn it was about to begin — and handled like any other they revived
    // the just-cancelled task (`agent_start` below sets RUNNING again) while the
    // chat kept receiving reasoning after the operator pressed STOP. The next
    // user turn clears cancelRequested (#deliverMessage), so only the stopped
    // turn's tail is dropped; the raw frame is still on disk (line above).
    const stopped = runtime ?? this.runtimes.get(task.id);
    if (stopped?.cancelRequested === true) {
      if (frame.type === 'agent_settled') this.#resolveSettle(task.id);
      return;
    }
    // Живой кадр = фаза PROGRESS. Публикуется один раз на ход (дальше только
    // обновление _lastProgressAt в снимке), чтобы не дублировать кадры в ленту.
    if (task._turnPhase !== 'PROGRESS') await this.#turnStateEvent(task, 'PROGRESS');
    if (frame.type === 'extension_ui_request') return this.#onUiRequest(task, frame);
    // Провайдер ответил — объявленный повтор кончился. Доказательство только
    // одно: кадр от Pi. Heartbeat подтверждает связь с TaskBridge, а не ответ
    // модели, и ожидание с него не снимается.
    if (task.providerWait && (frame.type === 'message_start' || frame.type === 'message_update' || frame.type === 'agent_settled')) {
      await this.#clearProviderWait(task, frame.type);
    }
    if (frame.type === 'tool_execution_start') task._toolsRunning = (task._toolsRunning || 0) + 1;
    if (frame.type === 'tool_execution_end') {
      task._toolsRunning = Math.max(0, (task._toolsRunning || 0) - 1);
      // The next model call starts after the tool result becomes available.
      // Measuring from here to the first delta gives remote providers a useful
      // effective PP value even though their APIs do not expose prompt timings.
      task._promptStartedAt = Date.now();
      task._promptMs = 0;
      task._firstTokenAt = 0;
    }
    if (frame.type === 'compaction_start' || frame.type === 'auto_compaction_start') {
      task._compacting = true;
      // Отметка старта: клиенты показывают, сколько длится сжатие (компакт%
      // сводки может писать минуты, и без таймера это выглядит как зависание).
      task._compactingSince = Date.now();
      // A second compaction in the same task must re-emit chunk 1 (task-manager #onUiRequest).
      task._compactionStage = null;
      // Статусная строка чата и «Активность» в диагностике должны называть
      // сжатие: без этого в начале хода было только уведомление PI_EVENT,
      // а само состояние сессии выглядело «работает» без видимой причины.
      task.current = 'Pi сжимает контекст…';
    }
    if (frame.type === 'compaction_end' || frame.type === 'auto_compaction_end') {
      task._compacting = false;
      // The active compaction line must not outlive the explicit end frame. A
      // stuck compaction is still visible while no end frame arrives; after the
      // end, keeping the last smart-compaction tick as `current` makes the UI
      // look busy even though runtime.activity is no longer compacting.
      if (task.current === 'Pi сжимает контекст…' || String(task.current || '').startsWith('Smart compaction: ')) task.current = '';
      task._compactionStage = null;
      task._compactingSince = 0;
    }
    if (frame.type === 'agent_settled') {
      task._toolsRunning = 0;
      // A dialog cannot outlive its turn.
      if (task.pendingUiRequest) await this.#closeUiRequest(task, task.pendingUiRequest.id, { cancelled: true, reason: 'turn_ended' });
    }

    if (frame.type === 'message_update') {
      const delta = frame.assistantMessageEvent;
      if (delta?.type === 'text_delta' || delta?.type === 'thinking_delta') this.#trackStreamTime(task);
      if (delta?.type === 'text_delta') task.assistantText = stripMcpAdapterNoise(appendTail(task.assistantText, delta.delta, TEXT_TAIL));
      if (delta?.type === 'thinking_delta') {
        task.thinkingText = appendTail(task.thinkingText, delta.delta, THINKING_TAIL);
        // Токены, а не символы: та же эвристика, что у Pi и в отчёте «Откуда
      // контекст» (chars/4 вверх), и число сопоставимо с остальными подписями.
      task.current = `Pi is thinking… (~${estimateTokens(task.thinkingText.length)} tok)`;
      }
      if (frame.usage?.totalTokens > 0) task.lastUsage = frame.usage;
    }
    if (frame.type === 'tool_execution_start') {
      const arg = frame.args?.command || frame.args?.path || frame.args?.file_path || '';
      task.current = `${frame.toolName || 'tool'}${arg ? `: ${String(arg).slice(0, 160)}` : ''}`;
      if (frame.toolCallId) this.toolLogs.set(`${task.id}:${frame.toolCallId}`, { name: `tool-${safeFileName(frame.toolCallId)}.log`, bytes: 0 });
    }
    if (frame.type === 'tool_execution_update') {
      // Only a text chunk streams into the log. Pi's partialResult is an object
      // holding the output so far (not a delta): appending it wrote
      // "[object Object]", and its text would repeat; the end frame has it all.
      const chunk = [frame.output, frame.delta, frame.partialResult].find(value => typeof value === 'string') ?? '';
      const log = frame.toolCallId ? this.toolLogs.get(`${task.id}:${frame.toolCallId}`) : null;
      if (log && chunk) {
        log.bytes += Buffer.byteLength(chunk, 'utf8');
        this.store.appendRaw(task.id, log.name, chunk).catch(() => {});
      }
    }
    if (frame.type === 'tool_execution_end' && frame.toolCallId) {
      const key = `${task.id}:${frame.toolCallId}`;
      const log = this.toolLogs.get(key) ?? { name: `tool-${safeFileName(frame.toolCallId)}.log`, bytes: 0 };
      // Nothing streamed as text: the log is the final result, in full.
      const text = log.bytes === 0 ? toolResultText(frame.result) : '';
      if (text) {
        log.bytes = Buffer.byteLength(text, 'utf8');
        this.store.writeArtifact(task.id, log.name, text).catch(() => {});
      }
      if (log.bytes > 0) this.store.writeArtifact(task.id, `${log.name}.meta.json`, JSON.stringify({ toolCallId: frame.toolCallId, toolName: frame.toolName ?? null, bytes: log.bytes, at: now() })).catch(() => {});
      this.toolLogs.delete(key);
    }
    if (['compaction_end', 'auto_compaction_end'].includes(frame.type) && frame.result) {
      task.compaction.count += 1;
      const estimatedTokensAfter = frame.result.estimatedTokensAfter ?? null;
      task.compaction.last = {
        reason: frame.reason,
        tokensBefore: frame.result.tokensBefore ?? null,
        estimatedTokensAfter,
        summary: typeof frame.result.summary === 'string' ? frame.result.summary : null,
        at: now()
      };
      if (Number.isFinite(estimatedTokensAfter) && estimatedTokensAfter > 0) {
        task.lastUsage = { ...(task.lastUsage || {}), totalTokens: estimatedTokensAfter };
      }
    }
    if (frame.type === 'agent_start') {
      task.status = 'RUNNING';
      task.current = 'Pi is working';
      task._promptStartedAt = Date.now();
      task._promptMs = 0;
      task._firstTokenAt = 0;
      task._firstDeltaAt = 0;
      task._lastDeltaAt = 0;
      task.updatedAt = now();
      await this.store.save(this.#publicTask(task));
    }
    if (frame.type === 'message_end' && frame.message?.role === 'assistant') {
      if (frame.message.usage?.totalTokens > 0) task.lastUsage = frame.message.usage;
      if (frame.message.stopReason === 'error') task._modelError = frame.message.errorMessage || 'Модель завершила ответ с ошибкой.';
      // A message that produced no token at all is a failed attempt (connection
      // error, the wait before a retry): its time-to-first-token is the WAIT, not
      // the model's latency, and one such sample poisons the p50 the picker
      // shows. An answer cut short by an error keeps its sample — tokens were
      // really generated and their rate is real.
      if (frame.message.stopReason !== 'error' || Number(frame.message.usage?.output || 0) > 0) {
        await this.#recordGenerationSpeed(task);
      }
    }
    if (frame.type === 'message_end' || frame.type === 'compaction_end' || frame.type === 'auto_compaction_end') {
      task.updatedAt = now();
      await this.store.save(this.#publicTask(task));
    }

    await this.#event(task, 'PI_EVENT', summarizePiEvent(frame), { pi: storedPiFrame(frame) }, false);

    if (frame.type === 'message_end' && frame.message?.role === 'assistant') {
      await this.store.pruneStreamingDeltas(task.id).catch(() => {});
    }

    if (frame.type === 'agent_settled') this.#resolveSettle(task.id);
  }

  // Wall-clock window the model spent on one assistant message: its first delta
  // to its message_end. Tool execution happens between messages, so nothing has
  // to be guessed away here; only the time to the FIRST token (TTFT) is not part
  // of it, because that is prefill and is reported as its own number.
  #trackStreamTime(task) {
    const at = Date.now();
    if (!task._firstTokenAt && task._promptStartedAt) {
      task._firstTokenAt = at;
      task._promptMs = Math.max(0, at - task._promptStartedAt);
    }
    if (!task._firstDeltaAt) task._firstDeltaAt = at;
    task._lastDeltaAt = at;
  }

  // Prefer the local engine's own counters — the same source used by modern
  // llama.cpp/LM Studio-style dashboards. A provider that only exposes token
  // usage gets PP from the tokens it actually had to prefill (cache hits are
  // excluded: they cost no prefill work), and a local engine without counters
  // gets no PP at all — see generationMetrics.
  async #recordGenerationSpeed(task) {
    const windowMs = generationWindowMs(task._firstDeltaAt, Date.now());
    task._firstDeltaAt = 0;
    task._lastDeltaAt = 0;
    const promptMs = task._promptMs || 0;
    task._promptMs = 0;
    task._promptStartedAt = 0;
    task._firstTokenAt = 0;

    // One TTFT sample per assistant message, for every model (local and cloud).
    // Pi does not always name the provider (the default model, and local router
    // ids that drift between Pi and models.json), so it is taken from the task's
    // own selection, then from the catalog: the key has to be the provider/id the
    // clients look up.
    const ranModel = task.model || task.requestedModel;
    if (ranModel?.id) {
      const requested = task.requestedModel?.id === ranModel.id ? task.requestedModel : null;
      const provider = ranModel.provider
        || requested?.provider
        || this.modelCatalog.peek()?.models?.find(model => model.id === ranModel.id)?.provider
        || '';
      await this.modelLatency.record({ provider, id: ranModel.id }, promptMs);
    }

    const inputTokens = Number(task.lastUsage?.input || 0) + Number(task.lastUsage?.cacheRead || 0);
    const outputTokens = Number(task.lastUsage?.output || 0);
    // The router's /metrics describe the llama.cpp engine only: a configured
    // external server (Strata) is a different process with its own cache, so its
    // numbers must never be read as this session's.
    const routerEngine = this.localModels?.enabled && this.#usesLocalRuntime(task);
    // Сессия на внешнем сервере: Pi называет провайдера по-своему ('strata'), а
    // сервер в конфиге — по имени профиля ('strata-iq3s'), поэтому поиск только
    // по провайдеру не находил сервер. PP тогда считался оценкой «новые токены /
    // TTFT» (141K промпт почти целиком из кеша → честные 1845 новых за 4,4 с
    // показывались как «PP ≈422 tok/s», на другом ходу «≈23»). Сервер ищем и по
    // id модели — как это делает liveEnginePrompt на клиенте, — а PP/TG берём из
    // телеметрии самого сервера: у кеш-попаданий Strata сам не отдаёт PP
    // (ppUnavailable: 'conversation-cache'), и оценка не выдумывается.
    const providerId = task.model?.provider || task.requestedModel?.provider;
    const modelId = task.model?.id || task.requestedModel?.id;
    const externalServer = (providerId && this.localServers?.find(providerId))
      || (modelId && this.localServers?.find(modelId))
      || null;
    let engine = routerEngine ? await this.localModels.getMetrics().catch(() => null) : null;
    if (!engine && externalServer) {
      engine = await this.localServers.metrics(externalServer).catch(() => null);
    }
    const metrics = generationMetrics({
      usage: task.lastUsage,
      promptMs,
      windowMs,
      engine,
      local: routerEngine || Boolean(externalServer)
    });
    if (!metrics) return;
    task.metrics = metrics;
    // Скорости сессии, а не одного хода: PP у кеш-попаданий отсутствует, поэтому
    // копятся только те ходы, где число было (см. accumulateSessionSpeeds).
    task.speeds = accumulateSessionSpeeds(task.speeds, metrics);
  }

  #waitForSettle(taskId, timeoutMs) {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return Promise.reject(new Error('Pi runtime is missing'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.settleResolvers = runtime.settleResolvers.filter((x) => x.resolve !== resolve);
        reject(Object.assign(new Error('Timed out waiting for Pi to settle'), { code: 'PROCESS_TIMEOUT' }));
      }, timeoutMs);
      runtime.settleResolvers.push({ resolve, reject, timer });
    });
  }

  #resolveSettle(taskId) {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return;
    const waiters = runtime.settleResolvers.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  // A turn is one prompt followed by its settle. The token lets a finalizer know
  // whether a newer turn has already taken the session over.
  #beginTurn(task) {
    const runtime = this.runtimes.get(task.id);
    const turn = (runtime?.turn || 0) + 1;
    if (runtime) runtime.turn = turn;
    task._turn = turn;
    // Шаг C-A: фаза хода начинается с диспетчеризации. Поле сбрасывается, а не
    // ставится в DISPATCHING: публикацию делает #turnStateEvent в точке отправки
    // (иначе дедупликация съела бы первое событие хода).
    task._turnPhase = null;
    // Silence starts with this dispatch, not the previous turn's last frame.
    task._lastProgressAt = Date.now();
    return turn;
  }

  // Шаг C-A: фаза хода не откатывается. Кадр Pi может опередить запись ACK
  // (prompt() резолвится позже первого кадра), и без этого лента показывала бы
  // «ждём первый кадр» после того, как модель уже ответила. Новый ход начинает
  // с DISPATCHING (#beginTurn), так что откат возможен только внутри хода.
  #turnPhaseRank(phase) {
    return { DISPATCHING: 1, ACKED: 2, PROGRESS: 3, SETTLED: 4, FAILED: 4, CANCELLED: 4 }[phase] || 0;
  }

  // Шаг C-A: публикация фазы хода. Лёгкое аддитивное событие TURN_STATE идёт
  // в общей ленте событий (попадает в replay/историю); клиенты, не знающие
  // тип, его игнорируют. persistTask=false: фаза меняется часто, снимок задачи
  // и так уходит в сохранение на следующем статусе/кадре.
  async #turnStateEvent(task, phase) {
    const rank = this.#turnPhaseRank(phase);
    const rankNow = this.#turnPhaseRank(task._turnPhase);
    if (phase === task._turnPhase || rank < rankNow) return;
    task._turnPhase = phase;
    await this.#event(task, 'TURN_STATE', `Ход: ${phase}`, {
      phase,
      turn: task._turn ?? null,
      stage: task.current || null,
      lastProgressAt: task._lastProgressAt ? new Date(task._lastProgressAt).toISOString() : null,
    }, false).catch(() => {});
  }

  // Шаг C-C: тайминги доставки хода. Числа уходят в реестр deliveryMetrics
  // (видны в /api/metrics) и одной строкой в pi-events.jsonl — raw-журнал
  // остаётся на диске, даже когда ход уже потерян чатом.
  #recordTurnTiming(task, timing) {
    if (this.deleted.has(task.id)) return;
    if (Number.isFinite(timing.dispatchMs)) deliveryMetrics.observe('turn_dispatch_ms', Math.max(0, timing.dispatchMs));
    if (Number.isFinite(timing.ackMs)) deliveryMetrics.observe('ack_latency_ms', Math.max(0, timing.ackMs));
    this.store.appendRaw(task.id, 'pi-events.jsonl', JSON.stringify({ type: 'taskbridge_turn_timing', at: now(), ...timing }) + '\n').catch(() => {});
  }

  async #verifyAndFinalize(task, run = {}) {
    if (this.closing) return; // a closed store must not receive this run's tail
    if (this.deleted.has(task.id) || task.status === 'CANCELLED') return;
    const runtime = this.runtimes.get(task.id);
    const turn = run.turn ?? null;
    // A newer turn already owns the session: this turn must not touch its state.
    if (turn != null && task._turn !== turn) return;
    if (task._modelError) return this.#fail(task, Object.assign(new Error(task._modelError), { code: 'MODEL_ERROR' }));
    // The turn completed: the in-flight marker is spent (see #deliverMessage).
    if (task.inFlightPrompt) { task.inFlightPrompt = null; await this.store.save(this.#publicTask(task)).catch(() => {}); }
    await this.#setStatus(task, 'VERIFYING', 'Collecting diff and changed files');
    const gitState = await collectGitStateForCompletion(task.workspacePath);
    // STOP can arrive while Git is being inspected. Do not resume finalizing
    // that turn after cancellation (or after a newer turn takes ownership).
    if (this.deleted.has(task.id) || task.status === 'CANCELLED' || runtime?.cancelRequested) return;
    if (turn != null && task._turn !== turn) return;
    task.git = {
      isGit: gitState.isGit,
      status: gitState.status,
      changedFiles: gitState.changedFiles,
      ...(gitState.truncated ? { truncated: true } : {}),
      ...(gitState.warning ? { warning: gitState.warning } : {}),
    };
    await this.store.writeArtifact(task.id, 'diff.patch', gitState.diff || '');
    await this.store.writeArtifact(task.id, 'git-status.txt', gitState.status || gitState.warning || '');

    const output = await captureOutputs(task, this.store.taskDir(task.id), run.baseline);
    task.outputFiles = [...(task.outputFiles || []), ...output.files];
    if (output.files.length || output.warnings.length) await this.#event(task, 'OUTPUT_FILES', output.warnings.join('\n'), output);

    if (this.deleted.has(task.id) || task.status === 'CANCELLED' || runtime?.cancelRequested) return;
    // Re-checked after the awaits: a newer turn may have started meanwhile.
    if (turn != null && task._turn !== turn) return;

    // A recipe may name a verification profile; the project owns its commands, so a
    // scheduled run never has to carry a shell line in its prompt (MR-06). The
    // recipe's choice wins over the project's default list.
    const commands = (Array.isArray(task.verificationCommands) && task.verificationCommands.length
      ? task.verificationCommands
      : (this.projects.get(task.projectId)?.verification)) || [];
    // Turn's context is final here, so the limit is applied before the terminal
    // status is published: the next message from the queue must not reach the
    // model with an over-limit context, and the slot is still ours until
    // #releaseSlot runs in the caller.
    await this.#enforceContextLimit(task);
    if (this.deleted.has(task.id) || task.status === 'CANCELLED' || runtime?.cancelRequested) return;
    // The turn's outcome is decided by the MODEL, not by the project's checks.
    // A check that fails after a complete answer used to mark the whole task
    // FAILED and hide the answer; verification now runs detached below and only
    // updates `verification`/`verificationStatus`.
    task.verification = [];
    task.verificationStatus = commands.length ? 'RUNNING' : 'NOT_CONFIGURED';
    this.#terminalPublication.hold(task, this.#publicTask(task));
    task.status = 'SUCCEEDED';
    task.errorCode = null;
    task.error = null;
    task.retryable = null;
    task.retryAfterMs = null;
    task.current = 'Done';
    task.updatedAt = now();
    // Publish the terminal event BEFORE the terminal status becomes readable: a
    // client that polls the status must never receive TASK_SUCCEEDED as a late
    // event (that ordering race flaked tests/server.test.mjs).
    await this.#turnStateEvent(task, 'SETTLED');
    await this.#event(task, 'TASK_SUCCEEDED', task.current);
    await this.store.save(this.#publicTask(task));
    await this.#writeResult(task).catch(() => {});
    if (commands.length) this.#runVerification(task, commands, turn);
  }

  // Лимит контекста сессии (настройка TaskBridge, не Pi). Контекст хода к этому
  // моменту уже собран, и если Pi оценивает его выше лимита, история сжимается
  // здесь — до публикации терминального статуса и до `#releaseSlot`. Сжатие то
  // же самое, что Pi делает при подходе к окну модели (сводка + последние
  // сообщения); лимит лишь задаёт свой порог вместо размера окна.
  //
  // Ждём его намеренно: очередь за это время не стартует, зато следующее
  // сообщение уйдёт в модель с контекстом не больше лимита. Кадры самого сжатия
  // (compaction_start/end) приходят асинхронно и могут лечь уже после
  // TASK_SUCCEEDED — как и у кнопки «Сжать контекст» на завершённой сессии; они
  // не события хода. Один ход — одна попытка; ошибка (провайдер, отмена) на
  // исход хода не влияет и видна отдельным событием.
  async #enforceContextLimit(task) {
    const limit = task.contextLimit;
    if (!Number.isSafeInteger(limit) || limit <= 0) return;
    if (this.closing || this.deleted.has(task.id) || task.status === 'CANCELLED') return;
    if (task._compacting) return;
    const runtime = this.runtimes.get(task.id);
    if (!runtime || runtime.retired || runtime.cancelRequested) return;
    if (runtime.pi.closed || runtime.pi.canSend?.() === false) return;
    const stats = await runtime.pi.getSessionStats().catch(() => null);
    const used = stats?.contextUsage?.tokens;
    if (!Number.isFinite(used) || used <= limit) return;
    await this.#event(task, 'CONTEXT_LIMIT_REACHED',
      `Контекст ${used} токенов выше лимита ${limit} — сжимаю историю.`, { used, limit });
    try {
      await runtime.pi.compact('');
    } catch (error) {
      await this.#event(task, 'CONTEXT_LIMIT_FAILED', `Сжатие по лимиту контекста не удалось: ${error.message}`, { limit }, false).catch(() => {});
    }
  }

  // Project verification is advisory and detached (see #verifyAndFinalize): it
  // must never change the task outcome, hold the slot or delay the next message.
  #runVerification(task, commands, turn) {
    const running = (async () => {
      try {
        const verification = await runVerification(commands, task.workspacePath, (result) => {
          const text = `\n$ ${result.command}\n${result.stdout || ''}\n${result.stderr || ''}\n`;
          this.store.appendRaw(task.id, 'verification.log', text).catch(() => {});
        });
        if (this.deleted.has(task.id)) return;
        // A newer turn ran meanwhile: its own verification is the current one.
        if (turn != null && task._turn !== turn) return;
        const failed = verification.some((x) => !x.ok);
        task.verification = verification;
        task.verificationStatus = failed ? 'FAILED' : 'PASSED';
        task.updatedAt = now();
        await this.store.save(this.#publicTask(task));
        await this.#event(task, 'VERIFICATION', failed ? 'Verification failed' : 'Verification passed', {
          status: task.verificationStatus,
          commands: verification.map((v) => ({ command: v.command, ok: v.ok, exitCode: v.exitCode ?? null }))
        });
        await this.#writeResult(task).catch(() => {});
      } catch (error) {
        if (!this.deleted.has(task.id)) await this.#event(task, 'VERIFICATION_ERROR', error.message).catch(() => {});
      }
    })();
    running.catch(() => {});
    return running;
  }

  // Reads a bounded slice of a tool's local log (§38). `emit` publishes the
  // result as a durable one-off event for the remote UI; the local endpoint
  // calls it without emitting.
  async fetchToolOutput(id, toolCallId, { maxBytes = this.toolOutput.maxFullBytes, emit = false } = {}) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' });
    const name = `tool-${safeFileName(toolCallId)}.log`;
    const file = path.join(this.store.taskDir(id), 'artifacts', name);
    let text = '';
    let bytes = 0;
    try {
      const handle = await fs.open(file, 'r');
      try {
        const stat = await handle.stat();
        bytes = stat.size;
        const limit = Math.min(Math.max(1, Number(maxBytes) || this.toolOutput.maxFullBytes), this.toolOutput.maxFullBytes);
        // The end of the log is the useful part; the beginning is already
        // covered by the streamed window and by the artifacts on disk.
        const start = Math.floor(Math.max(0, stat.size - limit));
        const buffer = Buffer.alloc(stat.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        text = buffer.toString('utf8');
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      text = null;
    }
    // No log, or one saved as "[object Object]" by older builds: the end event
    // in the history still holds the result, so the output is rebuilt from it.
    if (text == null || isBrokenToolLog(text)) {
      const full = await this.#toolResultFromEvents(id, toolCallId);
      if (!full) throw Object.assign(new Error('Для этого вызова нет сохранённого вывода.'), { code: 'NOT_FOUND' });
      const limit = Math.min(Math.max(1, Number(maxBytes) || this.toolOutput.maxFullBytes), this.toolOutput.maxFullBytes);
      bytes = Buffer.byteLength(full, 'utf8');
      text = tailBytes(full, limit);
    }
    const truncated = bytes > Buffer.byteLength(text, 'utf8');
    const payload = { toolCallId, text, bytes, truncated, at: now() };
    if (emit) await this.#event(task, 'TOOL_OUTPUT', `tool output: ${toolCallId}`, payload);
    return payload;
  }

  // The result text of a finished tool call, from its tool_execution_end event.
  async #toolResultFromEvents(id, toolCallId) {
    const events = await this.store.readEvents(id, 0);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const frame = events[i]?.data?.pi;
      if (frame?.type === 'tool_execution_end' && frame.toolCallId === toolCallId) return toolResultText(frame.result);
    }
    return '';
  }

  // ------------------------------------------------------------ approvals ---

  approvalEnabled() {
    return this.approvalsConfig.enabled === true && Boolean(this.approvalBaseUrl);
  }

  checkApprovalToken(taskId, token) {
    const expected = this.approvalTokens.get(taskId);
    if (!expected || typeof token !== 'string') return false;
    const left = Buffer.from(expected);
    const right = Buffer.from(token);
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  }

  // Called by the Pi extension before a tool runs. Returns an immediate verdict
  // when the policy allows the call, otherwise registers a pending approval and
  // returns its id (§53, §54).
  beginApproval(taskId, { toolCallId = null, toolName = null, args = {} } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) throw Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' });
    const verdict = classifyToolCall({
      toolName,
      input: args,
      workspacePath: task.workspacePath,
      config: this.approvalsConfig
    });
    if (!verdict) return { status: 'ALLOW_ONCE', approvalId: null, reason: 'not_required' };

    const { approvalId, promise } = this.approvals.request({ taskId, toolCallId, toolName, args, risk: verdict.risk });
    this.#event(task, 'APPROVAL_REQUIRED', `Требуется подтверждение: ${toolName || 'tool'} (${verdict.risk})`, {
      approvalId, toolCallId, toolName, args, risk: verdict.risk, detail: verdict.detail ?? null
    }).catch(() => {});
    this.#setStatus(task, 'WAITING_USER', `Ожидается подтверждение: ${toolName || 'tool'}`).catch(() => {});

    promise.then(({ decision }) => {
      if (this.deleted.has(taskId)) return;
      this.#event(task, 'APPROVAL_RESOLVED', decision === 'DENY' ? 'Подтверждение отклонено' : 'Подтверждение получено', {
        approvalId, toolCallId, toolName, decision
      }).catch(() => {});
      if (!['CANCELLED', 'FAILED', 'SUCCEEDED'].includes(task.status)) {
        this.#setStatus(task, 'RUNNING', 'Pi is working').catch(() => {});
      }
    }).catch(() => {});

    return { status: 'PENDING', approvalId, risk: verdict.risk };
  }

  approvalStatus(taskId, approvalId) {
    const record = this.approvals.get(approvalId);
    if (!record || record.taskId !== taskId) return null;
    return {
      status: record.status,
      approvalId,
      risk: record.risk,
      toolName: record.toolName,
      decision: record.decision ?? null,
      ...(record.status === 'DENIED' ? { reason: 'Denied by the operator' } : {})
    };
  }

  resolveApproval(taskId, approvalId, decision) {
    const record = this.approvals.get(approvalId);
    if (!record || record.taskId !== taskId) return false;
    return this.approvals.resolve(approvalId, decision);
  }

  listApprovals(taskId) {
    return this.approvals.list().filter(approval => approval.taskId === taskId);
  }

  async #writeResult(task) {
    const result = {
      taskId: task.id,
      status: task.status,
      projectId: task.projectId,
      workspacePath: task.workspacePath,
      changedFiles: task.git?.changedFiles || [],
      verification: task.verification || [],
      compaction: task.compaction,
      lastUsage: task.lastUsage,
      assistantText: task.assistantText,
      thinkingText: task.thinkingText,
      errorCode: task.errorCode,
      error: task.error
    };
    await this.store.writeArtifact(task.id, 'result.json', JSON.stringify(result, null, 2));
    const verificationLines = (task.verification || []).map((v) => `- ${v.ok ? 'PASS' : 'FAIL'}: \`${v.command}\``).join('\n') || '- not configured';
    const md = `# Task ${task.id}\n\nStatus: **${task.status}**\n\n## Pi summary/output\n\n${task.assistantText || '(no assistant text captured)'}\n\n## Changed files\n\n${(task.git?.changedFiles || []).map((f) => `- ${f}`).join('\n') || '- none'}\n\n## Verification\n\n${verificationLines}\n\n## Compaction\n\nCount: ${task.compaction?.count || 0}\n`;
    await this.store.writeArtifact(task.id, 'result.md', md);
  }

  async #finalizeCancelled(task, forTurn = null) {
    const runtime = this.runtimes.get(task.id);
    if (runtime?.cancelFinalizing) return runtime.cancelFinalizing;
    const pending = this.#writeCancelled(task, forTurn ?? task._turn);
    if (runtime) runtime.cancelFinalizing = pending;
    return pending;
  }

  async #writeCancelled(task, forTurn = null) {
    if (this.deleted.has(task.id) || task.status === 'CANCELLED') return;
    // A cancel can overlap a delivery: «Отправить сейчас» stops the run, and the
    // queue pump delivers the message while that stop is still finalizing. The
    // runtime resets cancelRequested when it starts the new turn, so a terminal
    // TASK_CANCELLED written after it would mark a RUNNING answer as stopped
    // (the chat then shows the fresh turn as «прервано»).
    const runtime = this.runtimes.get(task.id);
    if (runtime && (runtime.cancelRequested !== true || (forTurn !== null && task._turn !== forTurn))) return;
    if (runtime && runtime.cancelRequested !== true && task.status === 'RUNNING') return;
    // STOP must not wait on a fresh Git snapshot. A large workspace or a
    // locked disposable index can otherwise keep the session in CANCELLING
    // even after Pi has stopped. The last completed snapshot remains available.
    // The turn ends cancelled: the in-flight marker is spent (see #deliverMessage).
    task.inFlightPrompt = null;
    this.#terminalPublication.hold(task, this.#publicTask(task));
    task.status = 'CANCELLED';
    task.current = 'Cancelled';
    task.updatedAt = now();
    await this.#turnStateEvent(task, 'CANCELLED');
    await this.#event(task, 'TASK_CANCELLED', 'Task cancelled');
    await this.store.save(this.#publicTask(task));
    await this.#writeResult(task);
  }

  async deleteTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Task not found'), { code: 'NOT_FOUND' });
    const runtime = this.runtimes.get(id);
    this.deleted.add(id);
    this.approvals.cancelTask(id);
    this.approvalTokens.delete(id);
    if (runtime) {
      runtime.cancelRequested = true;
      this.#resolveSettle(id);
      await runtime.pi.killTree().catch(() => {});
      await runtime.eventChain.catch(() => {});
      this.runtimes.delete(id);
    }
    this.#releaseSlot(id);
    this.#removeQueued(id);
    this.tasks.delete(id);
    if (task._nativeLease) await task._nativeLease().catch(() => {});
    if (task.worktree && task.workspacePath && task.sourcePath) {
      await removeWorktree(task.workspacePath, task.sourcePath, path.join(this.dataRoot, 'worktrees')).catch(() => {});
    } else if (task.workspacePath) {
      // Attachments were copied into the project workspace; drop this task's copy.
      await this.#removeInside(task.workspacePath, path.join(task.workspacePath, '.taskbridge-input', task.id));
    }
    await this.#removeInside(path.join(this.dataRoot, 'pi-sessions'), path.join(this.dataRoot, 'pi-sessions', task.id));
    await this.#removeInside(path.join(this.dataRoot, 'workspaces'), path.join(this.dataRoot, 'workspaces', task.id));
    // The session is gone: no work item may keep pointing at it.
    this.store.removeSessionLinks(id);
    await this.store.remove(id);
    // The rows are gone, but the file on disk keeps its old size until VACUUM.
    // Truncating the WAL here is cheap; a full rewrite only happens when the
    // server is idle and the file is over the configured threshold.
    await this.store.checkpoint().catch(() => {});
    await this.#maybeVacuum();
    this.#pump();
  }

  // Applies this task's result patch to the source checkout. Refuses when the
  // source is dirty or has moved since the worktree was created, unless forced.
  async applyTask(id, { force = false, commandId, clientId } = {}) {
    const cid = commandId ? String(commandId) : null;
    if (!cid) return this.#applyTask(id, force === true);
    return this.#withCommand(cid, clientId ? String(clientId) : null, () => this.#payloadHash(id, 'apply', force === true), () => this.#applyTask(id, force === true));
  }

  async #applyTask(id, force) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    if (!task.worktree || !task.sourcePath) {
      throw Object.assign(new Error('Применять изменения можно только к задачам в git worktree.'), { code: 'INPUT_INVALID' });
    }
    if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) {
      throw Object.assign(new Error('Дождитесь завершения задачи.'), { code: 'BUSY' });
    }
    const runtime = this.runtimes.get(id);
    if (runtime && !runtime.pi.closed) {
      const state = await runtime.pi.getState().catch(() => null);
      if (state?.isStreaming || state?.isCompacting) throw Object.assign(new Error('Pi ещё работает. Дождитесь завершения.'), { code: 'BUSY' });
    }
    const patch = await fs.readFile(path.join(this.store.taskDir(id), 'artifacts', 'diff.patch'), 'utf8').catch(() => '');
    if (!patch.trim()) throw Object.assign(new Error('Нет изменений для применения.'), { code: 'NOTHING_TO_APPLY' });
    if (!force) {
      const dirty = (await git(['status', '--porcelain'], task.sourcePath)).stdout.trim();
      if (dirty) throw Object.assign(new Error('В исходном проекте есть незакоммиченные изменения.'), { code: 'PROJECT_DIRTY' });
      if (task.baseCommit) {
        const head = (await git(['rev-parse', 'HEAD'], task.sourcePath)).stdout.trim();
        if (head !== task.baseCommit) throw Object.assign(new Error('Ветка исходного проекта изменилась после создания worktree.'), { code: 'SOURCE_MOVED' });
      }
    }
    const result = await applyTaskPatch(task.sourcePath, patch);
    const changed = (await collectGitState(task.sourcePath)).changedFiles;
    task.applied = { at: now(), files: changed, forced: Boolean(force) };
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.store.writeArtifact(id, 'apply.log', `Applied ${result.files.length} file(s) at ${task.applied.at}${force ? ' (forced)' : ''}\n${result.files.join('\n')}\n`);
    await this.#event(task, 'CHANGES_APPLIED', `Изменения применены к ${task.sourcePath}`, { files: changed, forced: Boolean(force) });
    return this.#publicTask(task);
  }

  async cleanupWorktree(id) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    if (!task.worktree) throw Object.assign(new Error('У этой задачи нет worktree.'), { code: 'INPUT_INVALID' });
    if (!task.workspacePath) throw Object.assign(new Error('Worktree уже удалён.'), { code: 'INPUT_INVALID' });
    if (['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING'].includes(task.status)) {
      throw Object.assign(new Error('Дождитесь завершения задачи.'), { code: 'BUSY' });
    }
    const runtime = this.runtimes.get(id);
    if (runtime && !runtime.pi.closed) {
      const state = await runtime.pi.getState().catch(() => null);
      if (state?.isStreaming || state?.isCompacting) throw Object.assign(new Error('Pi ещё работает. Дождитесь завершения.'), { code: 'BUSY' });
      // The worktree is Pi's cwd: close the session before deleting it, or a
      // later follow-up would resume into a missing directory.
      await runtime.pi.killTree().catch(() => {});
      this.runtimes.delete(id);
    }
    await removeWorktree(task.workspacePath, task.sourcePath, path.join(this.dataRoot, 'worktrees'));
    task.worktreeRemovedAt = now();
    task.workspacePath = null;
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#event(task, 'WORKTREE_REMOVED', 'Worktree удалён.');
    return this.#publicTask(task);
  }

  async cancel(id, opts = {}) {
    const commandId = opts && opts.commandId ? String(opts.commandId) : null;
    const hard = opts?.hard === true;
    if (!commandId) return this.#cancel(id, { hard });
    return this.#withCommand(commandId, opts && opts.clientId ? String(opts.clientId) : null, () => this.#payloadHash(id, 'cancel'), () => this.#cancel(id, { hard }));
  }

  // "Repeat message": permanently removes the last failed exchange (the
  // user's message + the model's error/abort) from the history so the same
  // text can be sent again without a duplicate. Allowed only for the very
  // last turn, only in a FAILED/CANCELLED session, and only when the model
  // produced nothing (no text, no tools): otherwise its output would be lost
  // forever and the UI only offers copying the text instead.
  async undoLastTurn(id) {
    return this.#admit(() => this.#undoLastTurn(id), id);
  }

  async #undoLastTurn(id) {
    const task = this.tasks.get(id);
    if (!task || this.deleted.has(id)) throw Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' });
    if (!['FAILED', 'CANCELLED'].includes(task.status)) {
      throw Object.assign(new Error('Отозвать можно только последний ход с ошибкой или отменённый.'), { code: 'NOT_ALLOWED' });
    }
    const events = await this.store.readEvents(id, 0);
    let lastUser = null;
    for (const event of events) if (event.type === 'USER_MESSAGE') lastUser = event;
    // The session's very first prompt has no USER_MESSAGE of its own (it lives
    // in task.prompt), so retracting it drops the whole log and asks the client
    // to forget the turn it synthesized from the task record.
    const fromSeq = lastUser ? lastUser.seq : 1;
    // "The model produced nothing" means no visible answer (text) and no tools.
    // Reasoning alone and a message_start without a body do not block a retry:
    // a cancel right after the first frame is exactly the case the operator
    // wants to send again.
    const producedText = (frame) => {
      if (frame?.type === 'message_update') return frame.assistantMessageEvent?.type === 'text_delta' && Boolean(frame.assistantMessageEvent.delta);
      // Pi records the operator's own message as a message_end frame too
      // (role=user), so the role must be checked — otherwise the prompt counts
      // as the model's answer and a retry is refused for an empty reply.
      if (frame?.type === 'message_end') return frame.message?.role === 'assistant'
        && (frame.message?.content || []).some(part => part?.type === 'text' && String(part.text || '').trim());
      return false;
    };
    const usedTools = (frame) => ['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(frame?.type);
    let terminal = null;
    let hasContent = false;
    for (const event of events) {
      if (lastUser && event.seq <= lastUser.seq) continue;
      const frame = event.data?.pi;
      if (event.type === 'PI_EVENT' && (producedText(frame) || usedTools(frame))) hasContent = true;
      if (event.type === 'TASK_SUCCEEDED' || (event.type === 'STATUS' && event.data?.status === 'SUCCEEDED')) terminal = 'ok';
      else if (event.type === 'TASK_FAILED' || event.type === 'TASK_CANCELLED'
        || (event.type === 'STATUS' && ['FAILED', 'CANCELLED'].includes(event.data?.status))) terminal = 'fail';
    }
    if (terminal !== 'fail') {
      throw Object.assign(new Error('Последний ход завершился успешно — отозвать нельзя.'), { code: 'NOT_ALLOWED' });
    }
    if (hasContent) {
      throw Object.assign(new Error('Модель успела дать ответ — отозвать нельзя, скопируйте сообщение.'), { code: 'NOT_ALLOWED' });
    }
    // The truncation must not race with a concurrent event write for this task,
    // and the TURN_TRUNCATED marker must land after it in the same chain.
    await this.#truncateFrom(task, fromSeq, { dropInitial: !lastUser, text: lastUser ? (lastUser.data?.text ?? lastUser.message ?? '') : (task.prompt || '') });
    const text = lastUser ? (lastUser.data?.text ?? lastUser.message ?? '') : (task.prompt || '');
    return { ok: true, text, fromSeq, dropInitial: !lastUser };
  }

  // One primitive behind delete and resend: every event from the start of the
  // chosen exchange on is dropped for good, and a marker tells live clients to
  // drop the matching turns too. The seq is reused by that marker first, so a
  // streaming client's cursor never skips past a later event.
  async #truncateFrom(task, fromSeq, { dropInitial = false, keepUser = false, reason = 'retry', text = null } = {}) {
    const id = task.id;
    const prior = this.eventWrites.get(id) || Promise.resolve();
    // The marker is written at the PRE-truncation high-water mark + 1, not at
    // `fromSeq`. Clients drop events they have already seen (`seq <= cursor`),
    // and a live client's cursor sits exactly at that high-water mark — a
    // marker that reused `fromSeq` was therefore dropped as "already known" and
    // the rewrite (regenerate / delete / repeat) never reached the screen.
    // Keeping the seq monotonic is what makes the cursor update carry.
    const chain = prior.then(async () => {
      const markerSeq = (await this.store.maxSeq(id)) + 1;
      await this.store.truncateEvents(id, fromSeq);
      const message = reason === 'clear' ? 'Чат очищен.'
        : reason === 'delete' ? 'Сообщение удалено из истории.'
        : reason === 'regenerate' ? 'Ответ удалён: запрос отправлен заново.'
        : reason === 'edit' ? 'Сообщение изменено: отправлено заново.'
        : 'Неудачный ход удалён: сообщение возвращено в поле ввода.';
      await this.#recordEvent(task, 'TURN_TRUNCATED', message, { fromSeq, dropInitial, keepUser, reason, text }, true, markerSeq);
    }, id);
    this.eventWrites.set(id, chain.then(() => {}, () => {}));
    await chain;
  }

  // A turn id as the client knows it: `user-12` (the seq of its USER_MESSAGE)
  // or `user-initial` for the session's first prompt, which has no event of
  // its own.
  #turnSequences(turnId) {
    const value = String(turnId || '');
    if (value === 'user-initial') return { fromSeq: 1, dropInitial: true, mode: 'initial' };
    const match = /^user-(\d+)$/.exec(value);
    if (!match) throw Object.assign(new Error('Неизвестное сообщение.'), { code: 'INPUT_INVALID' });
    return { fromSeq: Number(match[1]), dropInitial: false, mode: 'seq' };
  }

  // Deletes a message and everything that came after it. The log is linear, so
  // a later branch cannot survive its parent — the client warns with the
  // affected count before calling this.
  async deleteTurns(id, turnId) {
    return this.#admit(async () => {
      const task = this.#mutableTask(id);
      const answer = /^assistant-(initial|\d+)$/.exec(String(turnId));
      const { fromSeq, dropInitial, mode } = this.#turnSequences(answer ? `user-${answer[1]}` : turnId);
      const events = await this.store.readEvents(id, 0);
      if (mode === 'seq' && !events.some(event => event.type === 'USER_MESSAGE' && event.seq === fromSeq)) {
        throw Object.assign(new Error('Сообщение не найдено в истории.'), { code: 'NOT_FOUND' });
      }
      if (answer) {
        const answerSeq = mode === 'initial' ? 1 : fromSeq + 1;
        await this.#truncateFrom(task, answerSeq, { keepUser: true, reason: 'delete' });
        return { ok: true, fromSeq: answerSeq, dropInitial: false, keepUser: true };
      }
      await this.#truncateFrom(task, fromSeq, { dropInitial, reason: 'delete' });
      return { ok: true, fromSeq, dropInitial };
    }, id);
  }

  // "Очистить чат": drop every message but keep the session itself (name, project,
  // model). It reuses the truncation machinery — a marker at the pre-clear
  // high-water mark — so a live client retracts the whole log rather than
  // keeping a stale view.
  async clearConversation(id) {
    return this.#admit(async () => {
      const task = this.#mutableTask(id);
      task.prompt = '';
      task.assistantText = '';
      task.thinkingText = '';
      task.error = null;
      task.errorCode = null;
      task.current = 'Чат очищен';
      task.status = 'SUCCEEDED';
      task.queueReason = null;
      task.lastUsage = null;
      task.pendingPrompts = [];
      await this.#truncateFrom(task, 1, { dropInitial: true, reason: 'clear' });
      return { ok: true };
    }, id);
  }

  // Editing the operator's own message is "fix it and run again": the message
  // keeps its own place in the log (same event, same seq, corrected text), while
  // everything BELOW it — the answers, their tools, notes — is wiped, and the
  // edited text is put to the model as a fresh prompt. It is not an in-place
  // cosmetic correction: the old answer was produced for the old text.
  async editTurn(id, { turnId, text, branch = false }) {
    return this.#admit(() => this.#editTurn(id, turnId, text, branch), id);
  }

  async #editTurn(id, turnId, text, branch = false) {
    const task = this.#mutableTask(id);
    const value = String(turnId || '');
    if (typeof text !== 'string') throw Object.assign(new Error('Не передан текст сообщения.'), { code: 'INPUT_INVALID' });
    const edited = text.trim();
    if (!edited) throw Object.assign(new Error('Пустое сообщение отправлять нечего.'), { code: 'INPUT_INVALID' });
    if (value.startsWith('assistant-')) {
      // Editing an ANSWER: no model is asked. In place the text is corrected; as
      // a branch the edited text becomes another variant of the same exchange
      // (the previous answer is kept and stays switchable). Only answers of the
      // newest exchange may branch — for older ones the fork is the way.
      const events = await this.store.readEvents(id, 0);
      const { turnSeq } = this.#newestExchange(events);
      const { variants } = this.#variantsOf(events, turnSeq);
      if (!variants.some(variant => variant.id === value)) {
        throw Object.assign(new Error('Править можно только самый новый ответ.'), { code: 'NOT_ALLOWED' });
      }
      if (branch) {
        const variantId = shortId();
        await this.#event(task, 'TURN_VARIANT_START', 'Ответ отредактирован: создан новый вариант.',
          { turnSeq, variantId, editedText: edited });
        return { ok: true, turnId: `assistant-${variantId}`, role: 'assistant', branch: true, variantId };
      }
      await this.#event(task, 'TURN_EDITED', 'Ответ отредактирован вручную.', { id: value, text: edited, role: 'assistant' });
      return { ok: true, turnId: value, role: 'assistant', branch: false };
    }
    if (!value.startsWith('user-')) {
      throw Object.assign(new Error('Переотправить можно только сообщение оператора.'), { code: 'INPUT_INVALID' });
    }
    const { fromSeq, dropInitial } = this.#turnSequences(value);
    if (dropInitial) {
      // The session's first prompt has no event of its own: it lives in
      // task.prompt, so that is what gets corrected — and the whole log is cut.
      await this.#truncateFrom(task, 1, { dropInitial: true, keepUser: true, reason: 'edit', text: edited });
      task.prompt = edited;
      await this.store.save(this.#publicTask(task));
    } else {
      const own = (await this.store.readEvents(id, 0)).find(event => event.seq === fromSeq);
      await this.#truncateFrom(task, fromSeq + 1, { keepUser: true, reason: 'edit', text: edited });
      if (own) await this.store.updateEventData(id, fromSeq, { message: edited, data: { ...(own.data || {}), text: edited } });
    }
    // Live clients are told about the corrected text (the row above keeps its
    // cursor, so their stream would otherwise never notice the change).
    await this.#event(task, 'TURN_EDITED', 'Сообщение отредактировано и отправлено заново.', { id: value, text: edited, role: 'user' });
    return this.#message(id, edited, 'auto', [], null, { immediate: true, announce: false });
  }

  // "Regenerate as a variant": the same question is put to the model again, but
  // the previous answer is KEPT — it becomes a hidden sibling of the same
  // exchange and the client switches between them (‹ n/m ›). Nothing is deleted
  // here: a bad regeneration must not cost the answer that already existed.
  async regenerateLastTurn(id, turnId) {
    return this.#admit(() => this.#regenerateLastTurn(id, turnId), id);
  }

  async #regenerateLastTurn(id, turnId) {
    const task = this.#mutableTask(id);
    const events = await this.store.readEvents(id, 0);
    const { turnSeq, lastUser } = this.#newestExchange(events);
    const { variants } = this.#variantsOf(events, turnSeq);
    // Only the newest exchange may be regenerated, and the caller must name one
    // of its answers: "nothing was sent" must never silently re-run a session
    // somebody else is looking at.
    if (!variants.some(variant => variant.id === String(turnId || ''))) {
      throw Object.assign(new Error('Повторить можно только самый новый ответ.'), { code: 'NOT_ALLOWED' });
    }
    const text = lastUser ? (lastUser.data?.text ?? lastUser.message ?? '') : (task.prompt || '');
    if (!String(text).trim()) throw Object.assign(new Error('Пустой запрос — повторять нечего.'), { code: 'INPUT_INVALID' });
    const variantId = shortId();
    // The marker is what tells every client — and the next replay — that the
    // frames arriving now belong to a NEW answer of the same exchange, not to
    // the one that just went out of view.
    await this.#event(task, 'TURN_VARIANT_START', 'Новый вариант ответа.', { turnSeq, variantId, text });
    // #message directly: the public wrapper would re-enter #admit, which is
    // single-shot by design. announce:false keeps the operator's question single.
    return this.#message(id, text, 'auto', [], null, { immediate: true, announce: false });
  }

  /**
   * MR-07: «повторить с параметрами» — тот же вопрос задаётся заново, но с другой
   * моделью и/или уровнем мышления.
   *
   * Параметры применяются к СЕССИИ (теми же методами, что строки модели и уровня в
   * панели), а не только к этому запросу: у Pi нет переопределения на один запрос —
   * есть `prompt(message)` и отдельные `set_model`/`set_thinking_level` (проверено по
   * src/pi-rpc.mjs). Обещать «только для повтора» было бы неправдой, поэтому
   * применённое видно в самой сессии, а событие смены модели/уровня остаётся в логе.
   *
   * Ничего не отправляется «наугад»: и смена модели (BUSY во время ответа), и сам
   * повтор (NOT_ALLOWED для не-последнего хода) отвечают теми же ошибками, что и без
   * параметров.
   */
  async rerunLastTurn(id, { turnId, model = null, thinkingLevel = null } = {}) {
    return this.#admit(async () => {
      if (model && (model.id || model.modelId)) await this.setModel(id, model.provider, model.id || model.modelId);
      if (thinkingLevel) await this.setThinkingLevel(id, thinkingLevel);
      // Приватный метод: публичный #regenerateLastTurn снова вошёл бы в #admit,
      // который одноразовый по замыслу.
      return this.#regenerateLastTurn(id, turnId);
    }, id);
  }

  // The exchange regenerate/select may touch: the one behind the last
  // USER_MESSAGE, or the session's own first prompt when there is none.
  #newestExchange(events) {
    let lastUser = null;
    for (const event of events) if (event.type === 'USER_MESSAGE') lastUser = event;
    return { turnSeq: lastUser ? lastUser.seq : 0, lastUser };
  }

  // Every answer of one exchange, oldest first. The first answer has no marker of
  // its own — its id is derived from the exchange, exactly like the client does.
  #variantsOf(events, turnSeq) {
    const seq = Number(turnSeq) || 0;
    const variants = [{ id: seq ? `assistant-${seq}` : 'assistant-initial', variantId: seq ? String(seq) : 'initial', at: seq }];
    for (const event of events) {
      if (event.type !== 'TURN_VARIANT_START' || Number(event.data?.turnSeq || 0) !== seq) continue;
      variants.push({ id: `assistant-${event.data.variantId}`, variantId: String(event.data.variantId), at: event.seq });
    }
    return { turnSeq: seq, variants };
  }

  // Which answer of which exchange the client wants to see. Nothing is rewritten
  // and no model is asked: a reading preference, persisted so a reload lands on
  // the same variant.
  async selectVariant(id, { turnSeq, variantId }) {
    return this.#admit(async () => {
      const task = this.#mutableTask(id);
      const events = await this.store.readEvents(id, 0);
      const { variants } = this.#variantsOf(events, Number(turnSeq));
      if (!variants.some(variant => variant.variantId === String(variantId))) {
        throw Object.assign(new Error('Такого варианта ответа нет.'), { code: 'NOT_FOUND' });
      }
      const seq = Number(turnSeq) || 0;
      await this.#event(task, 'TURN_VARIANT_SELECTED', 'Показан другой вариант ответа.', { turnSeq: seq, variantId: String(variantId) });
      return { ok: true, turnSeq: seq, variantId: String(variantId), total: variants.length };
    }, id);
  }

  // "Continue": the existing answer is asked to go on. No new exchange and no
  // new variant is created — what the model writes next is appended to the same
  // answer (the client already renders a mid-answer continuation into the turn
  // it belongs to). Pi has no "continue" RPC, so the request is an explicit
  // instruction; unlike regenerate, nothing is dropped and no variant is made.
  async continueTurn(id, turnId) {
    return this.#admit(() => this.#continueTurn(id, turnId), id);
  }

  // «Перезапустить сессию»: retire the session's Pi process and let the next
  // message restart it from the saved session file. For a hung Pi (alive, not
  // responding) this is the routine exit — the message probe answers "hung Pi"
  // and fails, so a hung session is otherwise at the mercy of a server restart,
  // which is the emergency exit that hits every session.
  async restartSession(id) {
    return this.#admit(() => this.#restartSession(id), id);
  }

  // Persist Pi's exact-folder trust decision, then retire this Pi so the next
  // message reloads project-local instructions/extensions under that decision.
  async trustWorkspace(id) {
    return this.#admit(async () => {
      const task = this.tasks.get(id);
      if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      if (!task.workspacePath) throw Object.assign(new Error('Папка сессии ещё не подготовлена.'), { code: 'NOT_ALLOWED' });
      const env = { ...process.env, ...(this.config.pi?.env || {}) };
      const trusted = await trustProjectDirectory(task.workspacePath, piAgentDir(env));
      task.workspaceTrusted = true;
      task.updatedAt = now();
      await this.store.save(this.#publicTask(task));
      await this.#event(task, 'PROJECT_TRUSTED', `Папка добавлена в доверенные: ${trusted.path}`, trusted);
      return this.#restartSession(id);
    }, id);
  }

  async #restartSession(id) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    const current = this.runtimes.get(id);
    if (current) {
      // The same retire #ensureSession does: a hung Pi that still accepts
      // writes must not be reused as if it were alive. The flags go up before
      // the kill: the close event is then ignored (retired), and a pending turn
      // settles without racing into verifyAndFinalize.
      current.retired = true;
      current.cancelRequested = true;
      task._turn = (task._turn || 0) + 1;
      await current.pi.killTree().catch(() => {});
      this.#resolveSettle(task.id);
      if (this.runtimes.get(task.id) === current) this.runtimes.delete(task.id);
    }
    // A queued session has nothing hung: its prompts keep waiting, and the
    // restart must not turn waiting into a failure. A finished session has
    // nothing to recover either: the next message just works.
    const terminal = ['SUCCEEDED', 'CANCELLED', 'FAILED'].includes(task.status);
    if (task.status === 'QUEUED' || (terminal && !task.inFlightPrompt)) {
      task.updatedAt = now();
      await this.store.save(this.#publicTask(task));
      return this.#publicTask(task);
    }
    // The session was mid-run (or its Pi hung): mark it restorable the way the
    // daemon restart does (R3.6) — the next message resumes it, and the chat
    // says «Прервана — можно продолжить». A message Pi accepted but the kill
    // consumed nothing of is re-queued, so the restart does not lose the
    // operator's text. History is intact: the restart is not destructive.
    await this.#requeueUnconsumedPrompt(task);
    if (task.inFlightPrompt) task.inFlightPrompt = null;
    this.#terminalPublication.hold(task, this.#publicTask(task));
    task.status = 'FAILED';
    task.errorCode = 'FAILED_RECOVERY';
    task.error = 'Сессия перезапущена по запросу. Следующее сообщение продолжит сессию.';
    task.current = 'Failed';
    task.updatedAt = now();
    await this.#event(task, 'TASK_FAILED', task.error, { errorCode: task.errorCode });
    await this.store.save(this.#publicTask(task));
    return this.#publicTask(task);
  }

  async #continueTurn(id, turnId) {
    const task = this.#mutableTask(id);
    const events = await this.store.readEvents(id, 0);
    const { turnSeq } = this.#newestExchange(events);
    const { variants } = this.#variantsOf(events, turnSeq);
    // Continue only ever touches the newest answer, and the caller must name it:
    // "nothing was sent" must never silently re-run a session somebody else is
    // looking at.
    if (!variants.some(variant => variant.id === String(turnId || ''))) {
      throw Object.assign(new Error('Продолжить можно только самый новый ответ.'), { code: 'NOT_ALLOWED' });
    }
    if (!this.#answerHasOutput(events, turnSeq)) throw Object.assign(new Error('Продолжать нечего — ответ пуст.'), { code: 'INPUT_INVALID' });
    return this.#message(id, CONTINUE_PROMPT, 'auto', [], null, { immediate: true, announce: false });
  }

  // Whether the newest answer of an exchange produced anything. An agent answer
  // is several assistant messages (text → tools → text), and an interrupted one
  // ends with an empty aborted message — exactly the answer "continue" is for.
  // So every message of the current variant counts, text or tool call; only the
  // last one used to count, and a stopped answer was reported as empty.
  #answerHasOutput(events, turnSeq) {
    const seq = Number(turnSeq) || 0;
    let output = false;
    for (const event of events) {
      if (event.seq <= seq) continue;
      // A regenerated variant starts over: the previous answer is not this one.
      if (event.type === 'TURN_VARIANT_START' && Number(event.data?.turnSeq || 0) === seq) { output = false; continue; }
      const frame = event.data?.pi;
      if (event.type === 'PI_EVENT' && frame?.type === 'message_end' && frame.message?.role === 'assistant') {
        output ||= (frame.message.content || []).some(part => (part?.type === 'text' && String(part.text || '').trim()) || part?.type === 'toolCall');
      }
    }
    return output;
  }

  // "Fork": a new session in the same project whose conversation is copied out
  // of this one. `through` (the default) copies the history from the beginning
  // through the chosen message; `from` copies the chosen message and everything
  // after it, so the fork continues the conversation from that point instead of
  // from the session start. Nothing runs and no model is asked — the copied
  // events are replayed by the client at once, and the fork's first message
  // rebuilds Pi's session file from them (session-history.mjs). The source is
  // left untouched.
  async forkTask(id, turnId, direction = 'through') {
    // A client that serialises an unset field as null names the default.
    return this.#admit(() => this.#forkTask(id, turnId, direction ?? 'through'), id);
  }

  async #forkTask(id, turnId, direction) {
    if (direction !== 'through' && direction !== 'from') {
      throw Object.assign(new Error('Ветка бывает «до» или «от» сообщения.'), { code: 'INPUT_INVALID' });
    }
    const source = this.#mutableTask(id);
    const events = await this.store.readEvents(id, 0);
    const fork = this.#forkRange(events, turnId, direction);
    const kept = events.filter(event => event.seq >= fork.from && event.seq <= fork.through);
    // A copy that opens mid-conversation owns its first prompt: the clicked
    // message becomes the new session's own prompt — the client synthesizes
    // that first turn from the task record, exactly like a session created with
    // it — and its USER_MESSAGE event stays out of the copy. Keeping both would
    // show the operator's line twice.
    const opening = fork.fold
      ? kept.find(event => event.type === 'USER_MESSAGE' && event.seq === fork.from)
      : null;
    const copied = opening ? kept.filter(event => event !== opening) : kept;
    // The dropped line is the copy's own first prompt: the clients know it as
    // `user-initial` / `assistant-initial`, and the exchange it opens has the
    // key 0 (`#variantsOf`). Events naming it by its old seq must follow, or a
    // variant marker would plant a second, empty answer at the end and an
    // in-place edit would miss the turn it belongs to.
    const rewired = (data) => {
      if (!opening || !data || typeof data !== 'object') return data;
      const patched = { ...data };
      const seq = String(opening.seq);
      if (patched.turnSeq === opening.seq) {
        patched.turnSeq = 0;
        if (patched.variantId === seq) patched.variantId = 'initial';
      }
      if (patched.id === `assistant-${seq}`) patched.id = 'assistant-initial';
      if (patched.id === `user-${seq}`) patched.id = 'user-initial';
      return patched;
    };
    const task = {
      id: shortId(),
      createdAt: now(),
      updatedAt: now(),
      status: 'SUCCEEDED',
      queueReason: null,
      projectId: source.projectId,
      prompt: opening ? (opening.data?.text ?? opening.message ?? '') : source.prompt,
      title: source.title ? `${source.title} (ветка)` : null,
      // The workspace is prepared when the first message of the fork runs, so a
      // worktree project gets its own checkout instead of sharing one.
      workspacePath: null,
      sourcePath: null,
      worktree: false,
      current: 'Ветка',
      assistantText: '',
      thinkingText: '',
      error: null,
      errorCode: null,
      engine: source.engine,
      requestedModel: source.requestedModel,
      thinkingLevel: source.thinkingLevel,
      mcp: source.mcp,
      verification: null,
      git: null,
      compaction: { count: 0, last: null },
      lastUsage: null,
      metrics: null,
      speeds: null,
      model: source.model,
      autoCompactionEnabled: null,
      // The copy's first turn is the clicked message, so its own attachments
      // belong to it — the source's whole list would carry files of other turns.
      files: opening
        ? (Array.isArray(opening.data?.files) ? opening.data.files : [])
        : (Array.isArray(source.files) ? source.files : []),
      attachments: [],
      outputFiles: [],
      forkedFrom: id
    };
    await this.store.create(task);
    this.tasks.set(task.id, task);
    for (const event of copied) {
      const copy = { ...event, taskId: task.id };
      if (opening && event.data) copy.data = rewired(event.data);
      // A copy that opens mid-conversation keeps the source cursors: the events
      // refer to each other by seq (a variant names the exchange it belongs to,
      // TURN_TRUNCATED names the cut), so renumbering the copy from 1 would
      // leave those references pointing at whatever lands under the old number.
      // A copy of the prefix is numbered from the session start anyway, so it
      // is appended as usual.
      if (opening) await this.store.appendEventAt(task.id, event.seq, copy);
      else await this.store.appendEvent(task.id, copy);
    }
    await this.#event(task, 'TASK_FORKED', `Ветка сессии ${id}: перенесено событий — ${copied.length}.`, {
      from: id,
      fromSeq: fork.at,
      // null = the copy runs to the end of the source log.
      throughSeq: fork.through === Number.MAX_SAFE_INTEGER ? null : fork.through
    });
    return this.#publicTask(task);
  }

  // Which slice of the log a fork copies, and where the slice is cut. `through`
  // (the default) keeps history from the session start through the chosen
  // message: a click on an operator message keeps history through that message,
  // a click on an answer keeps through that answer, which ends just before the
  // next operator message. `from` keeps the chosen message and everything after
  // it. Both directions name an exchange the same way — the client's
  // `assistant-N` is the answer to `user-N` — so a click on either end of an
  // exchange starts or ends the copy at the same place. The session's own first
  // prompt has no event of its own, so `user-initial`/`assistant-initial` are
  // read from the record instead: "through" the first answer is the first
  // exchange, "from" the first prompt is the whole log. `fold` marks a `from`
  // copy that opens on someone else's message, which becomes its own prompt.
  #forkRange(events, turnId, direction = 'through') {
    const value = String(turnId || '');
    const forward = direction === 'from';
    const all = Number.MAX_SAFE_INTEGER;
    // `through` the own first prompt copies nothing of it — the prompt travels
    // with the task record; `from` it copies the whole log.
    if (value === 'user-initial') return { from: 1, through: forward ? all : 0, at: 0, fold: false };
    if (value === 'assistant-initial') {
      // "Up to the first answer" ends just before the next operator message; a
      // session without follow-ups has none, so it is copied whole.
      const next = events.find(event => event.type === 'USER_MESSAGE');
      return { from: 1, through: forward ? all : (next ? next.seq - 1 : all), at: 0, fold: false };
    }
    const match = /^(user|assistant)-(\d+)$/.exec(value);
    if (!match) throw Object.assign(new Error('Ответвить можно только от сообщения или ответа.'), { code: 'INPUT_INVALID' });
    const role = match[1];
    const fromSeq = Number(match[2]);
    if (!events.some(event => event.type === 'USER_MESSAGE' && event.seq === fromSeq)) {
      throw Object.assign(new Error('Ход не найден в истории.'), { code: 'NOT_FOUND' });
    }
    if (forward) return { from: fromSeq, through: all, at: fromSeq, fold: true };
    if (role === 'user') return { from: 1, through: fromSeq, at: fromSeq };
    const next = events.find(event => event.type === 'USER_MESSAGE' && event.seq > fromSeq);
    return { from: 1, through: next ? next.seq - 1 : all, at: fromSeq };
  }

  // Shared guard for history mutations: the session must exist and must not be
  // working right now (editing the answer that is streaming would fight the
  // live frames for the same turn). The status is what says so — every working
  // phase (QUEUED…CANCELLING, VERIFYING) is non-terminal. `activeTaskId` is NOT
  // used as an extra guard: it stays set through the async finalizer, so right
  // after an answer lands it refused edits for a moment even though nothing was
  // writing history any more.
  #mutableTask(id) {
    const task = this.tasks.get(id);
    if (!task || this.deleted.has(id)) throw Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' });
    if (!RUN_TERMINAL.has(task.status)) {
      throw Object.assign(new Error('Сессия сейчас работает — дождитесь завершения.'), { code: 'NOT_ALLOWED' });
    }
    return task;
  }

  async #cancel(id, { keepPending = false, hard = false } = {}) {
    const task = this.tasks.get(id);
    const runtime = this.runtimes.get(id);
    if (!task) throw Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' });
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return this.#publicTask(task);
    // Retire the runtime before touching Pi.  The abort response is not an
    // ownership boundary: Pi may acknowledge it while already queued frames
    // are still in flight.  Retiring here makes both the event handler and
    // #ensureSession reject that old runtime immediately.
    if (runtime) {
      runtime.cancelRequested = true;
      runtime.retired = true;
    }
    this.approvals.cancelTask(id);
    // STOP — это «останови всё сразу». Процессы сессии умирают ПЕРВЫМИ, до
    // любой записи в store: под нагрузкой (поток кадров инструмента, занятая
    // БД) статус и разбор очереди отодвигали убийство на секунды, и STOP
    // выглядел как зависание (2026-10-14, blender-команда, телефон и десктоп).
    if (runtime && hard) {
      try {
        await runtime.pi.killTree();
      } catch {
        // The process may already be gone. Ownership still has to be released.
      }
      await this.#setStatus(task, 'CANCELLING', 'Stopping Pi');
      await this.#event(task, 'HARD_STOP', 'Жёсткий стоп: процессы сессии убиты.');
    } else if (runtime) {
      await this.#setStatus(task, 'CANCELLING', 'Stopping Pi');
      try {
        await runtime.pi.abort(this.config.pi?.abortTimeoutMs || 10000);
      } catch (error) {
        await this.#event(task, 'ABORT_TIMEOUT', `RPC abort failed: ${error.message}. Killing process tree.`);
        try {
          await runtime.pi.killTree();
        } catch {
          // The process may already be gone. Ownership still has to be released.
        }
      }
    }
    // Открытый диалог расширения закрывается сам: Pi уже убит, но состояние
    // задачи обязано быть очищено (иначе кнопки подтверждения останутся на экране).
    if (runtime && task.pendingUiRequest) {
      try { runtime.pi.send({ type: 'extension_ui_response', id: task.pendingUiRequest.id, cancelled: true }); } catch {}
      await this.#closeUiRequest(task, task.pendingUiRequest.id, { cancelled: true, reason: 'stopped' });
    }
    // A queued prompt is dropped with the task, on either cancel path — unless
    // the cancel is only interrupting a generation (Ctrl+Enter / «Отправить
    // сейчас»), where the operator's queue must survive. Делается после остановки:
    // освобождение файлов — это I/O и ждать его на пути убийства нельзя.
    if (keepPending) {
      if ((task.pendingPrompts || []).length) this.#enqueue(id);
    } else {
      await this.#releasePendingFiles(id, task.pendingPrompts);
      task.pendingPrompts = null;
      task.queueReason = null;
      this.#removeQueued(id);
    }
    if (!runtime) {
      this.#terminalPublication.hold(task, this.#publicTask(task));
      task.status = 'CANCELLED';
      task.current = 'Cancelled';
      await this.store.save(this.#publicTask(task));
      await this.#event(task, 'TASK_CANCELLED', 'Task cancelled');
      return this.#publicTask(task);
    }
    await runtime.eventChain.catch(() => {});
    this.#resolveSettle(id);
    await this.#finalizeCancelled(task);
    this.#releaseSlot(id);
    this.#pump();
    return this.#publicTask(task);
  }

  // Operator intents, named after the wire options and renamed locally so they
  // do not shadow the now() helper:
  //   now: true   — send immediately, do not wait for the local model (Ctrl+Enter)
  //   queue: true — take a place in the queue even when the model is free (Enter)
  // With neither flag (cloud/LAN callers) the previous behaviour applies: steer
  // while the session streams, queue while the model is busy with something else.
  //
  // `commandId` (when provided by a client) makes the command idempotent: the
  // same commandId+payload is replayed from the ledger instead of executed a
  // second time; the same id with different content is a CONFLICT.
  async message(id, text, mode = 'auto', files = [], uploadToken = null, opts = {}) {
    const commandId = opts && opts.commandId ? String(opts.commandId) : null;
    // Who sent it: carried into the queue entry and the USER_MESSAGE event, so a
    // client can match its own command in the history (e.g. after
    // UNKNOWN_AFTER_CRASH) without comparing texts.
    const origin = originOf(commandId, opts && opts.clientId, opts && opts.deviceId);
    // Ctrl+Enter («вклиниться сразу»): the text skips the local queue and, while
    // the turn streams, goes in as steering — the command in flight keeps
    // running and the model answers the new text next. Only the model itself or
    // STOP ends a command.
    const send = async () => this.#message(id, text, mode, files, uploadToken, { immediate: opts.now === true, queue: opts.queue === true, origin });
    if (!commandId) return this.#admit(send, id);
    return this.#withCommand(
      commandId,
      opts && opts.clientId ? String(opts.clientId) : null,
      () => this.#payloadHash(id, text, mode, files, uploadToken, opts.now === true, opts.queue === true),
      () => this.#admit(send, id),
    );
  }

  // Returns an idempotency guard around `fn`. If `commandId` is new it records
  // ACCEPTED in SQLite *before* running (so a crash mid-run is durable), runs
  // `fn`, and stores the outcome. A repeat of a finished command replays the
  // saved result; a repeat of one still in flight is refused as ACCEPTED; the
  // same id with different content is a CONFLICT; an id recorded ACCEPTED but
  // never finished (a prior process crashed) is UNKNOWN_AFTER_CRASH — never
  // re-run silently. The in-memory map is only a cache + in-flight tracker;
  // SQLite is the source of truth across restarts.
  async #withCommand(commandId, clientId, hashOf, fn) { return this.commandCoordinator.run(commandId, clientId, hashOf, fn); }

  // Command-status contract (TZ stage 3): ACCEPTED / DISPATCHING / COMPLETED /
  // REJECTED / UNKNOWN_AFTER_CRASH, plus the client that issued it. Read-only;
  // does not change the live command response shape.
  commandStatus(commandId) { return this.commandCoordinator.status(commandId); }


  #payloadHash(...args) {
    return crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
  }

  // A prompt the operator decided not to wait for: it is handed to Pi right
  // away (Pi/llama.cpp decide how to fit it into the running turn), bypassing
  // the local queue.
  async sendPendingNow(id, pendingId = null) {
    return this.#admit(async () => {
      const task = this.tasks.get(id);
      if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      // Retrying a stale button must not deliver the NEXT queued message.
      if (pendingId && !(task.pendingPrompts || []).some(p => p.id === pendingId)) return this.#publicTask(task);
      if (!task.workspacePath) throw Object.assign(new Error('Сначала дождитесь запуска исходной задачи.'), { code: 'BUSY' });
      // The pump may have already taken the last message but still own dispatch.
      // With nothing left to send this request is a read of the current result,
      // so it must not fail a capacity/dispatch check or deliver another prompt.
      if (!(task.pendingPrompts || []).length) {
        this.#removeQueued(id);
        return this.#publicTask(task);
      }
      // Check first: "сейчас" cannot mean a second generation in parallel, and a
      // refusal must leave the prompt where it was. The pump may be delivering
      // another session's queued prompt right now (a delegating delivery claims
      // its slot only inside #message, so activeTaskId alone cannot see it) —
      // "сейчас" must not cut into a delivery in flight either.
      if (!this.activeTaskIds.has(id) && !this.#hasCapacityFor(task)) {
        const reason = this.#waitReason(task);
        const ownerId = reason === 'WORKSPACE_BUSY' ? this.#workspaceOwner(task) : this.activeTaskId;
        const owner = this.tasks.get(ownerId);
        throw Object.assign(
          new Error(reason === 'WORKSPACE_BUSY'
            ? `Рабочая папка занята сессией${owner ? ` «${owner.title || ownerId}»` : ''}: сообщение отправится, когда она её освободит.`
            : `Машина занята сессией${owner ? ` «${owner.title || ownerId}»` : ''}: достигнут лимит параллельных запусков.`),
          { code: 'BUSY' });
      }
      if (this.dispatching) {
        throw Object.assign(new Error('Очередь доставляет сообщение прямо сейчас — повторите через мгновение.'), { code: 'BUSY' });
      }
      // «Отправить сейчас» cuts in without stopping anything: while the turn
      // streams the text goes in as steering (the command in flight finishes,
      // then the model answers it); an idle session gets it as a new prompt.
      // Only the model itself or STOP ends a command.
      // If delivery fails, restore puts the prompt back at the queue front.
      // The pump may have already taken (or delivered) the only queued prompt by
      // now: «Отправить сейчас» clicked right after Enter. An empty queue here is
      // not an error — the message is already on its way, and the operator must
      // not see «Нет сообщения в очереди» for a text that was sent.
      let pending, restore;
      try {
        ({ pending, restore } = await this.#takePending(task, pendingId));
      } catch (error) {
        if (error.code === 'INPUT_INVALID') {
          // Lost the race with the pump: the prompt was taken and is being
          // delivered right now.
          this.#removeQueued(id);
          return this.#publicTask(task);
        }
        throw error;
      }
      if (!(task.pendingPrompts || []).length) this.#removeQueued(id);
      try {
        const waiting = (await this.#getPendingFiles(id, pending.id)) || { files: [], uploadToken: null };
        // A follow-up would wait for the end of the turn again: "now" is steering.
        const result = await this.#message(id, pending.text, pending.mode === 'follow_up' ? 'auto' : (pending.mode || 'auto'), waiting.files, waiting.uploadToken, { immediate: true, fromQueue: true, staged: pending.files || [], announce: pending.announce, ...pendingOrigin(pending) });
        await this.#deletePendingFiles(id, pending.id);
        return result;
      } catch (error) {
        await restore().catch(() => {});
        throw error;
      }
    }, id);
  }

  // Removing a queued prompt leaves the session as it was: a session that never
  // ran is cancelled, an existing one simply loses the pending message.
  async dropPending(id, pendingId = null) {
    return this.#admit(async () => {
      const task = this.tasks.get(id);
      if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const items = task.pendingPrompts || [];
      const index = pendingId ? items.findIndex(p => p.id === pendingId) : 0;
      const dropped = items[index];
      const rest = items.filter((_, i) => i !== index);
      if (pendingId && !dropped) return this.#publicTask(task);
      if (!dropped) throw Object.assign(new Error('Нет сообщения в очереди.'), { code: 'INPUT_INVALID' });
      await this.#releasePendingFiles(id, [dropped]);
      task.pendingPrompts = rest;
      if (rest.length) { await this.store.save(this.#publicTask(task)); return this.#publicTask(task); }
      if (!task.workspacePath) {
        // The original task.prompt is still queued; only its follow-up was removed.
        task.updatedAt = now();
        await this.#event(task, 'QUEUE_DROPPED', 'Сообщение убрано из очереди');
        await this.store.save(this.#publicTask(task));
        return this.#publicTask(task);
      }
      task.queueReason = null;
      this.#removeQueued(id);
      if (this.activeTaskIds.has(id) || ['RUNNING', 'PREPARING', 'PREFLIGHT', 'VERIFYING', 'WAITING_USER', 'CANCELLING'].includes(task.status)) {
        // Removing future input cannot finish the current run or its tools.
        task.updatedAt = now();
        await this.#event(task, 'QUEUE_DROPPED', 'Сообщение убрано из очереди');
        await this.store.save(this.#publicTask(task));
      } else {
        task.status = 'SUCCEEDED';
        task.current = 'Сообщение убрано из очереди';
        task.updatedAt = now();
        await this.#event(task, 'QUEUE_DROPPED', task.current);
        await this.#event(task, 'TASK_SUCCEEDED', task.current);
        await this.store.save(this.#publicTask(task));
      }
      return this.#publicTask(task);
    }, id);
  }

  async #message(...args) {
    try { return await this.#deliverMessage(...args); }
    catch (error) {
      await this.#recoverRpcFailure(this.tasks.get(args[0]), error);
      throw error;
    }
  }

  async #deliverMessage(id, text, mode, files, uploadToken, { immediate = false, queue = false, fromQueue = false, staged = [], announce = true, origin = null, pendingId: deliveredPendingId = null } = {}) {
    const deliveryStartedAt = Date.now();
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    // A task that already reached a terminal state may start a new turn even if
    // the queue slot has not been released yet (the finalizer clears it on the
    // next tick). Otherwise a follow-up sent right after completion — e.g. a
    // remote FOLLOW_UP arriving with the task_finished event — would be refused.
    const alreadyFinished = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status);
    // The machine runs one generation at a time. If another session owns it (or
    // this one is still preparing), the prompt waits its turn — the operator
    // never loses the text to a "модель занята" refusal. A task that already
    // reached a terminal state may start a new turn even if the queue slot has
    // not been released yet (the finalizer clears it on the next tick).
    const ownsSlot = this.activeTaskIds.has(id);
    const reservedElsewhere = (!ownsSlot && !this.#hasCapacityFor(task))
      || (ownsSlot && !alreadyFinished && task.status !== 'RUNNING');
    const incomingFiles = await this.#resolveFiles(files, uploadToken);
    const userText = String(text || '').trim() || (incomingFiles.length ? 'Прикреплённые файлы' : '');
    if (!userText) throw Object.assign(new Error('Добавьте сообщение или файл.'), { code: 'INPUT_INVALID' });
    if (!['auto', 'prompt', 'steer', 'follow_up'].includes(mode)) throw Object.assign(new Error('Неизвестный режим сообщения.'), { code: 'INPUT_INVALID' });
    // The queue decision happens BEFORE any session is started: asking
    // #ensureSession first would fail with "модель занята" on a busy runtime, and
    // the prompt would never reach the queue.
    const live = this.runtimes.get(id);
    // A probe, not a command. A session whose Pi pipe is already gone has no live
    // state to read — and failing the probe here is what made every message from
    // the phone answer "Pi RPC session is not writable" instead of the prompt
    // restarting the session (see #ensureSession). Other failures keep
    // propagating: a hung Pi is a different diagnosis and must stay visible.
    const liveState = live && !live.pi.closed && live.pi.canSend?.() !== false
      ? await live.pi.getState(PiRpcSession.PROBE_TIMEOUT_MS).catch(error => {
        if (error?.code === 'PI_RPC_NOT_WRITABLE') return null;
        throw error;
      })
      : null;
    if (liveState?.isCompacting) throw Object.assign(new Error('Сейчас выполняется сжатие контекста.'), { code: 'BUSY' });
    const liveStreaming = Boolean(liveState?.isStreaming);
    // Without an explicit queue request, a streaming session still receives the
    // text as steering (the previous behaviour); only a busy model queues it.
    const localBusy = this.#usesLocalRuntime(task) ? await this.local.getBusyStatus() : null;
    const holdingModel = !immediate && !liveStreaming && localBusy?.busy === true;
    // `queue` means "wait your turn instead of interrupting", not "always park".
    // A session that is idle right now takes the prompt immediately: parking it
    // made every Enter flash "В очереди" and put an idle chat at the mercy of
    // the next pump tick.
    const waitForTurn = queue && liveStreaming;
    // A COLD local model is what makes "Enter → buttons locked, nothing sent"
    // happen: without --models-autoload this prompt would block the HTTP request
    // while Pi loads the model (tens of seconds to minutes). Ack immediately by
    // parking, and let the pump load the model and deliver in the background.
    // `immediate` (Ctrl+Enter / queue delivery) is excluded on purpose: it means
    // "don't wait", and the pump delivers through it.
    const coldModel = !immediate && !fromQueue && localBusy?.loaded === false;
    if (waitForTurn || reservedElsewhere || holdingModel || coldModel) {
      // A prompt that came *out* of the queue must never be silently put back
      // here: that loop is what made «Отправить сейчас» look dead — the button
      // took the prompt out and this branch returned it, every time. Fail
      // loudly instead; the caller restores the prompt and the operator sees why.
      if (fromQueue) throw Object.assign(new Error('Машина занята — сообщение осталось в очереди.'), { code: 'BUSY' });
      // The model is held by another consumer (a second client, a stale slot,
      // another session): record the prompt and deliver it when the model is
      // free. Attachments are staged now, so the queued entry stays valid even
      // across a restart.
      // Files can only be staged into a workspace that exists. A session queued
      // before it ever started has none yet, so its files wait with the prompt
      // (in memory, next to the upload staging) and are staged at delivery,
      // when the workspace is real.
      const stageNow = Boolean(task.workspacePath);
      const pendingId = crypto.randomUUID();
      const attached = stageNow ? await stageFiles(task, this.store.taskDir(id), incomingFiles) : [];
      if (attached.length) {
        task.attachments = [...(task.attachments || []), ...attached];
        task.files = [...(task.files || []), ...attached.map(metadata)];
      }
      if (stageNow && uploadToken) await this.uploads.discard(uploadToken).catch(() => {});
      if (!stageNow && ((files || []).length || uploadToken)) {
        await this.#savePendingFiles(id, pendingId, { files: files || [], uploadToken: uploadToken || null });
      }
      const note = attached.length
        ? '\n\nAdditional files from the phone are in .taskbridge-input/:\n' + attached.map(f => `- ${f.path}`).join('\n')
        : '';
      // Several messages may wait for one session; they are delivered in order.
      // The files are staged already; the delivered turn must carry them too,
      // otherwise the chat shows a raw .taskbridge-input path instead of the
      // file the operator attached.
      task.pendingPrompts = [...(task.pendingPrompts || []), { id: pendingId, text: userText + note, mode, files: attached.map(metadata), ...(origin || {}) }];
      task.updatedAt = now();
      await this.#markWaiting(task, reservedElsewhere ? this.#waitReason(task) : (holdingModel ? 'MODEL_BUSY' : (coldModel ? 'MODEL_LOADING' : 'QUEUED')));
      // One event per queued prompt (QUEUE_WAITING is per session state and
      // deduplicated), so every client learns the pendingId of what it sent.
      await this.#event(task, 'PROMPT_QUEUED', 'Сообщение поставлено в очередь', { pendingId, ...(origin || {}) }, false);
      this.#enqueue(id);
      // Straight away, so a session that is idle does not wait for the retry tick.
      setImmediate(() => this.#pump());
      return this.#publicTask(task);
    }
    // Nothing is queued: start (or reuse) the session and deliver the prompt.
    if (this.#usesLocalRuntime(task) && !(await this.local.isReady())) await this.local.ensureRunning();
    const runtime = await this.#ensureSession(task);
    const state = await runtime.pi.getState(PiRpcSession.PROBE_TIMEOUT_MS);
    // Fresh state, taken right before delivering: this decides steer vs prompt.
    const streaming = Boolean(state?.isStreaming);
    if (state?.isCompacting) throw Object.assign(new Error('Сейчас выполняется сжатие контекста.'), { code: 'BUSY' });
    const baseline = streaming ? null : await snapshotWorkspace(task.workspacePath);
    // A prompt delivered from the queue was staged when it was accepted: reusing
    // those records keeps one copy on disk and one entry in task.attachments.
    const attached = staged.length ? staged : await stageFiles(task, this.store.taskDir(id), incomingFiles);
    if (uploadToken) await this.uploads.discard(uploadToken).catch(() => {});
    // The queued text already carries the note about its files.
    const message = userText + (attached.length && !staged.length ? `\n\nAdditional files from the phone are in .taskbridge-input/:\n${attached.map(f => `- ${f.path}`).join('\n')}` : '');
    // Расширенческую команду Pi нельзя ставить в очередь: отправленная как
    // steer/follow-up, пока агент работает, она отвечает «Extension command "/nudge"
    // cannot be queued. Use prompt() or execute the command when not streaming.»
    // (agent-session `_throwIfExtensionCommand`) и теряется — именно так «/nudge не
    // работает». Pi's prompt() выполняет такие команды сразу, даже во время стрима,
    // поэтому команда всегда идёт promt'ом. Список берётся живой у Pi: «/skill:…»,
    // «/prompt:…» и любой неизвестный «/text» — не команды расширения и остаются
    // steer'ом (их Pi сам разворачивает в текст, и очередь для них законна).
    // Считается и для явного steer/follow_up: Pi отказывается ставить команду в
    // очередь при ЛЮБОМ состоянии сессии, поэтому «вклиниться» командой не бывает —
    // бывает только выполнить её.
    const requestedMode = mode === 'auto' ? (streaming ? 'steer' : 'prompt') : mode;
    const extendableCommand = requestedMode !== 'prompt' && userText.startsWith('/')
      ? await this.#isPiExtensionCommand(runtime, userText)
      : false;
    const effectiveMode = extendableCommand ? 'prompt' : requestedMode;
    // Hold incoming frames until the RPC acknowledgement and USER_MESSAGE record
    // are persisted. A rejected RPC must not create a phantom user turn.
    await runtime.eventChain.catch(() => {});
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    runtime.eventChain = runtime.eventChain.then(() => gate);
    let settled;
    let accepted = false;
    let turn = null;
    // Any incoming user turn (prompt or steer) supersedes a previous cancel request:
    // the operator is sending new work and expects an answer, not a late CANCELLED.
    runtime.cancelRequested = false;
    runtime.cancelFinalizing = null;
    if (!streaming) {
      this.#claimSlot(id);
      turn = this.#beginTurn(task);
      settled = this.#waitForSettle(id, 12 * 60 * 60 * 1000);
      settled.catch(() => {});
    }
    // The in-flight marker (see #executeInitial): every new command overwrites
    // it, so the latest sent text is the one a restart recovers. Persisted
    // before the RPC: a restart between the RPC and the acknowledgement must
    // not lose the command either.
    task.inFlightPrompt = { text: message, at: now() };
    await this.store.save(this.#publicTask(task)).catch(() => {});
    if (!streaming) await this.#turnStateEvent(task, 'DISPATCHING');
    const dispatchedAt = Date.now();
    let ackError = null;
    try {
      if (effectiveMode === 'prompt') await runtime.pi.prompt(message);
      else await runtime.pi.sendFollowUp(message, effectiveMode);
      accepted = true;
      task.error = task.errorCode = task._modelError = null;
      task.retryable = task.retryAfterMs = null;
      if (!staged.length) task.attachments = [...(task.attachments || []), ...attached];
      await this.store.save(this.#publicTask(task));
      // announce:false = the message is already in history (regeneration), so a
      // second USER_MESSAGE would show the operator's own line twice.
      if (announce) {
        await this.#event(task, 'USER_MESSAGE', userText, {
          text: userText, mode: effectiveMode, files: attached,
          ...(origin || {}), ...(deliveredPendingId ? { pendingId: deliveredPendingId } : {}),
        });
      }
      if (!streaming) await this.#setStatus(task, 'RUNNING', 'Follow-up sent to Pi');
      else await this.#setStatus(task, 'RUNNING', 'Сообщение вклинилось в текущий ответ');
      if (!streaming) await this.#turnStateEvent(task, 'ACKED');
      // Вклинивание не начинает новый ход: фаза остаётся за живыми кадрами Pi.
      // Сброс нужен только чтобы снятый ранее терминальный ранг (Стоп → CANCELLED)
      // не блокировал PROGRESS, если Pi ещё стримит.
      else task._turnPhase = null;
      // Release gate immediately after USER_MESSAGE is safely persisted so the
      // HTTP response returns to client without waiting for subsequent background ticks.
      release();
    } catch (error) {
      ackError = error?.code || 'RPC_FAILED';
      // Шаг C-A: попытка доставки и её провал — диагностические факты в ленте;
      // фантомного USER_MESSAGE при этом нет (см. тест ниже).
      if (!streaming) await this.#turnStateEvent(task, 'FAILED');
      if (!accepted && !staged.length) await rollbackFiles(task, this.store.taskDir(id), attached);
      if (!streaming) {
        this.#resolveSettle(id);
        this.#releaseSlot(id);
      }
      throw error;
    } finally {
      release();
      this.#recordTurnTiming(task, {
        phase: 'follow_up', mode: effectiveMode,
        dispatchMs: dispatchedAt - deliveryStartedAt,
        ackMs: ackError ? null : Math.max(0, Date.now() - dispatchedAt), ackError
      });
    }
    if (!streaming) {
      (async () => {
        try {
          await settled;
          if (!runtime.cancelRequested && !['CANCELLED', 'FAILED'].includes(task.status)) await this.#verifyAndFinalize(task, { turn, baseline });
        } catch (error) { await this.#fail(task, error); }
        finally {
          // A newer turn may already own the session: a follow-up accepted while
          // this turn was finalizing (its `alreadyFinished` check lets it start
          // right away) has called #beginTurn by now. Releasing the slot here
          // would let the queue start another task in parallel with the live
          // generation — the same guard #verifyAndFinalize uses.
          if (this.activeTaskIds.has(id) && task._turn === turn) this.#releaseSlot(id);
          this.#pump();
        }
      })().catch(error => console.error(error));
    }
    return this.#publicTask(task);
  }

  async compact(id, instructions = '') {
    return this.#admit(() => this.#compact(id, instructions), id);
  }

  async #compact(id, instructions) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' });
    const runtime = await this.#ensureSession(task);
    if (this.activeTaskIds.has(id) || (await runtime.pi.getState())?.isStreaming) throw Object.assign(new Error('Дождитесь завершения ответа перед сжатием контекста.'), { code: 'BUSY' });
    if (this.#usesLocalRuntime(task) && (await this.local.getBusyStatus()).busy) throw Object.assign(new Error('Локальная модель сейчас занята другим запросом.'), { code: 'MODEL_BUSY' });
    await this.#event(task, 'COMPACT_REQUESTED', 'Manual compaction requested');
    const response = await runtime.pi.compact(String(instructions || ''));
    return response.data || null;
  }

  // Normalizes the task's model selection against the live catalog before Pi
  // is started: Pi names providers/models its own way (strata-iq3s → strata,
  // qwen3.8-flash-next-iq3-s → qwen3.8-flash-next-iq3_s), and a selection that
  // resolved yesterday can carry a name Pi cannot resolve today. Without this
  // Pi is started with a pattern it cannot resolve and exits «code=0» with no
  // explanation (observed 2026-10-01: «Error: Unknown provider strata-iq3s».).
  // Match by the dash/underscore-normalized id across providers: the profile
  // name and the provider name Pi serves differ, so the provider alone cannot
  // be the key. Several providers serving the same id → the same provider wins,
  // otherwise the rewrite is skipped (a wrong rewrite must never happen).
  async #normalizeTaskModel(task) {
    const model = task.requestedModel || task.model || null;
    if (!model?.id) return null;
    const known = this.modelCatalog.peek()?.models || [];
    if (!known.length) return null;
    const norm = (value) => String(value || '').toLowerCase().replace(/[_\s]+/g, '-');
    const wanted = norm(model.id);
    const exact = known.filter(m => norm(m.id) === wanted);
    if (!exact.length) return null;
    const match = exact.find(m => m.provider === model.provider) || (exact.length === 1 ? exact[0] : null);
    if (!match || (match.provider === model.provider && match.id === model.id)) return match;
    task.requestedModel = { provider: match.provider, id: match.id };
    task.model = this.#taskModel({ id: match.id, provider: match.provider, contextWindow: match.contextWindow ?? null, maxTokens: match.maxTokens ?? null });
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task)).catch(() => {});
    await this.#event(task, 'MODEL_SWITCH', `Модель: ${match.provider}/${match.id} (имя нормализовано по каталогу)`, { provider: match.provider, modelId: match.id }, false);
    return match;
  }

  // A session bound to a local model that is not loaded dies exactly like the
  // name-mismatch case above: Pi is started against weights that are not there
  // and exits «code=0» with no explanation (observed 2026-10-01: Strata was
  // unloaded, every start died with PI_SESSION_FAILED). The readable reason
  // replaces the silent exit: the operator loads the model or switches.
  // Only an explicitly unloaded external model fails here: router models have
  // no tracked status and their own autoload, and cloud models are not in the
  // local list at all.
  async #requireLocalModelLoaded(task) {
    if (!this.localModels.enabled) return;
    const model = task.requestedModel || task.model || null;
    if (!model?.id) return;
    const norm = (value) => String(value || '').toLowerCase().replace(/[_\s]+/g, '-');
    const wanted = norm(model.provider ? `${model.provider}/${model.id}` : model.id);
    const wantedId = norm(model.id);
    const external = await this.localServers.status().catch(() => null);
    // The session's provider may differ from the server's config provider
    // ('strata' vs 'strata-iq3s') while the model id is the same: without the
    // bare-id match the entry is not found, the unloaded check is skipped, and
    // Pi is started against a dead server and hangs with no model events
    // (observed 2026-10-01: Strata down, session on strata, start hung).
    const entry = (external?.models || []).find(m => norm(m.id) === wanted || norm(`${m.provider}/${m.id}`) === wanted || norm(m.id) === wantedId);
    if (entry) {
      if (entry.status === 'unloaded') {
        throw Object.assign(new Error(`Модель ${entry.provider}/${entry.id} сейчас выгружена. Загрузите её в локальных моделях или смените модель сессии.`), { code: 'MODEL_NOT_FOUND' });
      }
      if (entry.status === 'loading') {
        throw Object.assign(new Error(`Модель ${entry.provider}/${entry.id} ещё загружается — подождите немного.`), { code: 'BUSY' });
      }
      return;
    }
    // A router-model session: the router must be reachable, or Pi would be
    // started against a server that is not there.
    if (this.#usesLocalRuntime(task)) {
      const status = await this.local.getStatus().catch(() => null);
      if (status && !status.reachable) {
        throw Object.assign(new Error('Локальный сервер моделей недоступен. Запустите его или смените модель сессии.'), { code: 'MODEL_NOT_FOUND' });
      }
    }
  }

  async #ensureSession(task) {
    const current = this.runtimes.get(task.id);
    // `closed` alone is not enough: Pi that exited leaves stdin closed while the
    // close event may still be unprocessed, and the runtime is then reused as if
    // it were alive — every command against it fails with "Pi RPC session is not
    // writable" instead of the session being started again. `canSend` is checked
    // defensively because the in-process test fixtures stub Pi with a plain
    // object; only a session that explicitly reports a dead pipe is replaced.
    // A cancelled runtime is retired immediately, before the abort/kill RPC
    // finishes.  Keeping it reusable here lets a newly opened chat attach to
    // the old Pi process while its queued frames are still draining; that is
    // how a session can show CANCELLED in the list and continue answering in
    // the details screen.  A new turn must start a fresh runtime instead.
    if (current && !current.retired && !current.cancelRequested && !current.pi.closed && current.pi.canSend?.() !== false) return current;
    if (current) {
      current.retired = true;
      current.cancelRequested = true;
      task._turn = (task._turn || 0) + 1;
      await current.pi.killTree().catch(() => {});
      this.#resolveSettle(task.id);
      if (this.runtimes.get(task.id) === current) this.runtimes.delete(task.id);
    }
    // The model the session is about to run, normalized against the live
    // catalog: Pi names providers/models its own way (strata-iq3s → strata,
    // qwen3.8-flash-next-iq3-s → qwen3.8-flash-next-iq3_s), and a selection that
    // resolved yesterday can carry a name Pi cannot resolve today. Without this
    // Pi is started with a pattern it cannot resolve and exits «code=0» with no
    // explanation (observed 2026-10-01: «Error: Unknown provider strata-iq3s»).).
    await this.#normalizeTaskModel(task);
    // A session bound to a local model that is not loaded dies the same way:
    // the readable reason replaces the silent exit.
    await this.#requireLocalModelLoaded(task);
    if (this.#usesLocalRuntime(task) && (await this.local.getBusyStatus()).busy) throw Object.assign(new Error('Локальная модель сейчас занята другим запросом. Повторите чуть позже.'), { code: 'MODEL_BUSY' });
    if (!task.workspacePath) {
      Object.assign(task, await this.#prepareWorkspace(task));
    }
    await this.#checkpointStart(task);
    await fs.access(task.workspacePath);
    if (task.nativeSession && !task._nativeLease) task._nativeLease = await acquireNativeLease(task);
    const sessionFile = await restoreSessionFile(task, this.store, this.dataRoot);
    await this.#guardSessionFile(task, sessionFile);
    const autoCompaction = task.autoCompactionEnabled;
    task._starting = true;
    this.#syncRuntime(task, 'starting');
    let pi;
    try { pi = await this.#createPi(task, sessionFile); }
    finally { task._starting = false; }
    this.#syncRuntime(task, 'started');
    try {
      await pi.getState();
      if (autoCompaction != null) await pi.setAutoCompaction(autoCompaction);
      await this.#captureModelInfo(task, pi);
      task.piSessionFile = sessionFile;
      await this.#event(task, 'SESSION_RESTORED', 'Сессия Pi восстановлена с сохранённой историей.');
      return this.runtimes.get(task.id);
    } catch (error) {
      await pi.killTree().catch(() => {});
      this.runtimes.delete(task.id);
      throw error;
    }
  }

  async state(id) {
    const runtime = this.runtimes.get(id);
    // The chat screen polls this while it is open. A session whose pipe is gone
    // must answer "no live runtime" (the same null the client handles) instead
    // of failing the request with "Pi RPC session is not writable".
    if (!runtime || runtime.pi.closed || runtime.pi.canSend?.() === false) return null;
    return runtime.pi.getState();
  }

  async #setStatus(task, status, current) {
    if (this.closing) return;
    if (this.deleted.has(task.id)) return;
    // Терминальный статус закрывает и ожидание: следующий ход начнёт его заново,
    // а до тех пор «ждём провайдера» — уже неправда. Событие здесь не нужно:
    // за статусом всегда идёт TASK_*.
    if (RUN_TERMINAL.has(status)) {
      task.providerWait = null;
      if (String(task.current || '').startsWith(PROVIDER_WAIT_CURRENT)) task.current = '';
    }
    // The UI shows "работает 12 с", so the moment of the transition matters.
    if (task.status !== status) task.statusChangedAt = now();
    // Re-entering RUNNING after an approval belongs to the same turn.
    if (status === 'RUNNING' && task.status !== 'RUNNING') this.runCoordinator.start(task.id);
    task.status = status;
    task.current = current;
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#event(task, 'STATUS', current, { status }, false);
  }

  // Runs recorded for a task, newest first (read-only; stage 2).
  listRuns(taskId, limit = 50) {
    try { return this.store.listRuns(taskId, limit); } catch { return []; }
  }

  // A dead RPC process must not remain the owner of the session/model slot.
  // Do not retire PI_RPC_SLOW: events prove it is still doing useful work.
  async #recoverRpcFailure(task, error) {
    if (!task || !['PI_RPC_HUNG', 'PI_RPC_EXITED'].includes(error?.code)) return;
    const runtime = this.runtimes.get(task.id);
    if (runtime) {
      runtime.retired = true;
      runtime.cancelRequested = true;
      task._turn = (task._turn || 0) + 1;
      await runtime.pi.killTree();
      this.#resolveSettle(task.id);
      if (this.runtimes.get(task.id) === runtime) this.runtimes.delete(task.id);
    }
    task.piPid = null;
    task.piStartedAt = null;
    task._toolsRunning = 0;
    task._compacting = false;
    task._compactingSince = 0;
    this.#releaseSlot(task.id);
    if (task.pendingUiRequest) await this.#closeUiRequest(task, task.pendingUiRequest.id, { cancelled: true, reason: 'rpc_failed' });
    await this.#fail(task, error);
    this.#schedulePump();
  }

  // A message Pi accepted into its own queue (a steer) but that never got
  // consumed is otherwise lost silently: the chat kept showing «ожидание
  // события агента» while nothing would ever deliver it (observed 2026-09-30,
  // deepseek-flash, code=4294967295 four hundred ms after the steer). Pi
  // records the user message as the turn consumes it, so the session file
  // tells the two cases apart: nothing there → the text is re-queued the way
  // the restart resume does (announce: false — the chat already has it), and
  // the queue line delivers it via «Сейчас» or the next message; already
  // there → nothing to bring back.
  async #requeueUnconsumedPrompt(task) {
    if (!task.inFlightPrompt?.text) return;
    if (await sessionContainsUserMessage(task.piSessionFile, task.inFlightPrompt.text).catch(() => false)) return;
    const pendingId = crypto.randomUUID();
    task.pendingPrompts = [...(task.pendingPrompts || []), {
      id: pendingId,
      text: task.inFlightPrompt.text,
      mode: 'auto',
      announce: false,
    }];
    await this.#event(task, 'PROMPT_QUEUED', 'Сообщение осталось в очереди: Pi завершился до его обработки.', { pendingId }, false);
  }

  async #fail(task, error) {
    if (this.closing) return; // like #setStatus: nothing reaches a closed store
    if (task.status === 'CANCELLED' || this.deleted.has(task.id)) return;
    // A message Pi accepted into its own queue (a steer) but died before
    // consuming is otherwise lost silently: the chat kept showing «ожидание
    // события агента» while nothing would ever deliver it (observed 2026-09-30,
    // deepseek-flash, code=4294967295 four hundred ms after the steer).
    await this.#requeueUnconsumedPrompt(task);
    // The turn reached a terminal state: the in-flight command is spent.
    if (task.inFlightPrompt) task.inFlightPrompt = null;
    const classified = classifyEngineError(error) || classifyEngineError(task._modelError);
    const explicit = error?.code && !['MODEL_ERROR', 'INTERNAL_ERROR'].includes(error.code) ? error.code : null;
    this.#terminalPublication.hold(task, this.#publicTask(task));
    task.status = 'FAILED';
    task.errorCode = explicit || classified?.code || error?.code || 'INTERNAL_ERROR';
    task.retryable = classified ? classified.retryable : null;
    task.retryAfterMs = classified?.retryAfterMs ?? null;
    if (task.errorCode === 'RATE_LIMITED') {
      const provider = this.#providerForTask(task);
      if (provider) this.providerCooldownUntil.set(provider, Date.now() + Math.max(1000, task.retryAfterMs || Number(this.config.queue?.rateLimitBackoffMs) || 30000));
    }
    // Store a readable line, not the provider's raw JSON body: this text goes to
    // the UI, result.md and push notifications. Classification above still ran
    // against the untouched error.
    task.error = humanizeError(error.message || String(error));
    task.current = 'Failed';
    task.updatedAt = now();
    // Publish the event before the failed status is observable (see
    // #verifyAndFinalize): a late TASK_FAILED broke the "no events after a
    // terminal status" contract the client relies on.
    await this.#turnStateEvent(task, 'FAILED');
    await this.#event(task, 'TASK_FAILED', task.error, { errorCode: task.errorCode });
    await this.store.save(this.#publicTask(task));
    await this.#writeResult(task).catch(() => {});
  }

  async #event(task, type, message, data = {}, persistTask = true) {
    if (this.deleted.has(task.id)) return;
    const next = (this.eventWrites.get(task.id) || Promise.resolve()).then(() => this.#recordEvent(task, type, message, data, persistTask));
    const settled = next.catch(() => {});
    this.eventWrites.set(task.id, settled);
    settled.then(() => { if (this.eventWrites.get(task.id) === settled) this.eventWrites.delete(task.id); });
    return next;
  }

  async #recordEvent(task, type, message, data, persistTask, seq = null) {
    if (this.deleted.has(task.id)) return;
    // Consumers may close their stream at TASK_*: publish the runtime change
    // first so the terminal event really is the final event of this turn.
    if (['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_CANCELLED'].includes(type)) {
      const change = this.#runtimeChange(task);
      if (change) await this.#recordEvent(task, 'RUNTIME_STATE', `${change.from || '—'} → ${change.to}`, { ...change, reason: type }, false);
    }
    const event = { at: now(), taskId: task.id, type, message, data };
    // Ход закончился — будим устройства (телефон в локальной сети): уведомление
    // придёт за секунды, а не с ближайшим фоновым опросом. Fire-and-forget:
    // промах — штатный сон устройства, запасной канал остаётся.
    const atomicTerminal = seq === null && ['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_CANCELLED'].includes(type);
    if (atomicTerminal) {
      const run = this.runCoordinator.terminal(task.id, type.slice(5), event.at);
      await this.store.appendEventWithTask(task.id, event, { ...this.#publicTask(task, true), updatedAt: event.at }, run);
      if (run) this.runCoordinator.committed(task.id, run.id);
    } else if (seq === null) await this.store.appendEvent(task.id, event);
    else await this.store.appendEventAt(task.id, seq, event);
    if (['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_CANCELLED'].includes(type)) this.#terminalPublication.release(task);
    // Шаг C-B: снимок задачи теперь версионирован последним событием (appendEvent
    // проставляет event.seq). Старшинство сравнивается на клиенте.
    if (Number.isFinite(event.seq)) task._snapshotSeq = event.seq;
    if (persistTask) {
      task.updatedAt = event.at;
      if (!atomicTerminal) await this.store.save(this.#publicTask(task)).catch(() => {});
    }
    if (['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_CANCELLED'].includes(type)) {
      this.wakeChannel.sendAll({ taskId: task.id, type, at: event.at }).catch(() => {});
    }
    this.emit('task-event', event);
    // Every status change is followed by an event, so this is the one place the
    // runtime state is re-derived (R3.1).
    if (type !== 'RUNTIME_STATE') {
      const change = this.#runtimeChange(task);
      if (change) await this.#recordEvent(task, 'RUNTIME_STATE', `${change.from || '—'} → ${change.to}`, { ...change, reason: type }, false);
    }
    return event;
  }

  // --- runtime state (R3.1) --------------------------------------------------
  #runtimeFacts(task) {
    const runtime = this.runtimes.get(task.id);
    return deriveRuntimeState({
      status: task.status,
      live: Boolean(runtime && !runtime.pi.closed),
      starting: Boolean(task._starting),
      sleeping: Boolean(task._sleeping),
      hasSession: Boolean(task.piSessionFile || task.workspacePath) && !task._sessionLost,
      compacting: Boolean(task._compacting),
      compactingSince: task._compactingSince || 0,
      toolsRunning: task._toolsRunning || 0,
      waitingModel: Boolean(task.providerWait),
    });
  }

  #runtimeChange(task) {
    const next = this.#runtimeFacts(task);
    const previous = task._runtimeFacts || null;
    const changed = !previous
      || previous.state !== next.state
      || previous.activity !== next.activity
      || (previous.compactingSince || null) !== (next.compactingSince || null);
    if (!changed) return null;
    if (!transitionAllowed(previous?.state || null, next.state)) console.warn(`[TaskBridge] runtime ${task.id}: unexpected ${previous?.state || null} → ${next.state} (status ${task.status})`);
    task._runtimeFacts = next;
    task._runtimeState = next.state;
    return {
      from: previous?.state || null,
      to: next.state,
      fromActivity: previous?.activity || null,
      toActivity: next.activity || null,
      compactingSince: next.compactingSince || null,
    };
  }

  // For changes no event announces (a Pi starting or exiting).
  #syncRuntime(task, reason) {
    if (this.deleted.has(task.id) || this.closing) return;
    const change = this.#runtimeChange(task);
    if (change) this.#event(task, 'RUNTIME_STATE', `${change.from || '—'} → ${change.to}`, { ...change, reason }, false).catch(() => {});
  }

  // --- ownership guard (R3.5) ------------------------------------------------
  // Two writers on one Pi session file corrupt it. Before our Pi opens a file:
  // no other process may name it on its command line (a `pi --session <file>` in
  // a terminal), and a session imported from terminal Pi must have been quiet
  // for a while (a `pi -c` there does not name the file).
  async #guardSessionFile(task, sessionFile) {
    if (!sessionFile) return;
    const own = new Set();
    for (const [taskId, runtime] of this.runtimes) {
      if (taskId !== task.id && runtime?.pi?.proc?.pid) own.add(runtime.pi.proc.pid);
    }
    const busy = (detail) => Object.assign(new Error(`Сессию Pi сейчас пишет другой процесс (${detail}). Можно открыть историю только для чтения или сделать копию («Клонировать»).`), { code: 'SESSION_BUSY', detail });
    for (const [taskId, runtime] of this.runtimes) {
      if (taskId !== task.id && runtime?.pi && !runtime.pi.closed && this.tasks.get(taskId)?.piSessionFile === sessionFile) throw busy(`сессия ${taskId}`);
    }
    const holders = await processesUsingFile(sessionFile, { exclude: own });
    // Our Pi processes of other tasks never name this file; anything that does
    // is a foreign writer. (unknown = the OS would not say: go on.)
    const foreign = holders || [];
    if (foreign.length) throw busy(`pid ${foreign.map(item => item.pid).join(', ')}`);
    if (task.nativeSession) {
      const quietMs = Math.max(0, Number(this.config.pi?.sessionQuietMs ?? 10000));
      const stat = await fs.stat(sessionFile).catch(() => null);
      const ownWrite = task._lastPiExitAt ? stat && stat.mtimeMs <= task._lastPiExitAt + 2000 : false;
      if (stat && !ownWrite && Date.now() - stat.mtimeMs < quietMs) throw busy('файл менялся только что');
    }
  }

  // --- provider wait (a retry Pi announces while the agent is still alive) ----
  // Логика — в provider-wait.mjs; здесь только привязка публикации событий задачи.
  async #noteProviderWait(task, wait) {
    const failure = classifyEngineError(wait?.reason);
    const guidance = {
      MODEL_AUTH_INCOMPATIBLE: 'Модель несовместима с авторизацией ChatGPT. Выберите доступную модель провайдера openai-codex или измените способ авторизации.',
      ENGINE_AUTH: 'Провайдер отклонил авторизацию. Проверьте ключ или обновите вход у этого провайдера.',
      QUOTA_EXCEEDED: 'Провайдер сообщил об исчерпанной квоте или недостатке средств. Проверьте лимиты и баланс провайдера.',
    }[failure?.code];
    if (guidance && failure.retryable === false) {
      // The retry belongs to Pi/its extension. Retire that owned process before
      // publishing failure; merely hiding PROVIDER_WAIT would still send again.
      const runtime = this.runtimes.get(task.id);
      if (runtime) {
        runtime.retired = true;
        await runtime.pi.killTree();
      }
      task.piPid = null;
      task.piStartedAt = null;
      task._lastPiExitAt = Date.now();
      task._toolsRunning = 0;
      task._compacting = false;
      task._compactingSince = 0;
      await this.#clearProviderWait(task, 'non_retryable', { announce: false });
      const error = Object.assign(new Error(
        `${guidance} Автоматический повтор остановлен. ${wait.reason}`
      ), { code: failure.code });
      try { await this.#fail(task, error); }
      finally { this.#resolveSettle(task.id); }
      return;
    }
    await noteProviderWait(task, wait, (type, message, data) => this.#event(task, type, message, data));
  }
  #sameProviderWait(current, wait) {
    return sameProviderWait(current, wait);
  }
  async #clearProviderWait(task, reason, options) {
    await clearProviderWait(task, reason, (type, message, data) => this.#event(task, type, message, data), options);
  }

  /**
   * Названа ли команда расширения Pi в тексте вида `/nudge help`.
   *
   * Разбор имени — тот же, что у Pi в `_tryExecuteExtensionCommand`: до первого
   * пробела, без ведущего слэша. Список команд спрашивается у живого Pi только когда
   * это вообще может изменить доставку (слэш при работающем агенте), поэтому кэш и его
   * протухание не нужны: ошибка чтения списка не ломает отправку — команда просто
   * уедет прежним путём и Pi скажет своё.
   */
  async #isPiExtensionCommand(runtime, text) {
    const name = String(text || '').trim().slice(1).split(/\s/, 1)[0];
    if (!name) return false;
    const commands = await runtime.pi.getCommands().catch(() => []);
    return commands.some(command => String(command?.name || '').replace(/^\//, '') === name);
  }

  // --- extension UI requests (Pi RPC) ------------------------------------------
  async #onUiRequest(task, frame) {
    if (frame.method === 'notify') {
      const message = uiText(frame.message, 2000) || '';
      if (GIVE_UP_NOTICE.test(message)) {
        // Отказ без повтора: состояние ожидания снимет машинный кадр `give_up`, а в чат
        // об этом скажет эта строка — без модели и причины сырое объявление бесполезно.
        await this.#event(task, 'UI_NOTIFY', providerGiveUpMessage(parseProviderGiveUp(message)), { notifyType: 'error', giveUp: true });
        return;
      }
      if (RETRY_IN_PROGRESS_NOTICE.test(message)) {
        // В чат — не строкой уведомления (выше): она читается как ошибка агента,
        // которой нет. Но само ожидание — состояние сессии, и его видно.
        await this.#noteProviderWait(task, parseProviderWait(message));
        return;
      }
      await this.#event(task, 'UI_NOTIFY', message, { notifyType: ['info', 'warning', 'error'].includes(frame.notifyType) ? frame.notifyType : 'info' });
      return;
    }
    // pi-limits-wait отдаёт то же ожидание машинным кадром (statusKey
    // `…pi-limits-wait.json`): провайдер, модель, `reason` и абсолютный
    // `plannedDeadline`. Предпочитаем его тексту: там поля, а не проза, которую
    // приходится разбирать догадками.
    if (frame.method === 'setStatus' && String(frame.statusKey || '').endsWith('pi-limits-wait.json')) {
      const wait = parseProviderWaitStatus(frame.statusText);
      // `give_up` — не ожидание, а его конец: держать «ждём провайдера» после него
      // значит обещать повтор, которого не будет. Молча: сама ошибка уже идёт в чат
      // своим сообщением Pi (и строкой выше — прозой того же отказа).
      if (wait?.giveUp) await this.#clearProviderWait(task, 'give_up', { announce: false });
      else await this.#noteProviderWait(task, wait);
      return;
    }
    // Extension progress ticks (smart-compaction) arrive as setStatus frames
    // with statusKey "smart-compaction" — terminal decoration on Pi's side, but
    // the stage is exactly what the diagnostics panel is for: «Сжимается
    // контекст · Smart compaction: chunk 10/25 (35s)» in Активность instead of a
    // wall of one note per chunk in the chat.
    if (frame.method === 'setStatus' && String(frame.statusKey || '').startsWith('smart-compaction')) {
      const text = uiText(frame.statusText, 500) || '';
      if (!text) {
        task._compactionStage = null;
        if (String(task.current || '').startsWith('Smart compaction: ')) {
          task.current = '';
          task.updatedAt = now();
          await this.store.save(this.#publicTask(task));
          await this.#event(task, 'STATUS', '', { status: task.status }, false);
        }
        return;
      }
      // The ticker re-sends the same stage every second with a new elapsed time:
      // emit once per stage change, not once per tick.
      const stage = text.replace(/ \(\d+s\)$/, '');
      if (stage !== task._compactionStage) {
        task._compactionStage = stage;
        task.current = text;
        task.updatedAt = now();
        await this.store.save(this.#publicTask(task));
        await this.#event(task, 'STATUS', text, { status: task.status }, false);
      }
      return;
    }
    // setStatus / setWidget / setTitle / set_editor_text: terminal decoration.
    if (!UI_DIALOGS.has(frame.method) || typeof frame.id !== 'string') return;
    const request = {
      id: frame.id,
      method: frame.method,
      title: uiText(frame.title, 500),
      message: uiText(frame.message),
      options: frame.method === 'select' && Array.isArray(frame.options) ? frame.options.slice(0, 100).map(option => String(option).slice(0, 500)) : undefined,
      placeholder: uiText(frame.placeholder, 500),
      prefill: uiText(frame.prefill, 100000),
      timeout: Number.isFinite(frame.timeout) && frame.timeout > 0 ? frame.timeout : null,
      at: now(),
    };
    // A second dialog replaces the first: Pi only asks one at a time, so the
    // first was resolved on its side (its own timeout).
    if (task.pendingUiRequest) await this.#closeUiRequest(task, task.pendingUiRequest.id, { timedOut: true, reason: 'superseded' });
    task.pendingUiRequest = request;
    await this.#event(task, 'UI_REQUEST', request.title || 'Pi ждёт ответа', request);
    await this.#setStatus(task, 'WAITING_USER', `Ждёт ответа: ${request.title || request.method}`);
    // With a timeout Pi resolves the dialog itself; mirror that here.
    if (request.timeout) {
      clearTimeout(task._uiTimer);
      task._uiTimer = setTimeout(() => this.#closeUiRequest(task, request.id, { timedOut: true }).catch(() => {}), request.timeout + 250);
      task._uiTimer.unref?.();
    }
  }

  async #closeUiRequest(task, requestId, outcome, origin = null) {
    if (task.pendingUiRequest?.id !== requestId) return false;
    task.pendingUiRequest = null;
    clearTimeout(task._uiTimer);
    task._uiTimer = null;
    await this.#event(task, 'UI_RESOLVED', outcome.cancelled ? 'Запрос закрыт' : outcome.timedOut ? 'Время ответа истекло' : 'Ответ отправлен', { id: requestId, ...outcome, ...(origin || {}) });
    if (task.status === 'WAITING_USER' && !this.listApprovals(task.id).some(item => item.status === 'PENDING')) {
      await this.#setStatus(task, 'RUNNING', 'Pi is working');
    }
    return true;
  }

  /**
   * Answers the dialog Pi is waiting on. The first answer wins: the rest get
   * NOT_ALLOWED and see the UI_RESOLVED event of the winner.
   */
  async respondUi(id, { requestId, value, confirmed, cancelled } = {}, origin = null) {
    const task = this.tasks.get(id);
    if (!task || this.deleted.has(id)) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    const pending = task.pendingUiRequest;
    if (!pending || pending.id !== requestId) throw Object.assign(new Error('На этот запрос уже ответили или он закрыт.'), { code: 'NOT_ALLOWED' });
    let response;
    if (cancelled === true) response = { cancelled: true };
    else if (pending.method === 'confirm') {
      if (typeof confirmed !== 'boolean') throw Object.assign(new Error('Ответ на подтверждение: confirmed true или false.'), { code: 'INPUT_INVALID' });
      response = { confirmed };
    } else {
      if (typeof value !== 'string') throw Object.assign(new Error('Нужен текст ответа (value).'), { code: 'INPUT_INVALID' });
      if (pending.method === 'select' && !pending.options?.includes(value)) throw Object.assign(new Error('Такого варианта нет.'), { code: 'INPUT_INVALID' });
      response = { value: value.slice(0, 100000) };
    }
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.pi.closed) throw Object.assign(new Error('Pi уже не ждёт ответа.'), { code: 'NOT_ALLOWED' });
    // #closeUiRequest claims the request synchronously, before its first await:
    // a second answer arriving while this one is written finds it gone.
    const closing = this.#closeUiRequest(task, requestId, response.cancelled ? { cancelled: true } : { answered: true, ...response }, origin);
    runtime.pi.send({ type: 'extension_ui_response', id: requestId, ...response });
    await closing;
    return this.#publicTask(task);
  }
}
