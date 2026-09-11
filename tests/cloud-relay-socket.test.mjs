import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRelayServer } from '../cloud/lib/relay-server.mjs';
import { createEnvelope, parseEnvelope } from '../src/cloud/protocol.mjs';
import { encodeFrame } from '../cloud/lib/ws.mjs';

// The relay over real sockets: the same tests the routing core has, plus the
// things only a socket can show — the handshake, fragmented frames, ping/pong,
// oversized input and the close handshake.

async function withRelay(t, { limits } = {}) {
  const relay = createRelayServer({ logger: () => {}, ...(limits ? { limits } : {}) });
  const endpoint = await relay.listen({ port: 0 });
  t.after(() => endpoint.close());
  return { relay, endpoint };
}

function open(url) {
  const socket = new WebSocket(url);
  socket.received = [];
  socket.addEventListener('message', event => socket.received.push(JSON.parse(event.data)));
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', error => reject(new Error(`websocket error: ${error.message || 'unknown'}`)));
  });
}

const waitFor = async (check, what = 'frames') => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), `timed out waiting for ${what}`);
};

const hello = (role, machineId, extra = {}) => createEnvelope({ type: 'HELLO', machineId, payload: { role, ...extra } });
const send = (socket, envelope) => socket.send(JSON.stringify(envelope));

test('a machine and a client exchange frames through the relay socket', async t => {
  const { endpoint } = await withRelay(t);
  const machine = await open(endpoint.url);
  const client = await open(endpoint.url);
  t.after(() => { machine.close(); client.close(); });

  send(machine, hello('machine', 'home-pc'));
  send(client, hello('client', 'home-pc', { deviceId: 'phone-1' }));
  await waitFor(() => client.received.some(frame => frame.type === 'AUTH_OK'), 'the client handshake');
  assert.equal(machine.received.at(-1).type, 'AUTH_OK');

  // A command reaches the machine untouched, including a sealed payload.
  send(client, createEnvelope({ type: 'COMMAND', machineId: 'home-pc', commandId: 'c-1', payload: 'ciphertext' }));
  await waitFor(() => machine.received.some(frame => frame.type === 'COMMAND'), 'the command');
  const command = machine.received.find(frame => frame.type === 'COMMAND');
  assert.equal(command.payload, 'ciphertext');
  assert.equal(command.commandId, 'c-1');

  // An event reaches only the client that attached to that session.
  send(client, createEnvelope({ type: 'ATTACH', machineId: 'home-pc', sessionId: 'tb_1' }));
  await waitFor(() => machine.received.some(frame => frame.type === 'ATTACH'), 'the attach');
  send(machine, createEnvelope({ type: 'EVENT', machineId: 'home-pc', sessionId: 'tb_1', seq: 5, payload: { kind: 'text' } }));
  await waitFor(() => client.received.some(frame => frame.type === 'EVENT' && frame.seq === 5), 'the event');

  // PING is answered by the relay itself.
  send(client, createEnvelope({ type: 'PING' }));
  await waitFor(() => client.received.some(frame => frame.type === 'PONG'), 'the pong');
});

test('the handshake happens on the relay path only', async t => {
  const { endpoint } = await withRelay(t);
  const wrongPath = endpoint.url.replace('/api/relay', '/api/other');
  const rejected = new WebSocket(wrongPath);
  const outcome = await new Promise(resolve => {
    rejected.addEventListener('open', () => resolve('open'));
    rejected.addEventListener('error', () => resolve('error'));
    rejected.addEventListener('close', () => resolve('close'));
  });
  assert.notEqual(outcome, 'open', 'a socket on any other path must not be upgraded');
  rejected.close();
});

test('a fragmented text message is assembled', async t => {
  const { endpoint } = await withRelay(t);
  // Raw socket: the standard client never fragments, but a real one may.
  const { port } = new URL(endpoint.url);
  const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
  t.after(() => socket.destroy());
  await new Promise(resolve => socket.once('connect', resolve));

  const received = [];
  socket.on('data', chunk => received.push(chunk));
  const key = crypto.randomBytes(16).toString('base64');
  socket.write([
    'GET /api/relay HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '', ''
  ].join('\r\n'));
  await new Promise(resolve => setTimeout(resolve, 100));

  const clientFrame = (text, { fin, opcode }) => {
    const data = Buffer.from(text, 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    const header = [(fin ? 0x80 : 0) | opcode];
    if (data.length < 126) header.push(0x80 | data.length);
    else header.push(0x80 | 126, (data.length >> 8) & 0xff, data.length & 0xff);
    return Buffer.concat([Buffer.from(header), mask, masked]);
  };
  const payload = JSON.stringify(hello('machine', 'fragmented-pc'));
  socket.write(clientFrame(payload.slice(0, 12), { fin: false, opcode: 0x1 }));
  socket.write(clientFrame(payload.slice(12), { fin: true, opcode: 0x0 }));

  const deadline = Date.now() + 2_000;
  const text = () => Buffer.concat(received).toString('utf8');
  while (Date.now() < deadline && !text().includes('AUTH_OK')) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(text(), /AUTH_OK/, 'the reassembled handshake was answered');
  assert.match(text(), /fragmented-pc/);
});

test('an oversized frame closes the connection instead of buffering it', async t => {
  const { endpoint } = await withRelay(t, { limits: {} });
  const client = await open(endpoint.url);
  let closed = false;
  client.addEventListener('close', () => { closed = true; });
  // 300 KiB of text: above the 256 KiB frame ceiling.
  client.send(JSON.stringify({ v: 2, type: 'HELLO', id: 'x', ts: new Date().toISOString(), payload: { role: 'client', deviceId: 'x'.repeat(300 * 1024) } }));
  for (let i = 0; i < 200 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, true, 'the socket is closed');
});

test('a machine disconnect is visible: clients get an offline status', async t => {
  const { endpoint } = await withRelay(t);
  const machine = await open(endpoint.url);
  const client = await open(endpoint.url);
  t.after(() => client.close());
  send(machine, hello('machine', 'home-pc'));
  send(client, hello('client', 'home-pc', { deviceId: 'phone-1' }));
  await waitFor(() => client.received.some(frame => frame.type === 'AUTH_OK'), 'the client handshake');

  machine.close();
  await waitFor(() => client.received.some(frame => frame.type === 'MACHINE_STATUS' && frame.payload?.online === false), 'the offline status');
});

test('everything the relay sends is a valid frame of the same protocol version', async t => {
  const { endpoint } = await withRelay(t);
  const client = await open(endpoint.url);
  t.after(() => client.close());
  send(client, hello('client', 'nobody-here', { deviceId: 'phone-1' }));
  send(client, createEnvelope({ type: 'COMMAND', machineId: 'nobody-here', commandId: 'c-1' }));
  await waitFor(() => client.received.some(frame => frame.type === 'ERROR'), 'the offline error');
  assert.equal(client.received.find(frame => frame.type === 'ERROR').payload.code, 'MACHINE_OFFLINE');
  for (const frame of client.received) assert.equal(parseEnvelope(frame).v, 2);
  assert.equal(encodeFrame('x')[0], 0x81, 'text frames are final and text-typed');
});
