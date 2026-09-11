import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLocalTransport, createCloudTransport, selectTransport } from '../web/transport.mjs';
import { createRelayServer } from '../cloud/lib/relay-server.mjs';
import { createSecretAuthenticator } from '../cloud/lib/relay-auth.mjs';
import { createRelayConnector } from '../src/cloud/relay-connector.mjs';
import { issueDeviceToken } from '../src/cloud/device-token.mjs';

// The UI must not care whether it talks to the PC directly or through the relay.
// Both transports are exercised here against real servers: HTTP + SSE for the
// local one, and the relay plus the real machine connector for the cloud one.

// Node has WebSocket but no EventSource; the browser provides both. This shim is
// what the transport expects: onmessage/onerror/close over a text/event-stream.
class TestEventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onerror = null;
    this.closed = false;
    this.controller = new AbortController();
    this.started = this.#start();
  }
  async #start() {
    try {
      const response = await fetch(this.url, { headers: { accept: 'text/event-stream' }, signal: this.controller.signal });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop();
        for (const block of blocks) {
          const line = block.split('\n').find(part => part.startsWith('data:'));
          if (line && this.onmessage) this.onmessage({ data: line.slice(5).trim() });
        }
      }
    } catch { this.onerror?.(); }
  }
  close() { this.closed = true; this.controller.abort(); }
}

const MACHINE = { id: 'home-pc', secret: 'machine-secret-0123456789' };
const DEVICE = { id: 'phone-1' };
const TOKEN = issueDeviceToken({ machineId: MACHINE.id, deviceId: DEVICE.id, secret: MACHINE.secret });

