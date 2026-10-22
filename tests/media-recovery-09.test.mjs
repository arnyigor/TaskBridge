import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { DEFAULT_SESSION_MAX_MB } from '../src/session-shrink.mjs';

// STAB-01D / MEDIA-09: восстановление после 413 не должно превращаться в цикл
// повторов и не должно повторять побочные действия вслепую.
//
// Критерий допустимости автоповтора — счётчик выполнений инструментов в самом
// отказавшем ходе (`task._turnTools`, ведётся обработкой кадров Pi). Ход без
// инструментов продолжаем сами; ход, где уже что-то записано или выполнено, — нет:
// результат мог измениться, решает человек.

const ACTIVE = ['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING'];
const LIMIT = DEFAULT_SESSION_MAX_MB * 1024 * 1024;

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

// Сессия под контролем теста: живой Pi убран, файл истории свой и меньше лимита.
async function prepareSession(api, fixture, { content, overrides } = {}) {
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первый ход', ...(overrides || {}) });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');
  await api(`/api/tasks/${id}/session/restart`, {});
  const dir = path.join(fixture.root, 'data', 'pi-sessions', id);
  await fs.mkdir(dir, { recursive: true });
  const existing = (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl'));
  const file = path.join(dir, existing[0] || '2026-01-01T00-00-00-000Z_fixture.jsonl');
  await fs.writeFile(file, content ?? `${[sessionHeader, userLine('начало')].join('\n')}\n`);
  return { id, file };
}

// 09A: инструментов в отказавшем ходе не было — одно восстановление, один повтор.
test('09A: 413 без инструментов — ровно одно восстановление и один автоповтор', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const { id, file } = await prepareSession(api, fixture);

  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit read-only structured' });
  const finished = await settle(api, id);
  assert.equal(finished.status, 'FAILED');

  // Автоповтор — продолжение, а не повтор сообщения оператора.
  let resumed = finished;
  for (let i = 0; i < 300 && resumed.status !== 'SUCCEEDED'; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    resumed = await api(`/api/tasks/${id}`);
  }
  assert.equal(resumed.status, 'SUCCEEDED', resumed.error || '');

  const list = await events(api, id);
  assert.equal(count(list, 'SESSION_SHRUNK'), 1, 'одно восстановление');
  assert.equal(count(list, 'USER_MESSAGE'), 1, 'сообщение оператора не дублировано');
  assert.equal(count(list, 'RECOVERY_WITHHELD'), 0, 'продолжение не удерживалось');
  assert.equal(resumed.unknownResult ?? false, false);
  assert.ok((await fs.stat(file)).size < LIMIT, 'история уложилась в бюджет');
});

// 09D: в отказавшем ходе уже выполнился инструмент — сами не продолжаем.
test('09D: 413 после выполненного инструмента — восстановление без слепого повтора', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const { id, file } = await prepareSession(api, fixture);

  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit tools-ran structured' });
  const failed = await settle(api, id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'REQUEST_TOO_LARGE');
  assert.match(failed.error || '', /инструмент/i, 'оператору сказано, почему продолжение не запущено');
  assert.doesNotMatch(failed.error || '', /будет повторён автоматически/i);

  // Даём время любому (ошибочному) автоповтору проявиться.
  await new Promise(resolve => setTimeout(resolve, 1500));
  const after = await api(`/api/tasks/${id}`);
  assert.equal(after.status, 'FAILED', 'нового хода не было');
  assert.equal(after.unknownResult, true, 'состояние неопределённого результата видно в снимке');

  const list = await events(api, id);
  assert.equal(count(list, 'SESSION_SHRUNK'), 1, 'история всё-таки восстановлена');
  assert.equal(count(list, 'RECOVERY_WITHHELD'), 1, 'решение названо в ленте');
  assert.equal(count(list, 'USER_MESSAGE'), 1, 'фантомного сообщения нет');
  assert.equal(count(list, 'PROMPT_QUEUED'), 0, 'в очередь ничего не поставлено');
  assert.ok((await fs.stat(file)).size < LIMIT);
});

// 09B: второй 413 после восстановления — окончательный отказ, без третьего хода.
test('09B: повторный 413 после восстановления останавливает цикл', { timeout: 180000 }, async t => {
  const flag = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'tb-413-')), 'always-413');
  t.after(() => fs.rm(path.dirname(flag), { recursive: true, force: true }));
  const fixture = await startFixture(0, { env: { FAKE_PI_413_FLAG: flag } });
  t.after(() => fixture.close());
  const { api } = fixture;
  const { id } = await prepareSession(api, fixture);
  // С этого момента провайдер отвечает 413 на каждый ход, включая автоповтор.
  await fs.writeFile(flag, '1');

  await api(`/api/tasks/${id}/message`, { text: 'продолжай' });
  let task = await settle(api, id);
  for (let i = 0; i < 300 && task.status !== 'FAILED'; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    task = await api(`/api/tasks/${id}`);
  }
  assert.equal(task.status, 'FAILED', 'после второго отказа — окончательный FAILED');
  assert.equal(task.errorCode, 'REQUEST_TOO_LARGE');

  // Третьего хода быть не должно: ждём и убеждаемся, что ничего не ожило.
  await new Promise(resolve => setTimeout(resolve, 2000));
  const after = await api(`/api/tasks/${id}`);
  assert.equal(after.status, 'FAILED');
  // Число восстановлений зависит от того, успел ли файл вырасти между ходами, поэтому
  // критерий цикла — отсутствие НОВОЙ работы после отказа, а не точное число строк.
  const list = await events(api, id);
  assert.ok(count(list, 'SESSION_SHRUNK') >= 1, 'история действительно восстанавливалась');
  assert.equal(count(list, 'USER_MESSAGE'), 1, 'оператор отправил одно сообщение');
  const afterWait = await events(api, id);
  assert.equal(afterWait.length, list.length, 'после отказа новых событий не появилось — цикла нет');
  const turnsStarted = afterWait.filter(event => event.type === 'TURN_STATE' && event.data?.to === 'RUNNING');
  assert.ok(turnsStarted.length <= 3, `начатых ходов не больше трёх, было ${turnsStarted.length}`);
});

