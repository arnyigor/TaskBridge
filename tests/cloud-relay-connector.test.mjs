import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from '../cloud/lib/relay-server.mjs';
import { createSecretAuthenticator } from '../cloud/lib/relay-auth.mjs';
import { createRelayConnector } from '../src/cloud/relay-connector.mjs';
import { issueDeviceToken } from '../src/cloud/device-token.mjs';
import { createEnvelope } from '../src/cloud/protocol.mjs';

// End to end without any deployment: a phone-like client talks through the real
// relay to the machine connector, which runs commands on a stub TaskManager and
// streams the stub's events back. This is the whole cloud path in one test.

const MACHINE = { id: 'home-pc', secret: 'machine-secret-0123456789' };
const DEVICE = { id: 'phone-1' };
const TOKEN = issueDeviceToken({ machineId: MACHINE.id, deviceId: DEVICE.id, secret: MACHINE.secret });

async function setup(t, { dispatcher, store, manager } = {}) {
  const relay = createRelayServer({
    logger: () => {},
    auth: createSecretAuthenticator({ machines: [MACHINE], logger: () => {} })
  });
  const endpoint = await relay.listen({ port: 0 });
  t.after(() => endpoint.close());

  const events = [];
  const stubManager = manager || {
    on(event, handler) { if (event === 'task-event') events.push(handler); },
    off() {},
    listTasks: () => []
  };
  const calls = [];
  const stubDispatcher = dispatcher || { async handle(command) { calls.push(command); return { status: 'ACCEPTED', detail: { taskId: command.taskId } }; } };
  const connector = createRelayConnector({
    url: endpoint.url, machineId: MACHINE.id, machineSecret: MACHINE.secret,
    manager: stubManager, dispatcher: stubDispatcher, store, logger: () => {},
    limits: { pingIntervalMs: 50, pongTimeoutMs: 5_000, reconnectBaseMs: 20, reconnectMaxMs: 60 }
  });
  t.after(() => connector.stop());
  await connector.start();
  return { relay, endpoint, connector, events, calls, emit: event => events.forEach(handler => handler(event)) };
}

async function connectClient(endpoint, { deviceId = DEVICE.id, token = TOKEN } = {}) {
  const socket = new WebSocket(endpoint.url);
  socket.received = [];
  socket.addEventListener('message', event => socket.received.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', () => reject(new Error('client socket failed')));
  });
  socket.send(JSON.stringify(createEnvelope({
    type: 'HELLO', machineId: MACHINE.id, payload: { role: 'client', deviceId, auth: { deviceToken: token } }
  })));
  return socket;
}

const waitFor = async (check, what) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), `timed out waiting for ${what}`);
};

test('the connector authenticates, streams local events and reports the machine online', async t => {
  const { endpoint, connector, emit } = await setup(t);
  await waitFor(() => connector.status().status === 'online', 'the machine to come online');
  assert.equal(connector.status().machineId, 'home-pc');

  const client = await connectClient(endpoint);
  t.after(() => client.close());
  await waitFor(() => client.received.some(frame => frame.type === 'AUTH_OK'), 'the client handshake');
  await waitFor(() => client.received.some(frame => frame.type === 'MACHINE_STATUS' && frame.payload.online === true), 'the online status');

  // A local task event reaches an attached client with its own seq.
  client.send(JSON.stringify(createEnvelope({ type: 'ATTACH', machineId: MACHINE.id, sessionId: 'tb_1' })));
  await new Promise(resolve => setTimeout(resolve, 50));
  emit({ at: new Date().toISOString(), taskId: 'tb_1', type: 'TASK_SUCCEEDED', message: 'Готово', seq: 7 });
  await waitFor(() => client.received.some(frame => frame.type === 'EVENT' && frame.seq === 7), 'the task event');
  const event = client.received.find(frame => frame.type === 'EVENT' && frame.seq === 7);
  assert.equal(event.payload.event.type, 'TASK_SUCCEEDED');
  assert.equal(event.payload.event.message, 'Готово');
  // An event of another session never reaches this client.
  emit({ taskId: 'tb_other', type: 'TASK_QUEUED', message: 'x', seq: 1 });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(client.received.some(frame => frame.sessionId === 'tb_other'), false);
});

test('a command from the phone runs on the machine and comes back acknowledged', async t => {
  const { endpoint, connector, calls } = await setup(t);
  await waitFor(() => connector.status().status === 'online', 'the machine to come online');
  const client = await connectClient(endpoint);
  t.after(() => client.close());
  await waitFor(() => client.received.some(frame => frame.type === 'AUTH_OK'), 'the client handshake');

  client.send(JSON.stringify(createEnvelope({
    type: 'COMMAND', machineId: MACHINE.id, commandId: 'c-1', sessionId: 'tb_1', seq: 3,
    payload: { type: 'FOLLOW_UP', data: { text: 'продолжай' } }
  })));
  await waitFor(() => client.received.some(frame => frame.type === 'COMMAND_ACK'), 'the acknowledgement');
  const ack = client.received.find(frame => frame.type === 'COMMAND_ACK');
  assert.equal(ack.commandId, 'c-1');
  assert.equal(ack.status, 'ACCEPTED');
  assert.equal(ack.sessionId, 'tb_1');
  // The dispatcher sees the shape it expects, including the command type.
  assert.deepEqual(calls, [{ commandId: 'c-1', machineId: MACHINE.id, taskId: 'tb_1', seq: 3, type: 'FOLLOW_UP', payload: { text: 'продолжай' } }]);
});

