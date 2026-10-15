import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WakeChannel, isLanAddress, isValidWakePort } from '../src/wake-channel.mjs';
import { startFixture } from './server-fixture.mjs';

// Свой push-канал в локальной сети (4.3, решение оператора 2026-10-14: только LAN,
// без внешних сервисов). Доставка at-most-once: промах — штатный сон устройства.

test('only private addresses may register', () => {
  assert.equal(isLanAddress('192.168.1.132'), true);
  assert.equal(isLanAddress('::ffff:192.168.1.132'), true, 'IPv4-маппинг IPv6 — тот же телефон');
  assert.equal(isLanAddress('127.0.0.1'), true);
  assert.equal(isLanAddress('10.0.0.5'), true);
  assert.equal(isLanAddress('172.16.0.9'), true);
  assert.equal(isLanAddress('172.32.0.9'), false, '172.32 — уже не приватный диапазон');
  assert.equal(isLanAddress('8.8.8.8'), false, 'публичный адрес зарегистрировать нельзя');
  assert.equal(isLanAddress('2a01:5f8::1'), false);
  assert.equal(isLanAddress(''), false);
});

test('ports are validated', () => {
  assert.equal(isValidWakePort(45454), true);
  assert.equal(isValidWakePort(0), false);
  assert.equal(isValidWakePort(70000), false);
  assert.equal(isValidWakePort(45454.5), false);
});

test('re-registering the same device replaces its old port', () => {
  const channel = new WakeChannel();
  assert.deepEqual(channel.register({ address: '192.168.1.132', port: 40000 }), { ok: true, id: '192.168.1.132:40000' });
  assert.deepEqual(channel.register({ address: '192.168.1.132', port: 40001 }), { ok: true, id: '192.168.1.132:40001' });
  assert.deepEqual(channel.devices.map(device => device.port), [40001], 'мёртвый приёмник не остаётся в списке');
});

test('a wake reaches the registered device with the task identity', async t => {
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => receiver.close(resolve)));
  const port = receiver.address().port;

  const channel = new WakeChannel();
  channel.register({ address: '127.0.0.1', port });
  const result = await channel.sendAll({ taskId: 't1', type: 'TASK_SUCCEEDED', at: '2026-10-14T00:00:00Z' });
  assert.equal(result.sent, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/wake');
  assert.equal(received[0].body.taskId, 't1');
  assert.equal(received[0].body.type, 'TASK_SUCCEEDED');
});

test('unreachable devices are tolerated and pruned after repeated failures', async t => {
  let now = 1_000;
  const channel = new WakeChannel({ now: () => now, timeoutMs: 300 });
  channel.register({ address: '127.0.0.1', port: 1 }); // порт 1 — никто не слушает
  for (let attempt = 0; attempt < 5; attempt++) {
    await channel.sendAll({ taskId: 't1', type: 'TASK_SUCCEEDED', at: 'x' });
    now += 1_000;
  }
  assert.equal(channel.devices.length, 0, 'мёртвое устройство забывается, а не копится вечно');
});

test('the endpoint registers a LAN device and a turn wakes it end-to-end', { timeout: 120_000 }, async t => {
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => receiver.close(resolve)));

  const fixture = await startFixture();
  t.after(() => fixture.close());

  const registered = await fixture.api('/api/clients/wake', { port: receiver.address().port });
  assert.equal(registered.ok, true, JSON.stringify(registered));

  // Полный путь: ход фейкового Pi завершается → сервер будит приёмник.
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'Прочитай example.txt' });
  const woke = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`устройство не разбужено; received=${JSON.stringify(received)}`)), 60_000);
    const poll = setInterval(() => {
      const event = received.find(item => item.taskId === task.id && item.type === 'TASK_SUCCEEDED');
      if (event) { clearInterval(poll); clearTimeout(timer); resolve(event); }
    }, 50);
  });
  assert.equal(woke.type, 'TASK_SUCCEEDED');
});
