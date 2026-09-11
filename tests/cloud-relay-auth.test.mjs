import test from 'node:test';
import assert from 'node:assert/strict';
import { issueDeviceToken, verifyDeviceToken, DEFAULT_DEVICE_TOKEN_TTL_MS } from '../src/cloud/device-token.mjs';
import { createRelay, createMemoryRelayState } from '../cloud/lib/relay.mjs';
import { createSecretAuthenticator, createOpenAuthenticator } from '../cloud/lib/relay-auth.mjs';
import { createEnvelope } from '../src/cloud/protocol.mjs';

// The relay lets a machine in only with its secret, and a phone only with a token
// that machine signed. Knowing a machineId must not be enough to watch a session,
// and trusted devices stay on the PC — the relay keeps no registry.

const MACHINE = { id: 'home-pc', secret: 'machine-secret-0123456789' };

function connection() {
  const conn = { frames: [], closed: null,
    send(text) { conn.frames.push(JSON.parse(text)); },
    close(code, reason) { conn.closed = { code, reason }; } };
  return conn;
}
const hello = (role, machineId, payload = {}) => createEnvelope({ type: 'HELLO', machineId, payload: { role, ...payload } });
const relayWithSecret = (logger = () => {}) => createRelay({
  state: createMemoryRelayState(),
  logger,
  auth: createSecretAuthenticator({ machines: [MACHINE], logger })
});