// 09C: текстовой истории чинить нечего — восстановления нет, повтора нет.
test('09C: текстовая история без изображений — восстановления и автоповтора нет', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const content = `${[sessionHeader, userLine('x'.repeat(LIMIT + 4096))].join('\n')}\n`;
  const { id, file } = await prepareSession(api, fixture, { content });

  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit-text structured' });
  const failed = await settle(api, id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'REQUEST_TOO_LARGE');
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await api(`/api/tasks/${id}`)).status, 'FAILED', 'автоповтора не было');

  const list = await events(api, id);
  assert.equal(count(list, 'SESSION_SHRUNK'), 0, 'чинить нечего — восстановления нет');
  assert.equal(count(list, 'PROMPT_QUEUED'), 0);
  // Pi дописывает свой ход, но TaskBridge ничего не выбросил: прежний текст — префикс,
  // плейсхолдеров восстановления нет.
  const after = await fs.readFile(file, 'utf8');
  assert.ok(after.startsWith(content), 'история не уменьшена');
  assert.doesNotMatch(after, /скриншот исключён/, 'восстановления не было');
});

// 09F: одно и то же предупреждение не повторяется в пределах попытки.
test('09F: SESSION_TOO_LARGE не дублируется в одной попытке', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const content = `${[sessionHeader, userLine('x'.repeat(LIMIT + 4096))].join('\n')}\n`;
  const { id } = await prepareSession(api, fixture, { content });

  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit-text structured' });
  const failed = await settle(api, id);
  assert.equal(failed.status, 'FAILED');
  const list = await events(api, id);
  assert.equal(count(list, 'SESSION_TOO_LARGE'), 1, 'preflight на старте и на 413 дают одну строку, а не две');
});

// 09G: повтор с тем же commandId не создаёт второй ход.
test('09G: повторная отправка с тем же commandId — один ход', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const { id } = await prepareSession(api, fixture);
  const commandId = 'cmd-09g-1';
  const text = 'обычный ход без отказа';

  await api(`/api/tasks/${id}/message`, { text, commandId });
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');
  const first = await events(api, id);
  const before = count(first, 'USER_MESSAGE');

  // Клиент повторил ту же команду (потерял ответ): второго хода быть не должно.
  await api(`/api/tasks/${id}/message`, { text, commandId });
  await new Promise(resolve => setTimeout(resolve, 500));
  const after = await events(api, id);
  assert.equal(count(after, 'USER_MESSAGE'), before, 'второго хода нет');
});

// 09H: архив не пишется (каталог занят файлом) — нет ложного восстановления и автоповтора.
test('09H: ошибка записи архива во время recovery — без ложного SESSION_SHRUNK', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const mediaDir = path.join(fixture.root, 'data', 'media');
  await fs.rm(mediaDir, { recursive: true, force: true });
  await fs.writeFile(mediaDir, 'not a directory');
  const { id } = await prepareSession(api, fixture);

  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit read-only structured' });
  const failed = await settle(api, id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'REQUEST_TOO_LARGE');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await api(`/api/tasks/${id}`)).status, 'FAILED', 'автоповтора не было');
  const list = await events(api, id);
  assert.equal(count(list, 'SESSION_SHRUNK'), 0, 'ложного восстановления нет');
  assert.equal(count(list, 'PROMPT_QUEUED'), 0, 'в очередь ничего не поставлено');
});

// 09E: перезапуск между восстановлением и продолжением. Результат отказавшего хода
// неизвестен (инструменты уже выполнились), поэтому после рестарта не должно быть
// ни повторной отправки сообщения, ни новой работы «из очереди».
test('09E: рестарт после удержанного восстановления не возобновляет работу', { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const { id, file } = await prepareSession(api, fixture);

  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit tools-ran structured' });
  const failed = await settle(api, id);
  assert.equal(failed.status, 'FAILED');
  assert.equal((await api(`/api/tasks/${id}`)).unknownResult, true);
  const before = await events(api, id);
  const fileBefore = await fs.readFile(file, 'utf8');

  await api('/api/health').catch(() => null);
  await fixture.restart();
  await new Promise(resolve => setTimeout(resolve, 2000));

  const after = await events(api, id);
  const task = await api(`/api/tasks/${id}`);
  assert.equal(task.status, 'FAILED', 'сессия не ожила сама');
  assert.equal(count(after, 'USER_MESSAGE'), count(before, 'USER_MESSAGE'), 'сообщение оператора не переслано');
  assert.equal(count(after, 'SESSION_SHRUNK'), count(before, 'SESSION_SHRUNK'), 'нового восстановления не запускалось');
  assert.equal(count(after, 'PROMPT_QUEUED'), 0, 'в очередь ничего не встало');
  assert.equal(await fs.readFile(file, 'utf8'), fileBefore, 'история не тронута');
});
