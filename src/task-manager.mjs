import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PiRpcSession } from './pi-rpc.mjs';
import { prepareProjectWorkspace, createScratchWorkspace, collectGitState, runVerification, applyTaskPatch, removeWorktree, git } from './git.mjs';
import { RuntimeManager } from './runtime-manager.mjs';
import { restoreSessionFile } from './session-history.mjs';
import { validateFiles, validateUploadRefs, metadata, stageFiles, rollbackFiles, snapshotWorkspace, captureOutputs } from './files.mjs';
import { UploadStore } from './uploads.mjs';
import { NativeSessionService, acquireNativeLease } from './native-sessions.mjs';
import { classifyEngineError } from './engine.mjs';
import { humanizeError } from '../web/errors.mjs';
import { chooseEngine, usesLocalRuntime, resolveRouterModel, resolveLocalProviderId } from './dispatcher.mjs';
import { ModelCatalog } from './model-catalog.mjs';
import { LocalModelService, quantFromPath } from './local-models.mjs';
import { McpManager, MCP_MODES } from './mcp-manager.mjs';
import { TEXT_TAIL, THINKING_TAIL, tailText, appendTail } from './text-tail.mjs';
import { computeTokensPerSecond, accumulateStreamMs } from './system-metrics.mjs';
import { ApprovalManager } from './cloud/approval-manager.mjs';
import { classifyToolCall, resolveApprovalConfig } from './approvals/policy.mjs';

function now() { return new Date().toISOString(); }
function shortId() { return crypto.randomUUID().replaceAll('-', '').slice(0, 12); }
function safeFileName(name) {
  const base = path.basename(String(name || 'file.bin'));
  return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180) || 'file.bin';
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

