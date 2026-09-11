import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, createMemoryRelayState } from '../cloud/lib/relay.mjs';
import { createEnvelope, parseEnvelope } from '../src/cloud/protocol.mjs';

// The relay is a telephone exchange: it routes frames between a machine and its
// clients, tracks presence with a TTL and rate-limits devices. It must never
// store sessions/tasks/events and never look inside `payload`.

function connection() {
  const conn = {
    frames: [],
    closed: null,
    send(text) { conn.frames.push(JSON.parse(text)); },
    close(code, reason) { conn.closed = { code, reason }; }
  };
  return conn;
}

const hello = (role, machineId, extra = {}) => createEnvelope({
  type: 'HELLO', machineId, payload: { role, ...extra }
});
const command = (machineId, payload = { text: 'привет' }) => createEnvelope({
  type: 'COMMAND', machineId, commandId: 'c-1', payload
});

async function relayWith(limits = {}) {
  return createRelay({ limits, logger: () => {} });
}

test('a frame without HELLO is refused instead of being routed for an unknown peer', async () => {
  const relay = await relayWith();
  const client = connection();
  const session = relay.attach(client);

  await session.handle(createEnvelope({ type: 'COMMAND', machineId: 'm', commandId: 'c-1' }));
  assert.equal(client.frames.at(-1).type, 'ERROR');
  assert.equal(client.frames.at(-1).payload.code, 'HELLO_REQUIRED');
  assert.equal(client.closed.code, 1008);
});

test('a command reaches the machine untouched, ciphertext payload included', async () => {
  const relay = await relayWith();
  const machine = connection();
  const client = connection();
  const machineSession = relay.attach(machine);
  const clientSession = relay.attach(client);
  await machineSession.handle(hello('machine', 'home-pc'));
  await clientSession.handle(hello('client', 'home-pc', { deviceId: 'phone-1' }));
  assert.equal(client.frames.at(-1).type, 'AUTH_OK');

  // Sealed payload: the relay must not need to understand it.
  const sealed = createEnvelope({ type: 'COMMAND', machineId: 'home-pc', commandId: 'c-1', payload: 'base64-ciphertext' });
  await clientSession.handle(sealed);
  const delivered = machine.frames.at(-1);
  assert.equal(delivered.type, 'COMMAND');
  assert.equal(delivered.payload, 'base64-ciphertext', 'the relay forwards the payload verbatim');
  assert.equal(delivered.commandId, 'c-1');
  assert.equal(relay.stats().machines, 1);
});

test('events go only to clients attached to that session', async () => {
  const relay = await relayWith();
  const machine = connection();
  const attached = connection();
  const other = connection();
  const machineSession = relay.attach(machine);
  const attachedSession = relay.attach(attached);
  const otherSession = relay.attach(other);
  await machineSession.handle(hello('machine', 'home-pc'));
  await attachedSession.handle(hello('client', 'home-pc', { deviceId: 'phone-1' }));
  await otherSession.handle(hello('client', 'home-pc', { deviceId: 'laptop-1' }));
  await attachedSession.handle(createEnvelope({ type: 'ATTACH', machineId: 'home-pc', sessionId: 'tb_1' }));

  const event = createEnvelope({ type: 'EVENT', machineId: 'home-pc', sessionId: 'tb_1', seq: 7, payload: { kind: 'text' } });
  await machineSession.handle(event);
  assert.equal(attached.frames.at(-1).type, 'EVENT');
  assert.equal(attached.frames.at(-1).seq, 7);
  assert.equal(other.frames.some(frame => frame.type === 'EVENT'), false, 'a client that did not attach sees nothing');

  // DETACH stops the stream without touching anything else.
  await attachedSession.handle(createEnvelope({ type: 'DETACH', machineId: 'home-pc', sessionId: 'tb_1' }));
  await machineSession.handle(event);
  assert.equal(attached.frames.filter(frame => frame.type === 'EVENT').length, 1);
});

