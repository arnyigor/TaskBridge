// TB-STAB-01, задача 1: некорректный запрос — это ошибка клиента, а не сервера.
//
// Повод: тело "[object Object]" (так выглядит объект, переданный в fetch без
// JSON.stringify) отвечало 500 INTERNAL_ERROR с текстом парсера. Клиентская
// ошибка не должна выглядеть как сбой сервера — и не должна стоить 5xx в метриках.
//
// Проверяется на живом фикстуре (tests/server-fixture.mjs): сырые тела, кодировка,
// Content-Type, лимит размера и обычный рабочий запрос — чтобы правка не сломала
// счастливый путь.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';

const raw = (base, path, { body, headers = {}, method = 'POST' } = {}) => fetch(`${base}${path}`, { method, body, headers });

const asJson = async response => ({ status: response.status, body: await response.json() });

test('тело «[object Object]» — 400 INPUT_INVALID, без текста парсера', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { status, body } = await asJson(await raw(fixture.base, '/api/tasks', {
    body: '[object Object]',
    headers: { 'content-type': 'application/json' },
  }));
  assert.equal(status, 400, JSON.stringify(body));
  assert.equal(body.code, 'INPUT_INVALID');
  assert.match(body.error, /корректным JSON/);
  // Внутренности парсера наружу не уходят: это диагностика сервера, а не ответ.
  assert.doesNotMatch(body.error, /Unexpected|JSON\.parse|position \d+/i);
  assert.equal(body.stack, undefined);
});

test('обрезанный JSON и мусор в теле — тоже 400, а не 500', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  for (const body of ['{"prompt": "x"', '{"prompt": }', '{prompt: "x"}', 'nonsense', '[]']) {
    const response = await asJson(await raw(fixture.base, '/api/tasks', { body, headers: { 'content-type': 'application/json' } }));
    // `[]` — валидный JSON, но не объект: его отбрасывает валидация эндпоинта,
    // главное — тоже 4xx, а не 500.
    assert.ok(response.status >= 400 && response.status < 500, `${body} → ${response.status} ${JSON.stringify(response.body)}`);
    assert.notEqual(response.status, 500, body);
  }
});

test('битый UTF-8 — 400 INPUT_INVALID, а не тихая замена на U+FFFD', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const broken = Buffer.from([0x7b, 0x22, 0x70, 0x72, 0x6f, 0x6d, 0x70, 0x74, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
  const { status, body } = await asJson(await raw(fixture.base, '/api/tasks', { body: broken, headers: { 'content-type': 'application/json' } }));
  assert.equal(status, 400, JSON.stringify(body));
  assert.equal(body.code, 'INPUT_INVALID');
  assert.match(body.error, /UTF-8/);
});

test('неверный Content-Type отклоняется контрактом', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { status, body } = await asJson(await raw(fixture.base, '/api/tasks', {
    body: 'prompt=x',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }));
  assert.equal(status, 400);
  assert.equal(body.code, 'INPUT_INVALID');
  assert.match(body.error, /JSON/);
});

test('тело больше лимита — 413 BODY_TOO_LARGE', async t => {
  // Лимит проверяется по конфигу, поэтому в фикстуре он крошечный: 1 КБ.
  const fixture = await startFixture(undefined, { server: { maxBodyMb: 0.001 } });
  t.after(() => fixture.close());
  const body = JSON.stringify({ prompt: 'x'.repeat(4096) });
  const response = await asJson(await raw(fixture.base, '/api/tasks', { body, headers: { 'content-type': 'application/json' } }));
  assert.equal(response.status, 413, JSON.stringify(response.body));
  assert.equal(response.body.code, 'BODY_TOO_LARGE');
});

test('пустое тело — обычная валидация эндпоинта, не 500', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const response = await asJson(await raw(fixture.base, '/api/tasks', { body: '', headers: { 'content-type': 'application/json' } }));
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.code, 'INPUT_INVALID');
});

test('корректный JSON по-прежнему работает', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const created = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'Есть ли файл?' });
  assert.ok(created.id, JSON.stringify(created));
});
