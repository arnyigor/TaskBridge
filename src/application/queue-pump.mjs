// Serializes queue dispatch and retains wake-ups received during a dispatch.
// Selection, admission and execution remain with the session owner.
export class QueuePump {
  constructor({ isClosing, hasQueued, hasCapacity, dispatch, pollMs }) {
    Object.assign(this, { isClosing, hasQueued, hasCapacity, dispatch, pollMs });
    this.running = false;
    this.again = false;
    this.timer = null;
  }

  schedule() {
    if (this.isClosing() || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      setImmediate(() => this.wake());
    }, this.pollMs());
    this.timer.unref?.();
  }

  stopPolling() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async drain(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.running && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  async wake() {
    if (this.isClosing()) return;
    if (this.running) { this.again = true; return; }
    if (!this.hasQueued()) return;
    this.running = true;
    try {
      do {
        this.again = false;
        const started = await this.dispatch();
        if (started && this.hasQueued()) this.again = true;
      } while (this.again && this.hasQueued() && this.hasCapacity());
    } finally {
      this.running = false;
      if (this.hasQueued()) this.schedule();
    }
  }
}
