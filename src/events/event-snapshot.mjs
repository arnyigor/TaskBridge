// Assistant snapshot policy (§31). Deltas alone are not enough: a client that
// reconnects after a long gap must be able to rebuild the message without
// replaying thousands of chunks, and the final message must always have a
// durable full representation.

export const SNAPSHOT_INTERVAL_MS = 1000;
export const SNAPSHOT_BYTES = 4096;

export function createSnapshotState(nowMs = Date.now()) {
  return { lastAt: nowMs, bytes: 0, messageId: null };
}

export class SnapshotPolicy {
  constructor({ intervalMs = SNAPSHOT_INTERVAL_MS, bytes = SNAPSHOT_BYTES } = {}) {
    this.intervalMs = intervalMs;
    this.bytes = bytes;
  }

  // Records a delta that belongs to `messageId`. A new message always starts a
  // fresh window so the previous message's final snapshot is not delayed.
  note(state, messageId, text, nowMs = Date.now()) {
    if (state.messageId !== messageId) {
      state.messageId = messageId;
      state.lastAt = nowMs;
      state.bytes = 0;
    }
    state.bytes += Buffer.byteLength(String(text ?? ''), 'utf8');
    return state;
  }

  due(state, nowMs = Date.now()) {
    if (!state.messageId) return false;
    if (state.bytes >= this.bytes) return true;
    return nowMs - state.lastAt >= this.intervalMs;
  }

  mark(state, nowMs = Date.now()) {
    state.lastAt = nowMs;
    state.bytes = 0;
    return state;
  }
}
