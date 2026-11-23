import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import {
  resetTaskRuntimeFlags,
  retireTaskRuntime,
  canAcceptPiFrame,
  deriveChatUiContract,
} from '../src/chat-lifecycle.mjs';

/** Управляемая заглушка PiRpcSession без спавна реального процесса. */
class FakePi extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
    this.killed = false;
    this.aborted = false;
    this.proc = { pid: 424242, exitCode: null, signalCode: null };
    this.state = { isStreaming: false, isCompacting: false, sessionFile: null };
    this.onPrompt = async () => ({ success: true, data: {} });
    this.onGetState = async () => this.state;
  }
  canSend() { return !this.closed && !this.killed; }
  async getState() { return this.onGetState(); }
  async prompt(msg) { return this.onPrompt(msg); }
  async sendFollowUp(msg) { return this.onPrompt(msg); }
  async getCommands() { return []; }
  async abort() { this.aborted = true; }
  async killTree() {
    this.killed = true;
    this.closed = true;
    this.proc.exitCode = 1;
    this.emit('close', { code: 1, signal: 'SIGKILL' });
  }
  send() {}
  closeStdin() {}
}

describe('chat-lifecycle (pure contract)', () => {
  it('resetTaskRuntimeFlags сбрасывает все временные флаги runtime', () => {
    const task = {
      id: 't1',
      piPid: 1234,
      piStartedAt: '2026-11-23T10:00:00Z',
      _toolsRunning: 3,
      _compacting: true,
      _compactingSince: 1700000000000,
      _compactionStage: 'chunk 5/10',
      _starting: true,
      providerWait: { kind: 'rate-limit', httpStatus: 429 },
      _modelFrameAt: 1700000000000,
    };

    resetTaskRuntimeFlags(task);

    assert.equal(task.piPid, null);
    assert.equal(task.piStartedAt, null);
    assert.equal(task._toolsRunning, 0);
    assert.equal(task._compacting, false);
    assert.equal(task._compactingSince, 0);
    assert.equal(task._compactionStage, null);
    assert.equal(task._starting, false);
    assert.equal(task.providerWait, null);
    assert.equal(task._modelFrameAt, 0);
  });

  it('retireTaskRuntime удаляет runtime из Map ДО killTree и чистит флаги', async () => {
    const pi = new FakePi();
    const runtimes = new Map();
    const task = { id: 't1', _compacting: true, _toolsRunning: 2, piPid: 999 };
    const runtime = { pi, retired: false, cancelRequested: false };
    runtimes.set('t1', runtime);

    let mapHadRuntimeDuringKill = null;
    pi.killTree = async () => {
      mapHadRuntimeDuringKill = runtimes.has('t1');
      pi.killed = true;
      pi.closed = true;
    };

    let settledId = null;
    await retireTaskRuntime({ task, runtimes, resolveSettle: id => { settledId = id; } });

    assert.equal(mapHadRuntimeDuringKill, false, 'runtime должен быть удалён из Map до await killTree()');
    assert.equal(runtime.retired, true);
    assert.equal(runtime.cancelRequested, true);
    assert.equal(task._compacting, false);
    assert.equal(task._toolsRunning, 0);
    assert.equal(settledId, 't1');
  });

  it('canAcceptPiFrame блокирует кадры от retired/cancelled runtime и при CANCELLING', () => {
    const task = { id: 't1', status: 'RUNNING' };
    const rt = { retired: false, cancelRequested: false };
    assert.equal(canAcceptPiFrame(task, rt), true);
    assert.equal(canAcceptPiFrame(task, { retired: true, cancelRequested: false }), false);
    assert.equal(canAcceptPiFrame(task, { retired: false, cancelRequested: true }), false);
    assert.equal(canAcceptPiFrame({ id: 't1', status: 'CANCELLING' }, rt), false);
  });

  it('deriveChatUiContract согласует фазу, анимации, STOP и редактирование', () => {
    // 1. Стриминг: анимация идёт, STOP включён, редактировать нельзя, Enter поставит в очередь.
    const streaming = deriveChatUiContract(
      { status: 'RUNNING', _turnPhase: 'PROGRESS', _modelFrameAt: Date.now() },
      { liveRuntime: true, seq: 10 },
    );
    assert.deepEqual(
      { phase: streaming.phase, busy: streaming.busy, typing: streaming.typing, canStop: streaming.canStop, canEditHistory: streaming.canEditHistory, sendAction: streaming.sendAction },
      { phase: 'streaming', busy: true, typing: true, canStop: true, canEditHistory: false, sendAction: 'queue' },
    );

    // 2. VERIFYING (после agent_settled): точек нет, но busy=true, STOP включён, редактировать НЕЛЬЗЯ.
    const verifying = deriveChatUiContract({ status: 'VERIFYING' }, { liveRuntime: true, seq: 11 });
    assert.equal(verifying.phase, 'verifying');
    assert.equal(verifying.busy, true);
    assert.equal(verifying.typing, false);
    assert.equal(verifying.canStop, true);
    assert.equal(verifying.canEditHistory, false);

    // 3. CANCELLING: отправка заблокирована, STOP активен (для повторного hard stop).
    const cancelling = deriveChatUiContract({ status: 'CANCELLING' }, { liveRuntime: false, seq: 12 });
    assert.equal(cancelling.phase, 'cancelling');
    assert.equal(cancelling.canStop, true);
    assert.equal(cancelling.canSend, false);
    assert.equal(cancelling.canEditHistory, false);

    // 4. SUCCEEDED + нет очереди: всё чисто, можно редактировать и отправлять сразу.
    const done = deriveChatUiContract({ status: 'SUCCEEDED', pendingPrompts: [] }, { liveRuntime: true, seq: 13 });
    assert.equal(done.phase, 'idle');
    assert.equal(done.busy, false);
    assert.equal(done.typing, false);
    assert.equal(done.canStop, false);
    assert.equal(done.canEditHistory, true);
    assert.equal(done.sendAction, 'send');
  });
});

