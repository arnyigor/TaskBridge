import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createCloudTransport } from '../web/transport.mjs';

function fixture(t, options = {}) {
  const sockets = [];
  class Socket {
    readyState = 0;
    handlers = new Map();
    sent = [];
    constructor() { sockets.push(this); }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    send(data) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(data)); }
    open() { this.readyState = 1; this.handlers.get('open')?.(); }
    frame(fields) { this.handlers.get('message')?.({ data: JSON.stringify({ v: 2, ...fields }) }); }
    close() { this.readyState = 3; this.handlers.get('close')?.(); }
  }
  const transport = createCloudTransport({ url: 'ws://fixture', machineId: 'pc', deviceToken: 'fixture', WebSocketImpl: Socket, reconnectBaseMs: 2, reconnectMaxMs: 2, ...options });
  t.after(() => transport.close());
  return { transport, sockets };
}

async function online(transport, sockets) {
  const ready = transport.ready();
  const socket = sockets.at(-1);
  socket.open();
  socket.frame({ type: 'AUTH_OK' });
  await ready;
  return socket;
}

test('reconnect waits for authentication, resumes every session at its cursor and never repeats a command', async t => {
  const { transport, sockets } = fixture(t);
  const first = await online(transport, sockets);
  const received = [];
  transport.open('a', { after: 10, onEvent: event => received.push(event.seq) });
  transport.open('b', { after: 20 });
  first.frame({ type: 'EVENT', sessionId: 'a', seq: 11, payload: { event: { seq: 11 } } });
  const pending = assert.rejects(transport.command({ sessionId: 'a', type: 'ABORT_TASK' }), { code: 'RELAY_OFFLINE' });
  first.close();
  await pending;
  for (let i = 0; i < 100 && sockets.length < 2; i++) await delay(2);
  assert.equal(sockets.length, 2);
  const second = sockets[1];
  assert.deepEqual(second.sent, []);
  second.open();
  assert.deepEqual(second.sent.map(frame => frame.type), ['HELLO']);
  second.frame({ type: 'AUTH_OK' });
  assert.deepEqual(second.sent.map(frame => frame.type), ['HELLO', 'ATTACH', 'SYNC', 'ATTACH', 'SYNC']);
  assert.deepEqual(second.sent.filter(frame => frame.type === 'SYNC').map(frame => [frame.sessionId, frame.payload.afterSeq]), [['a', 11], ['b', 20]]);
  first.frame({ type: 'AUTH_FAIL' });
  first.close();
  assert.equal(transport.status(), 'online', 'stale socket cannot change the new connection');
  second.frame({ type: 'EVENT', sessionId: 'a', seq: 11, payload: { event: { seq: 11 } } });
  second.frame({ type: 'EVENT', sessionId: 'a', seq: 12, payload: { event: { seq: 12 } } });
  assert.deepEqual(received, [11, 12]);
  assert.equal(second.sent.some(frame => frame.type === 'COMMAND'), false);
});

test('a subscription opened before ready attaches after authentication and close cancels its sync callback', async t => {
  const { transport, sockets } = fixture(t, { syncTimeoutMs: 25 });
  const statuses = [];
  const handle = transport.open('a', { onStatus: status => statuses.push(status) });
  const socket = await online(transport, sockets);
  assert.deepEqual(socket.sent.map(frame => frame.type), ['HELLO', 'ATTACH', 'SYNC']);
  handle.close();
  await delay(40);
  assert.deepEqual(statuses, []);
});

test('long streams keep a reconnect cursor without spreading an unbounded seen set', async t => {
  const { transport, sockets } = fixture(t);
  const first = await online(transport, sockets);
  let count = 0;
  transport.open('a', { onEvent: () => count++ });
  for (let seq = 1; seq <= 150_000; seq++) first.frame({ type: 'EVENT', sessionId: 'a', seq, payload: { event: { seq } } });
  assert.equal(count, 150_000);
  first.close();
  for (let i = 0; i < 100 && sockets.length < 2; i++) await delay(2);
  const next = sockets[1];
  next.open();
  next.frame({ type: 'AUTH_OK' });
  assert.equal(next.sent.find(frame => frame.type === 'SYNC').payload.afterSeq, 150_000);
});