test('the local transport speaks HTTP and streams SSE, skipping repeated seq', async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname, after: url.searchParams.get('after') });
    if (url.pathname === '/api/tasks/a/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ seq: 1, type: 'USER_MESSAGE' })}\n\n`);
      res.write(`data: ${JSON.stringify({ seq: 1, type: 'USER_MESSAGE' })}\n\n`); // duplicate after reconnect
      res.write(`data: ${JSON.stringify({ seq: 2, type: 'TASK_SUCCEEDED' })}\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: 'a' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;

  const transport = createLocalTransport({ base, EventSourceImpl: TestEventSource });
  assert.equal(transport.kind, 'local');
  assert.deepEqual(await transport.request('GET', '/api/tasks/a'), { ok: true, id: 'a' });

  const received = [];
  const statuses = [];
  const handle = transport.open('a', { after: 0, onEvent: event => received.push(event), onStatus: value => statuses.push(value) });
  for (let i = 0; i < 200 && received.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(received.map(event => event.seq), [1, 2], 'a repeated seq is delivered once');
  assert.equal(statuses[0], 'open');
  handle.close();
  // A zero cursor means "from the start": no query parameter is sent at all.
  assert.equal(requests.filter(r => r.path === '/api/tasks/a/stream')[0].after, null);
});

test('the local transport reports HTTP failures with their code', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'MODEL_BUSY', error: 'Модель занята' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const transport = createLocalTransport({ base: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(transport.request('POST', '/api/tasks/a/message', { text: 'hi' }), { code: 'MODEL_BUSY' });
  await assert.rejects(transport.command({ type: 'FOLLOW_UP' }), { code: 'NOT_SUPPORTED' });
  await transport.close();
});

test('the cloud transport attaches, syncs, streams and commands a real machine', async t => {
  // The machine: the real connector over a stub TaskManager/dispatcher.
  const relay = createRelayServer({ logger: () => {}, auth: createSecretAuthenticator({ machines: [MACHINE], logger: () => {} }) });
  const endpoint = await relay.listen({ port: 0 });
  t.after(() => endpoint.close());

  const localApi = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ provider: 'llama.cpp', id: 'qwen-27b-q3' }] })); return; }
    if (url.pathname === '/api/tasks/42') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'NOT_FOUND', error: 'Сессия не найдена.' })); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('plain text');
  });
  await new Promise(resolve => localApi.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { localApi.closeAllConnections?.(); localApi.close(resolve); }));
  const localApiBase = `http://127.0.0.1:${localApi.address().port}`;

  const stored = [
    { seq: 1, type: 'TASK_QUEUED', taskId: 'tb_1', message: 'старт' },
    { seq: 2, type: 'USER_MESSAGE', taskId: 'tb_1', message: 'привет' }
  ];
  const store = { async readEvents(taskId, limit, after) { return stored.filter(event => event.taskId === taskId && event.seq > after); } };
  const commands = [];
  const events = [];
  const connector = createRelayConnector({
    url: endpoint.url, machineId: MACHINE.id, machineSecret: MACHINE.secret,
    manager: { on(event, handler) { if (event === 'task-event') events.push(handler); }, off() {}, listTasks: () => [] },
    dispatcher: { async handle(command) { commands.push(command); return { status: 'ACCEPTED', detail: { ok: true } }; } },
    store, localApiBase, logger: () => {}
  });
  t.after(() => connector.stop());
  await connector.start();

  const transport = createCloudTransport({ url: endpoint.url, machineId: MACHINE.id, deviceToken: TOKEN, logger: () => {} });
  t.after(() => transport.close());
  assert.equal(transport.kind, 'cloud');
  await transport.ready();

  // Attach: the agent gets the stored events first (replay), then the live ones.
  const received = [];
  const statuses = [];
  const handle = transport.open('tb_1', { after: 0, onEvent: event => received.push(event), onStatus: value => statuses.push(value) });
  for (let i = 0; i < 300 && received.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(received.map(event => event.seq), [1, 2], 'the missed events were replayed');
  assert.equal(handle.synced, true);

  events.forEach(handler => handler({ seq: 3, type: 'TASK_SUCCEEDED', taskId: 'tb_1', message: 'готово' }));
  for (let i = 0; i < 300 && received.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(received.at(-1).seq, 3, 'live events continue the same stream');
  assert.deepEqual(received.map(event => event.type), ['TASK_QUEUED', 'USER_MESSAGE', 'TASK_SUCCEEDED']);

  // A command goes to the machine and comes back acknowledged.
  const ack = await transport.command({ sessionId: 'tb_1', type: 'FOLLOW_UP', data: { text: 'продолжай' } });
  assert.equal(ack.status, 'ACCEPTED');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'FOLLOW_UP');
  assert.equal(commands[0].taskId, 'tb_1');
  assert.equal(commands[0].payload.text, 'продолжай');

  // The shared screens work: an allowed path is replayed against the machine's
  // own API and comes back exactly as a local page would see it.
  const models = await transport.request('GET', '/api/models');
  assert.deepEqual(models, { models: [{ provider: 'llama.cpp', id: 'qwen-27b-q3' }] });

  // A failure keeps its code, so the UI shows the same message as locally.
  await assert.rejects(transport.request('GET', '/api/tasks/42'), { code: 'NOT_FOUND' });

  // Non-JSON answers pass through as text.
  const plain = await transport.request('GET', '/api/info');
  assert.equal(typeof plain, 'string');

  // Anything outside the allowlist is refused by the machine, not by luck.
  await assert.rejects(transport.request('GET', '/api/project-browser?path=/'), { code: 'CLOUD_PATH_DENIED' });
  await assert.rejects(transport.request('POST', '/api/cloud/config', {}), { code: 'CLOUD_PATH_DENIED' });
  await assert.rejects(transport.request('GET', '/api/tasks/../secrets'), { code: 'CLOUD_PATH_DENIED' });
  assert.equal(statuses.includes('synced-empty'), false);
  handle.close();
});

test('the cloud transport surfaces an authentication refusal instead of hanging', async t => {
  const relay = createRelayServer({ logger: () => {}, auth: createSecretAuthenticator({ machines: [MACHINE], logger: () => {} }) });
  const endpoint = await relay.listen({ port: 0 });
  t.after(() => endpoint.close());
  const forged = issueDeviceToken({ machineId: MACHINE.id, deviceId: 'phone-1', secret: 'attacker-secret-0123456789' });
  const transport = createCloudTransport({ url: endpoint.url, machineId: MACHINE.id, deviceToken: forged, logger: () => {}, reconnectBaseMs: 10, reconnectMaxMs: 20 });
  t.after(() => transport.close());
  await assert.rejects(transport.ready(3_000), { code: 'AUTH_FAILED' });
  assert.equal(transport.status(), 'unauthorized');
});

test('a command that the machine never answers times out instead of hanging forever', async t => {
  const relay = createRelayServer({ logger: () => {}, auth: createSecretAuthenticator({ machines: [MACHINE], logger: () => {} }) });
  const endpoint = await relay.listen({ port: 0 });
  t.after(() => endpoint.close());
  // No machine is connected: the relay answers MACHINE_OFFLINE, and a command to
  // a machine that never replies must not leave the caller waiting.
  const transport = createCloudTransport({ url: endpoint.url, machineId: MACHINE.id, deviceToken: TOKEN, logger: () => {}, commandTimeoutMs: 150 });
  t.after(() => transport.close());
  await transport.ready();
  await assert.rejects(transport.command({ sessionId: 'tb_1', type: 'FOLLOW_UP' }), { code: 'COMMAND_TIMEOUT' });
});

test('the transport is chosen by where the page is served from', () => {
  assert.equal(selectTransport({ location: { hostname: 'localhost' } }).kind, 'local');
  assert.equal(selectTransport({ location: { hostname: '192.168.1.20' } }).kind, 'local');
  assert.equal(selectTransport({ location: { hostname: '10.0.0.5' } }).kind, 'local');
  // A public origin without relay configuration stays local (localhost dev).
  assert.equal(selectTransport({ location: { hostname: 'taskbridge.example.app' } }).kind, 'local');
  const cloud = selectTransport({
    location: { hostname: 'taskbridge.example.app' },
    cloud: { url: 'wss://relay.example.app/api/relay', machineId: 'home-pc', deviceToken: 'token', options: { logger: () => {} } }
  });
  assert.equal(cloud.kind, 'cloud');
});
