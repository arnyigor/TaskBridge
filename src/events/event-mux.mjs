import { EventEmitter } from 'node:events';
import { EventNormalizer } from './event-normalizer.mjs';
import { EventSequence, uuidv7 } from './event-sequence.mjs';
import { SnapshotPolicy, createSnapshotState } from './event-snapshot.mjs';
import { sanitizeForCloud, buildPathAliases } from '../cloud/sanitize.mjs';
import { isDurableEvent } from '../domain/task-event.mjs';

// EventMux is the single place where local task activity becomes a sequenced,
// normalized, sanitized TaskEvent stream (§8, §23–§31, §114 steps 1–2).
//
// Sequence allocation happens here, before any transport sees the event, so the
// same seq is used by every transport and by the local /debug/cloud view.

const MAX_TASK_STATES = 200;

export class EventMux extends EventEmitter {
  constructor({
    machineId,
    sequence = null,
    normalizer = null,
    snapshotPolicy = null,
    aliases = {},
    redactPaths = true,
    largePayloadBytes = 4 * 1048576,
    logger = null,
    now = () => new Date().toISOString(),
    nowMs = () => Date.now()
  } = {}) {
    super();
    this.machineId = machineId;
    this.sequence = sequence || new EventSequence();
    this.normalizer = normalizer || new EventNormalizer({ now });
    this.snapshotPolicy = snapshotPolicy || new SnapshotPolicy();
    this.aliases = buildPathAliases(aliases);
    this.redactPaths = redactPaths;
    this.largePayloadBytes = largePayloadBytes;
    this.logger = logger;
    this.now = now;
    this.nowMs = nowMs;
    this.transports = new Set();
    this.snapshots = new Map();
    this.taskOrder = [];
    this.stats = { published: 0, durable: 0, snapshots: 0, dropped: 0 };
  }

  attach(manager) {
    this.manager = manager;
    this.onTaskEvent = (event) => {
      try { this.handleLocalEvent(event); }
      catch (error) { this.logger?.('error', { component: 'EventMux', event: 'normalize_failed', code: error?.code || null, message: error?.message }); }
    };
    manager.on('task-event', this.onTaskEvent);
    return this;
  }

  detach() {
    if (this.manager && this.onTaskEvent) this.manager.off('task-event', this.onTaskEvent);
    this.manager = null;
  }

  addTransport(transport) {
    if (transport) this.transports.add(transport);
    return this;
  }

  removeTransport(transport) {
    this.transports.delete(transport);
  }

  // Called for events that do not originate from TaskManager, e.g.
  // approval_required / approval_resolved.
  publishLocal(taskId, type, payload, { timestamp = this.now() } = {}) {
    return this.#publish([{ taskId, type, payload, timestamp }]);
  }

  handleLocalEvent(event) {
    if (!event?.taskId) return [];
    const normalized = this.normalizer.normalizeLocalEvent(event.taskId, event);
    const withTask = normalized.map(item => ({ ...item, taskId: event.taskId }));
    return this.#publish(withTask);
  }

  #publish(events) {
    const out = [];
    for (const event of events) {
      if (!event?.taskId || !event.type) continue;
      this.#track(event.taskId);
      const seq = this.sequence.allocate(event.taskId);
      const normalized = {
        eventId: uuidv7(Date.parse(event.timestamp) || Date.now()),
        machineId: this.machineId,
        taskId: event.taskId,
        seq,
        timestamp: event.timestamp || this.now(),
        type: event.type,
        payload: this.#sanitize(event.payload ?? {}, event.type)
      };
      if (event.seqFrom != null) normalized.seqFrom = event.seqFrom;
      if (event.seqTo != null) normalized.seqTo = event.seqTo;
      out.push(normalized);
      this.stats.published += 1;
      if (isDurableEvent(normalized.type)) this.stats.durable += 1;

      // Snapshot bookkeeping runs on the *normalized* events so a coalesced
      // batch and the raw deltas behave identically.
      if (normalized.type === 'assistant_delta') {
        const state = this.#snapshotState(event.taskId);
        this.snapshotPolicy.note(state, normalized.payload.messageId, normalized.payload.text, this.nowMs());
        if (this.snapshotPolicy.due(state, this.nowMs())) {
          const text = this.normalizer.assistantText(event.taskId);
          if (text) {
            this.snapshotPolicy.mark(state, this.nowMs());
            out.push(this.#snapshotEvent(event.taskId, normalized.payload.messageId, text));
          }
        }
      }
      if (normalized.type === 'assistant_end' || normalized.type === 'turn_finished') {
        const state = this.snapshots.get(event.taskId);
        if (state) { state.messageId = null; state.bytes = 0; state.lastAt = this.nowMs(); }
      }
      if (normalized.type === 'task_finished' || normalized.type === 'task_failed' || normalized.type === 'task_aborted') {
        this.snapshots.delete(event.taskId);
      }
    }

    if (out.length) {
      for (const transport of this.transports) {
        try { transport.publishEvents(out); }
        catch (error) { this.logger?.('warn', { component: 'EventMux', event: 'transport_failed', message: error?.message }); }
      }
      for (const event of out) this.emit('event', event);
    }
    return out;
  }

  #snapshotEvent(taskId, messageId, text) {
    this.stats.snapshots += 1;
    return {
      eventId: uuidv7(),
      machineId: this.machineId,
      taskId,
      seq: this.sequence.allocate(taskId),
      timestamp: this.now(),
      type: 'assistant_snapshot',
      payload: { messageId, text: this.#sanitize(text) }
    };
  }

  #sanitize(value, type = null) {
    // An explicit "load full output" payload is allowed to be larger than a
    // normal event, but still bounded and redacted (§38, §68).
    const maxString = type === 'tool_output_full' ? this.largePayloadBytes : undefined;
    return sanitizeForCloud(value, { redactPaths: this.redactPaths, aliases: this.aliases, ...(maxString ? { maxString } : {}) });
  }

  #snapshotState(taskId) {
    let state = this.snapshots.get(taskId);
    if (!state) {
      state = createSnapshotState(this.nowMs());
      this.snapshots.set(taskId, state);
    }
    return state;
  }

  #track(taskId) {
    if (this.taskOrder.includes(taskId)) return;
    this.taskOrder.push(taskId);
    if (this.taskOrder.length <= MAX_TASK_STATES) return;
    const evicted = this.taskOrder.shift();
    this.snapshots.delete(evicted);
    this.normalizer.forget(evicted);
  }

  forgetTask(taskId) {
    this.taskOrder = this.taskOrder.filter(id => id !== taskId);
    this.snapshots.delete(taskId);
    this.normalizer.forget(taskId);
  }

  lastSeqByTask() {
    return this.sequence.snapshot();
  }

  snapshot() {
    return {
      machineId: this.machineId,
      transports: this.transports.size,
      tasks: this.taskOrder.length,
      ...this.stats
    };
  }
}