test('an answer is addressed to one device, and a status frame reaches every client', async () => {
  const relay = await relayWith();
  const machine = connection();
  const phone = connection();
  const laptop = connection();
  const machineSession = relay.attach(machine);
  const phoneSession = relay.attach(phone);
  const laptopSession = relay.attach(laptop);
  await machineSession.handle(hello('machine', 'home-pc'));
  await phoneSession.handle(hello('client', 'home-pc', { deviceId: 'phone-1' }));
  await laptopSession.handle(hello('client', 'home-pc', { deviceId: 'laptop-1' }));

  await machineSession.handle(createEnvelope({ type: 'COMMAND_ACK', machineId: 'home-pc', commandId: 'c-1', status: 'ACCEPTED', to: 'phone-1' }));
  assert.equal(phone.frames.at(-1).type, 'COMMAND_ACK');
  assert.equal(laptop.frames.some(frame => frame.type === 'COMMAND_ACK'), false);

  await machineSession.handle(createEnvelope({ type: 'MACHINE_STATUS', machineId: 'home-pc', payload: { online: true } }));
  assert.equal(phone.frames.at(-1).type, 'MACHINE_STATUS');
  assert.equal(laptop.frames.at(-1).type, 'MACHINE_STATUS');
});

test('a client of an offline machine is told so, or handed to another instance', async () => {
  const relay = await relayWith();
  const client = connection();
  const session = relay.attach(client);
  await session.handle(hello('client', 'home-pc', { deviceId: 'phone-1' }));

  await session.handle(command('home-pc'));
  assert.equal(client.frames.at(-1).type, 'ERROR');
  assert.equal(client.frames.at(-1).payload.code, 'MACHINE_OFFLINE');

  // Present in the shared state (connected elsewhere): publish instead of failing.
  const published = [];
  const state = createMemoryRelayState();
  const original = state.publish;
  state.publish = async (machineId, frame) => { published.push({ machineId, type: frame.type }); return original(machineId, frame); };
  await state.setPresence('laptop-home', 60_000);
  const second = createRelay({ state, logger: () => {} });
  const remote = connection();
  const remoteSession = second.attach(remote);
  await remoteSession.handle(hello('client', 'laptop-home', { deviceId: 'phone-2' }));
  await remoteSession.handle(command('laptop-home'));
  assert.deepEqual(published, [{ machineId: 'laptop-home', type: 'COMMAND' }]);
  assert.equal(remote.frames.some(frame => frame.payload?.code === 'MACHINE_OFFLINE'), false);
});

test('a second machine connection for the same id is refused: one owner per machine', async () => {
  const relay = await relayWith();
  const first = connection();
  const second = connection();
  await relay.attach(first).handle(hello('machine', 'home-pc'));
  const secondSession = relay.attach(second);
  await secondSession.handle(hello('machine', 'home-pc'));
  assert.equal(second.frames.at(-1).payload.code, 'MACHINE_ALREADY_CONNECTED');
});

test('PING is answered by the relay itself, so a client can test the link cheaply', async () => {
  const relay = await relayWith();
  const client = connection();
  const session = relay.attach(client);
  await session.handle(hello('client', 'home-pc'));
  await session.handle(createEnvelope({ type: 'PING' }));
  assert.equal(client.frames.at(-1).type, 'PONG');
});

test('too many frames per second close the connection, and the limit recovers', async () => {
  let clock = 1_000_000;
  const state = createMemoryRelayState({ now: () => clock });
  const relay = createRelay({ state, limits: { maxFramesPerSecond: 2 }, logger: () => {} });
  const client = connection();
  const session = relay.attach(client);
  await session.handle(hello('client', 'home-pc'));   // 1
  await session.handle(createEnvelope({ type: 'PING' })); // 2
  await session.handle(createEnvelope({ type: 'PING' })); // over the limit
  assert.equal(client.frames.at(-1).payload.code, 'RATE_LIMITED');
  assert.equal(client.closed.code, 1008);

  // A fresh connection after the window is served normally.
  clock += 1_100;
  const next = connection();
  const nextSession = relay.attach(next);
  await nextSession.handle(hello('client', 'home-pc'));
  assert.equal(next.frames.at(-1).type, 'AUTH_OK');
});

