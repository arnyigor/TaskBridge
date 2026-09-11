import path from 'node:path';
import { EventMux } from '../events/event-mux.mjs';
import { EventSequence } from '../events/event-sequence.mjs';
import { EventNormalizer } from '../events/event-normalizer.mjs';
import { SnapshotPolicy } from '../events/event-snapshot.mjs';
import { CloudClient } from './cloud-client.mjs';
import { EventBuffer } from './event-buffer.mjs';
import { CloudOutbox } from './outbox.mjs';
import { EventUploader } from './event-uploader.mjs';
import { ReconnectManager } from './reconnect-manager.mjs';
import { Heartbeat } from './heartbeat.mjs';
import { CommandDispatcher, CommandLedger } from './command-dispatcher.mjs';
import { CloudTransport, LocalTransport, CompositeTransport } from './cloud-transport.mjs';
import { compareCommands } from '../domain/cloud-command.mjs';
import { isTerminalState } from '../domain/task-event.mjs';
import { secretFingerprint } from './machine-auth.mjs';
import { Metrics } from '../metrics.mjs';

// CloudWorker is the local half of the cloud transport (§8, §18, §19, §20,
// §71–§73, §114). It owns nothing that TaskManager needs: the local runtime
// keeps working exactly as before if this worker is disabled or fails.

const RUNNING_LOCAL_STATUSES = new Set(['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING']);

