import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { DEFAULT_SESSION_MAX_MB } from '../src/session-shrink.mjs';

// STAB-01C на серверном маршруте: что видит оператор, когда история повреждена или
// когда провайдер отказывает по размеру, а чинить нечего. Фейковый Pi разбирает
// JSONL теми же строками и так же падает на обрезанной записи; реакция настоящего
// Pi на такие файлы этим тестом не проверяется (говорится в отчёте отдельно).

const ACTIVE = ['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING'];
const LIMIT = DEFAULT_SESSION_MAX_MB * 1024 * 1024;

async function settle(api, id, { tries = 200, delay = 50 } = {}) {
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

// Один ход, после которого сессия остаётся под контролем теста: живой Pi убран,
// файл истории положен свой.
async function prepareSession(api, fixture, { content }) {
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первый ход' });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');
  await api(`/api/tasks/${id}/session/restart`, {});
  const dir = path.join(fixture.root, 'data', 'pi-sessions', id);
  await fs.mkdir(dir, { recursive: true });
  const existing = (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl'));
  const file = path.join(dir, existing[0] || '2026-01-01T00-00-00-000Z_fixture.jsonl');
  await fs.writeFile(file, content);
  return { id, file };
}

const events = async (api, id) => {
  const list = await api(`/api/tasks/${id}/events?limit=0`);
  return Array.isArray(list) ? list : list.events || [];
};

test('оборванная история: сессия не переписана, отправка отклонена 409 SESSION_INVALID', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const content = `${[sessionHeader, userLine('x'.repeat(LIMIT + 4096))].join('\n')}\n{"type":"message","id":"cut","message":{"role":"assis`;
  const { id, file } = await prepareSession(api, fixture, { content });
  const runsBefore = (await api(`/api/tasks/${id}/runs`)).runs;

  // Pi на повреждённом файле больше не запускается: попытка отклонена с причиной.
  const mediaDir = path.join(fixture.root, 'data', 'media');
  const mediaBefore = await fs.readdir(mediaDir).catch(() => []);
  const refusal = await api(`/api/tasks/${id}/message`, { text: 'продолжим' }).then(() => null, error => error);
  assert.ok(refusal, 'отправка должна быть отклонена');
  assert.equal(refusal.status, 409, 'HTTP 409, а не 500');
  assert.equal(refusal.code, 'SESSION_INVALID');
  assert.match(refusal.message, /повреждён/i, 'причина названа человеческим текстом');
  assert.match(refusal.message, /строка 3/, 'названа именно оборванная строка');
  assert.deepEqual(await fs.readdir(mediaDir).catch(() => []), mediaBefore, 'архив не тронут');

  const list = await events(api, id);
  const invalid = list.filter(event => event.type === 'SESSION_INVALID');
  assert.equal(invalid.length, 1, 'повреждение названо, а не спрятано');
  assert.equal(list.filter(event => event.type === 'SESSION_SHRUNK').length, 0, 'восстановления не было');
  assert.equal(list.filter(event => event.type === 'SESSION_RESTORED').length, 0, 'Pi не запускался на повреждённом файле');
  assert.equal(list.filter(event => event.type === 'USER_MESSAGE').length, 0, 'фантомного USER_MESSAGE нет');
  assert.equal(list.filter(event => event.type === 'PROMPT_QUEUED').length, 0, 'автоматического повтора нет');
  assert.equal(await fs.readFile(file, 'utf8'), content, 'файл байт в байт прежний');

  // Неудачная попытка видна в состоянии сессии, прежние Runs и история целы.
  const task = await api(`/api/tasks/${id}`);
  assert.equal(task.status, 'FAILED');
  assert.equal(task.errorCode, 'SESSION_INVALID');
  assert.match(task.error || '', /повреждён/i);
  const runsAfter = (await api(`/api/tasks/${id}/runs`)).runs;
  assert.deepEqual(runsAfter.map(run => [run.id, run.status]), runsBefore.map(run => [run.id, run.status]), 'прошлые прогоны не пере писаны');
  assert.ok(runsBefore.some(run => run.status === 'SUCCEEDED'), 'история прогонов не пуста');

  // Повторная попытка — тот же отказ, без нового TASK_FAILED и без роста ленты.
  const again = await api(`/api/tasks/${id}/message`, { text: 'ещё раз' }).then(() => null, error => error);
  assert.ok(again, 'и вторая попытка отклонена');
  const later = await events(api, id);
  // Повторный отказ приходит ответом 409 с тем же текстом, но лента не дублирует
  // одно и то же предупреждение (MEDIA-09F): вторая строка «файл повреждён» ничего
  // не добавляет.
  assert.equal(again.status, 409);
  assert.equal(again.code, 'SESSION_INVALID');
  assert.match(again.message, /повреждён/i);
  assert.equal(later.filter(event => event.type === 'SESSION_INVALID').length, 2, 'каждая попытка названа, но не дважды');
  assert.equal(later.filter(event => event.type === 'USER_MESSAGE').length, 0);
  assert.equal(await fs.readFile(file, 'utf8'), content);
});

