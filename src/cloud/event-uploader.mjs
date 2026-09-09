import { EventEmitter } from 'node:events';

// Uploads durable batches from the outbox to the cloud (§44, §45, §73).
//
// Events are never silently dropped: a failed batch stays in the outbox and is
// retried with backoff, even across a process restart.

export class EventUploader extends EventEmitter {
  constructor({ client, outbox, reconnect, logger = null, maxRetryDelayMs = 30000, metrics = null }) {
    super();
    this.metrics = metrics;
    this.client = client;
    this.outbox = outbox;
    this.reconnect = reconnect;
    this.logger = logger;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.draining = null;
    this.pendingEnqueue = Promise.resolve();
    this.stopped = false;
    this.lastUploadedSeq = {};
    this.stats = { batches: 0, events: 0, failures: 0, bytes: 0, lastUploadAt: null, lastError: null };
  }

  // Enqueue first, then try to drain. The batch is durable before any network
  // call is attempted, so a crash mid-upload cannot lose it.
  async send(events) {
    if (this.stopped) return null;
    // The async body starts executing synchronously, so `pendingEnqueue` is set
    // before the caller returns and a concurrent drain() cannot miss it.
    const work = (async () => {
      const record = await this.outbox.enqueue(events, { machineId: this.client.machineId });
      if (!record) return null;
      await this.outbox.enforceLimit().catch(() => {});
      this.emit('queued', record);
      return record;
    })();
    this.pendingEnqueue = work.catch(() => {});
    const record = await work;
    if (record) this.drain().catch(() => {});
    return record;
  }

  async drain() {
    if (this.stopped) return;
    if (this.draining) return this.draining;
    this.draining = (async () => {
      // Several passes: batches enqueued while a pass is running must still be
      // uploaded before drain() resolves, otherwise a caller that flushes and
      // then awaits drain would observe a partially delivered stream.
      for (let pass = 0; pass < 100; pass++) {
        await this.pendingEnqueue.catch(() => {});
        const records = await this.outbox.list();
        if (!records.length) return;
        if (!await this.#drainRecords(records)) return; // failure: retry is scheduled
      }
    })().finally(() => { this.draining = null; });
    return this.draining;
  }

  // Returns false when a batch failed (and a retry was scheduled).
  async #drainRecords(records) {
    for (const [index, record] of records.entries()) {
      if (this.stopped) return;
      try {
        const startedAt = Date.now();
        await this.outbox.markSending(record);
        await this.client.uploadEvents(record.events);
        this.metrics?.observe('cloud_event_upload_latency_ms', Date.now() - startedAt);
        await this.outbox.ack(record);
        this.reconnect.markConnected();
        this.stats.batches += 1;
        this.stats.events += record.events.length;
        this.stats.bytes += Buffer.byteLength(JSON.stringify(record.events), 'utf8');
        this.stats.lastUploadAt = new Date().toISOString();
        this.stats.lastError = null;
        // O(1): how many batches are still queued behind this one.
        this.metrics?.set('cloud_outbox_size', records.length - index - 1);
        for (const event of record.events) {
          if (event.taskId) {
            this.lastUploadedSeq[event.taskId] = Math.max(this.lastUploadedSeq[event.taskId] ?? 0, Number(event.seq) || 0);
          }
        }
        this.logger?.('info', {
          component: 'EventUploader',
          event: 'batch_uploaded',
          batchId: record.id,
          count: record.events.length
        });
        this.emit('uploaded', record);
      } catch (error) {
        await this.outbox.fail(record, error).catch(() => {});
        this.stats.failures += 1;
        this.stats.lastError = error?.code || error?.message || String(error);
        this.metrics?.increment('cloud_event_retry_count');
        this.reconnect.markDisconnected(error?.code || 'upload_failed');
        this.logger?.('warn', {
          component: 'EventUploader',
          event: 'batch_failed',
          batchId: record.id,
          code: error?.code || null,
          attempts: record.attempts
        });
        this.emit('failed', { record, error });
        if (error?.retryable !== false) this.reconnect.schedule(() => this.drain());
        return false;
      }
    }
    return true;
  }

  snapshot() {
    return { ...this.stats, lastUploadedSeq: { ...this.lastUploadedSeq } };
  }

  async stop() {
    this.reconnect.cancel();
    // Flush what is already enqueued before refusing new work, so a clean
    // shutdown does not leave an uploadable batch behind (it stays durable in
    // the outbox either way).
    await this.pendingEnqueue.catch(() => {});
    await this.drain().catch(() => {});
    this.stopped = true;
    await this.draining?.catch(() => {});
  }
}
