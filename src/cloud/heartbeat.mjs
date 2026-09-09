import { EventEmitter } from 'node:events';
import { buildMachineHeartbeat } from '../domain/machine-state.mjs';

// Periodic machine state publication (§20). The cloud uses it for the machine
// dashboard and to decide whether a queued task can start.

export class Heartbeat extends EventEmitter {
  constructor({ client, intervalMs = 20000, stateProvider = () => ({}), logger = null, protocolVersion = 1, setTimer = setTimeout, clearTimer = clearTimeout, metrics = null }) {
    super();
    this.metrics = metrics;
    this.client = client;
    this.intervalMs = intervalMs;
    this.stateProvider = stateProvider;
    this.logger = logger;
    this.protocolVersion = protocolVersion;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.stopped = false;
    this.stats = { sent: 0, failures: 0, lastAt: null, lastError: null };
  }

  build() {
    const state = this.stateProvider() || {};
    return buildMachineHeartbeat({
      machineId: this.client.machineId,
      displayName: state.displayName ?? null,
      version: state.version ?? null,
      status: state.status ?? 'ONLINE',
      activeTaskId: state.activeTaskId ?? null,
      queuedTasks: state.queuedTasks ?? 0,
      capabilities: state.capabilities || {},
      commandCapabilities: state.commandCapabilities || {},
      protocolVersion: this.protocolVersion
    });
  }

  async sendOnce() {
    const payload = this.build();
    try {
      await this.client.heartbeat(payload);
      this.stats.sent += 1;
      this.stats.lastAt = payload.timestamp;
      this.stats.lastError = null;
      this.emit('sent', payload);
      return payload;
    } catch (error) {
      this.stats.failures += 1;
      this.stats.lastError = error?.code || error?.message || String(error);
      this.metrics?.increment('heartbeat_failure_count');
      this.logger?.('warn', { component: 'Heartbeat', event: 'heartbeat_failed', code: error?.code || null });
      this.emit('failed', error);
      throw error;
    }
  }

  start() {
    if (this.timer || this.stopped) return;
    const tick = async () => {
      this.timer = null;
      try { await this.sendOnce(); } catch { /* retried by the next tick */ }
      if (!this.stopped) {
        this.timer = this.setTimer(tick, this.intervalMs);
        this.timer?.unref?.();
      }
    };
    this.timer = this.setTimer(tick, 0);
    this.timer?.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
