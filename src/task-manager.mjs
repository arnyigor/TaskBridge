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
import { chooseEngine, usesLocalRuntime, resolveRouterModel, resolveLocalProviderId } from './dispatcher.mjs';
import { ModelCatalog } from './model-catalog.mjs';
import { LocalModelService } from './local-models.mjs';
import { McpManager, MCP_MODES } from './mcp-manager.mjs';
import { TEXT_TAIL, THINKING_TAIL, tailText, appendTail } from './text-tail.mjs';
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
    // Files of prompts queued before their workspace existed: raw input kept in
    // memory only, never written into the task record where every save would
    // carry them.
    this.pendingFiles = new Map();
    // capacity 1: a task that cannot start yet (local model busy) is kept in
    // the queue and retried, instead of rejecting the operator's prompt.
    this.queuePollMs = Number(config.queue?.pollMs) > 0 ? Number(config.queue.pollMs) : 1000;
    this.pumpTimer = null;
    this.pumpAgain = false;
    this.admitting = false;
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
    return Array.from(this.tasks.values()).map(t => this.#publicTask(t)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
    return this.#admit(() => this.#createTask(input, options));
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
    const { _incomingFiles, _modelError, _baseline, _nativeLease, _uploadToken, ...safe } = task;
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
    task.current = reason === 'MODEL_BUSY' ? 'Ждёт освобождения локальной модели' : 'В очереди';
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

  // A queued prompt that never ran releases the files that were waiting with it.
  #releasePendingFiles(prompts) {
    for (const prompt of prompts || []) {
      const waiting = this.pendingFiles.get(prompt?.id);
      if (!waiting) continue;
      this.pendingFiles.delete(prompt.id);
      if (waiting.uploadToken) this.uploads.discard(waiting.uploadToken).catch(() => {});
    }
  }

  async #deliverPending(task) {
    const { pending, restore } = await this.#takePending(task);
    // The next prompt waits for this turn to end, which is what capacity 1 means.
    if ((task.pendingPrompts || []).length && !this.queue.includes(task.id)) this.queue.push(task.id);
    try {
      const waiting = this.pendingFiles.get(pending.id) || { files: [], uploadToken: null };
      await this.#message(task.id, pending.text, pending.mode || 'auto', waiting.files, waiting.uploadToken, { immediate: true, fromQueue: true, staged: pending.files || [] });
      this.pendingFiles.delete(pending.id);
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
      if (delegating) delivered = await this.#deliverPending(task);
      else await this.#executeInitial(task);
    } finally {
      if (!delegating && this.activeTaskId === id) this.activeTaskId = null;
      // A delivery that failed put the prompt back: retry on the timer instead
      // of spinning on it immediately.
      if (delivered) setImmediate(() => this.#pump());
      else this.#schedulePump();
    }
  }

  async #executeInitial(task) {
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
      task._baseline = await snapshotWorkspace(task.workspacePath);
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
        await this.#verifyAndFinalize(task);
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
      verifying: false,
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
    const applied = await runtime.pi.setModel(model.provider, model.id).catch((error) => {
      throw Object.assign(new Error(`Pi не принял модель ${model.provider}/${model.id}: ${error.message}`), { code: 'MODEL_NOT_FOUND' });
    });
    task.requestedModel = model;
    task.model = applied
      ? { id: applied.id, provider: applied.provider, contextWindow: applied.contextWindow ?? null, maxTokens: applied.maxTokens ?? null }
      : { id: model.id, provider: model.provider, contextWindow: null, maxTokens: null };
    const nextState = await runtime.pi.getState().catch(() => null);
    task.thinkingLevelActual = nextState?.thinkingLevel ?? task.thinkingLevelActual ?? null;
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#event(task, 'MODEL_SWITCH', `Модель: ${model.provider}/${model.id}`, { provider: model.provider, modelId: model.id });
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

  async #verifyAndFinalize(task) {
    if (this.deleted.has(task.id) || task.status === 'CANCELLED') return;
    if (task._modelError) return this.#fail(task, Object.assign(new Error(task._modelError), { code: 'MODEL_ERROR' }));
    const runtime = this.runtimes.get(task.id);
    if (runtime?.verifying) return;
    if (runtime) runtime.verifying = true;
    try {
      await this.#setStatus(task, 'VERIFYING', 'Collecting diff and running verification');
      const gitState = await collectGitState(task.workspacePath);
      task.git = {
        isGit: gitState.isGit,
        status: gitState.status,
        changedFiles: gitState.changedFiles
      };
      await this.store.writeArtifact(task.id, 'diff.patch', gitState.diff || '');
      await this.store.writeArtifact(task.id, 'git-status.txt', gitState.status || '');

      const project = this.projects.get(task.projectId);
      const commands = project?.verification || [];
      const verification = await runVerification(commands, task.workspacePath, (result) => {
        const text = `\n$ ${result.command}\n${result.stdout || ''}\n${result.stderr || ''}\n`;
        this.store.appendRaw(task.id, 'verification.log', text).catch(() => {});
      });
      if (this.deleted.has(task.id) || task.status === 'CANCELLED' || runtime?.cancelRequested) return;
      task.verification = verification;
      const output = await captureOutputs(task, this.store.taskDir(task.id), task._baseline);
      task.outputFiles = [...(task.outputFiles || []), ...output.files];
      if (output.files.length || output.warnings.length) await this.#event(task, 'OUTPUT_FILES', output.warnings.join('\n'), output);
      delete task._baseline;
      task.verificationStatus = commands.length ? (verification.some(x => !x.ok) ? 'FAILED' : 'PASSED') : 'NOT_CONFIGURED';

      const failed = verification.some((x) => !x.ok);
      task.status = failed ? 'FAILED' : 'SUCCEEDED';
      task.errorCode = failed ? 'VERIFICATION_FAILED' : null;
      task.error = failed ? 'One or more verification commands failed.' : null;
      if (!failed) { task.retryable = null; task.retryAfterMs = null; }
      task.current = failed ? 'Verification failed' : 'Done';
      task.updatedAt = now();
      await this.store.save(this.#publicTask(task));
      await this.#writeResult(task);
      await this.#event(task, failed ? 'TASK_FAILED' : 'TASK_SUCCEEDED', task.current);
    } finally {
      if (runtime) runtime.verifying = false;
    }
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

  async #finalizeCancelled(task) {
    const runtime = this.runtimes.get(task.id);
    if (runtime?.cancelFinalizing) return runtime.cancelFinalizing;
    const pending = this.#writeCancelled(task);
    if (runtime) runtime.cancelFinalizing = pending;
    return pending;
  }

  async #writeCancelled(task) {
    if (this.deleted.has(task.id) || task.status === 'CANCELLED') return;
    const gitState = task.workspacePath ? await collectGitState(task.workspacePath).catch(() => null) : null;
    if (gitState) {
      task.git = { isGit: gitState.isGit, status: gitState.status, changedFiles: gitState.changedFiles };
      await this.store.writeArtifact(task.id, 'diff.patch', gitState.diff || '');
    }
    task.status = 'CANCELLED';
    task.current = 'Cancelled';
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#writeResult(task);
    await this.#event(task, 'TASK_CANCELLED', 'Task cancelled');
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
  async applyTask(id, { force = false } = {}) {
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

  async cancel(id) {
    const task = this.tasks.get(id);
    const runtime = this.runtimes.get(id);
    if (!task) throw Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' });
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return this.#publicTask(task);
    // A queued prompt is dropped with the task, on either cancel path.
    this.#releasePendingFiles(task.pendingPrompts);
    task.pendingPrompts = null;
    task.queueReason = null;
    this.queue = this.queue.filter(x => x !== id);
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
  async message(id, text, mode = 'auto', files = [], uploadToken = null, { now: immediate = false, queue = false } = {}) {
    return this.#admit(() => this.#message(id, text, mode, files, uploadToken, { immediate, queue }));
  }

  // A prompt the operator decided not to wait for: it is handed to Pi right
  // away (Pi/llama.cpp decide how to fit it into the running turn), bypassing
  // the local queue.
  async sendPendingNow(id) {
    return this.#admit(async () => {
      const task = this.tasks.get(id);
      if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      // Check first: "сейчас" cannot mean a second generation in parallel, and a
      // refusal must leave the prompt where it was.
      if (this.activeTaskId && this.activeTaskId !== id) {
        const owner = this.tasks.get(this.activeTaskId);
        throw Object.assign(
          new Error(`Машина занята сессией «${owner?.title || this.activeTaskId}» — сначала остановите её.`),
          { code: 'BUSY' });
      }
      // Like Ctrl+Enter, "сейчас" is allowed to try even when the model looks
      // busy (the flag can be stale): if the attempt fails, `restore` below puts
      // the prompt back at the front of the queue.
      const { pending, restore } = await this.#takePending(task);
      if (!(task.pendingPrompts || []).length) this.queue = this.queue.filter(x => x !== id);
      try {
        const waiting = this.pendingFiles.get(pending.id) || { files: [], uploadToken: null };
        const result = await this.#message(id, pending.text, pending.mode || 'auto', waiting.files, waiting.uploadToken, { immediate: true, fromQueue: true, staged: pending.files || [] });
        this.pendingFiles.delete(pending.id);
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
      this.#releasePendingFiles([dropped]);
      task.pendingPrompts = rest;
      if (rest.length) { await this.store.save(this.#publicTask(task)); return this.#publicTask(task); }
      task.queueReason = null;
      this.queue = this.queue.filter(x => x !== id);
      if (!task.workspacePath) {
        task.status = 'CANCELLED';
        task.current = 'Cancelled';
        await this.store.save(this.#publicTask(task));
        await this.#event(task, 'TASK_CANCELLED', 'Queued prompt removed');
      } else {
        task.status = 'SUCCEEDED';
        task.current = 'Сообщение убрано из очереди';
        await this.store.save(this.#publicTask(task));
        await this.#event(task, 'QUEUE_DROPPED', task.current);
      }
      return this.#publicTask(task);
    });
  }

  async #message(id, text, mode, files, uploadToken, { immediate = false, queue = false, fromQueue = false, staged = [] } = {}) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    // A task that already reached a terminal state may start a new turn even if
    // the queue slot has not been released yet (the finalizer clears it on the
    // next tick). Otherwise a follow-up sent right after completion — e.g. a
    // remote FOLLOW_UP arriving with the task_finished event — would be refused.
    const alreadyFinished = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status);
    // The machine runs one generation at a time. If another session owns it (or
    // this one is still preparing), the prompt waits its turn — the operator
    // never loses the text to a "модель занята" refusal.
    const reservedElsewhere = Boolean(this.activeTaskId) && (this.activeTaskId !== id || task.status !== 'RUNNING');
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
    const holdingModel = !immediate && !liveStreaming && this.#usesLocalRuntime(task)
      && (await this.local.getBusyStatus()).busy;
    // `queue` means "wait your turn instead of interrupting", not "always park".
    // A session that is idle right now takes the prompt immediately: parking it
    // made every Enter flash "В очереди" and put an idle chat at the mercy of
    // the next pump tick.
    const waitForTurn = queue && liveStreaming;
    if (waitForTurn || reservedElsewhere || holdingModel) {
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
      if (!stageNow && ((files || []).length || uploadToken)) this.pendingFiles.set(pendingId, { files: files || [], uploadToken: uploadToken || null });
      const note = attached.length
        ? '\n\nAdditional files from the phone are in .taskbridge-input/:\n' + attached.map(f => `- ${f.path}`).join('\n')
        : '';
      // Several messages may wait for one session; they are delivered in order.
      // The files are staged already; the delivered turn must carry them too,
      // otherwise the chat shows a raw .taskbridge-input path instead of the
      // file the operator attached.
      task.pendingPrompts = [...(task.pendingPrompts || []), { id: pendingId, text: userText + note, mode, files: attached.map(metadata) }];
      task.updatedAt = now();
      await this.#markWaiting(task, reservedElsewhere ? 'BUSY' : (holdingModel ? 'MODEL_BUSY' : 'QUEUED'));
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
    if (!streaming) task._baseline = await snapshotWorkspace(task.workspacePath);
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
    if (!streaming) {
      this.activeTaskId = id;
      runtime.cancelRequested = false;
      runtime.cancelFinalizing = null;
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
      await this.#event(task, 'USER_MESSAGE', userText, { text: userText, mode: effectiveMode, files: attached });
      if (!streaming) await this.#setStatus(task, 'RUNNING', 'Follow-up sent to Pi');
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
          if (!runtime.cancelRequested && !['CANCELLED', 'FAILED'].includes(task.status)) await this.#verifyAndFinalize(task);
        } catch (error) { await this.#fail(task, error); }
        finally { if (this.activeTaskId === id) this.activeTaskId = null; this.#pump(); }
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
    if (this.deleted.has(task.id)) return;
    // The UI shows "работает 12 с", so the moment of the transition matters.
    if (task.status !== status) task.statusChangedAt = now();
    task.status = status;
    task.current = current;
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#event(task, 'STATUS', current, { status }, false);
  }

  async #fail(task, error) {
    if (task.status === 'CANCELLED' || this.deleted.has(task.id)) return;
    const classified = classifyEngineError(error) || classifyEngineError(task._modelError);
    const explicit = error?.code && !['MODEL_ERROR', 'INTERNAL_ERROR'].includes(error.code) ? error.code : null;
    task.status = 'FAILED';
    task.errorCode = explicit || classified?.code || error?.code || 'INTERNAL_ERROR';
    task.retryable = classified ? classified.retryable : null;
    task.retryAfterMs = classified?.retryAfterMs ?? null;
    task.error = error.message || String(error);
    task.current = 'Failed';
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#writeResult(task).catch(() => {});
    await this.#event(task, 'TASK_FAILED', task.error, { errorCode: task.errorCode });
  }

  async #event(task, type, message, data = {}, persistTask = true) {
    if (this.deleted.has(task.id)) return;
    const next = (this.eventWrites.get(task.id) || Promise.resolve()).then(() => this.#recordEvent(task, type, message, data, persistTask));
    const settled = next.catch(() => {});
    this.eventWrites.set(task.id, settled);
    settled.then(() => { if (this.eventWrites.get(task.id) === settled) this.eventWrites.delete(task.id); });
    return next;
  }

  async #recordEvent(task, type, message, data, persistTask) {
    if (this.deleted.has(task.id)) return;
    const event = { at: now(), taskId: task.id, type, message, data };
    await this.store.appendEvent(task.id, event);
    if (persistTask) {
      task.updatedAt = event.at;
      await this.store.save(this.#publicTask(task)).catch(() => {});
    }
    this.emit('task-event', event);
    return event;
  }
}
