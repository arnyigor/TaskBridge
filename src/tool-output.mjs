// Tool output bounding (§38). Large outputs stay local: only a rolling window
// travels to the cloud, the final event always carries a bounded tail, and the
// full log can be fetched later by an explicit request.
//
// Policy:
//   - under the window size  → delta chunks (append on the client);
//   - over the window size   → periodic rolling snapshots (replace on the client);
//   - between snapshots      → progress is dropped (allowed: §118);
//   - final event            → tail + fullLogAvailable + localLogId.

export const DEFAULT_ROLLING_KB = 64;
export const DEFAULT_TAIL_KB = 64;
export const DEFAULT_SNAPSHOT_MS = 500;

function tailUtf8(text, maxBytes) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  // Walk from the end in code points until the byte budget is exhausted.
  let bytes = 0;
  let index = value.length;
  while (index > 0) {
    const code = value.codePointAt(index - 1);
    const size = code > 0xffff ? 4 : code > 0x7ff ? 3 : code > 0x7f ? 2 : 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    index -= code > 0xffff ? 2 : 1;
  }
  return value.slice(index);
}

export class ToolOutputWindow {
  constructor({ rollingBytes = DEFAULT_ROLLING_KB * 1024, tailBytes = DEFAULT_TAIL_KB * 1024, snapshotMs = DEFAULT_SNAPSHOT_MS, now = () => Date.now() } = {}) {
    this.rollingBytes = rollingBytes;
    this.tailBytes = tailBytes;
    this.snapshotMs = snapshotMs;
    this.now = now;
    this.reset();
  }

  reset() {
    this.tail = '';
    this.bytes = 0;
    this.droppedBytes = 0;
    this.truncated = false;
    this.lastSnapshotAt = -Infinity;
    return this;
  }

  // Returns the event payload to publish, or null when the chunk is dropped
  // because a rolling window is already in effect.
  append(chunk) {
    const text = String(chunk ?? '');
    if (!text) return null;
    this.bytes += Buffer.byteLength(text, 'utf8');
    this.tail = tailUtf8(this.tail + text, this.rollingBytes);

    if (this.bytes <= this.rollingBytes) {
      return { mode: 'delta', output: text, truncated: false };
    }
    this.truncated = true;
    const at = this.now();
    if (at - this.lastSnapshotAt < this.snapshotMs) {
      this.droppedBytes += Buffer.byteLength(text, 'utf8');
      return null;
    }
    this.lastSnapshotAt = at;
    return { mode: 'snapshot', output: this.tail, truncated: true };
  }

  // Durable final representation: always bounded, never empty when output existed.
  final() {
    return {
      tail: tailUtf8(this.tail, this.tailBytes),
      outputBytes: this.bytes,
      droppedBytes: this.droppedBytes,
      truncated: this.bytes > this.tailBytes,
      fullLogAvailable: this.bytes > 0
    };
  }

  get state() {
    return { bytes: this.bytes, tailBytes: Buffer.byteLength(this.tail, 'utf8'), truncated: this.truncated, droppedBytes: this.droppedBytes };
  }
}

export { tailUtf8 as tailBytes };