test('a device token is verified against the machine that signed it', () => {
  const token = issueDeviceToken({ machineId: 'home-pc', deviceId: 'phone-1', secret: MACHINE.secret });
  assert.match(token, /^v1\./);
  const ok = verifyDeviceToken(token, { secret: MACHINE.secret, machineId: 'home-pc', deviceId: 'phone-1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.deviceId, 'phone-1');
  assert.ok(ok.expiresAt > Date.now());

  // Wrong secret, tampered payload, another machine, another device, expiry.
  assert.equal(verifyDeviceToken(token, { secret: 'different-secret-0123456789', machineId: 'home-pc' }).reason, 'TOKEN_SIGNATURE');
  assert.equal(verifyDeviceToken(token, { secret: MACHINE.secret, machineId: 'other-pc' }).reason, 'TOKEN_MACHINE_MISMATCH');
  assert.equal(verifyDeviceToken(token, { secret: MACHINE.secret, machineId: 'home-pc', deviceId: 'laptop' }).reason, 'TOKEN_DEVICE_MISMATCH');
  assert.equal(verifyDeviceToken(token, { secret: MACHINE.secret, machineId: 'home-pc', now: Date.now() + DEFAULT_DEVICE_TOKEN_TTL_MS + 1 }).reason, 'TOKEN_EXPIRED');

  const [version, payload, signature] = token.split('.');
  const tampered = Buffer.from(JSON.stringify({ v: 'v1', machineId: 'home-pc', deviceId: 'attacker', exp: Date.now() + 1000 })).toString('base64url');
  assert.equal(verifyDeviceToken(`${version}.${tampered}.${signature}`, { secret: MACHINE.secret, machineId: 'home-pc' }).reason, 'TOKEN_SIGNATURE');

  // Malformed input is a plain "no", never a crash.
  for (const bad of [null, '', 'nonsense', 'v1.a', 'v2.abc.def']) {
    const result = verifyDeviceToken(bad, { secret: MACHINE.secret, machineId: 'home-pc' });
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
  assert.throws(() => issueDeviceToken({ machineId: 'home-pc', deviceId: 'phone-1', secret: 'short' }), { code: 'INPUT_INVALID' });
});

test('without configured credentials the relay accepts nobody', async () => {
  const relay = createRelay({ logger: () => {} });
  assert.equal(relay.authMode, 'closed');
  const machine = connection();
  const session = relay.attach(machine);
  await session.handle(hello('machine', 'home-pc', { auth: { secret: MACHINE.secret } }));
  assert.equal(machine.frames.at(-1).type, 'AUTH_FAIL');
  assert.equal(machine.frames.at(-1).payload.code, 'AUTH_NOT_CONFIGURED');
  assert.equal(machine.closed.code, 1008, 'the socket is closed, not left half-authenticated');
});

test('a machine without the right secret is refused before it owns a machine id', async () => {
  const relay = relayWithSecret();
  const machine = connection();
  const session = relay.attach(machine);
  await session.handle(hello('machine', 'home-pc', { auth: { secret: 'not-the-secret-0123456789' } }));
  assert.equal(machine.frames.at(-1).type, 'AUTH_FAIL');
  assert.equal(machine.frames.at(-1).payload.code, 'MACHINE_SECRET_INVALID');
  assert.equal(relay.stats().machines, 0, 'nothing was registered');

  await session.handle(hello('machine', 'home-pc', { auth: { secret: MACHINE.secret } }));
  assert.equal(machine.frames.at(-1).type, 'AUTH_OK');
  assert.equal(relay.stats().machines, 1);
});

test('a client cannot watch a machine without a token that machine signed', async () => {
  const relay = relayWithSecret();
  const machine = connection();
  const client = connection();
  await relay.attach(machine).handle(hello('machine', 'home-pc', { auth: { secret: MACHINE.secret } }));

  // No token at all: refused, and the socket is closed.
  const anonymous = connection();
  await relay.attach(anonymous).handle(hello('client', 'home-pc', { deviceId: 'phone-1' }));
  assert.equal(anonymous.frames.at(-1).type, 'AUTH_FAIL');
  assert.equal(anonymous.frames.at(-1).payload.code, 'TOKEN_MISSING');

  // A token signed with someone else's secret is refused too.
  const forged = issueDeviceToken({ machineId: 'home-pc', deviceId: 'phone-1', secret: 'attacker-secret-0123456789' });
  const attacker = connection();
  await relay.attach(attacker).handle(hello('client', 'home-pc', { deviceId: 'phone-1', auth: { deviceToken: forged } }));
  assert.equal(attacker.frames.at(-1).payload.code, 'TOKEN_SIGNATURE');

  // A token for another machine does not open this one.
  const otherMachine = issueDeviceToken({ machineId: 'other-pc', deviceId: 'phone-1', secret: MACHINE.secret });
  const wrong = connection();
  await relay.attach(wrong).handle(hello('client', 'home-pc', { deviceId: 'phone-1', auth: { deviceToken: otherMachine } }));
  assert.equal(wrong.frames.at(-1).payload.code, 'TOKEN_MACHINE_MISMATCH');

  // The paired phone gets in and can route a command to the machine.
  const paired = await createRelaySession(relay, client, MACHINE.secret, 'phone-1');
  assert.equal(paired.ok, true);
  assert.equal(client.frames.at(-1).type, 'AUTH_OK');
  assert.equal(client.frames.at(-1).payload.deviceId, 'phone-1');
  const command = createEnvelope({ type: 'COMMAND', machineId: 'home-pc', commandId: 'c-1', payload: 'sealed' });
  paired.session.handle(JSON.stringify(command));
  for (let i = 0; i < 50 && !machine.frames.some(frame => frame.type === 'COMMAND'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(machine.frames.find(frame => frame.type === 'COMMAND').payload, 'sealed');
});

async function createRelaySession(relay, client, secret, deviceId) {
  const session = relay.attach(client);
  const token = issueDeviceToken({ machineId: 'home-pc', deviceId, secret });
  const ok = await session.handle(hello('client', 'home-pc', { deviceId, auth: { deviceToken: token } }));
  return { session, ok };
}

test('a client cannot pretend to be a machine, and vice versa', async () => {
  const relay = relayWithSecret();
  const impostor = connection();
  // The machine secret in a client HELLO is not a device token.
  await relay.attach(impostor).handle(hello('client', 'home-pc', { auth: { secret: MACHINE.secret } }));
  assert.equal(impostor.frames.at(-1).type, 'AUTH_FAIL');

  const device = connection();
  const token = issueDeviceToken({ machineId: 'home-pc', deviceId: 'phone-1', secret: MACHINE.secret });
  await relay.attach(device).handle(hello('machine', 'home-pc', { auth: { deviceToken: token } }));
  assert.equal(device.frames.at(-1).type, 'AUTH_FAIL');
  assert.equal(relay.stats().machines, 0);
});

test('the open authenticator exists but has to be asked for explicitly', async () => {
  const relay = createRelay({ logger: () => {}, auth: createOpenAuthenticator() });
  assert.equal(relay.authMode, 'open');
  const machine = connection();
  await relay.attach(machine).handle(hello('machine', 'home-pc'));
  assert.equal(machine.frames.at(-1).type, 'AUTH_OK');
});
