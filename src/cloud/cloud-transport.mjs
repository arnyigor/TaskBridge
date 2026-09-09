import { EventEmitter } from 'node:events';
import { uuidv7 } from '../events/event-sequence.mjs';

// Transport abstraction (§9). TaskManager and EventMux only know this shape, so
// cloud support is an additional transport rather than a rewrite of the local
// runtime.

export class LocalTransport extends EventEmitter {
  constructor({ logger = null } = {}) {
    super();
    this.logger = logger;
    this.started = false;
    this.count = 0;
  }

  async start() { this.started = true; }
  async stop() { this.started = false; }

  publishEvents(events = []) {
    this.count += events.length;
    for (const event of events) this.emit('event', event);
  }

  publishTaskState(state) { this.emit('task-state', state); }
  publishHeartbeat(heartbeat) { this.emit('heartbeat', heartbeat); }
  onCommand(callback) { this.on('command', callback); }
  isConnected() { return this.started; }

  snapshot() { return { kind: 'local', started: this.started, events: this.count }; }
}

// Buffers events, uploads them through the outbox and reports connection state
// from the reconnect manager.
export class CloudTransport extends EventEmitter {
  constructor({ buffer, uploader, reconnect = null, sequence = null, machineId = null, logger = null }) {
    super();
    this.buffer = buffer;
    this.uploader = uploader;
    this.reconnect = reconnect;
    this.sequence = sequence;
    this.machineId = machineId;
    this.logger = logger;
    this.started = false;
    this.commandHandlers = new Set();

    this.buffer.on('flush', (events) => {
      this.uploader.send(events).catch((error) => {
        this.logger?.('warn', { component: 'CloudTransport', event: 'send_failed', code: error?.code || null });
      });
    });
    this.buffer.on('dropped', (count) => {
      this.logger?.('warn', { component: 'CloudTransport', event: 'buffer_dropped', count });
    });
  }

  async start() {
    this.started = true;
    // Recover anything the previous process left in the outbox (§73).
    await this.uploader.drain().catch(() => {});
  }

  async stop() {
    this.started = false;
    this.buffer.stop();
    await this.uploader.stop().catch(() => {});
  }

  publishEvents(events = []) {
    if (!this.started) return;
    this.buffer.pushMany(events);
  }

  // TaskManager never calls this (EventMux publishes task_state events), but the
  // transport interface (§9) requires it. Without a sequence allocator there is
  // no valid cursor, so the event is emitted locally only.
  publishTaskState(state) {
    if (!this.started) return;
    if (!this.sequence || !this.machineId || !state?.taskId) { this.emit('task-state', state); return; }
    this.publishEvents([{
      eventId: uuidv7(),
      machineId: this.machineId,
      taskId: state.taskId,
      seq: this.sequence.allocate(state.taskId),
      timestamp: state.timestamp || new Date().toISOString(),
      type: 'task_state',
      payload: { status: state.status, current: state.current ?? null }
    }]);
  }

  publishHeartbeat(heartbeat) { this.emit('heartbeat', heartbeat); }

  onCommand(callback) {
    this.commandHandlers.add(callback);
    return () => this.commandHandlers.delete(callback);
  }

  // Used by CloudWorker when a command arrives over polling or realtime.
  async dispatchCommand(command) {
    for (const handler of this.commandHandlers) await handler(command);
  }

  isConnected() {
    if (!this.started) return false;
    if (!this.reconnect) return true;
    return this.reconnect.connected;
  }

  snapshot() {
    return {
      kind: 'cloud',
      started: this.started,
      connected: this.isConnected(),
      buffer: this.buffer.snapshot(),
      uploader: this.uploader.snapshot(),
      reconnect: this.reconnect?.stats?.() ?? null
    };
  }
}

// Hybrid mode (§6.3): the same local events feed several transports at once.
export class CompositeTransport extends EventEmitter {
  constructor(transports = []) {
    super();
    this.transports = [...transports];
  }

  add(transport) {
    if (transport) this.transports.push(transport);
    return this;
  }

  remove(transport) {
    this.transports = this.transports.filter(item => item !== transport);
  }

  async start() {
    await Promise.all(this.transports.map(t => t.start()));
  }

  async stop() {
    await Promise.all(this.transports.map(t => t.stop()));
  }

  publishEvents(events = []) {
    for (const transport of this.transports) {
      try { transport.publishEvents(events); }
      catch (error) { this.emit('error', error); }
    }
  }

  publishTaskState(state) {
    for (const transport of this.transports) {
      try { transport.publishTaskState(state); }
      catch (error) { this.emit('error', error); }
    }
  }

  publishHeartbeat(heartbeat) {
    for (const transport of this.transports) {
      try { transport.publishHeartbeat(heartbeat); }
      catch (error) { this.emit('error', error); }
    }
  }

  onCommand(callback) {
    for (const transport of this.transports) transport.onCommand?.(callback);
  }

  isConnected() {
    return this.transports.some(t => t.isConnected());
  }

  snapshot() {
    return { kind: 'composite', transports: this.transports.map(t => t.snapshot?.() ?? null) };
  }
}
