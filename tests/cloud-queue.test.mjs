import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryQueue, createUpstashQueue, createQueueFromEnv } from '../cloud/lib/relay-queue.mjs';
import { createRelayServer } from '../cloud/lib/relay-server.mjs';
import { createSecretAuthenticator } from '../cloud/lib/relay-auth.mjs';
import { createRelayConnector } from '../src/cloud/relay-connector.mjs';
import { createCloudTransport } from '../web/transport.mjs';
import { issueDeviceToken } from '../src/cloud/device-token.mjs';

// "Работает, пока ПК выключен": a command sent to a sleeping machine is parked
// durably and handed over the moment it dials in — in order, once.

const MACHINE = { id: 'home-pc', secret: 'machine-secret-0123456789' };
const DEVICE = 'phone-1';
const TOKEN = issueDeviceToken({ machineId: MACHINE.id, deviceId: DEVICE, secret: MACHINE.secret });
const frame = (commandId, type = 'STOP') => ({ type: 'COMMAND', machineId: MACHINE.id, commandId, payload: { type } });

/** A stand-in for Upstash: only the handful of commands the queue actually uses. */
async function fakeUpstash(t) {
  const lists = new Map();
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401); return res.end('{}'); }
      const commands = JSON.parse(body || '[]');
      const results = commands.map(([name, key, ...args]) => {
        calls.push(name);
        const list = lists.get(key) || [];
        if (name === 'RPUSH') { list.push(...args); lists.set(key, list); return { result: list.length }; }
        if (name === 'LTRIM') {
          const start = Number(args[0]);
          lists.set(key, start < 0 ? list.slice(start) : list.slice(start, Number(args[1]) + 1));
          return { result: 'OK' };
        }
        if (name === 'PEXPIRE') return { result: 1 };
        if (name === 'LRANGE') return { result: [...list] };
        if (name === 'DEL') { lists.delete(key); return { result: 1 }; }
        if (name === 'LLEN') return { result: list.length };
        return { error: `unknown command ${name}` };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(results));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}`, lists, calls };
}

test('the queue keeps order, caps itself and forgets stale commands', async () => {
  let clock = 1_000;
  const queue = createMemoryQueue({ maxItems: 3, ttlMs: 60_000, now: () => clock });

  await queue.enqueue('home-pc', frame('c1'));
  await queue.enqueue('home-pc', frame('c2'));
  assert.equal(await queue.size('home-pc'), 2);
  assert.equal(await queue.size('other-pc'), 0, 'queues are per machine');

  await queue.enqueue('home-pc', frame('c3'));
  await queue.enqueue('home-pc', frame('c4'));
  const drained = await queue.drain('home-pc');
  assert.deepEqual(drained.map(item => item.commandId), ['c2', 'c3', 'c4'], 'the cap drops the oldest, order is preserved');
  assert.deepEqual(await queue.drain('home-pc'), [], 'draining takes the commands out');

  await queue.enqueue('home-pc', frame('old'));
  clock += 61_000;
  assert.equal(await queue.size('home-pc'), 0, 'a day-old command is not delivered as a surprise');
  assert.deepEqual(await queue.drain('home-pc'), []);
});

test('the Upstash backend speaks the REST pipeline and survives a bad entry', async t => {
  const upstash = await fakeUpstash(t);
  const queue = createUpstashQueue({ url: upstash.url, token: 'test-token', maxItems: 2 });
  assert.equal(queue.kind, 'upstash');

  assert.deepEqual(await queue.enqueue(MACHINE.id, frame('c1')), { queued: 1 });
  await queue.enqueue(MACHINE.id, frame('c2'));
  await queue.enqueue(MACHINE.id, frame('c3'));
  assert.equal(await queue.size(MACHINE.id), 2, 'LTRIM enforced the cap on the server side');

  // Something else wrote junk into the list: the rest must still be delivered.
  upstash.lists.get(`taskbridge:queue:${MACHINE.id}`).splice(1, 0, 'not json');
  const drained = await queue.drain(MACHINE.id);
  assert.deepEqual(drained.map(item => item.commandId), ['c2', 'c3']);
  assert.equal(await queue.size(MACHINE.id), 0, 'the drain deleted the list');
  assert.ok(upstash.calls.includes('PEXPIRE'), 'the list must expire by itself if nobody ever drains it');

  // A wrong token is an error, not a silently lost command.
  const wrong = createUpstashQueue({ url: upstash.url, token: 'nope' });
  await assert.rejects(() => wrong.enqueue(MACHINE.id, frame('c4')), /replied 401/);
});

test('the backend is chosen by the environment', async t => {
  const upstash = await fakeUpstash(t);
  assert.equal(createQueueFromEnv({}).kind, 'memory');
  assert.equal(createQueueFromEnv({ UPSTASH_REDIS_REST_URL: upstash.url, UPSTASH_REDIS_REST_TOKEN: 'test-token' }).kind, 'upstash');
  // Vercel's own KV naming works too, so a Marketplace Redis needs no extra setup.
  assert.equal(createQueueFromEnv({ KV_REST_API_URL: upstash.url, KV_REST_API_TOKEN: 'test-token' }).kind, 'upstash');
  assert.equal(createQueueFromEnv({ UPSTASH_REDIS_REST_URL: upstash.url }).kind, 'memory', 'half a configuration is not a configuration');
});

test('a command sent while the PC is off is delivered when it comes back', { timeout: 40000 }, async t => {
  const upstash = await fakeUpstash(t);
  const queue = createUpstashQueue({ url: upstash.url, token: 'test-token' });
  const relay = createRelayServer({
    auth: createSecretAuthenticator({ machines: [MACHINE] }),
    queue,
    logger: () => {}
  });
  const endpoint = await relay.listen({ port: 0 });
  t.after(() => endpoint.close());

  // The phone connects while the machine is asleep.
  const transport = createCloudTransport({ url: endpoint.url, machineId: MACHINE.id, deviceToken: TOKEN, logger: () => {} });
  t.after(() => transport.close());
  await transport.ready();

  const first = await transport.command({ sessionId: 'tb_1', type: 'STOP', data: {}, timeoutMs: 5000 });
  assert.equal(first.status, 'ACCEPTED');
  assert.equal(first.queued, true, 'the phone is told it will be delivered later, not that it failed');
  assert.match(first.message, /офлайн/i);

  const second = await transport.command({ sessionId: 'tb_1', type: 'FOLLOW_UP', data: { text: 'продолжай' }, timeoutMs: 5000 });
  assert.equal(second.queued, true);
  assert.equal(await queue.size(MACHINE.id), 2, 'both wait in Redis, not in a process that may be recycled');

  // The PC wakes up.
  const executed = [];
  const connector = createRelayConnector({
    url: endpoint.url, machineId: MACHINE.id, machineSecret: MACHINE.secret,
    manager: { on() {}, off() {}, listTasks: () => [] },
    dispatcher: { async handle(command) { executed.push(command); return { status: 'ACCEPTED', detail: { ok: true } }; } },
    store: { async readEvents() { return []; } },
    logger: () => {}
  });
  t.after(() => connector.stop());
  await connector.start();

  for (let i = 0; i < 200 && executed.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(executed.map(command => command.type), ['STOP', 'FOLLOW_UP'], 'delivered in the order they were asked');
  assert.equal(await queue.size(MACHINE.id), 0, 'and taken out of the queue exactly once');

  // A second connect must not replay them again.
  await connector.stop();
  const replayed = [];
  const again = createRelayConnector({
    url: endpoint.url, machineId: MACHINE.id, machineSecret: MACHINE.secret,
    manager: { on() {}, off() {}, listTasks: () => [] },
    dispatcher: { async handle(command) { replayed.push(command); return { status: 'ACCEPTED', detail: {} }; } },
    store: { async readEvents() { return []; } },
    logger: () => {}
  });
  t.after(() => again.stop());
  await again.start();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(replayed, [], 'a delivered command is gone for good');
});

test('what cannot wait is still refused honestly while the machine is off', { timeout: 40000 }, async t => {
  const relay = createRelayServer({ auth: createSecretAuthenticator({ machines: [MACHINE] }), logger: () => {} });
  const endpoint = await relay.listen({ port: 0 });
  t.after(() => endpoint.close());

  const transport = createCloudTransport({ url: endpoint.url, machineId: MACHINE.id, deviceToken: TOKEN, logger: () => {} });
  t.after(() => transport.close());
  await transport.ready();

  // A REQUEST is a question that needs an answer now: parking it for a day
  // would leave the screen spinning instead of saying the machine is off.
  await assert.rejects(
    () => transport.request('GET', '/api/tasks'),
    error => {
      assert.match(`${error.code} ${error.message}`, /MACHINE_OFFLINE|offline/i);
      return true;
    }
  );
});
