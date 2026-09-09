import { EventEmitter } from 'node:events';
import { isHighPriorityEvent, isDurableEvent } from '../domain/task-event.mjs';

// Batching layer between EventMux and the cloud uploader (§28, §29, §39, §47).
//
// Rules implemented here:
//  - never a separate HTTP request per delta (flush interval + size limits);
//  - HIGH priority events flush immediately;
//  - consecutive assistant deltas of the same message may be coalesced into one
//    `assistant_delta_batch`, keeping seqFrom/seqTo so replay stays exact;
//  - durable events are never dropped, only re-ordered within a batch by seq.

const COALESCEABLE = new Set(['assistant_delta']);

export class EventBuffer extends EventEmitter {
  constructor({
    flushMs = 75,
    maxEvents = 100,
    maxBytes = 256 * 1024,
    coalesce = true,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    metrics = null
  } = {}) {
    super();
    this.metrics = metrics;
    this.flushMs = flushMs;
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    this.coalesce = coalesce;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = [];
    this.bytes = 0;
    this.timer = null;
    this.stopped = false;
    this.stats = { pushed: 0, flushed: 0, batches: 0, coalesced: 0 };
  }

  get pendingCount() { return this.pending.length; }
  get pendingBytes() { return this.bytes; }

  push(event) {
    if (this.stopped) return;
    if (!event || typeof event !== 'object') return;
    this.pending.push(event);
    this.bytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
    this.stats.pushed += 1;
    this.metrics?.set('cloud_buffer_pending_events', this.pending.length);
    if (isHighPriorityEvent(event.type)) this.#schedule(0);
    else this.#schedule(this.flushMs);
  }

  pushMany(events = []) {
    for (const event of events) this.push(event);
  }

  #schedule(delay) {
    if (this.timer != null) {
      // An urgent event must not wait for an already scheduled slow flush.
      if (delay !== 0) return;
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flushNow();
    }, delay);
    this.timer?.unref?.();
  }

  // Drains the buffer and emits one 'flush' event per batch.
  flushNow() {
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (!this.pending.length) return [];
    const events = this.coalesce ? this.#coalesce(this.pending) : this.pending;
    this.pending = [];
    this.bytes = 0;

    const batches = [];
    let current = [];
    let currentBytes = 0;
    for (const event of events) {
      const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (current.length && (current.length >= this.maxEvents || currentBytes + size > this.maxBytes)) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(event);
      currentBytes += size;
    }
    if (current.length) batches.push(current);

    this.stats.flushed += events.length;
    this.stats.batches += batches.length;
    this.metrics?.set('cloud_buffer_pending_events', 0);
    for (const batch of batches) {
      this.metrics?.observe('cloud_event_batch_size', batch.length);
      this.emit('flush', batch);
    }
    return batches;
  }

  // Merges runs of consecutive assistant deltas that belong to one message and
  // have contiguous seq numbers. Anything else is passed through untouched.
  #coalesce(events) {
    const out = [];
    let run = null;
    const flushRun = () => {
      if (!run) return;
      if (run.items.length === 1) { out.push(run.items[0]); run = null; return; }
      const first = run.items[0];
      const last = run.items.at(-1);
      this.stats.coalesced += run.items.length - 1;
      out.push({
        ...first,
        type: 'assistant_delta_batch',
        seq: last.seq,
        seqFrom: first.seq,
        seqTo: last.seq,
        payload: { messageId: first.payload?.messageId ?? null, text: run.items.map(item => item.payload?.text || '').join(''), count: run.items.length },
        coalescedFrom: run.items.map(item => item.seq)
      });
      run = null;
    };

    for (const event of events) {
      const canMerge = COALESCEABLE.has(event.type)
        && run
        && run.type === event.type
        && run.messageId === (event.payload?.messageId ?? null)
        && event.seq === run.items.at(-1).seq + 1;
      if (canMerge) {
        run.items.push(event);
        continue;
      }
      flushRun();
      if (COALESCEABLE.has(event.type)) {
        run = { type: event.type, messageId: event.payload?.messageId ?? null, items: [event] };
      } else {
        out.push(event);
      }
    }
    flushRun();
    return out;
  }

  // Under backpressure (§47) intermediate progress may be discarded, but never
  // a durable event. Returns the number of events dropped.
  dropNonCritical() {
    const before = this.pending.length;
    this.pending = this.pending.filter(event => isDurableEvent(event.type));
    this.bytes = this.pending.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0);
    const dropped = before - this.pending.length;
    if (dropped) this.emit('dropped', dropped);
    return dropped;
  }

  stop() {
    this.stopped = true;
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    return this.flushNow();
  }

  snapshot() {
    return { pending: this.pending.length, bytes: this.bytes, ...this.stats };
  }
}
