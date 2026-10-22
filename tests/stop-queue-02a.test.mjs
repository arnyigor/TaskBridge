import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

// STAB-02A: STOP и очередь. Отменённая команда не должна запускаться после dequeue,
// а отмена не должна навсегда блокировать сессию.
//
// Окно ловится по наблюдаемому признаку, а не по таймеру: continuation после
// восстановления виден в снимке задачи (`pendingPrompts` / `queueReason`), и STOP
// отправляется сразу, как только он там появился.

const ACTIVE = ['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING'];

async function settle(api, id, { tries = 300, delay = 50 } = {}) {
  let task;
  for (let i = 0; i < tries; i++) {
    task = await api(`/api/tasks/${id}`);
    if (!ACTIVE.includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(`task stayed ${task.status}`);
}

const sessionHeader = JSON.stringify({ type: 'session', version: 1, id: 'fixture-session' });
const userLine = text => JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
const events = async (api, id) => {
  const list = await api(`/api/tasks/${id}/events?limit=0`);
  return Array.isArray(list) ? list : list.events || [];
};
const count = (list, type) => list.filter(event => event.type === type).length;

async function prepareSession(api, fixture) {
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первый ход' });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');
  await api(`/api/tasks/${id}/session/restart`, {});
  const dir = path.join(fixture.root, 'data', 'pi-sessions', id);
  await fs.mkdir(dir, { recursive: true });
  const existing = (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl'));
  const file = path.join(dir, existing[0] || '2026-01-01T00-00-00-000Z_fixture.jsonl');
  await fs.writeFile(file, `${[sessionHeader, userLine('начало')].join('\n')}\n`);
  return { id, file };
}

const waitFor = async (check, { tries = 400, delay = 50 } = {}) => {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return false;
};

// 10E: STOP в окне «продолжение снято с очереди, ход ещё не начался».
// Окно держит сама фикстура: fake Pi паркуется на старте (FAKE_PI_GATE_DIR),
// поэтому тест не зависит от гонки с планировщиком.
test('STAB-02A: STOP на старте снятого с очереди продолжения — ход не начинается', { timeout: 180000 }, async t => {
  const gateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-gate-'));
  t.after(() => fs.rm(gateDir, { recursive: true, force: true }));
  const fixture = await startFixture(0, { env: { FAKE_PI_GATE_DIR: gateDir, FAKE_PI_GATE_ARM_ON_413: '1' } });
  t.after(() => fixture.close());
  const { api } = fixture;
  const { id, file } = await prepareSession(api, fixture);

  // Заслонку взведёт сам fake Pi в момент 413 — так паркуется именно продолжение,
  // а не сессия, в которой происходит отказ.
  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit read-only structured' });

  assert.ok(await waitFor(async () => fs.access(path.join(gateDir, 'parked')).then(() => true, () => false)),
    'продолжение снято с очереди и ждёт запуска Pi');

  const stopPromise = api(`/api/tasks/${id}/cancel`, {}).then(value => value, error => error);
  await new Promise(resolve => setTimeout(resolve, 300));
  await fs.writeFile(path.join(gateDir, 'release'), '1');
  const stopped = await stopPromise;
  assert.ok(stopped?.status, `STOP отклонён: ${stopped?.message ?? stopped?.status}`);

  const final = await settle(api, id);
  assert.ok(['CANCELLED', 'FAILED'].includes(final.status), `после STOP: ${final.status}`);

  // Планировщик получил отпущенный Pi: ход не должен начаться.
  await new Promise(resolve => setTimeout(resolve, 2500));
  const after = await api(`/api/tasks/${id}`);
  assert.ok(['CANCELLED', 'FAILED'].includes(after.status), `снятая работа запустилась: ${after.status}`);
  const list = await events(api, id);
  assert.equal(count(list, 'USER_MESSAGE'), 1, 'сообщение оператора одно');
  assert.ok(count(list, 'TASK_SUCCEEDED') <= 1, 'второго успешного хода нет');
  const text = await fs.readFile(file, 'utf8');
  for (const line of text.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line), 'история разбирается');

  // Перезапуск сервера не оживляет снятую работу.
  await fixture.restart();
  await new Promise(resolve => setTimeout(resolve, 2000));
  const restarted = await api(`/api/tasks/${id}`);
  assert.ok(['CANCELLED', 'FAILED'].includes(restarted.status), `после рестарта: ${restarted.status}`);
  assert.equal(count(await events(api, id), 'USER_MESSAGE'), 1);
});

// Отмена не блокирует сессию навсегда: новый запрос оператора стартует штатно.
test('STAB-02A: после отмены новый запрос оператора начинает новый ход', { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const { id } = await prepareSession(api, fixture);

  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit read-only structured' });
  // Ждём любого терминального состояния: автовосстановление могло и успеть.
  const failed = await settle(api, id);
  assert.ok(['FAILED', 'SUCCEEDED'].includes(failed.status), `после 413: ${failed.status}`);
  // STOP (в том числе по уже завершённому ходу) не должен навсегда закрыть сессию.
  await api(`/api/tasks/${id}/cancel`, {}).catch(() => null);
  await settle(api, id);

  // Ручной ход после отмены: обычный текст, без ключевых слов фикстуры.
  await api(`/api/tasks/${id}/message`, { text: 'продолжаем вручную' });
  const finished = await settle(api, id);
  assert.equal(finished.status, 'SUCCEEDED', finished.error || '');
  const list = await events(api, id);
  assert.equal(count(list, 'USER_MESSAGE'), 2, 'оба сообщения оператора в истории');
});