test('a machine going away clears presence and tells its clients', async () => {
  const state = createMemoryRelayState();
  const relay = createRelay({ state, logger: () => {} });
  const machine = connection();
  const client = connection();
  const machineSession = relay.attach(machine);
  const clientSession = relay.attach(client);
  await machineSession.handle(hello('machine', 'home-pc'));
  await clientSession.handle(hello('client', 'home-pc', { deviceId: 'phone-1' }));
  assert.equal(await state.isPresent('home-pc'), true);

  await machineSession.close();
  assert.equal(await state.isPresent('home-pc'), false);
  const offline = client.frames.filter(frame => frame.type === 'MACHINE_STATUS').at(-1);
  assert.equal(offline.payload.online, false);
  assert.equal(relay.stats().machines, 0);
});

test('a client cannot attach to unlimited sessions', async () => {
  const relay = await relayWith({ maxAttachedSessions: 1 });
  const machine = connection();
  const client = connection();
  await relay.attach(machine).handle(hello('machine', 'home-pc'));
  const session = relay.attach(client);
  await session.handle(hello('client', 'home-pc', { deviceId: 'phone-1' }));
  await session.handle(createEnvelope({ type: 'ATTACH', machineId: 'home-pc', sessionId: 'tb_1' }));
  await session.handle(createEnvelope({ type: 'ATTACH', machineId: 'home-pc', sessionId: 'tb_2' }));
  assert.equal(client.frames.at(-1).payload.code, 'TOO_MANY_SESSIONS');
  assert.equal(machine.frames.filter(frame => frame.type === 'ATTACH').length, 1, 'the refused attach was not forwarded');
});

test('a malformed frame and a frame for another machine are rejected', async () => {
  const relay = await relayWith();
  const client = connection();
  const session = relay.attach(client);
  await session.handle(hello('client', 'home-pc', { deviceId: 'phone-1' }));

  await session.handle('{ not json');
  assert.equal(client.frames.at(-1).payload.code, 'PROTOCOL_INVALID');

  const other = connection();
  const otherSession = relay.attach(other);
  await otherSession.handle(hello('client', 'home-pc'));
  await otherSession.handle(command('someone-elses-pc'));
  assert.equal(other.frames.at(-1).payload.code, 'MACHINE_MISMATCH');

  // Everything the relay emits is a valid frame of the same protocol version.
  for (const frame of [...client.frames, ...other.frames]) {
    assert.equal(parseEnvelope(frame).v, 2);
  }
});

test('machines are isolated: a client of one never sees another machine', async () => {
  const relay = await relayWith();
  const machineA = connection();
  const machineB = connection();
  const clientA = connection();
  const clientB = connection();
  const sessionA = relay.attach(clientA);
  const sessionB = relay.attach(clientB);
  const machineSessionA = relay.attach(machineA);
  const machineSessionB = relay.attach(machineB);
  await machineSessionA.handle(hello('machine', 'pc-a'));
  await machineSessionB.handle(hello('machine', 'pc-b'));
  await sessionA.handle(hello('client', 'pc-a', { deviceId: 'device-a' }));
  await sessionB.handle(hello('client', 'pc-b', { deviceId: 'device-b' }));
  await sessionA.handle(createEnvelope({ type: 'ATTACH', machineId: 'pc-a', sessionId: 'tb_a' }));
  await sessionB.handle(createEnvelope({ type: 'ATTACH', machineId: 'pc-b', sessionId: 'tb_b' }));

  await machineSessionA.handle(createEnvelope({ type: 'EVENT', machineId: 'pc-a', sessionId: 'tb_a', seq: 1, payload: { secret: 'A' } }));
  await machineSessionA.handle(createEnvelope({ type: 'MACHINE_STATUS', machineId: 'pc-a', payload: { online: true } }));
  await machineSessionB.handle(createEnvelope({ type: 'EVENT', machineId: 'pc-b', sessionId: 'tb_b', seq: 1, payload: { secret: 'B' } }));

  // Each client sees its own machine and nothing else.
  assert.equal(clientA.frames.some(frame => frame.payload?.secret === 'B'), false);
  assert.equal(clientB.frames.some(frame => frame.payload?.secret === 'A'), false);
  assert.equal(clientB.frames.some(frame => frame.type === 'MACHINE_STATUS'), false, 'status of another machine stays private');
  assert.equal(clientA.frames.filter(frame => frame.type === 'EVENT').length, 1);
  assert.equal(clientB.frames.filter(frame => frame.type === 'EVENT').length, 1);
});
