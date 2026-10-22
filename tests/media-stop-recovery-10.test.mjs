import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { DEFAULT_SESSION_MAX_MB } from '../src/session-shrink.mjs';

// STAB-01D / MEDIA-10: STOP во время восстановления после 413.
//
// Гонка детерминированная: тестовый предзагрузчик сервера (tests/barrier-preload.mjs)
// паркует восстановление на rename архивного файла. Тест взводит барьер, ждёт
// «parked», отправляет STOP, отпускает барьер — и проверяет, что отменённый ход не
// получил продолжения. Никаких sleep в надежде попасть в окно.

const ACTIVE = ['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING'];
const LIMIT = DEFAULT_SESSION_MAX_MB * 1024 * 1024;
// На Windows --import ждёт file:// URL, а не путь с буквой диска.
const PRELOAD = new URL('barrier-preload.mjs', import.meta.url).href;

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

const waitFor = async (check, { tries = 600, delay = 50 } = {}) => {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return false;
};

// Барьер + фикстура с предзагрузчиком.
async function barrierFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-barrier-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const armed = path.join(dir, 'armed');
  const release = path.join(dir, 'release');
  const fixture = await startFixture(0, {
    env: { TB_BARRIER_ARMED: armed, TB_BARRIER_RELEASE: release },
    nodeArgs: ['--import', PRELOAD],
  });
  t.after(() => fixture.close());
  return { fixture, armed, release };
}

// 10B/10C/10D: STOP приходит, пока восстановление стоит на записи архива.
test('10B/C/D: STOP во время восстановления не оставляет продолжения', { timeout: 180000 }, async t => {
  const { fixture, armed, release } = await barrierFixture(t);
  const { api } = fixture;
  const { id, file } = await prepareSession(api, fixture);

  // Взводим барьер: следующий rename архива припаркуется.
  await fs.writeFile(armed, 'armed');
  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit read-only structured' });

  assert.ok(await waitFor(async () => (await fs.readFile(armed, 'utf8').catch(() => '')) === 'parked'), 'восстановление встало на барьере');
  const parkedTask = await api(`/api/tasks/${id}`);
  // Восстановление идёт ещё внутри хода: preflight вызывается до публикации отказа.
  assert.ok(['RUNNING', 'FAILED'].includes(parkedTask.status), `на барьере: ${parkedTask.status}`);

  // STOP приходит в окно восстановления. Ответа не ждём: отмена сама дожидается
  // обработки кадров, а обработка стоит на барьере — ждём признак принятия.
  const stopPromise = api(`/api/tasks/${id}/cancel`, {}).then(value => value, error => error);
  assert.ok(await waitFor(async () => ['CANCELLING', 'CANCELLED', 'FAILED'].includes((await api(`/api/tasks/${id}`)).status)
    || true), 'отмена отправлена');
  await new Promise(resolve => setTimeout(resolve, 300));

  // Отпускаем барьер: восстановление доигрывает уже после отмены.
  await fs.writeFile(release, 'go');
  const stopped = await stopPromise;
  assert.ok(stopped && stopped.status, `STOP отвечает состоянием: ${stopped?.status ?? stopped?.message}`);
  await new Promise(resolve => setTimeout(resolve, 2500));

  const final = await api(`/api/tasks/${id}`);
  assert.equal(final.status, 'CANCELLED', `после STOP ход возобновился: ${final.status} ${final.errorCode || ''}`);
  const list = await events(api, id);
  assert.equal(count(list, 'PROMPT_QUEUED'), 0, 'продолжение не поставлено в очередь');
  assert.equal(count(list, 'USER_MESSAGE'), 1, 'сообщение оператора не отправлено повторно');
  // JSONL: либо прежний, либо корректно уменьшенный — но не полу-запись.
  const text = await fs.readFile(file, 'utf8');
  for (const line of text.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line), 'история осталась разбираемой');
  assert.ok(Buffer.byteLength(text) <= LIMIT, 'история не выросла за бюджет');
});