export class TaskManager extends EventEmitter {
  constructor(config, dataRoot, store) {
    super();
    this.config = config;
    this.dataRoot = dataRoot;
    this.store = store;
    this.projects = new Map((config.projects || []).map((p) => [p.id, p]));
    this.tasks = new Map();
    this.runtimes = new Map();
    this.queue = [];
    this.activeTaskId = null;
    // Open run ids per task (stage 2 telemetry): kept out of the task record
    // so they never leak into saved/public task state.
    this.openRuns = new Map();
    // Files of prompts queued before their workspace existed: raw input kept in
    // memory only, never written into the task record where every save would
    // carry them.
    this.pendingFiles = new Map();
    // capacity 1: a task that cannot start yet (local model busy) is kept in
    // the queue and retried, instead of rejecting the operator's prompt.
    this.queuePollMs = Number(config.queue?.pollMs) > 0 ? Number(config.queue.pollMs) : 1000;
    this.pumpTimer = null;
    this.pumpAgain = false;
    this.closing = false;
    // commandId → { hash, done, result, at }: dedupes operator commands so a
    // retry / second client / double-click cannot fire a prompt twice. TTL is
    // bounded by memory (see #dedupeCommand); persistence across a process
    // restart is a deliberate follow-up.
    this.commandLedger = new Map();
    this.admitting = false;
    // Task id whose pending prompt the pump is delivering right now (delegating
    // delivery). Read by sendPendingNow to refuse cutting into it.
    this.dispatching = null;
    this.deleted = new Set();
    this.eventWrites = new Map();
    this.runtimeManager = new RuntimeManager(config.localRuntime || {}, dataRoot);
    // Router mode: one always-on llama.cpp server that loads presets on demand
    // (see docs). When configured it replaces the single-model RuntimeManager
    // for every health/busy/ensure check; the old object stays for the legacy
    // profile restart endpoints.
    this.localModels = new LocalModelService(config.localRuntime || {}, dataRoot);
    this.local = this.localModels.enabled ? this.localModels : this.runtimeManager;
    this.mcp = new McpManager(config.pi || {}, dataRoot);
    this.modelCatalog = new ModelCatalog({ pi: config.pi, cwd: dataRoot, env: this.#llamaEnv() });
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

  async init() {
    await this.uploads.cleanup().catch(() => {});
    await this.mcp.ensureReady().catch(() => {});
    const previous = await this.store.list();
    let trimmed = 0;
    for (const task of previous) {
      // One-time shrink of records written before text was bounded.
      const assistantText = tailText(task.assistantText, TEXT_TAIL);
      const thinkingText = tailText(task.thinkingText, THINKING_TAIL);
      if (assistantText !== task.assistantText || thinkingText !== task.thinkingText) {
        task.assistantText = assistantText;
        task.thinkingText = thinkingText;
        await this.store.save(task).catch(() => {});
        trimmed++;
      }
      // A queued task is restored: nothing was sent to Pi yet, so the prompt is
      // still exactly what the operator asked for. A task that was already
      // running (or preparing) cannot be resumed — its Pi process is gone.
      const queuedNotStarted = task.status === 'QUEUED' && !task.workspacePath;
      const queuedPrompt = task.status === 'QUEUED' && Boolean(task.pendingPrompts?.length);
      if (queuedNotStarted || queuedPrompt) {
        task.queueReason = 'RESTORED';
        task.current = 'В очереди после перезапуска TaskBridge';
        task.updatedAt = now();
        await this.store.save(task);
        this.queue.push(task.id);
        await this.#restorePendingFiles(task.id);
      } else if (['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING'].includes(task.status)) {
        task.status = 'FAILED';
        task.errorCode = 'FAILED_RECOVERY';
        task.error = 'TaskBridge restarted while this task was active.';
        task.updatedAt = now();
        await this.store.save(task);
      }
      this.tasks.set(task.id, task);
    }
    if (trimmed) await this.store.vacuum().catch(() => {});
    await this.#sweepOrphans();
    if (this.queue.length) this.#schedulePump();
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
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
    await this.#drainPump(2000);
    for (const [taskId, entry] of this.runtimes) {
      try {
        if (entry?.eventChain) await entry.eventChain;
        const pi = entry?.pi;
        if (!pi || pi.closed) continue;
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
  }

  // Waits until an in-flight pump has finished (bounded), so store.write from a
  // pump cannot race store.close(). The pump aborts promptly because closing is
  // latched and #executeInitial/#setStatus early-return on it.
  async #drainPump(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.pumping && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

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
    // keeps it cheap even with hundreds of sessions.
    const counts = this.store.eventCounts();
    return Array.from(this.tasks.values())
      .map(t => ({ ...this.#publicTask(t), events: counts.get(t.id) || 0 }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getTask(id) {
    const task = this.tasks.get(id);
    return task ? this.#publicTask(task) : null;
  }

  async #admit(action) {
    if (this.admitting) throw Object.assign(new Error('Другой запрос ещё отправляется. Повторите позже.'), { code: 'BUSY' });
    this.admitting = true;
    try { return await action(); } finally { this.admitting = false; }
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
    const ownerBusy = Boolean(this.activeTaskId);
    let requestedModel = this.#normalizeModelSelection(input.model);
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

    const task = {
      id: requestedId || shortId(),
      createdAt: now(),
      updatedAt: now(),
      status: 'QUEUED',
      queueReason: waitingReason,
      projectId,
      prompt,
      workspacePath: null,
      sourcePath: null,
      worktree: false,
      current: waitingReason === 'MODEL_BUSY' ? 'Ждёт освобождения локальной модели' : (waitingReason ? 'В очереди' : 'Queued'),
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
      model: null,
      autoCompactionEnabled: null,
      files: incomingFiles.map(metadata),
      attachments: [],
      outputFiles: []
    };

    await this.store.create(task);
    this.tasks.set(task.id, task);
    task._incomingFiles = incomingFiles;
    task._uploadToken = input.uploadToken;
    this.queue.push(task.id);
    await this.#event(task, waitingReason ? 'QUEUE_WAITING' : 'TASK_QUEUED',
      waitingReason === 'MODEL_BUSY' ? 'Ждёт освобождения локальной модели' : (waitingReason ? 'В очереди' : 'Task queued'),
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

  #publicTask(task) {
    const { _incomingFiles, _modelError, _baseline, _turn, _nativeLease, _uploadToken, _genStreamMs, _genLastDeltaAt, ...safe } = task;
    const runtime = this.runtimes.get(task.id);
    return {
      ...safe,
      assistantText: tailText(safe.assistantText, TEXT_TAIL),
      thinkingText: tailText(safe.thinkingText, THINKING_TAIL),
      sessionAvailable: Boolean(task.workspacePath || (runtime && !runtime.pi.closed))
    };
  }

  // Retry the queue later instead of spinning: the model is owned by someone
  // else for an unknown time.
  #schedulePump() {
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      setImmediate(() => this.#pump());
    }, this.queuePollMs);
    this.pumpTimer.unref?.();
  }

  // One event per transition, so the UI (and the cloud) can explain why nothing
  // is happening yet.
  async #markWaiting(task, reason) {
    // A session that is streaming right now keeps its RUNNING status: the prompt
    // waits for the turn to end, and the status must not claim otherwise (a
    // QUEUED status on the session that owns the slot also made "Отправить
    // сейчас" look like a second generation and refuse).
    if (this.activeTaskId === task.id && task.status === 'RUNNING') {
      task.updatedAt = now();
      await this.store.save(this.#publicTask(task));
      return;
    }
    if (task.queueReason === reason && task.status === 'QUEUED') return;
    if (task.status !== 'QUEUED') task.statusChangedAt = now();
    task.status = 'QUEUED';
    task.queueReason = reason;
    task.current = reason === 'MODEL_BUSY' ? 'Ждёт освобождения локальной модели'
      : reason === 'MODEL_LOADING' ? 'Ждёт загрузки локальной модели' : 'В очереди';
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#event(task, 'QUEUE_WAITING', task.current, { reason });
  }

  // A prompt accepted while the model was busy is sent here, unchanged.
  // Taking a prompt out of the queue must never lose it. `restore` puts it back in
  // front and makes the session wait again, so a failure (the model got busy in a
  // race, an RPC error) costs time, not the operator's text.
  async #takePending(task) {
    const [pending, ...rest] = task.pendingPrompts || [];
    if (!pending) throw Object.assign(new Error('Нет сообщения в очереди.'), { code: 'INPUT_INVALID' });
    task.pendingPrompts = rest;
    await this.store.save(this.#publicTask(task));
    return {
      pending,
      restore: async () => {
        task.pendingPrompts = [pending, ...(task.pendingPrompts || [])];
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
    if ((task.pendingPrompts || []).length && !this.queue.includes(task.id)) this.queue.push(task.id);
    try {
      const waiting = (await this.#getPendingFiles(task.id, pending.id)) || { files: [], uploadToken: null };
      await this.#message(task.id, pending.text, pending.mode || 'auto', waiting.files, waiting.uploadToken, { immediate: true, fromQueue: true, staged: pending.files || [] });
      await this.#deletePendingFiles(task.id, pending.id);
      return true;
    } catch (error) {
      // Never die silently inside the pump: explain the retry and keep the text.
      await this.#event(task, 'QUEUE_RETRY', `Не удалось отправить из очереди: ${error.message}. Сообщение осталось в очереди.`).catch(() => {});
      await restore();
      return false;
    }
  }


  async #pump() {
    // One pump at a time. Two overlapping pumps used to take two pending prompts
    // at once, so the queue could deliver them out of order (caught by
    // tests/queue-http.test.mjs).
    //
    // A wake-up that arrives during a pump (or while a session owns the machine)
    // must never be lost: it is remembered and acted on instead of dropped,
    // because the thing it would have started is a message an operator is
    // watching. Whatever stays in the queue keeps the poll timer armed, so the
    // queue is self-healing even if some future path forgets to call #pump.
    if (this.closing) return;
    if (this.pumping) { this.pumpAgain = true; return; }
    if (this.activeTaskId) { this.#schedulePump(); return; }
    if (this.queue.length === 0) return;
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        await this.#pumpOnce();
      } while (this.pumpAgain && !this.activeTaskId && this.queue.length);
    } finally {
      this.pumping = false;
      if (this.queue.length) this.#schedulePump();
    }
  }

  async #pumpOnce() {
    if (this.activeTaskId || this.queue.length === 0) return;
    // The first entry that can actually run — not simply the first entry. A
    // session waiting for a busy local model must not hold up one that needs a
    // remote model (or no model at all): that head-of-line block is what made a
    // queue look stuck long after the model had answered.
    let index = 0;
    let task = null;
    while (index < this.queue.length) {
      const candidate = this.tasks.get(this.queue[index]);
      if (!candidate || candidate.status === 'CANCELLED' || this.deleted.has(this.queue[index])) {
        this.queue.splice(index, 1);
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
    if (!task) { if (this.queue.length) this.#schedulePump(); return; }

    const id = this.queue[index];
    this.queue.splice(index, 1);
    task.queueReason = null;
    // A stored prompt is delivered through #message, which claims the slot
    // itself: the queue must not hold it meanwhile, nor release it afterwards.
    const delegating = Boolean(task.pendingPrompts?.length);
    this.activeTaskId = delegating ? null : id;
    let delivered = true;
    try {
      if (delegating) {
        // A delegating delivery claims its slot only inside #message, so this
        // flag is what tells sendPendingNow (see there) that the machine is
        // busy with a delivery activeTaskId cannot represent.
        this.dispatching = id;
        delivered = await this.#deliverPending(task);
      } else await this.#executeInitial(task);
    } finally {
      this.dispatching = null;
      if (!delegating && this.activeTaskId === id) this.activeTaskId = null;
      // A delivery that failed put the prompt back: retry on the timer instead
      // of spinning on it immediately.
      if (delivered) setImmediate(() => this.#pump());
      else this.#schedulePump();
    }
  }

  async #executeInitial(task) {
    if (this.closing) return;
    try {
      await this.#setStatus(task, 'PREPARING', 'Preparing workspace');
      const prepared = await this.#prepareWorkspace(task);
      if (task.status === 'CANCELLED' || this.deleted.has(task.id)) return;
      Object.assign(task, prepared);
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
      const baseline = await snapshotWorkspace(task.workspacePath);
      if (task.status === 'CANCELLED' || this.deleted.has(task.id) || this.runtimes.get(task.id)?.cancelRequested) {
        await pi.killTree();
        return;
      }
      const settled = this.#waitForSettle(task.id, 12 * 60 * 60 * 1000);
      settled.catch(() => {});
      try {
        await this.#setStatus(task, 'RUNNING', 'Pi starting');
        if (task.status === 'CANCELLED' || this.runtimes.get(task.id)?.cancelRequested) { this.#resolveSettle(task.id); return; }
        await pi.prompt(this.#buildPrompt(task));
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
      await this.#fail(task, error);
    } finally {
      delete task._incomingFiles;
    }
  }

  async #prepareWorkspace(task) {
    let prepared;
    if (task.projectId === '__scratch__') {
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
    let env = null;
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
        env = {
          TASKBRIDGE_APPROVAL_URL: this.approvalBaseUrl,
          TASKBRIDGE_TASK_ID: task.id,
          TASKBRIDGE_APPROVAL_TOKEN: token,
          TASKBRIDGE_APPROVAL_FAILSAFE: this.approvalsConfig.failsafe,
          TASKBRIDGE_APPROVAL_WAIT_MS: String(Math.max(1000, this.approvalsConfig.timeoutMinutes * 60000)),
          TASKBRIDGE_APPROVAL_POLL_MS: '1000'
        };
      }
    }
    const pi = new PiRpcSession({
      command: this.config.pi?.command || 'pi',
      args,
      cwd: task.workspacePath,
      env: this.#piEnv(),
      sessionDir,
      sessionName: `task-${task.id}`,
      sessionFile,
      persistSessions: this.config.pi?.persistSessions !== false,
      projectTrust: this.config.pi?.projectTrust || 'approve',
      env
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
      if (this.deleted.has(task.id)) return;
      runtime.eventChain = runtime.eventChain
        .then(() => this.#handlePiEvent(task, frame))
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
      runtime.eventChain = runtime.eventChain.then(() => this.#fail(task, error)).finally(() => this.#resolveSettle(task.id));
      runtime.eventChain.catch(() => {});
    });
    pi.on('close', ({ code, signal }) => {
      if (this.deleted.has(task.id) || runtime.cancelRequested) { this.#resolveSettle(task.id); return; }
      if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) {
        runtime.eventChain = runtime.eventChain.then(() => this.#fail(task, Object.assign(new Error(`Pi process exited unexpectedly: code=${code}, signal=${signal}`), { code: 'PI_SESSION_FAILED' }))).finally(() => this.#resolveSettle(task.id));
        runtime.eventChain.catch(() => {});
      }
    });

    await pi.start();
    return pi;
  }

  async #captureModelInfo(task, pi) {
    try {
      const state = await pi.getState();
      if (state?.sessionFile) task.piSessionFile = state.sessionFile;
      task.model = state?.model
        ? { id: state.model.id, provider: state.model.provider, contextWindow: state.model.contextWindow ?? null, maxTokens: state.model.maxTokens ?? null }
        : null;
      task.autoCompactionEnabled = state?.autoCompactionEnabled ?? null;
      task.thinkingLevelActual = state?.thinkingLevel ?? null;
      await this.store.save(this.#publicTask(task));
    } catch {}
  }

  // Lists the models Pi currently considers usable (all providers, not just the
  // local llama.cpp profiles). Refresh forces a fresh Pi probe.
  async listModels({ refresh = false } = {}) {
    return this.modelCatalog.list({ refresh });
  }

  // ---- local llama.cpp router (router mode) ----

  // `probeCatalog` is for the endpoint the user opens deliberately (the local
  // models dialog): the id Pi can serve is only knowable from Pi's own catalog,
  // and probing costs a short Pi start, so the polled /api/info must not do it.
  async localStatus({ probeCatalog = false } = {}) {
    if (probeCatalog && !this.modelCatalog.peek()) await this.modelCatalog.list().catch(() => {});
    // Advertise the id Pi can really serve: with the hand-written provider
    // renamed (e.g. "llamacpp") the configured one may no longer exist, and
    // selecting a model under a dead id makes Pi answer
    // "Provider is not configured".
    return { ...(await this.local.getStatus()), provider: this.#localProviderId() };
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

  async importMcp() {
    await this.mcp.importFromPi();
    return this.mcp.status();
  }

  async loadLocalModel(id) {
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
    if (!this.localModels.enabled) throw Object.assign(new Error('Router не настроен (localRuntime.router).'), { code: 'NOT_CONFIGURED' });
    await this.localModels.unloadModel(id);
    return this.localModels.getStatus();
  }

  async stopLocal() {
    if (!this.localModels.enabled) throw Object.assign(new Error('Router не настроен (localRuntime.router).'), { code: 'NOT_CONFIGURED' });
    return this.localModels.stop();
  }

  // Translates a raw file path or alias into the exact model id Pi lists in its
  // catalog (e.g. G:\...\Qwen3.8-27B-UD-Q3_K_XL.gguf -> qwen-27b-q3).
  async #resolvePiModelId(provider, modelId) {
    if (!modelId) return modelId;
    let known = this.modelCatalog.peek()?.models || [];
    if (!known.length) {
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
    const runtime = await this.#ensureSession(task);
    const state = await runtime.pi.getState().catch(() => null);
    if (state?.isStreaming || state?.isCompacting) throw Object.assign(new Error('Дождитесь завершения ответа перед сменой модели.'), { code: 'BUSY' });
    const targetModelId = await this.#resolvePiModelId(model.provider, model.id);
    const applied = await runtime.pi.setModel(model.provider, targetModelId).catch((error) => {
      throw Object.assign(new Error(`Pi не принял модель ${model.provider}/${targetModelId}: ${error.message}`), { code: 'MODEL_NOT_FOUND' });
    });
    task.requestedModel = { provider: model.provider, id: applied?.id || targetModelId };
    task.model = applied
      ? { id: applied.id, provider: applied.provider, contextWindow: applied.contextWindow ?? null, maxTokens: applied.maxTokens ?? null }
      : { id: targetModelId, provider: model.provider, contextWindow: null, maxTokens: null };
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
    const levels = this.modelCatalog.peek()?.thinkingLevels;
    if (Array.isArray(levels) && levels.length && !levels.includes(value)) {
      throw Object.assign(new Error(`Модель не поддерживает thinking level «${value}».`), { code: 'INPUT_INVALID' });
    }
    task.thinkingLevel = value;
    const runtime = this.runtimes.get(id);
    if (runtime && !runtime.pi.closed) {
      await runtime.pi.setThinkingLevel(value);
      task.thinkingLevelActual = value;
    }
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#event(task, 'THINKING_LEVEL', `Thinking level: ${value}`, { level: value });
    return this.#publicTask(task);
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

  async #handlePiEvent(task, frame) {
    if (this.deleted.has(task.id)) return;
    await this.store.appendRaw(task.id, 'pi-events.jsonl', JSON.stringify(frame) + '\n').catch(() => {});

    if (frame.type === 'message_update') {
      const delta = frame.assistantMessageEvent;
      if (delta?.type === 'text_delta' || delta?.type === 'thinking_delta') this.#trackStreamTime(task);
      if (delta?.type === 'text_delta') task.assistantText = appendTail(task.assistantText, delta.delta, TEXT_TAIL);
      if (delta?.type === 'thinking_delta') {
        task.thinkingText = appendTail(task.thinkingText, delta.delta, THINKING_TAIL);
        task.current = `Pi is thinking… (${task.thinkingText.length} chars)`;
      }
      if (frame.usage?.totalTokens > 0) task.lastUsage = frame.usage;
    }
    if (frame.type === 'tool_execution_start') {
      const arg = frame.args?.command || frame.args?.path || frame.args?.file_path || '';
      task.current = `${frame.toolName || 'tool'}${arg ? `: ${String(arg).slice(0, 160)}` : ''}`;
      if (frame.toolCallId) this.toolLogs.set(`${task.id}:${frame.toolCallId}`, { name: `tool-${safeFileName(frame.toolCallId)}.log`, bytes: 0 });
    }
    if (frame.type === 'tool_execution_update') {
      const chunk = frame.output ?? frame.partialResult ?? frame.delta ?? '';
      const log = frame.toolCallId ? this.toolLogs.get(`${task.id}:${frame.toolCallId}`) : null;
      if (log && chunk) {
        log.bytes += Buffer.byteLength(String(chunk), 'utf8');
        this.store.appendRaw(task.id, log.name, String(chunk)).catch(() => {});
      }
    }
    if (frame.type === 'tool_execution_end' && frame.toolCallId) {
      const key = `${task.id}:${frame.toolCallId}`;
      const log = this.toolLogs.get(key);
      if (log) this.store.writeArtifact(task.id, `${log.name}.meta.json`, JSON.stringify({ toolCallId: frame.toolCallId, toolName: frame.toolName ?? null, bytes: log.bytes, at: now() })).catch(() => {});
      this.toolLogs.delete(key);
    }
    if (['compaction_end', 'auto_compaction_end'].includes(frame.type) && frame.result) {
      task.compaction.count += 1;
      task.compaction.last = {
        reason: frame.reason,
        tokensBefore: frame.result.tokensBefore ?? null,
        estimatedTokensAfter: frame.result.estimatedTokensAfter ?? null,
        at: now()
      };
    }
    if (frame.type === 'agent_start') {
      task.status = 'RUNNING';
      task.current = 'Pi is working';
      task.updatedAt = now();
      await this.store.save(this.#publicTask(task));
    }
    if (frame.type === 'message_end' && frame.message?.role === 'assistant') {
      if (frame.message.usage?.totalTokens > 0) task.lastUsage = frame.message.usage;
      if (frame.message.stopReason === 'error') task._modelError = frame.message.errorMessage || 'Модель завершила ответ с ошибкой.';
      this.#recordGenerationSpeed(task);
    }
    if (frame.type === 'message_end' || frame.type === 'compaction_end' || frame.type === 'auto_compaction_end') {
      task.updatedAt = now();
      await this.store.save(this.#publicTask(task));
    }

    await this.#event(task, 'PI_EVENT', summarizePiEvent(frame), { pi: frame }, false);

    if (frame.type === 'message_end' && frame.message?.role === 'assistant') {
      await this.store.pruneStreamingDeltas(task.id).catch(() => {});
    }

    if (frame.type === 'agent_settled') this.#resolveSettle(task.id);
  }

  // Wall-clock time the model spent emitting deltas. Tool execution happens
  // between deltas as long pauses, so only short gaps are added: a 30 s `npm
  // test` in the middle of a turn must not be counted as generation time and
  // drag the reported TG down.
  #trackStreamTime(task) {
    const at = Date.now();
    task._genStreamMs = accumulateStreamMs(task._genLastDeltaAt, at, task._genStreamMs);
    task._genLastDeltaAt = at;
  }

  // TG from the model's own usage: output tokens over the time it actually
  // streamed them. Works for a cloud provider (the only speed it exposes) and
  // is a fallback for a local llama.cpp without --metrics. PP is not knowable
  // from a streaming response and is left to the llama.cpp /metrics source.
  #recordGenerationSpeed(task) {
    task._genLastDeltaAt = 0;
    const ms = task._genStreamMs || 0;
    task._genStreamMs = 0;
    const tg = computeTokensPerSecond(task.lastUsage?.output, ms);
    if (tg == null) return;
    task.metrics = { tg, outputTokens: Number(task.lastUsage.output), ms, source: 'usage' };
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
    return turn;
  }

  async #verifyAndFinalize(task, run = {}) {
    if (this.deleted.has(task.id) || task.status === 'CANCELLED') return;
    const runtime = this.runtimes.get(task.id);
    const turn = run.turn ?? null;
    // A newer turn already owns the session: this turn must not touch its state.
    if (turn != null && task._turn !== turn) return;
    if (task._modelError) return this.#fail(task, Object.assign(new Error(task._modelError), { code: 'MODEL_ERROR' }));
    await this.#setStatus(task, 'VERIFYING', 'Collecting diff and changed files');
    const gitState = await collectGitState(task.workspacePath);
    task.git = {
      isGit: gitState.isGit,
      status: gitState.status,
      changedFiles: gitState.changedFiles
    };
    await this.store.writeArtifact(task.id, 'diff.patch', gitState.diff || '');
    await this.store.writeArtifact(task.id, 'git-status.txt', gitState.status || '');

    const output = await captureOutputs(task, this.store.taskDir(task.id), run.baseline);
    task.outputFiles = [...(task.outputFiles || []), ...output.files];
    if (output.files.length || output.warnings.length) await this.#event(task, 'OUTPUT_FILES', output.warnings.join('\n'), output);

    if (this.deleted.has(task.id) || task.status === 'CANCELLED' || runtime?.cancelRequested) return;
    // Re-checked after the awaits: a newer turn may have started meanwhile.
    if (turn != null && task._turn !== turn) return;

    const commands = (this.projects.get(task.projectId)?.verification) || [];
    // The turn's outcome is decided by the MODEL, not by the project's checks.
    // A check that fails after a complete answer used to mark the whole task
    // FAILED and hide the answer; verification now runs detached below and only
    // updates `verification`/`verificationStatus`.
    task.verification = [];
    task.verificationStatus = commands.length ? 'RUNNING' : 'NOT_CONFIGURED';
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
    await this.#event(task, 'TASK_SUCCEEDED', task.current);
    await this.store.save(this.#publicTask(task));
    this.#finishRun(task, task.status);
    await this.#writeResult(task).catch(() => {});
    if (commands.length) this.#runVerification(task, commands, turn);
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
      throw Object.assign(new Error('Для этого вызова нет сохранённого вывода.'), { code: 'NOT_FOUND' });
    }
    const truncated = bytes > Buffer.byteLength(text, 'utf8');
    const payload = { toolCallId, text, bytes, truncated, at: now() };
    if (emit) await this.#event(task, 'TOOL_OUTPUT', `tool output: ${toolCallId}`, payload);
    return payload;
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
    const gitState = task.workspacePath ? await collectGitState(task.workspacePath).catch(() => null) : null;
    if (gitState) {
      task.git = { isGit: gitState.isGit, status: gitState.status, changedFiles: gitState.changedFiles };
      await this.store.writeArtifact(task.id, 'diff.patch', gitState.diff || '');
    }
    task.status = 'CANCELLED';
    task.current = 'Cancelled';
    task.updatedAt = now();
    // Event before the terminal status, same ordering rule as #verifyAndFinalize.
    await this.#event(task, 'TASK_CANCELLED', 'Task cancelled');
    await this.store.save(this.#publicTask(task));
    await this.#writeResult(task);
    this.#finishRun(task, 'CANCELLED');
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
    if (this.activeTaskId === id) this.activeTaskId = null;
    this.queue = this.queue.filter((x) => x !== id);
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
    await this.store.remove(id);
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
    if (!commandId) return this.#cancel(id);
    return this.#withCommand(commandId, opts && opts.clientId ? String(opts.clientId) : null, () => this.#payloadHash(id, 'cancel'), () => this.#cancel(id));
  }

  // "Repeat message": permanently removes the last failed exchange (the
  // user's message + the model's error/abort) from the history so the same
  // text can be sent again without a duplicate. Allowed only for the very
  // last turn, only in a FAILED/CANCELLED session, and only when the model
  // produced nothing (no text, no tools): otherwise its output would be lost
  // forever and the UI only offers copying the text instead.
  async undoLastTurn(id) {
    return this.#admit(() => this.#undoLastTurn(id));
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
    });
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
      const { fromSeq, dropInitial, mode } = this.#turnSequences(turnId);
      const events = await this.store.readEvents(id, 0);
      if (mode === 'seq' && !events.some(event => event.type === 'USER_MESSAGE' && event.seq === fromSeq)) {
        throw Object.assign(new Error('Сообщение не найдено в истории.'), { code: 'NOT_FOUND' });
      }
      await this.#truncateFrom(task, fromSeq, { dropInitial, reason: 'delete' });
      return { ok: true, fromSeq, dropInitial };
    });
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
    });
  }

  // Editing the operator's own message is "fix it and run again": the message
  // keeps its own place in the log (same event, same seq, corrected text), while
  // everything BELOW it — the answers, their tools, notes — is wiped, and the
  // edited text is put to the model as a fresh prompt. It is not an in-place
  // cosmetic correction: the old answer was produced for the old text.
  async editTurn(id, { turnId, text, branch = false }) {
    return this.#admit(() => this.#editTurn(id, turnId, text, branch));
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
    return this.#admit(() => this.#regenerateLastTurn(id, turnId));
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
    });
  }

  // "Continue": the existing answer is asked to go on. No new exchange and no
  // new variant is created — what the model writes next is appended to the same
  // answer (the client already renders a mid-answer continuation into the turn
  // it belongs to). Pi has no "continue" RPC, so the request is an explicit
  // instruction; unlike regenerate, nothing is dropped and no variant is made.
  async continueTurn(id, turnId) {
    return this.#admit(() => this.#continueTurn(id, turnId));
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
    const answer = this.#answerText(events, turnSeq);
    if (!String(answer).trim()) throw Object.assign(new Error('Продолжать нечего — ответ пуст.'), { code: 'INPUT_INVALID' });
    return this.#message(id, CONTINUE_PROMPT, 'auto', [], null, { immediate: true, announce: false });
  }

  // The newest answer's text of one exchange: the closing message_end carries
  // the full final content, so the last one wins.
  #answerText(events, turnSeq) {
    const seq = Number(turnSeq) || 0;
    let text = '';
    for (const event of events) {
      if (event.seq <= seq) continue;
      const frame = event.data?.pi;
      if (event.type === 'PI_EVENT' && frame?.type === 'message_end' && frame.message?.role === 'assistant') {
        text = (frame.message.content || []).filter(part => part?.type === 'text').map(part => part?.text || '').join('');
      }
    }
    return text;
  }

  // "Fork": a new session in the same project whose conversation is a copy of
  // this one through the chosen exchange. Nothing runs and no model is asked —
  // the copy is replayed by the client at once, and the fork's first message
  // rebuilds Pi's session file from those events (session-history.mjs), so the
  // branch keeps its context. The source is left untouched.
  async forkTask(id, turnId) {
    return this.#admit(() => this.#forkTask(id, turnId));
  }

  async #forkTask(id, turnId) {
    const source = this.#mutableTask(id);
    const events = await this.store.readEvents(id, 0);
    const boundary = this.#forkBoundary(events, turnId);
    const kept = events.filter(event => event.seq <= boundary);
    const task = {
      id: shortId(),
      createdAt: now(),
      updatedAt: now(),
      status: 'SUCCEEDED',
      queueReason: null,
      projectId: source.projectId,
      prompt: source.prompt,
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
      model: source.model,
      autoCompactionEnabled: null,
      files: [],
      attachments: [],
      outputFiles: [],
      forkedFrom: id
    };
    await this.store.create(task);
    this.tasks.set(task.id, task);
    for (const event of kept) await this.store.appendEvent(task.id, { ...event, taskId: task.id });
    await this.#event(task, 'TASK_FORKED', `Ветка сессии ${id}: перенесено ходов — ${kept.length}.`, { from: id, throughSeq: boundary });
    return this.#publicTask(task);
  }

  // Where a fork stops: the end of the chosen exchange. "user-<seq>" and
  // "assistant-<seq>" name the same exchange (the message that started it and
  // the answer it got), and the copy stops just before the next message in
  // either case — so it always ends on a settled answer, never on a question
  // nobody has asked yet.
  #forkBoundary(events, turnId) {
    const value = String(turnId || '');
    if (value === 'user-initial' || value === 'assistant-initial') {
      const first = events.find(event => event.type === 'USER_MESSAGE');
      return first ? first.seq - 1 : Number.MAX_SAFE_INTEGER;
    }
    const match = /^(?:user|assistant)-(\d+)$/.exec(value);
    if (!match) throw Object.assign(new Error('Ответвить можно только от сообщения или ответа.'), { code: 'INPUT_INVALID' });
    const fromSeq = Number(match[1]);
    if (!events.some(event => event.type === 'USER_MESSAGE' && event.seq === fromSeq)) {
      throw Object.assign(new Error('Ход не найден в истории.'), { code: 'NOT_FOUND' });
    }
    const next = events.find(event => event.type === 'USER_MESSAGE' && event.seq > fromSeq);
    return next ? next.seq - 1 : Number.MAX_SAFE_INTEGER;
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

  async #cancel(id, { keepPending = false } = {}) {
    const task = this.tasks.get(id);
    const runtime = this.runtimes.get(id);
    if (!task) throw Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' });
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return this.#publicTask(task);
    // A queued prompt is dropped with the task, on either cancel path — unless
    // the cancel is only interrupting a generation (Ctrl+Enter / «Отправить
    // сейчас»), where the operator's queue must survive.
    if (keepPending) {
      if ((task.pendingPrompts || []).length && !this.queue.includes(id)) this.queue.push(id);
    } else {
      await this.#releasePendingFiles(id, task.pendingPrompts);
      task.pendingPrompts = null;
      task.queueReason = null;
      this.queue = this.queue.filter(x => x !== id);
    }
    if (!runtime) {
      task.status = 'CANCELLED';
      task.current = 'Cancelled';
      await this.store.save(this.#publicTask(task));
      await this.#event(task, 'TASK_CANCELLED', 'Task cancelled');
      return this.#publicTask(task);
    }
    runtime.cancelRequested = true;
    this.approvals.cancelTask(id);
    await this.#setStatus(task, 'CANCELLING', 'Stopping Pi');
    try {
      await runtime.pi.abort(this.config.pi?.abortTimeoutMs || 10000);
    } catch (error) {
      await this.#event(task, 'ABORT_TIMEOUT', `RPC abort failed: ${error.message}. Killing process tree.`);
      await runtime.pi.killTree();
    }
    await runtime.eventChain.catch(() => {});
    this.#resolveSettle(id);
    await this.#finalizeCancelled(task);
    if (this.activeTaskId === id) this.activeTaskId = null;
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
    // Ctrl+Enter («вклиниться сразу»): the text must reach the model now, not
    // after the reasoning block in flight ends, so the generation is stopped
    // first (see #interruptGeneration).
    const send = async () => {
      if (opts.now === true) await this.#interruptGeneration(id);
      return this.#message(id, text, mode, files, uploadToken, { immediate: opts.now === true, queue: opts.queue === true });
    };
    if (!commandId) return this.#admit(send);
    return this.#withCommand(
      commandId,
      opts && opts.clientId ? String(opts.clientId) : null,
      () => this.#payloadHash(id, text, mode, files, uploadToken),
      () => this.#admit(send),
    );
  }

  // "Send now" has to beat a long reasoning block AND a long command: Pi injects
  // a steer only between messages, so text sent while the turn is in flight
  // would sit until that turn ends — and with a `bash` tool running that can be
  // minutes, during which the operator's message is not answered. Stopping the
  // turn makes the operator's message the very next thing Pi sees.
  //
  // A tool call in flight is stopped along with the turn: Pi hands the agent's
  // abort signal to the bash tool, which kills the whole process tree on abort
  // (pi-ai dist/core/tools/bash.js), so the command dies with the turn. That is
  // the deliberate trade of «Отправить сейчас» — an explicit operator decision,
  // half-applied side effects included — and the reason the queue survives while
  // the turn does not (see #cancel's keepPending).
  //
  // Pi keeps `isStreaming` true for the whole agent run (tools included), so it
  // alone answers "is there anything to stop".
  async #interruptGeneration(id) {
    const live = this.runtimes.get(id);
    if (!live || live.pi.closed || !this.tasks.get(id)) return false;
    const state = await live.pi.getState().catch(() => null);
    if (!state?.isStreaming) return false;
    // The prompts already queued for this session survive the interrupt: the
    // operator asked to cut in, not to drop their queue.
    await this.#cancel(id, { keepPending: true });
    return true;
  }

  // Returns an idempotency guard around `fn`. If `commandId` is new it records
  // ACCEPTED in SQLite *before* running (so a crash mid-run is durable), runs
  // `fn`, and stores the outcome. A repeat of a finished command replays the
  // saved result; a repeat of one still in flight is refused as ACCEPTED; the
  // same id with different content is a CONFLICT; an id recorded ACCEPTED but
  // never finished (a prior process crashed) is UNKNOWN_AFTER_CRASH — never
  // re-run silently. The in-memory map is only a cache + in-flight tracker;
  // SQLite is the source of truth across restarts.
  async #withCommand(commandId, clientId, hashOf, fn) {
    if (!hashOf) throw new Error('internal: hashOf required');
    this.#evictCommands();
    const hash = hashOf();
    let entry = this.commandLedger.get(commandId);
    if (!entry) {
      // Durable lookup: a finished command from a previous process replays, and
      // an ACCEPTED-but-unfinished id is a possible crash.
      const stored = this.store.getCommand(commandId);
      if (stored) {
        if (stored.hash !== hash) {
          throw Object.assign(new Error('Команда уже принималась с другим содержимым.'), { code: 'CONFLICT' });
        }
        if (stored.done) {
          const status = stored.status || (stored.result != null ? 'COMPLETED' : 'REJECTED');
          this.commandLedger.set(commandId, { hash, done: true, result: stored.result, at: stored.at, clientId: stored.clientId, status });
          return stored.result;
        }
        this.commandLedger.set(commandId, { hash, done: false, result: null, at: stored.at, clientId: stored.clientId, status: 'UNKNOWN_AFTER_CRASH' });
        throw Object.assign(new Error('Исход команды неизвестен после перезапуска — отправьте её заново с новым commandId.'), { code: 'UNKNOWN_AFTER_CRASH' });
      }
    } else {
      if (entry.hash !== hash) {
        throw Object.assign(new Error('Команда уже принималась с другим содержимым.'), { code: 'CONFLICT' });
      }
      if (entry.done) return entry.result;
      throw Object.assign(new Error('Команда уже выполняется.'), { code: entry.status === 'UNKNOWN_AFTER_CRASH' ? 'UNKNOWN_AFTER_CRASH' : 'ACCEPTED' });
    }
    // New command: persist ACCEPTED before running, so we cannot lose track of a
    // command that crashed mid-run. If we cannot record it we must not run it.
    try {
      this.store.upsertCommand(commandId, { hash, done: false, clientId, status: 'ACCEPTED' });
    } catch (error) {
      throw Object.assign(new Error('Не удалось зафиксировать команду: ' + (error?.message || error)), { code: 'COMMAND_LEDGER_FAILED' });
    }
    this.commandLedger.set(commandId, { hash, done: false, result: null, at: Date.now(), clientId, status: 'ACCEPTED' });
    try {
      const e = this.commandLedger.get(commandId);
      if (e) e.status = 'DISPATCHING';
      try { this.store.upsertCommand(commandId, { hash, done: false, clientId, status: 'DISPATCHING' }); } catch {}
      const result = await fn();
      const f = this.commandLedger.get(commandId);
      if (f) { f.done = true; f.result = result; f.status = 'COMPLETED'; }
      try { this.store.upsertCommand(commandId, { hash, done: true, result, clientId, status: 'COMPLETED' }); } catch {}
      return result;
    } catch (error) {
      const g = this.commandLedger.get(commandId);
      if (g) { g.done = true; g.result = null; g.status = 'REJECTED'; }
      try { this.store.upsertCommand(commandId, { hash, done: true, result: null, clientId, status: 'REJECTED' }); } catch {}
      throw error;
    }
  }

