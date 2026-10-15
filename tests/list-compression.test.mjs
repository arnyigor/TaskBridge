import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import http from 'node:http';
import { startFixture } from './server-fixture.mjs';

// Список сессий — первое, что грузит телефон, и он тянет его каждые 5 с. Без сжатия
// это была ~1.1 МБ по Wi-Fi (~50 КБ/с в тот день), и список открывался десятками
// секунд. JSON с повторяющимися ключами сжимается в разы, а распаковывают его сами
// клиенты (OkHttp, браузер) — серверу достаточно отдать content-encoding: gzip.

/**
 * «Сырой» GET: fetch распаковывает gzip сам (и оставляет заголовок), поэтому для
 * проверки сжатия нужен клиент без авто-распаковки.
 */
async function rawGet(base, path, headers = {}) {
  const url = new URL(`${base}${path}`);
  const { status, headers: got, buffer } = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, buffer: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
  return { response: { status, headers: { get: name => got[String(name).toLowerCase()] ?? null } }, buffer };
}

test('a list response is gzipped for a client that asks for it', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base } = fixture;
  // Несколько сессий, чтобы тело перевалило порог сжатия.
  for (let i = 0; i < 8; i++) await api('/api/tasks', { projectId: 'fixture', prompt: `сессия ${i}` });

  // fetch сам добавляет accept-encoding: gzip и распаковывает — поэтому «голый» запрос
  // сравниваем отдельно, с явными заголовками.
  const compressed = await rawGet(base, '/api/tasks', { 'accept-encoding': 'gzip' });
  assert.equal(compressed.response.headers.get('content-encoding'), 'gzip');
  assert.equal(compressed.response.headers.get('vary'), 'accept-encoding');
  const unpacked = JSON.parse(zlib.gunzipSync(compressed.buffer).toString('utf8'));
  assert.ok(Array.isArray(unpacked) && unpacked.length >= 8, `распакованный список: ${unpacked.length}`);
  assert.ok(compressed.buffer.length < zlib.gzipSync(Buffer.from(JSON.stringify(unpacked))).length * 2, 'тело действительно сжато');

  const plain = await rawGet(base, '/api/tasks', { 'accept-encoding': 'identity' });
  assert.equal(plain.response.headers.get('content-encoding'), null);
  assert.deepEqual(JSON.parse(plain.buffer.toString('utf8')).map(task => task.id), unpacked.map(task => task.id));
});

test('small answers stay uncompressed, and gzip never breaks a response', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  // /api/health — крошечный ответ: сжимать его незачем.
  const small = await rawGet(fixture.base, '/api/health', { 'accept-encoding': 'gzip' });
  assert.equal(small.response.headers.get('content-encoding'), null, 'мелкие ответы идут как есть');
  assert.equal(JSON.parse(small.buffer.toString('utf8')).status, 'ok');

  // Клиент, не умеющий gzip, получает обычный JSON по всем маршрутам.
  const info = await rawGet(fixture.base, '/api/info', { 'accept-encoding': 'identity' });
  assert.equal(info.response.status, 200);
  assert.ok(JSON.parse(info.buffer.toString('utf8')).bootId, 'ответ читается и без сжатия');
});

test('the session list carries counts instead of the full file lists', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'список' });
  for (let i = 0; i < 200; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const list = await api('/api/tasks');
  const entry = list.find(item => item.id === task.id);
  assert.ok(entry, 'сессия есть в списке');
  // Счётчики — то, что показывает строка списка; сами записи читает экран сессии.
  for (const field of ['outputFileCount', 'attachmentCount', 'fileCount']) {
    assert.ok(field in entry, `в списке нет ${field}`);
  }
  assert.ok(entry.outputFiles.length <= 3, `outputFiles урезан: ${entry.outputFiles.length}`);
  assert.ok((entry.git?.changedFiles?.length ?? 0) <= 3, 'список изменённых файлов урезан');
  if (entry.git) assert.ok('changedFileCount' in entry.git, 'у git есть счётчик изменённых файлов');
  // Тяжёлые для строки поля в списке не нужны: их читает только экран сессии.
  assert.equal(entry.metrics, null);
  assert.equal(entry.speeds, null);
  assert.equal(entry.lastUsage, null);
  assert.equal(entry.thinkingText, null);
  assert.ok(entry.model && typeof entry.model === 'object', 'подпись модели остаётся');
  assert.ok(!('contextWindow' in entry.model), 'описание модели урезано до подписи');

  // А сама сессия по-прежнему целая: список не влияет на экран чата.
  const whole = await api(`/api/tasks/${task.id}`);
  assert.ok('thinkingText' in whole, 'полная сессия не урезана');
});
