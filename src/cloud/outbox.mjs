import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDurableEvent } from '../domain/task-event.mjs';

// Local durable outbox (§46, §47, §73). Each batch is one file written with a
// temp file + rename, so a crash can never leave a half-written batch that the
// uploader would fail to parse forever.
//
// States: PENDING → SENDING → ACKNOWLEDGED (deleted) / FAILED_RETRY.

const STATE_PENDING = 'PENDING';
const STATE_SENDING = 'SENDING';
const STATE_FAILED = 'FAILED_RETRY';

function batchId() {
  // Timestamp first, then a process-local counter: batches created in the same
  // millisecond still sort in creation order, so replay order matches the order
  // events were produced. The random suffix only avoids collisions with a
  // different process writing to the same directory.
  batchSequence += 1;
  return `${String(Date.now()).padStart(13, '0')}-${String(batchSequence).padStart(8, '0')}-${crypto.randomBytes(3).toString('hex')}`;
}

let batchSequence = 0;

export class CloudOutbox {
  constructor({ dir, maxBytes = 100 * 1024 * 1024, logger = null }) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.logger = logger;
    this.warned = false;
    // Incremental byte accounting: recomputing it from disk on every enqueue
    // would turn a high event rate into O(files) reads per batch.
    this.bytes = 0;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    // A crash during upload leaves a SENDING marker; treat it as pending again.
    for (const entry of await fs.readdir(this.dir).catch(() => [])) {
      if (!entry.endsWith('.json')) continue;
      const file = path.join(this.dir, entry);
      const record = await this.#read(file);
      if (!record) continue;
      this.bytes += Buffer.byteLength(JSON.stringify(record.events), 'utf8');
      if (record.state === STATE_SENDING) {
        record.state = STATE_PENDING;
        await this.#write(file, record);
      }
    }
    return this;
  }

  #file(id) {
    return path.join(this.dir, `batch-${id}.json`);
  }

  async #read(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { return null; }
  }

  async #write(file, record) {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(record), 'utf8');
    await fs.rename(tmp, file);
  }

  async enqueue(events, { machineId = null } = {}) {
    const list = (events || []).filter(Boolean);
    if (!list.length) return null;
    const id = batchId();
    const record = {
      id,
      machineId,
      createdAt: new Date().toISOString(),
      state: STATE_PENDING,
      attempts: 0,
      lastError: null,
      events: list
    };
    await this.#write(this.#file(id), record);
    this.bytes += Buffer.byteLength(JSON.stringify(list), 'utf8');
    return record;
  }

  // Oldest first: batches are named by creation time, so plain name order is
  // delivery order and replay stays monotonic.
  async list() {
    const names = (await fs.readdir(this.dir).catch(() => []))
      .filter(name => name.startsWith('batch-') && name.endsWith('.json'))
      .sort();
    const out = [];
    for (const name of names) {
      const record = await this.#read(path.join(this.dir, name));
      if (record) out.push({ file: path.join(this.dir, name), ...record });
    }
    return out;
  }

  async markSending(record) {
    record.state = STATE_SENDING;
    await this.#write(record.file, record);
  }

  async ack(record) {
    await fs.rm(record.file, { force: true }).catch(() => {});
    this.bytes = Math.max(0, this.bytes - Buffer.byteLength(JSON.stringify(record.events), 'utf8'));
  }

  async fail(record, error) {
    record.state = STATE_FAILED;
    record.attempts = Number(record.attempts || 0) + 1;
    record.lastError = String(error?.code || error?.message || error).slice(0, 300);
    await this.#write(record.file, record);
    return record;
  }

  // O(1): the counter is maintained by enqueue/ack/enforceLimit and seeded at
  // init from disk.
  async sizeBytes() {
    return this.bytes;
  }

  async stats() {
    const records = await this.list();
    let bytes = 0;
    let events = 0;
    let attempts = 0;
    for (const record of records) {
      bytes += Buffer.byteLength(JSON.stringify(record.events), 'utf8');
      events += record.events.length;
      attempts += Number(record.attempts || 0);
    }
    return { batches: records.length, events, bytes, attempts, oldest: records[0]?.createdAt ?? null };
  }

  // Backpressure (§47). Durable semantic state is never dropped: when the limit
  // is hit, only non-durable progress events are removed, from the newest batch
  // backwards (the oldest state is the most valuable for replay).
  async enforceLimit() {
    let bytes = this.bytes;
    if (bytes <= this.maxBytes) { this.warned = false; return 0; }
    let dropped = 0;
    const records = (await this.list()).reverse();
    for (const record of records) {
      if (bytes <= this.maxBytes) break;
      const kept = record.events.filter(event => isDurableEvent(event.type));
      const removed = record.events.length - kept.length;
      if (!removed) continue;
      dropped += removed;
      bytes -= Buffer.byteLength(JSON.stringify(record.events), 'utf8') - Buffer.byteLength(JSON.stringify(kept), 'utf8');
      record.events = kept;
      if (kept.length) await this.#write(record.file, record);
      else await fs.rm(record.file, { force: true }).catch(() => {});
    }
    this.bytes = Math.max(0, bytes);
    if (dropped) {
      this.logger?.('warn', {
        component: 'CloudOutbox',
        event: 'backpressure_dropped',
        dropped,
        bytes,
        limit: this.maxBytes
      });
    }
    return dropped;
  }

  // Used by restart recovery (§73) to seed the uploader and to know which tasks
  // still have events the cloud has not seen.
  async pendingEventSeqs() {
    const lastByTask = {};
    for (const record of await this.list()) {
      for (const event of record.events) {
        const current = lastByTask[event.taskId] ?? 0;
        lastByTask[event.taskId] = Math.max(current, Number(event.seq) || 0);
      }
    }
    return lastByTask;
  }

  async clear() {
    await fs.rm(this.dir, { recursive: true, force: true });
    await fs.mkdir(this.dir, { recursive: true });
  }
}
