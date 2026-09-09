import crypto from 'node:crypto';

// Sortable unique ids (§26, §14). Same UUIDv7 layout as the local machine uses
// for eventId, so cloud ids and local ids sort consistently.

export function uuidv7(nowMs = Date.now()) {
  const bytes = crypto.randomBytes(16);
  let ts = BigInt(nowMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function taskId() {
  // The local TaskManager id pattern allows [A-Za-z0-9_-], so the cloud id can
  // be used verbatim as the local task id (no mapping table needed).
  return `task_${uuidv7().replaceAll('-', '')}`;
}

export function commandId() {
  return `cmd_${uuidv7().replaceAll('-', '')}`;
}

export function approvalId() {
  return `approval_${uuidv7().replaceAll('-', '')}`;
}