test('SYNC replays the events the client missed, from the machine store', async t => {
  const stored = [
    { seq: 1, type: 'TASK_QUEUED', taskId: 'tb_1' },
    { seq: 2, type: 'USER_MESSAGE', taskId: 'tb_1' },
    { seq: 3, type: 'TASK_SUCCEEDED', taskId: 'tb_1' }
  ];
  const store = { async readEvents(taskId, limit, after) { return stored.filter(event => event.taskId === taskId && event.seq > after); } };
  const { endpoint, connector } = await setup(t, { store });
  await waitFor(() => connector.status().status === 'online', 'the machine to come online');

  const client = await connectClient(endpoint);
  t.after(() => client.close());
  await waitFor(() => client.received.some(frame => frame.type === 'AUTH_OK'), 'the client handshake');
  // Attach first: attachment is what grants the event stream.
  client.send(JSON.stringify(createEnvelope({ type: 'ATTACH', machineId: MACHINE.id, sessionId: 'tb_1' })));
  await new Promise(resolve => setTimeout(resolve, 50));
  client.send(JSON.stringify(createEnvelope({ type: 'SYNC', machineId: MACHINE.id, sessionId: 'tb_1', payload: { afterSeq: 1 } })));

  await waitFor(() => client.received.filter(frame => frame.type === 'EVENT').length === 2, 'the replayed events');
  const replayed = client.received.filter(frame => frame.type === 'EVENT');
  assert.deepEqual(replayed.map(frame => frame.seq), [2, 3]);
  assert.equal(replayed[0].payload.replay, true);
  assert.equal(replayed[0].payload.event.type, 'USER_MESSAGE');
});

test('a wrong machine secret never becomes an online machine', async t => {
  const relay = createRelayServer({ logger: () => {}, auth: createSecretAuthenticator({ machines: [MACHINE], logger: () => {} }) });
  const endpoint = await relay.listen({ port: 0 });
  t.after(() => endpoint.close());
  const connector = createRelayConnector({
    url: endpoint.url, machineId: MACHINE.id, machineSecret: 'wrong-secret-0123456789',
    manager: { on() {}, off() {} }, dispatcher: { async handle() { return { status: 'ACCEPTED' }; } },
    logger: () => {}, limits: { reconnectBaseMs: 10, reconnectMaxMs: 20 }
  });
  t.after(() => connector.stop());
  await connector.start();
  await waitFor(() => connector.status().status === 'unauthorized', 'the rejection');
  assert.equal(relay.relay.stats().machines, 0, 'nothing was registered on the relay');
});

test('frames produced before the link is up are flushed once it is', async t => {
  const relay = createRelayServer({ logger: () => {}, auth: createSecretAuthenticator({ machines: [MACHINE], logger: () => {} }) });
  const endpoint = await relay.listen({ port: 0 });
  t.after(() => endpoint.close());

  // The phone is already attached when the machine appears, so the flushed frame
  // has somewhere to go.
  const client = await connectClient(endpoint);
  t.after(() => client.close());
  await waitFor(() => client.received.some(frame => frame.type === 'AUTH_OK'), 'the client handshake');
  client.send(JSON.stringify(createEnvelope({ type: 'ATTACH', machineId: MACHINE.id, sessionId: 'tb_9' })));
  await new Promise(resolve => setTimeout(resolve, 50));

  const connector = createRelayConnector({
    url: endpoint.url, machineId: MACHINE.id, machineSecret: MACHINE.secret,
    manager: { on() {}, off() {} }, dispatcher: { async handle() { return { status: 'ACCEPTED' }; } },
    logger: () => {}, limits: { reconnectBaseMs: 20, reconnectMaxMs: 60 }
  });
  t.after(() => connector.stop());

  // Produced while the machine is still offline: it must not be lost.
  connector.publishEvent({ taskId: 'tb_9', type: 'TASK_QUEUED', message: 'queued early', seq: 1 });
  assert.equal(connector.status().queued, 1);

  await connector.start();
  await waitFor(() => client.received.some(frame => frame.sessionId === 'tb_9'), 'the flushed event');
  assert.equal(connector.status().queued, 0);
  assert.equal(client.received.find(frame => frame.sessionId === 'tb_9').payload.event.message, 'queued early');
});