function defaultLogger(level, entry) {
  const line = JSON.stringify({ level, at: new Date().toISOString(), ...entry });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export class CloudWorker {
  constructor({ config, manager, store, dataRoot, logger = defaultLogger, fetchImpl = globalThis.fetch, version = null, aliases = {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.config = config;
    this.manager = manager;
    this.store = store;
    this.dataRoot = dataRoot;
    this.logger = logger;
    this.version = version;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.running = false;
    this.pollTimer = null;
    this.polling = false;
    this.lastPollAt = null;
    this.lastPollError = null;
    this.lastHeartbeatAt = null;
    this.reconciled = null;

    this.client = new CloudClient({
      baseUrl: config.url,
      machineId: config.machineId,
      machineSecret: config.machineSecret,
      authMode: config.authMode,
      protocolVersion: config.protocolVersion,
      timeoutMs: config.requestTimeoutMs,
      fetchImpl,
      logger
    });
    this.metrics = new Metrics();
    this.reconnect = new ReconnectManager({ maxDelayMs: config.maxRetryDelayMs, setTimer, clearTimer, metrics: this.metrics });
    this.outbox = new CloudOutbox({
      dir: path.join(dataRoot, 'cloud-outbox'),
      maxBytes: config.maxOutboxMb * 1024 * 1024,
      logger
    });
    this.sequence = new EventSequence({ store });
    this.mux = new EventMux({
      machineId: config.machineId,
      sequence: this.sequence,
      normalizer: new EventNormalizer({ toolOutput: config.toolOutput }),
      snapshotPolicy: new SnapshotPolicy(),
      aliases,
      redactPaths: config.redactPaths,
      largePayloadBytes: Math.max(1024, Math.floor(Number(config.toolOutput?.maxFullMb ?? 4) * 1048576)),
      logger
    });
    this.buffer = new EventBuffer({
      flushMs: config.eventFlushMs,
      maxEvents: config.eventBatchMax,
      maxBytes: config.eventBatchMaxKb * 1024,
      coalesce: config.coalesceDeltas,
      setTimer,
      clearTimer,
      metrics: this.metrics
    });
    this.uploader = new EventUploader({ client: this.client, outbox: this.outbox, reconnect: this.reconnect, logger, maxRetryDelayMs: config.maxRetryDelayMs, metrics: this.metrics });
    this.transport = new CloudTransport({ buffer: this.buffer, uploader: this.uploader, reconnect: this.reconnect, sequence: this.sequence, machineId: config.machineId, logger });
    this.localTransport = new LocalTransport({ logger });
    this.transports = new CompositeTransport([this.localTransport, this.transport]);
    this.heartbeat = new Heartbeat({
      client: this.client,
      intervalMs: config.heartbeatSeconds * 1000,
      stateProvider: () => this.#machineState(),
      logger,
      protocolVersion: config.protocolVersion,
      setTimer,
      clearTimer,
      metrics: this.metrics
    });
    // Approvals are owned by TaskManager (shared with the local UI); the cloud
    // path only forwards APPROVAL_RESPONSE commands into it.
    this.dispatcher = new CommandDispatcher({
      manager,
      ledger: new CommandLedger({ store }),
      logger,
      metrics: this.metrics
    });

    this.mux.addTransport(this.transport);
    this.mux.attach(manager);
    this.transport.onCommand(command => this.dispatcher.handle(command));
    this.heartbeat.on('sent', payload => { this.lastHeartbeatAt = payload.timestamp; this.reconnect.markConnected(); });
    this.heartbeat.on('failed', () => this.reconnect.markDisconnected('heartbeat_failed'));
  }

  get enabled() { return this.config.enabled === true; }

  async start() {
    if (!this.enabled || this.running) return this;
    this.running = true;
    await this.outbox.init();
    this.logger('info', {
      component: 'CloudWorker',
      event: 'starting',
      url: this.config.url,
      machineId: this.config.machineId,
      secretFingerprint: secretFingerprint(this.config.machineSecret),
      protocolVersion: this.config.protocolVersion
    });

    await this.transports.start();
    await this.reconcile().catch(error => {
      this.logger('warn', { component: 'CloudWorker', event: 'reconcile_failed', code: error?.code || null });
    });
    this.heartbeat.start();
    this.#schedulePoll(0);
    return this;
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer != null) { this.clearTimer(this.pollTimer); this.pollTimer = null; }
    this.heartbeat.stop();
    await this.transports.stop().catch(() => {});
    this.mux.detach();
    this.logger('info', { component: 'CloudWorker', event: 'stopped' });
  }

  #machineState() {
    const tasks = this.manager.listTasks();
    const active = tasks.find(task => task.id === this.manager.activeTaskId);
    const queued = tasks.filter(task => task.status === 'QUEUED').length;
    const running = tasks.some(task => RUNNING_LOCAL_STATUSES.has(task.status));
    return {
      displayName: this.config.machineDisplayName || null,
      version: this.version,
      status: active || running ? 'BUSY' : 'ONLINE',
      activeTaskId: active?.id ?? null,
      queuedTasks: queued,
      capabilities: { pi: true, git: true, worktree: true },
      commandCapabilities: {
        followUp: true,
        abort: true,
        compact: true,
        approvals: typeof this.manager.approvalEnabled === 'function' ? this.manager.approvalEnabled() : false,
        setModel: typeof this.manager.setModel === 'function',
        setThinking: typeof this.manager.setThinkingLevel === 'function',
        toolStreaming: true
      }
    };
  }

  // Startup reconciliation (§72). The cloud learns which tasks the machine still
  // has and how far its event log goes, so a machine restart while offline
  // cannot leave the cloud believing a finished task is still running.
  async reconcile() {
    const activeTasks = this.manager.listTasks()
      .filter(task => !isTerminalState(this.#cloudState(task)))
      .map(task => ({ taskId: task.id, status: this.#cloudState(task), updatedAt: task.updatedAt ?? null }));
    const outboxSeqs = await this.outbox.pendingEventSeqs();
    const lastEventSeqByTask = { ...this.sequence.snapshot() };
    for (const [taskId, seq] of Object.entries(outboxSeqs)) {
      lastEventSeqByTask[taskId] = Math.max(lastEventSeqByTask[taskId] ?? 0, seq);
    }
    const payload = {
      machineId: this.config.machineId,
      protocolVersion: this.config.protocolVersion,
      version: this.version,
      activeTasks,
      lastEventSeqByTask,
      lastCommandSeq: this.dispatcher.lastSeq
    };
    const response = await this.client.reconcile(payload);
    this.reconciled = { at: new Date().toISOString(), activeTasks: activeTasks.length, response: response ?? null };
    this.reconnect.markConnected();
    this.logger('info', {
      component: 'CloudWorker',
      event: 'reconciled',
      activeTasks: activeTasks.length,
      pendingTasks: response?.pendingCommands ?? null
    });
    return this.reconciled;
  }

  #cloudState(task) {
    const map = {
      QUEUED: 'QUEUED',
      PREPARING: 'STARTING',
      PREFLIGHT: 'STARTING',
      RUNNING: 'RUNNING',
      WAITING_USER: 'WAITING_USER',
      VERIFYING: 'RUNNING',
      CANCELLING: 'STOPPING',
      SUCCEEDED: 'COMPLETED',
      FAILED: 'FAILED',
      CANCELLED: 'ABORTED'
    };
    return map[task?.status] || 'RUNNING';
  }

  #pollDelayMs() {
    const busy = Boolean(this.manager.activeTaskId) || this.manager.listTasks().some(task => RUNNING_LOCAL_STATUSES.has(task.status));
    const seconds = busy ? this.config.activePollSeconds : this.config.idlePollSeconds;
    return Math.max(100, seconds * 1000);
  }

  #schedulePoll(delay = null) {
    if (!this.running) return;
    if (this.pollTimer != null) this.clearTimer(this.pollTimer);
    this.pollTimer = this.setTimer(() => {
      this.pollTimer = null;
      this.poll().finally(() => this.#schedulePoll());
    }, delay ?? this.#pollDelayMs());
    this.pollTimer?.unref?.();
  }

  async poll() {
    if (!this.running || this.polling) return null;
    this.polling = true;
    try {
      const after = this.dispatcher.lastSeq;
      const response = await this.client.fetchCommands({ after, limit: 50 });
      this.reconnect.markConnected();
      this.lastPollAt = new Date().toISOString();
      this.lastPollError = null;
      const commands = [...(response?.commands || [])].sort(compareCommands);
      for (const command of commands) {
        if (!this.running) break;
        const result = await this.dispatcher.handle(command).catch(error => ({
          status: 'FAILED',
          error: { code: error?.code || 'INTERNAL_ERROR', message: error?.message || String(error) }
        }));
        await this.client.ackCommand(command.commandId, result.status, result.detail ? { detail: result.detail } : null).catch(error => {
          // The command stays unacknowledged in the cloud; idempotency makes a
          // redelivery safe, which is exactly why the ledger is persisted.
          this.logger('warn', { component: 'CloudWorker', event: 'ack_failed', commandId: command.commandId, code: error?.code || null });
        });
      }
      return commands.length;
    } catch (error) {
      this.lastPollError = error?.code || error?.message || String(error);
      this.reconnect.markDisconnected(error?.code || 'poll_failed');
      if (error?.retryable !== false) this.reconnect.schedule(() => this.poll());
      return null;
    } finally {
      this.polling = false;
    }
  }

  // Local sequence vs uploaded sequence per task (§89 task_event_lag).
  eventLag() {
    const uploaded = this.uploader.snapshot().lastUploadedSeq;
    const lag = {};
    for (const [taskId, seq] of Object.entries(this.sequence.snapshot())) {
      lag[taskId] = Math.max(0, seq - (uploaded[taskId] ?? 0));
      this.metrics.set('task_event_lag', lag[taskId], { taskId });
    }
    return lag;
  }

  async status() {
    const outbox = await this.outbox.stats().catch(() => null);
    const lag = this.eventLag();
    return {
      enabled: this.enabled,
      running: this.running,
      url: this.config.url,
      machineId: this.config.machineId,
      machineDisplayName: this.config.machineDisplayName || null,
      protocolVersion: this.config.protocolVersion,
      authMode: this.config.authMode,
      connected: this.reconnect.connected,
      realtime: false, // WebSocket fast path is Phase 2; polling is authoritative.
      lastHeartbeat: this.lastHeartbeatAt,
      lastPollAt: this.lastPollAt,
      lastPollError: this.lastPollError,
      pendingEvents: this.buffer.pendingCount + (outbox?.events ?? 0),
      outbox,
      lastUploadedSeq: this.uploader.snapshot().lastUploadedSeq,
      eventLag: lag,
      metrics: this.metrics.snapshot(),
      lastCommandSeq: this.dispatcher.lastSeq,
      reconcile: this.reconciled,
      buffer: this.buffer.snapshot(),
      dispatcher: { ...this.dispatcher.stats },
      approvals: this.manager.approvals?.snapshot?.() ?? null,
      reconnect: this.reconnect.stats()
    };
  }
}
