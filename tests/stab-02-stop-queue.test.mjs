import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

// STAB-02A: STOP в окне между снятием продолжения с очереди и вызовом Pi.
//
// Окно держит сам fake Pi: арм-файл `arm-<rpc>` задерживает ответ на одну RPC, пока
// не появится `release-<rpc>`, при этом процесс продолжает обрабатывать остальные
// кадры (abort). Поэтому STOP попадает ровно в «сообщение уже передаётся», без
// таймеров в production коде и без гонки с планировщиком.
//
// Инварианты: отменённое продолжение не уходит в Pi, CANCELLED не откатывается
// поздними событиями и не превращается обратно в QUEUED, очередь не воскрешает
// отменённый текст, а новый ручной запрос после STOP начинает обычный ход.

const LOCAL_MODEL = { provider: 'llama.cpp', id: 'qwen-27b' };
const ACTIVE = ['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING'];

async function fakeRouter(t) {
  let processing = true;
  const loaded = new Set(['qwen-27b']);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/health') return res.end('{"status":"ok"}');
    if (req.method === 'GET' && url.pathname === '/models') {
      return res.end(JSON.stringify({ data: [...loaded].map(id => ({ id, status: { value: 'loaded' }, meta: { n_ctx: 33792 } })) }));
    }
    if (url.pathname === '/slots') return res.end(JSON.stringify([{ model: 'qwen-27b', is_processing: processing }]));
    if (url.pathname === '/models/sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(': ok\n\n'); }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, free: () => { processing = false; } };
}

async function fixtureWithQueue(t, gateDir) {
  const router = await fakeRouter(t);
  const fixture = await startFixture(0, {
    env: { FAKE_PI_GATE_DIR: gateDir },
    root: {
      localRuntime: { provider: 'llama.cpp', healthUrl: `${router.base}/health`, router: { enabled: true } },
      queue: { pollMs: 50 }
    }
  });
  t.after(() => fixture.close());
  return { fixture, router };
}

const exists = file => fs.access(file).then(() => true, () => false);

async function waitFor(check, { tries = 300, delay = 50, what = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(`not reached: ${what}`);
}

const events = async (api, id) => {
  const list = await api(`/api/tasks/${id}/events?limit=0`);
  return Array.isArray(list) ? list : list.events || [];
};
const count = (list, type) => list.filter(event => event.type === type).length;
const texts = (list, type) => list.filter(event => event.type === type).map(event => event.data?.text);

async function settle(api, id, { tries = 200, delay = 50 } = {}) {
  let task;
  for (let i = 0; i < tries; i++) {
    task = await api(`/api/tasks/${id}`);
    if (!ACTIVE.includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(`task stayed ${task.status}`);
}

// Сценарий: модель занята → исходный запрос ждёт вместе с продолжением в очереди.
async function queuedSession(fixture) {
  const created = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'первый ход', model: LOCAL_MODEL });
  assert.equal(created.status, 'QUEUED', JSON.stringify(created).slice(0, 200));
  return created.id;
}

test('STAB-02A: STOP между dequeue и вызовом Pi не запускает отменённое продолжение', { timeout: 180000 }, async t => {
  const gateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-gate-02a-'));
  t.after(() => fs.rm(gateDir, { recursive: true, force: true }));
  const { fixture, router } = await fixtureWithQueue(t, gateDir);
  const { api } = fixture;
  const id = await queuedSession(fixture);

  // Продолжение с mode=follow_up и слэшем: до вызова Pi доставка спрашивает у Pi
  // список команд — это и есть детерминированная точка «снято с очереди, ещё не отправлено».
  const queued = await api(`/api/tasks/${id}/message`, { text: '/finish the report', mode: 'follow_up', queue: true });
  assert.equal(queued.status, 'QUEUED');

  await fs.writeFile(path.join(gateDir, 'arm-commands'), '1');
  router.free();

  await waitFor(() => exists(path.join(gateDir, 'parked-commands')), { what: 'продолжение снято с очереди и ждёт Pi' });

  // STOP в этом окне. Сессия ещё QUEUED, поэтому отмена должна стать терминальной.
  const stopped = await api(`/api/tasks/${id}/cancel`, {});
  assert.ok(['CANCELLED', 'CANCELLING'].includes(stopped.status), `STOP вернул ${stopped.status}`);
  const cancelled = await settle(api, id);
  assert.equal(cancelled.status, 'CANCELLED', cancelled.error || '');

  // Освобождаем Pi: доставка после STOP не имеет права начать ход.
  await fs.writeFile(path.join(gateDir, 'release-commands'), '1');
  await new Promise(resolve => setTimeout(resolve, 2000));

  const after = await api(`/api/tasks/${id}`);
  assert.equal(after.status, 'CANCELLED', 'отмена откатилась после поздних событий');
  const list = await events(api, id);
  assert.deepEqual(texts(list, 'USER_MESSAGE'), [], 'отменённое продолжение ушло в Pi');
  assert.equal(count(list, 'QUEUE_RETRY'), 0, 'обработчик ошибки вернул отменённое сообщение в очередь');
  assert.deepEqual((after.pendingPrompts || []).map(entry => entry.text), [], 'отменённый текст остался в очереди');

  // Перезапуск сервера не воскрешает снятую работу.
  await fixture.restart();
  await new Promise(resolve => setTimeout(resolve, 2000));
  const restarted = await api(`/api/tasks/${id}`);
  assert.equal(restarted.status, 'CANCELLED', `после рестарта: ${restarted.status}`);
  assert.deepEqual((restarted.pendingPrompts || []).map(entry => entry.text), []);
  assert.deepEqual(texts(await events(api, id), 'USER_MESSAGE'), [], 'после рестарта продолжение не отправлено');

  // Сессия не заблокирована: новый ручной запрос проходит обычным ходом.
  await api(`/api/tasks/${id}/message`, { text: 'продолжаем вручную' });
  const finished = await settle(api, id);
  assert.equal(finished.status, 'SUCCEEDED', finished.error || '');
  assert.deepEqual(texts(await events(api, id), 'USER_MESSAGE'), ['продолжаем вручную']);
});

test('STAB-02A: STOP при уже отправленном prompt не воскрешает отменённый ход', { timeout: 180000 }, async t => {
  const gateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-gate-02a-'));
  t.after(() => fs.rm(gateDir, { recursive: true, force: true }));
  const { fixture, router } = await fixtureWithQueue(t, gateDir);
  const { api } = fixture;
  const id = await queuedSession(fixture);

  await api(`/api/tasks/${id}/message`, { text: 'продолжение после ответа', mode: 'follow_up', queue: true });
  await fs.writeFile(path.join(gateDir, 'arm-prompt'), '1');
  router.free();

  // Запрос уже в Pi (RPC ждёт ответа), ход ещё не подтверждён.
  await waitFor(() => exists(path.join(gateDir, 'parked-prompt')), { what: 'prompt в Pi' });

  const stopped = await api(`/api/tasks/${id}/cancel`, {});
  assert.ok(['CANCELLED', 'CANCELLING'].includes(stopped.status), `STOP вернул ${stopped.status}`);
  assert.equal((await settle(api, id)).status, 'CANCELLED');

  await fs.writeFile(path.join(gateDir, 'release-prompt'), '1');
  await new Promise(resolve => setTimeout(resolve, 2500));

  const after = await api(`/api/tasks/${id}`);
  assert.equal(after.status, 'CANCELLED', `поздний ACK воскресил отменённый ход: ${after.status}`);
  const list = await events(api, id);
  assert.deepEqual(texts(list, 'USER_MESSAGE'), [], 'отменённое сообщение объявлено пользовательским ходом');
});
