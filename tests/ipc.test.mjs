import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HostIpcServer, GatewayClient, persistToken, readToken } from '../src/ipc.mjs';

async function startHost(t, token, handlers) {
  const server = new HostIpcServer({ port: 0, token, handlers });
  const addr = await server.start();
  server.port = addr.port;
  t.after(() => server.close());
  return server;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('request/response round-trips over IPC', async t => {
  const server = await startHost(t, 'sekret', { request: async (name, args) => ({ name, echoed: args.x }) });
  const client = new GatewayClient({ host: '127.0.0.1', port: server.port, token: 'sekret', reconnect: false });
  t.after(() => client.close());
  await client.connect();
  const res = await client.request('ping', { x: 42 });
  assert.deepEqual(res, { name: 'ping', echoed: 42 });

  // Errors carry the handler error code back to the caller.
  server.handlers.request = async () => { throw Object.assign(new Error('nope'), { code: 'BUSY' }); };
  const failed = await client.request('boom').then(
    () => null,
    (e) => e,
  );
  assert.ok(failed, 'request should reject');
  assert.equal(failed.message, 'nope');
  assert.equal(failed.code, 'BUSY');
});

test('host broadcasts events to connected clients', async t => {
  const server = await startHost(t, 'sekret', { request: async () => ({}) });
  const client = new GatewayClient({ host: '127.0.0.1', port: server.port, token: 'sekret', reconnect: false });
  t.after(() => client.close());
  const seen = [];
  client.on('event', (type, data) => seen.push({ type, data }));
  await client.connect();
  client.subscribe();
  await sleep(30); // let the server process SUBSCRIBE before events are broadcast
  server.broadcast('task-event', { seq: 1, taskId: 'a' });
  server.broadcast('task-event', { seq: 2, taskId: 'a' });
  await sleep(50);
  assert.deepEqual(seen, [
    { type: 'task-event', data: { seq: 1, taskId: 'a' } },
    { type: 'task-event', data: { seq: 2, taskId: 'a' } },
  ]);
});

test('a client with the wrong token is refused', async t => {
  const server = await startHost(t, 'real-token', { request: async () => ({}) });
  const client = new GatewayClient({ host: '127.0.0.1', port: server.port, token: 'wrong', reconnect: false });
  t.after(() => client.close());
  await client.connect(); // TCP connects; HELLO is refused on the wire
  const err = await new Promise((resolve) => client.once('error', resolve));
  assert.ok(err instanceof Error);
  assert.equal(client.connected, false, 'refused connection is torn down');
});

test('client reconnects after the host restarts', async t => {
  const token = 'tok';
  const handlers = { request: async () => ({ v: 1 }) };
  let server = new HostIpcServer({ port: 0, token, handlers });
  const addr = await server.start();
  const port = addr.port;

  const client = new GatewayClient({ host: '127.0.0.1', port, token, reconnect: true });
  t.after(() => { try { client.close(); } catch {} });
  await client.connect();
  assert.deepEqual(await client.request('x'), { v: 1 });

  // Kill the host; the client schedules a reconnect.
  server.close();

  // Bring the host back on the same port with the same token.
  server = new HostIpcServer({ port, token, handlers });
  await server.start();
  t.after(() => server.close());

  // Wait for the client to re-handshake, then a request must succeed again.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !client.connected) await sleep(40);
  const deadline2 = Date.now() + 4000;
  let res = null;
  while (Date.now() < deadline2) {
    res = await client.request('y').catch(() => null);
    if (res) break;
    await sleep(50);
  }
  assert.deepEqual(res, { v: 1 }, 'request succeeds after reconnect');
});

test('token is persisted and read back', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-token-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'ipc.json');
  const token = persistToken(file);
  assert.ok(token.length >= 32);
  assert.equal(readToken(file), token);
  assert.equal(readToken(path.join(dir, 'missing.json')), null);
});
