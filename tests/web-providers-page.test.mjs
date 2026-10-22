// Страница провайдеров под настоящим DOM (linkedom): проверяется связка, которую
// не видит ни node --check, ни серверный тест — что скрипт страницы запускается,
// рисует список, собирает предпросмотр и зовёт маршрут мастера с теми полями,
// которые ждёт сервер (пункты 2.3/2.5 плана).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'web', 'providers.html'), 'utf8');
// Пути модулей переписываются на абсолютные file:// адреса: стенд исполняет
// страницу через new Function (с vm понадобился бы --experimental-vm-modules), а
// динамический import там разрешается относительно файла теста, не страницы.
const moduleUrl = name => pathToFileURL(path.join(root, 'web', name)).href;
const source = fs.readFileSync(path.join(root, 'web', 'providers.js'), 'utf8')
  .replaceAll("'./provider-check-view.mjs'", `'${moduleUrl('provider-check-view.mjs')}'`)
  .replaceAll("'./provider-wizard-view.mjs'", `'${moduleUrl('provider-wizard-view.mjs')}'`);

const PROFILES = {
  revision: 'rev-1',
  providers: [
    { id: 'tb-demo', managed: true, modelCount: 2, auth: 'configured', baseUrl: 'https://api.example/v1', keyEnv: 'DEMO_KEY', models: [{ id: 'a' }, { id: 'b' }] },
    { id: 'external', managed: false, modelCount: 14, auth: 'configured-elsewhere', baseUrl: 'https://other.example/v1', keyEnv: '', models: [] },
  ],
};

function buildPage({ draft = null } = {}) {
  const { document, window } = parseHTML(html);
  const calls = [];
  const fetchStub = async (url, options = {}) => {
    const target = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: target, method: options.method || 'GET', body });
    const payload = target.endsWith('/draft-check')
      ? (draft || { ok: true, status: 'NO_KEY', models: [], note: 'нет ключа' })
      : PROFILES;
    return { ok: true, status: 200, json: async () => payload };
  };
  // В linkedom у select только геттер value (та же особенность, из-за которой
  // web/model-picker-view.mjs отмечает опцию атрибутом): даём стенду сеттер,
  // чтобы проверять логику страницы, а не поведение библиотеки.
  const preset = document.getElementById('preset');
  Object.defineProperty(preset, 'value', {
    configurable: true,
    get() { return this.getAttribute('data-value') || ''; },
    set(next) { this.setAttribute('data-value', String(next)); },
  });
  new Function('document', 'window', 'fetch', 'confirm', 'console', 'setTimeout', source)(
    document, window, fetchStub, () => true, console, setTimeout);
  return { document, window, calls };
}

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Наполняет форму и ждёт, пока страница нарисует предпросмотр. Модули вида
 * подгружаются динамическим import, поэтому ждём результат, а не фиксированную
 * паузу: на медленной машине пауза стала бы флейком.
 */
async function fillDraft(document, window, { id = 'tb-new', baseUrl = 'https://api.example/v1', keyEnv = 'NEW_KEY', models = 'm1\nm2' } = {}) {
  document.getElementById('provider-id').value = id;
  document.getElementById('base-url').value = baseUrl;
  document.getElementById('key-env').value = keyEnv;
  document.getElementById('models').value = models;
  document.getElementById('models').dispatchEvent(new window.Event('input'));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = document.getElementById('draft-preview').textContent;
    if (text) return text;
    await tick(20);
  }
  return '';
}
const fire = (element, window, type = 'click') => element.dispatchEvent(new window.Event(type));

test('страница запускается, рисует подключения и собирает предпросмотр', async () => {
  const { document, window } = buildPage();
  await tick(100);

  const entries = [...document.getElementById('providers').querySelectorAll('button.entry')];
  assert.equal(entries.length, 2, 'оба подключения в списке');
  assert.match(entries[0].textContent, /tb-demo/);
  assert.match(entries[0].textContent, /можно настроить/);
  assert.match(entries[1].textContent, /только просмотр/);

  // Существующее чужое подключение: правка запрещена, проверка доступна.
  fire(entries[1], window);
  assert.equal(document.getElementById('base-url').disabled, true);
  assert.equal(document.getElementById('draft-check').disabled, true);
  assert.equal(document.getElementById('test').disabled, false);

  // Новое подключение: предпросмотр обновляется по вводу и говорит, что уйдёт в файл.
  fire(document.getElementById('add'), window);
  document.getElementById('provider-id').value = 'tb-new';
  document.getElementById('base-url').value = 'https://api.example/v1';
  document.getElementById('key-env').value = 'NEW_KEY';
  document.getElementById('models').value = 'm1\nm2';
  fire(document.getElementById('models'), window, 'input');
  const preview = document.getElementById('draft-preview').textContent;
  assert.match(preview, /tb-new/);
  assert.match(preview, /переменной NEW_KEY/);
  assert.match(preview, /Моделей: 2/);
  assert.equal(document.getElementById('save').disabled, false, 'черновик пригоден к записи');
});

test('проверка черновика показывает модели и переносит отмеченные в поле ID', async () => {
  const { document, window, calls } = buildPage({
    draft: { ok: true, status: 'AVAILABLE', httpStatus: 200, latencyMs: 12, models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
  });
  await tick(100);
  fire(document.getElementById('add'), window);
  await fillDraft(document, window, { models: 'a' });
  fire(document.getElementById('draft-check'), window);
  // Ждём ответ, а не плейсхолдер «Проверяем…»: он появляется синхронно.
  for (let attempt = 0; attempt < 100 && /Проверяем/.test(document.getElementById('draft-status').textContent); attempt += 1) await tick(20);

  const draftCall = calls.find(call => call.url.endsWith('/draft-check'));
  assert.ok(draftCall, 'маршрут вызван');
  assert.equal(draftCall.method, 'POST');
  assert.deepEqual(draftCall.body, { baseUrl: 'https://api.example/v1', keyEnv: 'NEW_KEY' }, 'секрета в теле нет — только имя переменной');
  assert.match(document.getElementById('draft-status').textContent, /Доступен/);
  assert.match(document.getElementById('discovered-count').textContent, /из 3/, 'каталог показан');

  // Отмечаем вторую модель и переносим: уже введённая «a» не дублируется.
  const boxes = [...document.getElementById('discovered-list').querySelectorAll('input[type=checkbox]')];
  assert.equal(boxes.length, 3);
  boxes[1].checked = true;
  fire(boxes[1], window, 'change');
  fire(document.getElementById('add-selected'), window);
  assert.deepEqual(document.getElementById('models').value.split('\n'), ['a', 'b']);
});