describe('TaskManager STOP & delivery invariants', () => {
  let tmpDir;
  let store;
  let manager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-lifecycle-'));
    const workDir = path.join(tmpDir, 'proj');
    await fs.mkdir(workDir, { recursive: true });
    store = new TaskStore(tmpDir);
    manager = new TaskManager(
      {
        projects: [{ id: 'p1', name: 'Demo', path: workDir, useWorktree: false }],
        localRuntime: { provider: 'remote-test' },
        queue: { maxConcurrentSessions: 2 },
      },
      tmpDir,
      store,
    );
    await manager.init();
  });

  afterEach(async () => {
    await manager.close().catch(() => {});
    store.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seedRunningTask(id = 't-stop', status = 'RUNNING') {
    const workspace = path.join(tmpDir, 'proj');
    const task = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status,
      projectId: 'p1',
      prompt: 'test',
      workspacePath: workspace,
      current: 'Pi is working',
      assistantText: '',
      thinkingText: '',
      requestedModel: { provider: 'deepseek', id: 'deepseek-flash' },
      compaction: { count: 0, last: null },
      pendingPrompts: [],
      files: [],
      attachments: [],
      outputFiles: [],
      _turn: 1,
      _turnOpened: 1,
      _compacting: true,
      _compactingSince: Date.now() - 5000,
      _toolsRunning: 2,
      providerWait: { kind: 'retry', httpStatus: 429 },
    };
    await store.create(task);
    manager.tasks.set(id, task);
    const pi = new FakePi();
    const runtime = {
      pi,
      settleResolvers: [],
      cancelRequested: false,
      retired: false,
      turn: 1,
      eventChain: Promise.resolve(),
    };
    manager.runtimes.set(id, runtime);
    manager.activeTaskIds.add(id);
    return { task, pi, runtime };
  }

  it('STOP (по умолчанию hard=true) убивает Pi, удаляет runtime и сбрасывает _compacting/_toolsRunning', async () => {
    const { task, pi } = await seedRunningTask('t-hard-stop');

    const result = await manager.cancel('t-hard-stop');

    assert.equal(pi.killed, true, 'Pi должен быть убит через killTree()');
    assert.equal(manager.runtimes.has('t-hard-stop'), false, 'retired runtime не должен оставаться в Map');
    assert.equal(manager.activeTaskIds.has('t-hard-stop'), false, 'слот должен быть освобождён');
    assert.equal(task._compacting, false);
    assert.equal(task._toolsRunning, 0);
    assert.equal(task.providerWait, null);
    assert.equal(result.status, 'CANCELLED');
    assert.equal(result.runtime.activity, null);
    assert.equal(result.ui?.canStop, false);
    assert.equal(result.ui?.busy, false);
  });

  it('STOP во время SUCCEEDED + inFlightPrompt всё равно останавливает Pi', async () => {
    // Эмулируем гонку: задача ещё SUCCEEDED, но #deliverMessage уже держит inFlightPrompt и runtime.
    const { task, pi } = await seedRunningTask('t-race-stop', 'SUCCEEDED');
    task.inFlightPrompt = { text: 'hello', at: new Date().toISOString() };

    const result = await manager.cancel('t-race-stop');

    assert.equal(pi.killed, true);
    assert.equal(result.status, 'CANCELLED');
    assert.equal(task.inFlightPrompt, null);
  });

  it('STOP при отсутствии runtime (!runtime, статус PREPARING) освобождает слот', async () => {
    const { task } = await seedRunningTask('t-no-rt', 'PREPARING');
    manager.runtimes.delete('t-no-rt');

    const result = await manager.cancel('t-no-rt');

    assert.equal(result.status, 'CANCELLED');
    assert.equal(manager.activeTaskIds.has('t-no-rt'), false);
    assert.equal(task.status, 'CANCELLED');
  });
});