  // Command-status contract (TZ stage 3): ACCEPTED / DISPATCHING / COMPLETED /
  // REJECTED / UNKNOWN_AFTER_CRASH, plus the client that issued it. Read-only;
  // does not change the live command response shape.
  commandStatus(commandId) {
    const key = String(commandId);
    const e = this.commandLedger.get(key);
    if (e) return { commandId: key, status: e.status || (e.done ? 'COMPLETED' : 'DISPATCHING'), done: e.done, at: e.at, clientId: e.clientId || null };
    const stored = this.store.getCommand(key);
    if (!stored) return null;
    return {
      commandId: key,
      status: stored.status || (stored.done ? (stored.result != null ? 'COMPLETED' : 'REJECTED') : 'UNKNOWN_AFTER_CRASH'),
      done: stored.done,
      at: stored.at,
      clientId: stored.clientId || null,
    };
  }


  #payloadHash(...args) {
    return crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
  }

  #evictCommands() {
    const now = Date.now();
    if (this.commandLedger.size >= 2) {
      const ttl = 24 * 60 * 60 * 1000;
      for (const [k, v] of this.commandLedger) if (now - v.at > ttl) this.commandLedger.delete(k);
    }
    // Hard ceiling for the in-memory cache: SQLite remains the source of
    // truth, so a resolved entry is safe to drop. In-flight entries (done:false)
    // are never evicted here — a replay of a command that is being executed
    // must keep seeing ACCEPTED.
    const maxCommands = 1000;
    if (this.commandLedger.size > maxCommands) {
      const removable = [...this.commandLedger.entries()]
        .filter(([, v]) => v.done)
        .sort((a, b) => a[1].at - b[1].at);
      const excess = this.commandLedger.size - maxCommands;
      for (let i = 0; i < Math.min(excess, removable.length); i++) this.commandLedger.delete(removable[i][0]);
    }
    // Prune resolved rows from SQLite at most hourly (in-flight rows survive to
    // mark a possible crash).
    if (!this._lastDbCommandPrune || now - this._lastDbCommandPrune > 60 * 60 * 1000) {
      this._lastDbCommandPrune = now;
      try { this.store.pruneCommands(24 * 60 * 60 * 1000); } catch {}
    }
  }

  // A prompt the operator decided not to wait for: it is handed to Pi right
  // away (Pi/llama.cpp decide how to fit it into the running turn), bypassing
  // the local queue.
  async sendPendingNow(id) {
    return this.#admit(async () => {
      const task = this.tasks.get(id);
      if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      // Check first: "сейчас" cannot mean a second generation in parallel, and a
      // refusal must leave the prompt where it was. The pump may be delivering
      // another session's queued prompt right now (a delegating delivery claims
      // its slot only inside #message, so activeTaskId alone cannot see it) —
      // "сейчас" must not cut into a delivery in flight either.
      if (this.activeTaskId && this.activeTaskId !== id) {
        const owner = this.tasks.get(this.activeTaskId);
        throw Object.assign(
          new Error(`Машина занята сессией «${owner?.title || this.activeTaskId}» — сначала остановите её.`),
          { code: 'BUSY' });
      }
      if (this.dispatching) {
        throw Object.assign(new Error('Очередь доставляет сообщение прямо сейчас — повторите через мгновение.'), { code: 'BUSY' });
      }
      // Like Ctrl+Enter, "сейчас" is allowed to try even when the model looks
      // busy (the flag can be stale): if the attempt fails, `restore` below puts
      // the prompt back at the front of the queue. A generation in flight is
      // stopped first, so the message is not queued behind the model's current
      // reasoning block.
      // "Сейчас" must not sit behind the model's current reasoning block, so a
      // generation in flight is stopped before the queue is touched.
      await this.#interruptGeneration(id).catch(() => false);
      // The pump may have already taken (or delivered) the only queued prompt by
      // now: «Отправить сейчас» clicked right after Enter. An empty queue here is
      // not an error — the message is already on its way, and the operator must
      // not see «Нет сообщения в очереди» for a text that was sent.
      if (!(task.pendingPrompts || []).length) {
        this.queue = this.queue.filter(x => x !== id);
        return this.#publicTask(task);
      }
      let pending, restore;
      try {
        ({ pending, restore } = await this.#takePending(task));
      } catch (error) {
        if (error.code === 'INPUT_INVALID') {
          // Lost the race with the pump: the prompt was taken and is being
          // delivered right now.
          this.queue = this.queue.filter(x => x !== id);
          return this.#publicTask(task);
        }
        throw error;
      }
      if (!(task.pendingPrompts || []).length) this.queue = this.queue.filter(x => x !== id);
      try {
        const waiting = (await this.#getPendingFiles(id, pending.id)) || { files: [], uploadToken: null };
        const result = await this.#message(id, pending.text, pending.mode || 'auto', waiting.files, waiting.uploadToken, { immediate: true, fromQueue: true, staged: pending.files || [] });
        await this.#deletePendingFiles(id, pending.id);
        return result;
      } catch (error) {
        await restore().catch(() => {});
        throw error;
      }
    });
  }

  // Removing a queued prompt leaves the session as it was: a session that never
  // ran is cancelled, an existing one simply loses the pending message.
  async dropPending(id) {
    return this.#admit(async () => {
      const task = this.tasks.get(id);
      if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const [dropped, ...rest] = task.pendingPrompts || [];
      if (!dropped) throw Object.assign(new Error('Нет сообщения в очереди.'), { code: 'INPUT_INVALID' });
      await this.#releasePendingFiles(id, [dropped]);
      task.pendingPrompts = rest;
      if (rest.length) { await this.store.save(this.#publicTask(task)); return this.#publicTask(task); }
      task.queueReason = null;
      this.queue = this.queue.filter(x => x !== id);
      if (!task.workspacePath) {
        task.status = 'CANCELLED';
        task.current = 'Cancelled';
        task.updatedAt = now();
        // Terminal event before terminal status is readable (same ordering rule
        // as #verifyAndFinalize and #fail).
        await this.#event(task, 'TASK_CANCELLED', 'Queued prompt removed');
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
    });
  }

  async #message(id, text, mode, files, uploadToken, { immediate = false, queue = false, fromQueue = false, staged = [], announce = true } = {}) {
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
    const reservedElsewhere = Boolean(this.activeTaskId)
      && (this.activeTaskId !== id || (!alreadyFinished && task.status !== 'RUNNING'));
    const incomingFiles = await this.#resolveFiles(files, uploadToken);
    const userText = String(text || '').trim() || (incomingFiles.length ? 'Прикреплённые файлы' : '');
    if (!userText) throw Object.assign(new Error('Добавьте сообщение или файл.'), { code: 'INPUT_INVALID' });
    if (!['auto', 'prompt', 'steer', 'follow_up'].includes(mode)) throw Object.assign(new Error('Неизвестный режим сообщения.'), { code: 'INPUT_INVALID' });
    // The queue decision happens BEFORE any session is started: asking
    // #ensureSession first would fail with "модель занята" on a busy runtime, and
    // the prompt would never reach the queue.
    const live = this.runtimes.get(id);
    const liveState = live && !live.pi.closed ? await live.pi.getState().catch(() => null) : null;
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
      task.pendingPrompts = [...(task.pendingPrompts || []), { id: pendingId, text: userText + note, mode, files: attached.map(metadata) }];
      task.updatedAt = now();
      await this.#markWaiting(task, reservedElsewhere ? 'BUSY' : (holdingModel ? 'MODEL_BUSY' : (coldModel ? 'MODEL_LOADING' : 'QUEUED')));
      if (!this.queue.includes(id)) this.queue.push(id);
      // Straight away, so a session that is idle does not wait for the retry tick.
      setImmediate(() => this.#pump());
      return this.#publicTask(task);
    }
    // Nothing is queued: start (or reuse) the session and deliver the prompt.
    if (this.#usesLocalRuntime(task) && !(await this.local.isReady())) await this.local.ensureRunning();
    const runtime = await this.#ensureSession(task);
    const state = await runtime.pi.getState();
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
    const effectiveMode = mode === 'auto' ? (streaming ? 'steer' : 'prompt') : mode;
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
      this.activeTaskId = id;
      turn = this.#beginTurn(task);
      settled = this.#waitForSettle(id, 12 * 60 * 60 * 1000);
      settled.catch(() => {});
    }
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
      if (announce) await this.#event(task, 'USER_MESSAGE', userText, { text: userText, mode: effectiveMode, files: attached });
      if (!streaming) await this.#setStatus(task, 'RUNNING', 'Follow-up sent to Pi');
      else await this.#setStatus(task, 'RUNNING', 'Сообщение вклинилось в текущий ответ');
      // Release gate immediately after USER_MESSAGE is safely persisted so the
      // HTTP response returns to client without waiting for subsequent background ticks.
      release();
    } catch (error) {
      if (!accepted && !staged.length) await rollbackFiles(task, this.store.taskDir(id), attached);
      if (!streaming) {
        this.#resolveSettle(id);
        if (this.activeTaskId === id) this.activeTaskId = null;
      }
      throw error;
    } finally { release(); }
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
          if (this.activeTaskId === id && task._turn === turn) this.activeTaskId = null;
          this.#pump();
        }
      })().catch(error => console.error(error));
    }
    return this.#publicTask(task);
  }

  async compact(id, instructions = '') {
    return this.#admit(() => this.#compact(id, instructions));
  }

  async #compact(id, instructions) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' });
    const runtime = await this.#ensureSession(task);
    if (this.activeTaskId || (await runtime.pi.getState())?.isStreaming) throw Object.assign(new Error('Дождитесь завершения ответа перед сжатием контекста.'), { code: 'BUSY' });
    if (this.#usesLocalRuntime(task) && (await this.local.getBusyStatus()).busy) throw Object.assign(new Error('Локальная модель сейчас занята другим запросом.'), { code: 'MODEL_BUSY' });
    await this.#event(task, 'COMPACT_REQUESTED', 'Manual compaction requested');
    const response = await runtime.pi.compact(String(instructions || ''));
    return response.data || null;
  }

  async #ensureSession(task) {
    const current = this.runtimes.get(task.id);
    if (current && !current.pi.closed) return current;
    if (this.#usesLocalRuntime(task) && (await this.local.getBusyStatus()).busy) throw Object.assign(new Error('Локальная модель сейчас занята другим запросом. Повторите чуть позже.'), { code: 'MODEL_BUSY' });
    if (!task.workspacePath) {
      Object.assign(task, await this.#prepareWorkspace(task));
    }
    await fs.access(task.workspacePath);
    if (task.nativeSession && !task._nativeLease) task._nativeLease = await acquireNativeLease(task);
    const sessionFile = await restoreSessionFile(task, this.store, this.dataRoot);
    const autoCompaction = task.autoCompactionEnabled;
    const pi = await this.#createPi(task, sessionFile);
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
    if (!runtime) return null;
    return runtime.pi.getState();
  }

  async #setStatus(task, status, current) {
    if (this.closing) return;
    if (this.deleted.has(task.id)) return;
    // The UI shows "работает 12 с", so the moment of the transition matters.
    if (task.status !== status) task.statusChangedAt = now();
    // Best-effort run ledger (stage 2): one run per RUNNING stint. Never lets
    // telemetry failure affect execution.
    if (status === 'RUNNING' && task.status !== 'RUNNING') this.#startRun(task);
    else if (RUN_TERMINAL.has(status)) this.#finishRun(task, status);
    task.status = status;
    task.current = current;
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#event(task, 'STATUS', current, { status }, false);
  }

  // --- run ledger (stage 2, best-effort telemetry) -------------------------
  #startRun(task) {
    const id = crypto.randomUUID();
    this.openRuns.set(task.id, id);
    try {
      this.store.recordRun({ id, taskId: task.id, sessionId: task.id, kind: 'prompt', status: 'RUNNING', startedAt: new Date().toISOString() });
    } catch { /* telemetry only */ }
  }

  #finishRun(task, status) {
    const id = this.openRuns.get(task.id);
    if (!id) return;
    this.openRuns.delete(task.id);
    try {
      this.store.recordRun({ id, taskId: task.id, sessionId: task.id, kind: 'prompt', status, finishedAt: new Date().toISOString() });
    } catch { /* telemetry only */ }
  }

  // Runs recorded for a task, newest first (read-only; stage 2).
  listRuns(taskId, limit = 50) {
    try { return this.store.listRuns(taskId, limit); } catch { return []; }
  }

  async #fail(task, error) {
    if (task.status === 'CANCELLED' || this.deleted.has(task.id)) return;
    const classified = classifyEngineError(error) || classifyEngineError(task._modelError);
    const explicit = error?.code && !['MODEL_ERROR', 'INTERNAL_ERROR'].includes(error.code) ? error.code : null;
    task.status = 'FAILED';
    task.errorCode = explicit || classified?.code || error?.code || 'INTERNAL_ERROR';
    task.retryable = classified ? classified.retryable : null;
    task.retryAfterMs = classified?.retryAfterMs ?? null;
    // Store a readable line, not the provider's raw JSON body: this text goes to
    // the UI, result.md and push notifications. Classification above still ran
    // against the untouched error.
    task.error = humanizeError(error.message || String(error));
    task.current = 'Failed';
    task.updatedAt = now();
    // Publish the event before the failed status is observable (see
    // #verifyAndFinalize): a late TASK_FAILED broke the "no events after a
    // terminal status" contract the client relies on.
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
    const event = { at: now(), taskId: task.id, type, message, data };
    if (seq === null) await this.store.appendEvent(task.id, event);
    else await this.store.appendEventAt(task.id, seq, event);
    if (persistTask) {
      task.updatedAt = event.at;
      await this.store.save(this.#publicTask(task)).catch(() => {});
    }
    this.emit('task-event', event);
    return event;
  }
}
