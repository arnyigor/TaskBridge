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

test('оборванная история: сессия не переписана, оператор видит повреждение', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const content = `${[sessionHeader, userLine('x'.repeat(LIMIT + 4096))].join('\n')}\n{"type":"message","id":"cut","message":{"role":"assis`;
  const { id, file } = await prepareSession(api, fixture, { content });

  // Pi разбирает JSONL сразу при старте и падает на оборванной строке — отправка
  // сообщения поэтому отклоняется: канал Pi уже закрыт. Проверяем те инварианты,
  // которые от этой гонки не зависят: файл не переписан, повреждение названо
  // один раз, восстановления не было.
  const sent = await api(`/api/tasks/${id}/message`, { text: 'продолжим' }).then(() => ({ ok: true }), error => ({ ok: false, error }));
  const finished = await settle(api, id);

  const list = await events(api, id);
  const invalid = list.filter(event => event.type === 'SESSION_INVALID');
  assert.equal(invalid.length, 1, 'повреждение названо, а не спрятано');
  assert.match(invalid[0].message, /повреждён/i);
  assert.match(invalid[0].message, /строка 3/, 'названа именно оборванная строка');
  assert.equal(list.filter(event => event.type === 'SESSION_SHRUNK').length, 0, 'восстановления не было');
  assert.equal(await fs.readFile(file, 'utf8'), content, 'файл байт в байт прежний');
  // Наблюдаемое поведение (описано в отчёте, не закрепляется как желаемое):
  // отправка возвращает 500 «Pi RPC session is not writable», и по этой ошибке
  // причину не видно — она есть только в ленте событий.
  if (!sent.ok) {
    assert.match(sent.error.message, /not writable/i);
    assert.ok(finished.error || finished.errorCode || finished.status, 'снимок сессии доступен');
  }
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
