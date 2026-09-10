import crypto from 'node:crypto';
import { CloudOutbox } from './cloud-outbox.mjs';
import { CloudClient } from './cloud-client.mjs';
import { CloudCommandDispatcher } from './cloud-commands.mjs';
import { CloudEventState } from './cloud-event-state.mjs';
import { sanitizeEvent } from './cloud-sanitize.mjs';
import { trimStreamingDeltas } from '../event-trim.mjs';

const TERMINAL = new Set(['TASK_CREATED', 'TASK_QUEUED', 'TASK_STARTED', 'TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_CANCELLED']);
const indexEvent = event => TERMINAL.has(event.type) || event.type === 'STATUS';

function urgent(event) {
  if (TERMINAL.has(event.type)) return true;
  const type = event.data?.pi?.type;
  return type === 'tool_execution_start' || type === 'tool_execution_end';
}

export class CloudTransport {
  constructor(manager, config = {}, dataRoot, options = {}) {
    this.manager = manager;
    this.config = config;
    this.dataRoot = dataRoot;
    this.enabled = config.enabled === true;
    this.machineId = String(config.machineId || 'home-pc');
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(this.machineId)) throw Object.assign(new Error('Некорректный cloud.machineId.'), { code: 'INPUT_INVALID' });
    this.secret = options.secret ?? process.env[String(config.machineSecretEnv || 'TASKBRIDGE_MACHINE_SECRET')];
    this.client = options.client || null;
    this.outbox = options.outbox || new CloudOutbox(dataRoot, config);
    this.flushMs = Math.min(Math.max(Number(config.eventFlushMs || 100), 25), 5000);
    this.pollMs = Math.min(Math.max(Number(config.pollIntervalMs || 1500), 250), 60000);
    this.maxBatch = Math.min(Math.max(Number(config.maxBatchEvents || 100), 1), 100);
    this.maxPayloadBytes = Math.min(Math.max(Number(config.maxPayloadKb || 256), 16), 512) * 1024;
    this.running = false;
    this.flushTimer = null;
    this.flushPromise = null;
    this.pollPromise = null;
    this.pollWake = null;
    this.lastError = null;
    this.onTaskEvent = event => { this.enqueueEvent(event).catch(error => { this.lastError = error; }); };
  }

  async start() {
    if (!this.enabled || this.running) return;
    if (!this.secret) throw Object.assign(new Error(`Cloud включён, но переменная ${this.config.machineSecretEnv || 'TASKBRIDGE_MACHINE_SECRET'} не задана.`), { code: 'INPUT_INVALID' });
    this.client ||= new CloudClient(this.config, this.secret);
    await this.outbox.init();
    this.eventState = new CloudEventState(this.dataRoot, this.manager.store);
    await this.eventState.init(this.manager.listTasks(), event => this.enqueueEvent(event));
    this.dispatcher = new CloudCommandDispatcher(this.manager, this.dataRoot, (command, result) => this.enqueueCommandResult(command, result), this.config);
    await this.dispatcher.init();
    this.running = true;
    this.manager.on('task-event', this.onTaskEvent);
    this.scheduleFlush(0);
    this.pollPromise = this.pollLoop();
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.manager.off('task-event', this.onTaskEvent);
    clearTimeout(this.flushTimer);
    this.pollWake?.();
    await Promise.allSettled([this.flushPromise, this.pollPromise]);
  }

  async enqueueEvent(event) {
    const clean = sanitizeEvent(event, { secret: this.secret, maxBytes: this.maxPayloadBytes });
    const record = { eventId: `event_${clean.taskId}_${clean.seq}`, taskId: clean.taskId, index: indexEvent(clean), event: clean };
    await this.outbox.enqueue(record);
    this.scheduleFlush(urgent(clean) ? 0 : this.flushMs);
  }

  async enqueueCommandResult(command, result) {
    const event = sanitizeEvent({
      taskId: command.taskId || `_machine_${this.machineId}`, seq: 0, at: new Date().toISOString(),
      type: 'COMMAND_RESULT', message: command.type, data: { commandId: command.id, commandType: command.type, ...result }
    }, { secret: this.secret, maxBytes: this.maxPayloadBytes });
    await this.outbox.enqueue({ eventId: `command_result_${command.id}`, taskId: event.taskId, index: true, event });
    this.scheduleFlush(0);
  }

  scheduleFlush(delay) {
    if (!this.running) return;
    if (this.flushTimer && delay !== 0) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      try { await this.flushOnce(); }
      catch (error) { this.lastError = error; }
      finally { if (this.running && this.outbox.size() && !this.flushTimer) this.scheduleFlush(this.pollMs); }
    }, delay);
    this.flushTimer.unref?.();
  }

  async flushOnce() {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = (async () => {
      const selected = await this.outbox.take(this.maxBatch, this.maxPayloadBytes);
      if (!selected.length) return;
      // Final message frames supersede completed streaming deltas. This only
      // trims records selected in the same buffered/recovery batch.
      const keptEvents = new Set(trimStreamingDeltas(selected.map(item => item.event)));
      const records = selected.filter(item => keptEvents.has(item.event));
      if (records.length) await this.client.publish(this.machineId, records);
      await this.eventState?.mark(selected);
      await this.outbox.ack(selected.map(item => item.eventId));
      this.lastError = null;
      if (this.outbox.size()) this.scheduleFlush(0);
    })().finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  async pollOnce() {
    const response = await this.client.pull(this.machineId);
    for (const item of response?.messages || []) {
      let acknowledge = false;
      try {
        await this.dispatcher.dispatch(item.command);
        acknowledge = true;
      } catch (error) {
        this.lastError = error;
        acknowledge = Boolean(error.permanent || ['INPUT_INVALID', 'NOT_FOUND'].includes(error.code));
        if (acknowledge) {
          await this.enqueueCommandResult(item.command || { id: crypto.randomUUID(), type: 'INVALID' }, { ok: false, error: error.message, code: error.code });
        }
      }
      if (acknowledge) await this.client.ack(this.machineId, item.receiptHandle);
    }
  }

  async pollLoop() {
    while (this.running) {
      try { await this.pollOnce(); this.lastError = null; }
      catch (error) { this.lastError = error; }
      if (this.running) await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); if (this.pollWake === finish) this.pollWake = null; resolve(); };
        const timer = setTimeout(finish, this.pollMs);
        timer.unref?.();
        this.pollWake = finish;
      });
    }
  }

  status() {
    return { enabled: this.enabled, running: this.running, machineId: this.machineId, pendingEvents: this.outbox.size(), error: this.lastError?.message || null };
  }
}
