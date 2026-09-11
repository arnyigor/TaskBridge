import crypto from 'node:crypto';

// TaskBridge Client Protocol (§ cloud stage).
//
// One wire format for every client of a machine — the local browser, the phone
// PWA, and a future Android client — and for the machine itself:
//
//   client ── WSS ──► relay ── WSS ──► machine (PC) ──► Pi
//
// The relay only needs the routing fields below to deliver a frame to the right
// machine; the contents ride in `payload`, which becomes ciphertext as soon as
// E2EE is switched on (§ docs/cloud-protocol.md). The PC stays the source of
// truth: no session, task or event history is stored in the cloud.

export const PROTOCOL_VERSION = 2;

// A frame must stay small enough to be one WebSocket message. Anything larger
// travels as a file reference, not as an inline payload.
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_PAYLOAD_BYTES = 200 * 1024;

export const MESSAGE_TYPES = new Set([
  'HELLO',        // client → relay/machine: introduce this connection
  'AUTH_OK',      // machine/client → peer: credentials accepted
  'AUTH_FAIL',    // → peer: rejected, with a reason code
  'MACHINE_STATUS', // machine → clients: online/offline, protocol version, load
  'PEER_JOINED',  // relay → machine: an authenticated client joined (push status)
  'SESSION_LIST',   // machine → clients: sessions a client may attach to
  'ATTACH',       // client → machine: start receiving this session
  'DETACH',       // client → machine: stop receiving it
  'SYNC',         // client → machine: replay everything after `afterSeq`
  'COMMAND',      // client → machine: do something (never replayed blindly)
  'COMMAND_ACK',  // machine → client: accepted/duplicate/rejected + result
  'EVENT',        // machine → clients: one session event with a monotonic seq
  'PING',
  'PONG',
  'ERROR'         // either way: routing/protocol level problem
]);

// Command acknowledgements. UNKNOWN_AFTER_CRASH is a first-class state: after a
// crash the machine may have executed a command without recording the answer,
// and the protocol must say so instead of silently retrying.
export const COMMAND_STATES = new Set([
  'ACCEPTED', 'DISPATCHING', 'COMPLETED', 'DUPLICATE', 'REJECTED', 'UNKNOWN_AFTER_CRASH'
]);

const fail = (message, code = 'PROTOCOL_INVALID') => Object.assign(new Error(message), { code });
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isSeq = value => Number.isSafeInteger(value) && value >= 0;

// Canonical JSON: object keys sorted, so the same command content always hashes
// the same and a redelivered commandId with different content can be detected.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Stable id for the content of a command payload (idempotency guard). */
export function commandPayloadHash(payload) {
  return crypto.createHash('sha256').update(canonical(payload ?? null)).digest('hex');
}

export function newCommandId() {
  return crypto.randomUUID();
}

// What each message must carry for the relay and the peer to act on it. The
// routing fields are visible to the relay; `payload` is not (it is opaque, and
// encrypted once E2EE is on).
const REQUIRED = {
  HELLO: [],
  AUTH_OK: [],
  AUTH_FAIL: [],
  MACHINE_STATUS: ['machineId'],
  PEER_JOINED: ['machineId'],
  SESSION_LIST: ['machineId'],
  ATTACH: ['machineId', 'sessionId'],
  DETACH: ['machineId', 'sessionId'],
  SYNC: ['machineId', 'sessionId'],
  COMMAND: ['machineId', 'commandId'],
  COMMAND_ACK: ['machineId', 'commandId', 'status'],
  EVENT: ['machineId', 'sessionId', 'seq'],
  PING: [],
  PONG: [],
  ERROR: []
};

/**
 * Builds a validated envelope. Throws PROTOCOL_INVALID on anything malformed,
 * so no half-built frame ever reaches a socket.
 */
export function createEnvelope({ type, machineId = null, sessionId = null, commandId = null, seq = null,
  status = null, from = null, to = null, payload = null, id = crypto.randomUUID(), ts = new Date().toISOString() } = {}) {
  return validateEnvelope({ v: PROTOCOL_VERSION, id, ts, type, machineId, sessionId, commandId, seq, status, from, to, payload });
}

/** Validates an envelope object (or JSON string) and returns it unchanged. */
export function parseEnvelope(input) {
  let value = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_FRAME_BYTES) throw fail(`Frame exceeds ${MAX_FRAME_BYTES} bytes`, 'FRAME_TOO_LARGE');
    try { value = JSON.parse(input); }
    catch { throw fail('Frame is not valid JSON'); }
  }
  return validateEnvelope(value);
}

export function serializeEnvelope(envelope) {
  const text = JSON.stringify(validateEnvelope(envelope));
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) throw fail(`Frame exceeds ${MAX_FRAME_BYTES} bytes`, 'FRAME_TOO_LARGE');
  return text;
}

function validateEnvelope(value) {
  if (!isPlainObject(value)) throw fail('Envelope must be an object');
  if (value.v !== PROTOCOL_VERSION) throw fail(`Unsupported protocol version: ${value.v}`, 'PROTOCOL_VERSION');
  if (typeof value.type !== 'string' || !MESSAGE_TYPES.has(value.type)) throw fail(`Unknown message type: ${value.type}`);
  if (typeof value.id !== 'string' || !value.id.trim()) throw fail('Envelope id is required');
  if (typeof value.ts !== 'string' || !Number.isFinite(Date.parse(value.ts))) throw fail('Envelope timestamp is required');

  for (const field of ['machineId', 'sessionId', 'commandId', 'status', 'from', 'to']) {
    const field_ = value[field];
    if (field_ !== null && field_ !== undefined && typeof field_ !== 'string') throw fail(`${field} must be a string`);
  }
  for (const field of REQUIRED[value.type]) {
    const required = value[field];
    if (required === null || required === undefined || required === '') throw fail(`${value.type} requires ${field}`);
  }
  if (value.type === 'COMMAND_ACK' && !COMMAND_STATES.has(value.status)) throw fail(`Unknown command status: ${value.status}`);
  if (value.seq !== null && value.seq !== undefined && !isSeq(value.seq)) throw fail('seq must be a non-negative integer');
  if (value.afterSeq !== undefined && !isSeq(value.afterSeq)) throw fail('afterSeq must be a non-negative integer');

  const payload = value.payload ?? null;
  if (payload !== null && typeof payload !== 'string' && !isPlainObject(payload)) throw fail('payload must be an object, a string or null');
  if (payload !== null) {
    // Ciphertext arrives as a string; everything else is measured after
    // serialization, so an oversized envelope never reaches a socket.
    const size = typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (size > MAX_PAYLOAD_BYTES) throw fail(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`, 'PAYLOAD_TOO_LARGE');
  }

  return value;
}

/**
 * Whether two COMMAND envelopes carry the same request. Same commandId with the
 * same hash is a retry; the same id with a different hash is a client bug and
 * must be rejected instead of being executed twice.
 */
export function sameCommand(a, b) {
  if (!a || !b || a.type !== 'COMMAND' || b.type !== 'COMMAND') throw fail('sameCommand expects two COMMAND envelopes');
  return a.commandId === b.commandId && commandPayloadHash(a.payload) === commandPayloadHash(b.payload);
}
