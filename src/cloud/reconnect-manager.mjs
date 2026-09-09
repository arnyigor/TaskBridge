import { EventEmitter } from 'node:events';

// Retry scheduling for anything that talks to the cloud (§19, §45, §80).
// Delays follow the documented ramp 1s, 2s, 4s, 8s, 15s, 30s (capped).

export const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

export class ReconnectManager extends EventEmitter {
  constructor({ backoffMs = DEFAULT_BACKOFF_MS, maxDelayMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout, metrics = null } = {}) {
    super();
    this.metrics = metrics;
    this.backoff = backoffMs.map(value => Math.min(value, maxDelayMs));
    this.maxDelayMs = maxDelayMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.attempt = 0;
    this.timer = null;
    this.connected = false;
    this.reconnects = 0;
  }

  nextDelay() {
    const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)] ?? this.maxDelayMs;
    this.attempt += 1;
    return Math.min(delay, this.maxDelayMs);
  }

  markConnected() {
    if (!this.connected) this.emit('connected');
    this.connected = true;
    this.attempt = 0;
  }

  markDisconnected(reason = 'unknown') {
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) {
      this.reconnects += 1;
      this.metrics?.increment('realtime_reconnect_count');
      this.emit('disconnected', reason);
    }
  }

  // Schedules `task` with backoff; repeated calls do not stack timers.
  schedule(task) {
    if (this.timer != null) return this.timer;
    const delay = this.nextDelay();
    this.emit('retry', delay);
    this.timer = this.setTimer(() => {
      this.timer = null;
      Promise.resolve().then(task).catch(() => {});
    }, delay);
    this.timer?.unref?.();
    return this.timer;
  }

  cancel() {
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  stats() {
    return { connected: this.connected, attempt: this.attempt, reconnects: this.reconnects, retryScheduled: this.timer != null };
  }
}