// MEDIA-07, маленький файл: под лимитом восстановление ничего не делает, но пускать
// на него Pi нельзя — обрыв строки не зависит от размера.
test('повреждённая сессия меньше лимита тоже не пускает Pi', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const content = `${[sessionHeader, userLine('короткий разговор')].join('\n')}\n{"type":"message","id":"cut","message":{"role":"assis`;
  assert.ok(Buffer.byteLength(content) < LIMIT, 'фикстура действительно меньше лимита');
  const { id, file } = await prepareSession(api, fixture, { content });

  const mediaDir = path.join(fixture.root, 'data', 'media');
  const mediaBefore = await fs.readdir(mediaDir).catch(() => []);
  const refusal = await api(`/api/tasks/${id}/message`, { text: 'продолжим' }).then(() => null, error => error);
  assert.ok(refusal, 'маленький файл тоже защищён');
  assert.equal(refusal.status, 409);
  assert.equal(refusal.code, 'SESSION_INVALID');
  assert.match(refusal.message, /повреждён/i);
  assert.deepEqual(await fs.readdir(mediaDir).catch(() => []), mediaBefore, 'архив не тронут');
  assert.match(refusal.message, /строка 3/);
  const list = await events(api, id);
  assert.equal(list.filter(event => event.type === 'SESSION_RESTORED').length, 0, 'Pi не запускался');
  assert.equal(list.filter(event => event.type === 'SESSION_SHRUNK').length, 0, 'чинить было нечего');
  assert.equal(await fs.readFile(file, 'utf8'), content, 'файл не тронут');
  const task = await api(`/api/tasks/${id}`);
  assert.equal(task.status, 'FAILED');
  assert.equal(task.errorCode, 'SESSION_INVALID');
});

test('без возможности писать архив ложное «восстановлено» не появляется', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  // Каталог архива занят файлом: mkdir падает, и восстановление физически невозможно.
  const mediaDir = path.join(fixture.root, 'data', 'media');
  await fs.rm(mediaDir, { recursive: true, force: true });
  await fs.writeFile(mediaDir, 'not a directory');

  const images = ['a', 'b', 'c'].map(fill => JSON.stringify({
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId: `call-${fill}`,
      toolName: 'read',
      content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data: fill.repeat(9 * 1024 * 1024), mimeType: 'image/png' }]
    }
  }));
  const content = `${[sessionHeader, userLine('начало'), ...images].join('\n')}\n`;
  const { id, file } = await prepareSession(api, fixture, { content });

  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit structured' });
  const finished = await settle(api, id);

  const list = await events(api, id);
  assert.equal(list.filter(event => event.type === 'SESSION_SHRUNK').length, 0, 'SESSION_SHRUNK без состоявшейся записи — ложь');
  // Pi дописывает свои ходы (фейк кладёт три скриншота в ответ на 413), но
  // переписывать историю TaskBridge не мог: старый текст остался префиксом,
  // а плейсхолдеров восстановления в файле нет.
  const after = await fs.readFile(file, 'utf8');
  assert.ok(after.startsWith(content), 'начало истории не переписано');
  assert.doesNotMatch(after, /скриншот исключён/, 'восстановления не было');
  assert.equal((await fs.stat(mediaDir)).isFile(), true, 'каталог архива так и не появился');
  assert.equal(finished.status, 'FAILED');
  assert.equal(finished.errorCode, 'REQUEST_TOO_LARGE', 'причина названа прежней — размер запроса');
});

test('текстовая история больше лимита: провайдер отказал, повтор остановлен с понятным действием', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const content = `${[sessionHeader, userLine('x'.repeat(LIMIT + 4096))].join('\n')}\n`;
  const { id, file } = await prepareSession(api, fixture, { content });

  // `body-limit-text` — 413 без роста истории: она и так текстовая и уже велика.
  await api(`/api/tasks/${id}/message`, { text: 'fault-provider-incompatible body-limit-text structured' });
  const finished = await settle(api, id);

  const list = await events(api, id);
  const tooLarge = list.filter(event => event.type === 'SESSION_TOO_LARGE');
  assert.ok(tooLarge.length >= 1, 'оператор узнал, что уменьшать нечего');
  // Одна диагностика на старт сессии и одна на сам 413; главное — их не становится
  // больше без новых ходов (иначе это цикл повторов).
  assert.match(tooLarge[0].message, /Сожмите контекст или клонируйте сессию/i, 'оператору предложено конкретное действие');
  assert.equal(list.filter(event => event.type === 'SESSION_SHRUNK').length, 0, 'текст не уменьшали');
  assert.equal(finished.status, 'FAILED');
  assert.equal(finished.errorCode, 'REQUEST_TOO_LARGE');
  assert.ok((await fs.readFile(file, 'utf8')).startsWith(content), 'история не переписана');

  // Никаких бесконечных повторов: сессия остаётся в отказе, новых обращений нет.
  const settled = await settle(api, id);
  assert.equal(settled.status, 'FAILED');
  const later = await events(api, id);
  assert.equal(later.filter(event => event.type === 'SESSION_TOO_LARGE').length, tooLarge.length, 'второй диагностики без нового хода не появилось');
  assert.equal(later.filter(event => event.type === 'USER_MESSAGE' && /body-limit-text/.test(event.message)).length, 1, 'сообщение не размножилось');
});
