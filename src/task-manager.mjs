import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PiRpcSession } from './pi-rpc.mjs';
import { prepareProjectWorkspace, createScratchWorkspace, collectGitState, runVerification } from './git.mjs';
import { RuntimeManager } from './runtime-manager.mjs';
import { restoreSessionFile } from './session-history.mjs';
import { validateFiles, metadata, stageFiles, rollbackFiles, snapshotWorkspace, captureOutputs } from './files.mjs';
import { NativeSessionService, acquireNativeLease } from './native-sessions.mjs';

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
    this.admitting = false;
    this.deleted = new Set();
    this.eventWrites = new Map();
    this.runtimeManager = new RuntimeManager(config.localRuntime || {}, dataRoot);
    this.nativeSessions = new NativeSessionService(this);
    this.runtimeChanging = false;
  }

  async init() {
    const previous = await this.store.list();
    for (const task of previous) {
      if (['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'VERIFYING', 'CANCELLING'].includes(task.status)) {
        task.status = 'FAILED';
        task.errorCode = 'FAILED_RECOVERY';
        task.error = 'TaskBridge restarted while this task was active.';
        task.updatedAt = now();
        await this.store.save(task);
      }
      this.tasks.set(task.id, task);
    }
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

  async createTask(input) {
    return this.#admit(() => this.#createTask(input));
  }

  async #createTask(input) {
    if (this.activeTaskId) throw Object.assign(new Error('Модель уже выполняет другую сессию.'), { code: 'MODEL_BUSY' });
    const busy = await this.runtimeManager.getBusyStatus();
    if (busy.busy) throw Object.assign(new Error('Локальная модель сейчас занята другим запросом. Повторите чуть позже.'), { code: 'MODEL_BUSY' });
    if (!this.config.localRuntime?.managed?.enabled && !(await this.runtimeManager.isReady())) throw Object.assign(new Error('Локальная модель недоступна.'), { code: 'LOCAL_RUNTIME_FAILED' });
    const incomingFiles = validateFiles(input.files || []);
    const prompt = String(input.prompt || '').trim() || (incomingFiles.length ? 'Прикреплённые файлы' : '');
    if (!prompt) throw Object.assign(new Error('Добавьте сообщение или файл.'), { code: 'INPUT_INVALID' });
    const projectId = String(input.projectId || this.projects.keys().next().value || '');
    if (projectId !== '__scratch__' && !this.projects.has(projectId)) {
      throw Object.assign(new Error(`Unknown project: ${projectId}`), { code: 'PROJECT_NOT_FOUND' });
    }

    const task = {
      id: shortId(),
      createdAt: now(),
      updatedAt: now(),
      status: 'QUEUED',
      projectId,
      prompt,
      workspacePath: null,
      sourcePath: null,
      worktree: false,
      current: 'Queued',
      assistantText: '',
      thinkingText: '',
      error: null,
      errorCode: null,
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
    this.queue.push(task.id);
    await this.#event(task, 'TASK_QUEUED', 'Task queued');
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
    const { _incomingFiles, _modelError, _baseline, _nativeLease, ...safe } = task;
    const runtime = this.runtimes.get(task.id);
    return { ...safe, sessionAvailable: Boolean(task.workspacePath || (runtime && !runtime.pi.closed)) };
  }

  async #pump() {
    if (this.activeTaskId || this.queue.length === 0) return;
    const id = this.queue.shift();
    const task = this.tasks.get(id);
    if (!task) return this.#pump();
    this.activeTaskId = id;
    try {
      await this.#executeInitial(task);
    } finally {
      if (this.activeTaskId === id) this.activeTaskId = null;
      setImmediate(() => this.#pump());
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
      const runtimeInfo = await this.runtimeManager.ensureRunning((text) => {
        this.store.appendRaw(task.id, 'runtime.log', text).catch(() => {});
      });
      if (task.status === 'CANCELLED' || this.deleted.has(task.id)) return;
      await this.#event(task, 'RUNTIME_READY', `Local runtime: ${runtimeInfo.state}`);

      const busy = await this.runtimeManager.getBusyStatus();
      if (busy.busy === true) {
        throw Object.assign(new Error('Локальная модель сейчас занята другим запросом. Повторите чуть позже.'), { code: 'MODEL_BUSY' });
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
    const pi = new PiRpcSession({
      command: this.config.pi?.command || 'pi',
      args: this.config.pi?.args || [],
      cwd: task.workspacePath,
      sessionDir,
      sessionName: `task-${task.id}`,
      sessionFile,
      persistSessions: this.config.pi?.persistSessions !== false,
      projectTrust: this.config.pi?.projectTrust || 'approve'
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
      await this.store.save(this.#publicTask(task));
    } catch {}
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
      if (delta?.type === 'text_delta') task.assistantText += delta.delta || '';
      if (delta?.type === 'thinking_delta') {
        task.thinkingText += delta.delta || '';
        task.current = `Pi is thinking… (${task.thinkingText.length} chars)`;
      }
      if (frame.usage?.totalTokens > 0) task.lastUsage = frame.usage;
    }
    if (frame.type === 'tool_execution_start') {
      const arg = frame.args?.command || frame.args?.path || frame.args?.file_path || '';
      task.current = `${frame.toolName || 'tool'}${arg ? `: ${String(arg).slice(0, 160)}` : ''}`;
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
      task.current = failed ? 'Verification failed' : 'Done';
      task.updatedAt = now();
      await this.store.save(this.#publicTask(task));
      await this.#writeResult(task);
      await this.#event(task, failed ? 'TASK_FAILED' : 'TASK_SUCCEEDED', task.current);
    } finally {
      if (runtime) runtime.verifying = false;
    }
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
    await this.store.remove(id);
    this.#pump();
  }

  async cancel(id) {
    const task = this.tasks.get(id);
    const runtime = this.runtimes.get(id);
    if (!task) throw Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' });
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return this.#publicTask(task);
    if (!runtime) {
      task.status = 'CANCELLED';
      task.current = 'Cancelled';
      this.queue = this.queue.filter(x => x !== id);
      await this.store.save(this.#publicTask(task));
      await this.#event(task, 'TASK_CANCELLED', 'Task cancelled');
      return this.#publicTask(task);
    }
    runtime.cancelRequested = true;
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

  async message(id, text, mode = 'auto', files = []) {
    return this.#admit(() => this.#message(id, text, mode, files));
  }

  async #message(id, text, mode, files) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
    if (this.activeTaskId && (this.activeTaskId !== id || task.status !== 'RUNNING')) throw Object.assign(new Error('Модель занята другой операцией.'), { code: 'BUSY' });
    const incomingFiles = validateFiles(files);
    const userText = String(text || '').trim() || (incomingFiles.length ? 'Прикреплённые файлы' : '');
    if (!userText) throw Object.assign(new Error('Добавьте сообщение или файл.'), { code: 'INPUT_INVALID' });
    if (!['auto', 'prompt', 'steer', 'follow_up'].includes(mode)) throw Object.assign(new Error('Неизвестный режим сообщения.'), { code: 'INPUT_INVALID' });
    if (!(await this.runtimeManager.isReady())) await this.runtimeManager.ensureRunning();
    const runtime = await this.#ensureSession(task);
    const state = await runtime.pi.getState();
    const streaming = Boolean(state?.isStreaming);
    if (state?.isCompacting) throw Object.assign(new Error('Сейчас выполняется сжатие контекста.'), { code: 'BUSY' });
    if (!streaming && (await this.runtimeManager.getBusyStatus()).busy) throw Object.assign(new Error('Локальная модель сейчас занята другим запросом. Повторите чуть позже.'), { code: 'MODEL_BUSY' });
    if (!streaming) task._baseline = await snapshotWorkspace(task.workspacePath);
    const attached = await stageFiles(task, this.store.taskDir(id), incomingFiles);
    const message = userText + (attached.length ? `\n\nAdditional files from the phone are in .taskbridge-input/:\n${attached.map(f => `- ${f.path}`).join('\n')}` : '');
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
      task.attachments = [...(task.attachments || []), ...attached];
      await this.store.save(this.#publicTask(task));
      await this.#event(task, 'USER_MESSAGE', userText, { text: userText, mode: effectiveMode, files: attached });
      if (!streaming) await this.#setStatus(task, 'RUNNING', 'Follow-up sent to Pi');
    } catch (error) {
      if (!accepted) await rollbackFiles(task, this.store.taskDir(id), attached);
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
    if ((await this.runtimeManager.getBusyStatus()).busy) throw Object.assign(new Error('Локальная модель сейчас занята другим запросом.'), { code: 'MODEL_BUSY' });
    await this.#event(task, 'COMPACT_REQUESTED', 'Manual compaction requested');
    const response = await runtime.pi.compact(String(instructions || ''));
    return response.data || null;
  }

  async #ensureSession(task) {
    const current = this.runtimes.get(task.id);
    if (current && !current.pi.closed) return current;
    if ((await this.runtimeManager.getBusyStatus()).busy) throw Object.assign(new Error('Локальная модель сейчас занята другим запросом. Повторите чуть позже.'), { code: 'MODEL_BUSY' });
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
    task.status = status;
    task.current = current;
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#event(task, 'STATUS', current, { status }, false);
  }

  async #fail(task, error) {
    if (task.status === 'CANCELLED' || this.deleted.has(task.id)) return;
    task.status = 'FAILED';
    task.errorCode = error.code || 'INTERNAL_ERROR';
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
