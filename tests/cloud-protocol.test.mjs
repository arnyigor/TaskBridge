import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION, MAX_FRAME_BYTES, MESSAGE_TYPES,
  createEnvelope, parseEnvelope, serializeEnvelope, commandPayloadHash, newCommandId, sameCommand
} from '../src/cloud/protocol.mjs';

// One wire format for every client of a machine (browser, phone, future
// Android) and for the machine itself. The relay routes on the envelope; the
// payload is opaque (ciphertext once E2EE is on).

test('every message type the protocol names can be built and round-tripped', () => {
  const fields = {
    MACHINE_STATUS: { machineId: 'home-pc' },
    PEER_JOINED: { machineId: 'home-pc' },
    REQUEST: { machineId: 'home-pc', commandId: 'r-1' },
    RESPONSE: { machineId: 'home-pc', commandId: 'r-1', status: 'OK' },
    SESSION_LIST: { machineId: 'home-pc' },
    ATTACH: { machineId: 'home-pc', sessionId: 'tb_1' },
    DETACH: { machineId: 'home-pc', sessionId: 'tb_1' },
    SYNC: { machineId: 'home-pc', sessionId: 'tb_1' },
    COMMAND: { machineId: 'home-pc', commandId: 'c-1' },
    COMMAND_ACK: { machineId: 'home-pc', commandId: 'c-1', status: 'ACCEPTED' },
    EVENT: { machineId: 'home-pc', sessionId: 'tb_1', seq: 42 }
  };
  for (const type of MESSAGE_TYPES) {
    const envelope = createEnvelope({ type, ...(fields[type] || {}) });
    assert.equal(envelope.v, PROTOCOL_VERSION);
    assert.deepEqual(parseEnvelope(serializeEnvelope(envelope)), envelope);
  }
});

test('malformed envelopes are rejected before they reach a socket', () => {
  const cases = [
    [() => createEnvelope({ type: 'NOPE' }), /Unknown message type/],
    [() => createEnvelope({ type: 'COMMAND' }), /COMMAND requires machineId/],
    [() => createEnvelope({ type: 'COMMAND', machineId: 'm' }), /COMMAND requires commandId/],
    [() => createEnvelope({ type: 'EVENT', machineId: 'm', sessionId: 's' }), /EVENT requires seq/],
    [() => createEnvelope({ type: 'EVENT', machineId: 'm', sessionId: 's', seq: -1 }), /seq must be a non-negative integer/],
    [() => createEnvelope({ type: 'EVENT', machineId: 'm', sessionId: 's', seq: 1.5 }), /seq must be a non-negative integer/],
    [() => createEnvelope({ type: 'COMMAND_ACK', machineId: 'm', commandId: 'c', status: 'MAYBE' }), /Unknown command status/],
    [() => createEnvelope({ type: 'PING', payload: 5 }), /payload must be an object/],
    [() => parseEnvelope('{broken'), /not valid JSON/],
    [() => parseEnvelope(JSON.stringify({ ...createEnvelope({ type: 'PING' }), v: 99 })), /Unsupported protocol version/]
  ];
  for (const [build, expected] of cases) assert.throws(build, expected);

  // Unknown protocol version and oversized frames are named codes, not guesses.
  assert.throws(() => parseEnvelope(JSON.stringify({ v: 99, type: 'PING', id: 'x', ts: new Date().toISOString() })), { code: 'PROTOCOL_VERSION' });
  assert.throws(() => parseEnvelope('x'.repeat(MAX_FRAME_BYTES + 1)), { code: 'FRAME_TOO_LARGE' });
  assert.throws(() => createEnvelope({ type: 'PING', payload: { blob: 'y'.repeat(200 * 1024 + 10) } }), { code: 'PAYLOAD_TOO_LARGE' });
});

test('a redelivered command keeps its id and can be told apart from a different one', () => {
  const payload = { text: 'продолжай', files: [{ name: 'a.txt', size: 3 }] };
  const commandId = newCommandId();
  const first = createEnvelope({ type: 'COMMAND', machineId: 'm', commandId, payload });

  // Same content, key order changed: still the same command (§ idempotency).
  const retry = createEnvelope({ type: 'COMMAND', machineId: 'm', commandId, payload: { files: [{ size: 3, name: 'a.txt' }], text: 'продолжай' } });
  assert.equal(sameCommand(first, retry), true);
  assert.equal(commandPayloadHash(first.payload), commandPayloadHash(retry.payload));

  // Same id, different content: a client bug that must not be executed twice.
  const different = createEnvelope({ type: 'COMMAND', machineId: 'm', commandId, payload: { text: 'стоп' } });
  assert.equal(sameCommand(first, different), false);

  // Different ids are different commands even with identical content.
  const other = createEnvelope({ type: 'COMMAND', machineId: 'm', commandId: newCommandId(), payload });
  assert.equal(sameCommand(first, other), false);
});

test('a SYNC carries the cursor the client last applied', () => {
  const sync = createEnvelope({ type: 'SYNC', machineId: 'm', sessionId: 'tb_1', payload: { afterSeq: 18341 } });
  assert.equal(sync.payload.afterSeq, 18341);
  // An encrypted payload is a string, and the relay never looks inside it.
  const sealed = createEnvelope({ type: 'SYNC', machineId: 'm', sessionId: 'tb_1', payload: 'base64-ciphertext' });
  assert.equal(sealed.payload, 'base64-ciphertext');
});
