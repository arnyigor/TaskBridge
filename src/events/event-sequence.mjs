import crypto from 'node:crypto';

// Local sequence numbers (§24, §25). Allocation happens on the machine before
// transmission, must be monotonic per task, and must survive a restart without
// ever restarting at zero for an existing task (§73).

const META_PREFIX = 'cloud.seq.';

export function nextSeqFrom(previous) {
  const value = Number(previous);
  if (!Number.isSafeInteger(value) || value < 0) return 1;
  return value + 1;
}

export class EventSequence {
  // `store` is optional: without it sequences live in memory only (tests).
  constructor({ store = null, now = () => new Date().toISOString() } = {}) {
    this.store = store;
    this.now = now;
    this.cache = new Map();
  }

  // Restores the persisted cursor for a task. Called on startup and lazily on
  // first allocation, so a task created before a restart keeps counting up.
  load(taskId) {
    if (this.cache.has(taskId)) return this.cache.get(taskId);
    let value = 0;
    if (this.store?.getMeta) {
      value = Number(this.store.getMeta(`${META_PREFIX}${taskId}`) || 0);
    }
    if (!Number.isSafeInteger(value) || value < 0) value = 0;
    this.cache.set(taskId, value);
    return value;
  }

  last(taskId) {
    return this.load(taskId);
  }

  // Reserves the next cursor. The value is written to the store *before* the
  // event can be published, so a crash between publish and persist cannot make
  // the same seq be handed out twice.
  allocate(taskId) {
    const next = nextSeqFrom(this.load(taskId));
    this.cache.set(taskId, next);
    this.store?.setMeta?.(`${META_PREFIX}${taskId}`, String(next));
    return next;
  }

  // Used after a replay/reconciliation read of the cloud or local history, so a
  // restored machine never re-uses a cursor the cloud already knows (§72).
  observe(taskId, seq) {
    const value = Number(seq);
    if (!Number.isSafeInteger(value) || value <= 0) return this.last(taskId);
    const current = this.load(taskId);
    if (value > current) {
      this.cache.set(taskId, value);
      this.store?.setMeta?.(`${META_PREFIX}${taskId}`, String(value));
    }
    return this.last(taskId);
  }

  snapshot() {
    const out = {};
    for (const [taskId, seq] of this.cache) out[taskId] = seq;
    return out;
  }

  forget(taskId) {
    this.cache.delete(taskId);
    this.store?.setMeta?.(`${META_PREFIX}${taskId}`, '0');
  }
}

// Globally unique, sortable event id (§26). UUIDv7 layout: 48-bit big-endian
// unix ms, version/variant bits, then random.
export function uuidv7(nowMs = Date.now()) {
  const bytes = crypto.randomBytes(16);
  let ts = BigInt(nowMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
