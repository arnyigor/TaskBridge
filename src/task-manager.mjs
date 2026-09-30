import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PiRpcSession } from './pi-rpc.mjs';
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
import { McpManager, MCP_MODES } from './mcp-manager.mjs';
import { TEXT_TAIL, THINKING_TAIL, tailText, appendTail } from './text-tail.mjs';
import { toolResultText, isBrokenToolLog, tailBytes } from './tool-output.mjs';
import { generationWindowMs, generationMetrics } from './system-metrics.mjs';
import { ApprovalManager } from './cloud/approval-manager.mjs';
import { classifyToolCall, resolveApprovalConfig } from './approvals/policy.mjs';
import { deriveRuntimeState, transitionAllowed } from './runtime-state.mjs';
import { listProcesses, processesUsingFile, sameProcess } from './process-info.mjs';
import { piAgentDir } from './pi-settings.mjs';

function now() { return new Date().toISOString(); }
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
// A retry the agent announces while it is still alive is PROGRESS, not a result:
// «… retrying after error in 0m 05s. Error: Connection error.», «⏳ pi-limits-wait:
// … still alive, waiting 0m 05s before the next retry», «… error for 0m 30s;
// waiting, then retrying». Shown verbatim in the chat they read as a failure the
// agent does not have — the operator sees «Агент работает» and a wall of “Error:”
// at the same time (observed 2026-09-29 with a restarting local model). The chat
// note is dropped; the raw frame stays in pi-events.jsonl, and a real failure
// still arrives as the message's own error / TASK_FAILED.
const RETRY_IN_PROGRESS_NOTICE = /retrying after error|before the next retry|then retrying/iu;
// Kill a whole process tree by pid (an orphan from a previous TaskBridge run).
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
  constructor(config, dataRoot, store) {
    super();
    this.config = config;
    this.dataRoot = dataRoot;
    this.store = store;
    this.projects = new Map((config.projects || []).map((p) => [p.id, p]));
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
    this.mcp = new McpManager(config.pi || {}, dataRoot);
    this.modelCatalog = new ModelCatalog({ pi: config.pi, cwd: dataRoot, env: this.#llamaEnv() });
    // Per-model TTFT history (local + cloud): the UI shows "this model usually
    // answers in ~N s" before the prompt is even sent.
    this.modelLatency = new ModelLatency(dataRoot);
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
        this.#enqueue(task.id);
        await this.#restorePendingFiles(task.id);
      } else if (['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING'].includes(task.status)) {
        const intact = task.piSessionFile ? await fs.access(task.piSessionFile).then(() => true, () => false) : false;
        // The in-flight marker: a prompt was sent to Pi and its turn did not
        // complete before the restart. With the session file intact the restart
        // finishes the command instead of reporting a failure. Pi records the
        // user message as the prompt is accepted, so the session file tells the
        // two cases apart: the text is already there → a short continuation
        // nudge (re-sending it would duplicate the user turn); nothing there →
        // the prompt is re-sent as-is. The delivery announces nothing either
        // way (announce: false): the text is already in the chat history.
        if (intact && task.inFlightPrompt?.text) {
          const recorded = await sessionContainsUserMessage(task.piSessionFile, task.inFlightPrompt.text);
          const resume = {
            id: `resume-${now()}`,
            text: recorded ? CONTINUE_PROMPT : task.inFlightPrompt.text,
            mode: 'auto',
            files: (task.files || []).map(metadata),
            announce: false,
          };
          // The resume goes to the queue front; prompts queued before the
          // restart follow it. The marker is spent: the restart delivers it
          // exactly once, so no restart produces a duplicate.
          task.pendingPrompts = [resume, ...(task.pendingPrompts || [])];
          task.inFlightPrompt = null;
          // The task was RUNNING when the restart hit it: the pump delivers the
          // resume through #deliverPending, which claims the slot itself.
          task.status = 'QUEUED';
          task.queueReason = 'RESTORED_RESUME';
          task.current = 'TaskBridge перезапустился во время ответа — запрос будет отправлен повторно';
          task.updatedAt = now();
          await this.store.save(task);
          this.#enqueue(task.id);
          await this.#restorePendingFiles(task.id);
        } else {
          // R3.6: with the Pi session file intact the conversation is only
          // interrupted — the next message resumes it (RESTORABLE). Without it
          // there is nothing to resume from: a real failure.
          task.status = 'FAILED';
          task.errorCode = intact ? 'FAILED_RECOVERY' : 'SESSION_LOST';
          task.error = intact
            ? 'TaskBridge перезапустился во время ответа. Следующее сообщение продолжит сессию.'
            : 'TaskBridge перезапустился во время ответа, а файл сессии Pi не сохранился.';
          if (!intact) task._sessionLost = true;
          task.updatedAt = now();
          await this.store.save(task);
        }
      }
      // Pi is gone after a restart: a dialog it was waiting on is gone with it.
      if (task.pendingUiRequest) { task.pendingUiRequest = null; await this.store.save(task).catch(() => {}); }
      this.tasks.set(task.id, task);
      task._runtimeState = this.#runtimeFacts(task).state;
    }
    if (trimmed) await this.store.vacuum().catch(() => {});
    else await this.#maybeVacuum();
    await this.#sweepOrphans();
    await this.#killOrphanPis(previous);
    if (this.queue.length) this.#schedulePump();
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
      const alive = await sameProcess(task.piPid, task.piStartedAt, { list });
      if (alive) {
        console.warn(`[TaskBridge] killing orphan Pi of task ${task.id}: pid ${task.piPid}`);
        await killTreeByPid(task.piPid);
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
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
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

  #publicTask(task) {
    const { _incomingFiles, _modelError, _baseline, _turn, _nativeLease, _uploadToken,
      _firstDeltaAt, _lastDeltaAt, _promptStartedAt, _promptMs, _firstTokenAt,
      _runtimeState, _starting, _sleeping, _sessionLost, _compacting, _toolsRunning, _uiTimer, _lastPiExitAt, ...safe } = task;
    const runtime = this.runtimes.get(task.id);
    return {
      ...safe,
      runtime: this.#runtimeFacts(task),
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
    if (this.queue.length === 0) return;
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const started = await this.#pumpOnce();
        if (started && this.queue.length) this.pumpAgain = true;
      } while (this.pumpAgain && this.queue.length && this.activeTaskIds.size < this.maxParallelSessions);
    } finally {
      this.pumping = false;
      if (this.queue.length) this.#schedulePump();
    }
  }

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
    let ownedTurn = null;
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
        if (task.status === 'CANCELLED' || this.runtimes.get(task.id)?.cancelRequested) { this.#resolveSettle(task.id); return; }
        // The in-flight marker (see #deliverMessage): persisted before the RPC so
        // a restart between here and the turn's end finishes the command instead
        // of reporting a failure. Cleared when the turn reaches a terminal state.
        task.inFlightPrompt = { text: this.#buildPrompt(task), initial: true, at: now() };
        await this.store.save(this.#publicTask(task)).catch(() => {});
        await pi.prompt(this.#buildPrompt(task));
        // The initial prompt has no USER_MESSAGE frame (it is stored on the task).
        // Publish the RPC acknowledgement so clients can distinguish "created on
        // the server" from "Pi accepted the prompt".
        await this.#event(task, 'PROMPT_ACCEPTED', 'Первый запрос принят Pi', { initial: true });
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
      if (this.deleted.has(task.id) || runtime.retired) return;
      runtime.eventChain = runtime.eventChain
        .then(() => runtime.retired ? undefined : this.#handlePiEvent(task, frame, runtime))
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
    return { ...merged, provider: this.#localProviderId() };
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
    return this.localServers.setContext(id, context);
  }

  /**
   * Убрать внешний сервер из списка локальных моделей TaskBridge (его собственная
   * запись в config.json). Возвращает удалённую запись или null — если такая строка
   * пришла из Pi, а не из конфига; тогда её удаляют в Pi.
   *
   * Сам config.json сохраняет вызывающий (у менеджера нет rootDir).
   */
  forgetLocalServer(id) {
    return this.localServers.forget(id);
  }

  async stopLocal() {
    if (!this.localModels.enabled) throw Object.assign(new Error('Router не настроен (localRuntime.router).'), { code: 'NOT_CONFIGURED' });
    return this.localModels.stop();
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
    const runtime = await this.#ensureSession(task);
    const state = await runtime.pi.getState().catch(async error => {
      await this.#recoverRpcFailure(task, error);
      throw error;
    });
    if (state?.isStreaming || state?.isCompacting) throw Object.assign(new Error('Дождитесь завершения ответа перед сменой модели.'), { code: 'BUSY' });
    // Cached ids only: the selection must not wait on a catalog probe.
    const targetModelId = await this.#resolvePiModelId(model.provider, model.id, { probe: false });
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

  async #handlePiEvent(task, frame, runtime = null) {
    if (this.deleted.has(task.id)) return;
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
    if (frame.type === 'extension_ui_request') return this.#onUiRequest(task, frame);
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
    if (frame.type === 'compaction_start' || frame.type === 'auto_compaction_start') task._compacting = true;
    if (frame.type === 'compaction_end' || frame.type === 'auto_compaction_end') task._compacting = false;
    if (frame.type === 'agent_settled') {
      task._toolsRunning = 0;
      // A dialog cannot outlive its turn.
      if (task.pendingUiRequest) await this.#closeUiRequest(task, task.pendingUiRequest.id, { cancelled: true, reason: 'turn_ended' });
    }

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

    await this.#event(task, 'PI_EVENT', summarizePiEvent(frame), { pi: frame }, false);

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
    const engine = routerEngine ? await this.localModels.getMetrics().catch(() => null) : null;
    const metrics = generationMetrics({
      usage: task.lastUsage,
      promptMs,
      windowMs,
      engine,
      local: routerEngine || Boolean(this.localServers?.find(task.model?.provider || task.requestedModel?.provider))
    });
    if (!metrics) return;
    task.metrics = metrics;
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

  // "Fork": a new session in the same project whose conversation is a copy of
  // this one through the chosen exchange. Nothing runs and no model is asked —
  // the copy is replayed by the client at once, and the fork's first message
  // rebuilds Pi's session file from those events (session-history.mjs), so the
  // branch keeps its context. The source is left untouched.
  async forkTask(id, turnId) {
    return this.#admit(() => this.#forkTask(id, turnId), id);
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
      if ((task.pendingPrompts || []).length) this.#enqueue(id);
    } else {
      await this.#releasePendingFiles(id, task.pendingPrompts);
      task.pendingPrompts = null;
      task.queueReason = null;
      this.#removeQueued(id);
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
    // STOP answers an open dialog with «cancelled» first: the extension is
    // blocked on it and would otherwise hold the abort up.
    if (task.pendingUiRequest) {
      try { runtime.pi.send({ type: 'extension_ui_response', id: task.pendingUiRequest.id, cancelled: true }); } catch {}
      await this.#closeUiRequest(task, task.pendingUiRequest.id, { cancelled: true, reason: 'stopped' });
    }
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
          const replay = { hash, done: true, result: stored.result, at: stored.at, clientId: stored.clientId, status };
          this.commandLedger.set(commandId, replay);
          if (status === 'REJECTED') throw this.#commandError(stored.result);
          return stored.result;
        }
        this.commandLedger.set(commandId, { hash, done: false, result: null, at: stored.at, clientId: stored.clientId, status: 'UNKNOWN_AFTER_CRASH' });
        throw Object.assign(new Error('Исход команды неизвестен после перезапуска — отправьте её заново с новым commandId.'), { code: 'UNKNOWN_AFTER_CRASH' });
      }
    } else {
      if (entry.hash !== hash) {
        throw Object.assign(new Error('Команда уже принималась с другим содержимым.'), { code: 'CONFLICT' });
      }
      if (entry.done) {
        if (entry.status === 'REJECTED') throw this.#commandError(entry.result);
        return entry.result;
      }
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
      const rejected = { error: { code: error?.code || 'INTERNAL_ERROR', message: error?.message || String(error) } };
      const g = this.commandLedger.get(commandId);
      if (g) { g.done = true; g.result = rejected; g.status = 'REJECTED'; }
      try { this.store.upsertCommand(commandId, { hash, done: true, result: rejected, clientId, status: 'REJECTED' }); } catch {}
      throw error;
    }
  }

  #commandError(result) {
    const saved = result?.error;
    return Object.assign(new Error(saved?.message || 'Команда была отклонена.'), { code: saved?.code || 'INTERNAL_ERROR' });
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
  async sendPendingNow(id, pendingId = null) {
    return this.#admit(async () => {
      const task = this.tasks.get(id);
      if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      // Retrying a stale button must not deliver the NEXT queued message.
      if (pendingId && !(task.pendingPrompts || []).some(p => p.id === pendingId)) return this.#publicTask(task);
      if (!task.workspacePath) throw Object.assign(new Error('Сначала дождитесь запуска исходной задачи.'), { code: 'BUSY' });
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
      if (!(task.pendingPrompts || []).length) {
        this.#removeQueued(id);
        return this.#publicTask(task);
      }
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
      // Release gate immediately after USER_MESSAGE is safely persisted so the
      // HTTP response returns to client without waiting for subsequent background ticks.
      release();
    } catch (error) {
      if (!accepted && !staged.length) await rollbackFiles(task, this.store.taskDir(id), attached);
      if (!streaming) {
        this.#resolveSettle(id);
        this.#releaseSlot(id);
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

  async #ensureSession(task) {
    const current = this.runtimes.get(task.id);
    // `closed` alone is not enough: Pi that exited leaves stdin closed while the
    // close event may still be unprocessed, and the runtime is then reused as if
    // it were alive — every command against it fails with "Pi RPC session is not
    // writable" instead of the session being started again. `canSend` is checked
    // defensively because the in-process test fixtures stub Pi with a plain
    // object; only a session that explicitly reports a dead pipe is replaced.
    if (current && !current.pi.closed && current.pi.canSend?.() !== false) return current;
    if (current) {
      current.retired = true;
      current.cancelRequested = true;
      task._turn = (task._turn || 0) + 1;
      await current.pi.killTree().catch(() => {});
      this.#resolveSettle(task.id);
      if (this.runtimes.get(task.id) === current) this.runtimes.delete(task.id);
    }
    if (this.#usesLocalRuntime(task) && (await this.local.getBusyStatus()).busy) throw Object.assign(new Error('Локальная модель сейчас занята другим запросом. Повторите чуть позже.'), { code: 'MODEL_BUSY' });
    if (!task.workspacePath) {
      Object.assign(task, await this.#prepareWorkspace(task));
    }
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
    this.#releaseSlot(task.id);
    if (task.pendingUiRequest) await this.#closeUiRequest(task, task.pendingUiRequest.id, { cancelled: true, reason: 'rpc_failed' });
    await this.#fail(task, error);
    this.#schedulePump();
  }

  async #fail(task, error) {
    if (this.closing) return; // like #setStatus: nothing reaches a closed store
    if (task.status === 'CANCELLED' || this.deleted.has(task.id)) return;
    // The turn reached a terminal state: the in-flight command is spent.
    if (task.inFlightPrompt) task.inFlightPrompt = null;
    const classified = classifyEngineError(error) || classifyEngineError(task._modelError);
    const explicit = error?.code && !['MODEL_ERROR', 'INTERNAL_ERROR'].includes(error.code) ? error.code : null;
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
    if (seq === null) await this.store.appendEvent(task.id, event);
    else await this.store.appendEventAt(task.id, seq, event);
    if (persistTask) {
      task.updatedAt = event.at;
      await this.store.save(this.#publicTask(task)).catch(() => {});
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
      toolsRunning: task._toolsRunning || 0,
    });
  }

  #runtimeChange(task) {
    const next = this.#runtimeFacts(task).state;
    const from = task._runtimeState || null;
    if (from === next) return null;
    if (!transitionAllowed(from, next)) console.warn(`[TaskBridge] runtime ${task.id}: unexpected ${from} → ${next} (status ${task.status})`);
    task._runtimeState = next;
    return { from, to: next };
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

  // --- extension UI requests (Pi RPC) ------------------------------------------
  async #onUiRequest(task, frame) {
    if (frame.method === 'notify') {
      const message = uiText(frame.message, 2000) || '';
      if (RETRY_IN_PROGRESS_NOTICE.test(message)) return;
      await this.#event(task, 'UI_NOTIFY', message, { notifyType: ['info', 'warning', 'error'].includes(frame.notifyType) ? frame.notifyType : 'info' });
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