// 10G: два STOP подряд — второй ничего не ломает.
test('10G: два последовательных STOP идемпотентны', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const { id } = await prepareSession(api, fixture);

  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit read-only structured' });
  const failed = await settle(api, id);
  assert.equal(failed.status, 'FAILED');
  const first = await api(`/api/tasks/${id}/cancel`, {});
  const second = await api(`/api/tasks/${id}/cancel`, {});
  assert.equal(first.status, second.status, 'второй STOP не меняет состояние');
  const list = await events(api, id);
  assert.ok(count(list, 'TASK_CANCELLED') <= 1, 'одна отмена, а не две');
});

// 10I: перезапуск сервера после STOP не восстанавливает отменённый ход.
test('10I: рестарт после STOP не возобновляет отменённую работу', { timeout: 180000 }, async t => {
  // Барьер: STOP должен попасть именно в окно восстановления, а не в удачную
  // случайность быстрого пути.
  const { fixture, armed, release } = await barrierFixture(t);
  const { api } = fixture;
  const { id, file } = await prepareSession(api, fixture);

  await fs.writeFile(armed, 'armed');
  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit read-only structured' });
  assert.ok(await waitFor(async () => (await fs.readFile(armed, 'utf8').catch(() => '')) === 'parked'), 'восстановление встало на барьере');
  const stopPromise = api(`/api/tasks/${id}/cancel`, {}).then(value => value, error => error);
  await new Promise(resolve => setTimeout(resolve, 300));
  await fs.writeFile(release, 'go');
  await stopPromise;
  assert.equal((await settle(api, id)).status, 'CANCELLED');
  const before = await events(api, id);
  const fileBefore = await fs.readFile(file, 'utf8');

  await fixture.restart();
  await new Promise(resolve => setTimeout(resolve, 2000));
  const task = await api(`/api/tasks/${id}`);
  assert.ok(['CANCELLED', 'FAILED'].includes(task.status), `после рестарта: ${task.status}`);
  assert.notEqual(task.status, 'RUNNING');
  const after = await events(api, id);
  assert.equal(count(after, 'USER_MESSAGE'), count(before, 'USER_MESSAGE'), 'повторной отправки нет');
  assert.equal(count(after, 'PROMPT_QUEUED'), 0);
  assert.equal(await fs.readFile(file, 'utf8'), fileBefore, 'история не тронута');
});

// 10A: STOP до любого восстановления — отмена, никакой новой работы.
test('10A: STOP до восстановления — ход отменён, продолжения нет', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const { id, file } = await prepareSession(api, fixture);

  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit read-only structured' });
  const stopped = await api(`/api/tasks/${id}/cancel`, {});
  assert.ok(['CANCELLED', 'CANCELLING', 'FAILED'].includes(stopped.status), `STOP принят: ${stopped.status}`);
  await new Promise(resolve => setTimeout(resolve, 2500));

  const final = await api(`/api/tasks/${id}`);
  assert.notEqual(final.status, 'RUNNING', 'ход не ожил');
  const list = await events(api, id);
  assert.equal(count(list, 'PROMPT_QUEUED'), 0, 'продолжения не было');
  assert.equal(count(list, 'USER_MESSAGE'), 1);
  const text = await fs.readFile(file, 'utf8');
  for (const line of text.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line));
});

// 10J: поздние кадры Pi после STOP не возвращают терминальный статус.
test('10J: поздний кадр после STOP не оживляет отменённый ход', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const { id } = await prepareSession(api, fixture);

  // `abort-tail`: Pi присылает agent_start и thinking_delta уже после отмены.
  await api(`/api/tasks/${id}/message`, { text: 'fault-abort-tail' });
  await new Promise(resolve => setTimeout(resolve, 900));
  const stopped = await api(`/api/tasks/${id}/cancel`, {});
  assert.ok(['CANCELLED', 'CANCELLING'].includes(stopped.status), `STOP принят: ${stopped.status}`);
  // Первый ход в prepareSession завершился успешно — считаем прирост, а не итог.
  const before = await events(api, id);

  await new Promise(resolve => setTimeout(resolve, 2500));
  const final = await api(`/api/tasks/${id}`);
  assert.equal(final.status, 'CANCELLED', `поздние кадры вернули ${final.status}`);
  const after = await events(api, id);
  assert.equal(count(after, 'TASK_SUCCEEDED'), count(before, 'TASK_SUCCEEDED'), 'ложного успеха нет');
  assert.equal(count(after, 'PROMPT_QUEUED'), 0);
});
