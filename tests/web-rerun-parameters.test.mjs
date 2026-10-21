// Разметка повтора с параметрами в веб-панели (MR-07).
//
// Тест выполняет НАСТОЯЩИЕ функции из web/app.js (startRerunTurn, chooseModel,
// rerunTurnWith) на стенде linkedom: серверная часть уже проверена в
// tests/rerun-parameters.test.mjs, здесь важно, что кнопка хода ведёт ИМЕННО на
// /rerun и передаёт выбранную модель (а не молча меняет модель сессии, как обычный
// выбор модели в пикере).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `в app.js нет функции ${name}`);
  if (/async\s+$/.test(source.slice(0, start))) start = source.lastIndexOf('async', start);
  let parens = 0;
  let index = source.indexOf('(', start);
  for (; index < source.length; index++) {
    if (source[index] === '(') parens++;
    else if (source[index] === ')') {
      parens--;
      if (parens === 0) break;
    }
  }
  let depth = 0;
  for (index = source.indexOf('{', index); index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`не найдена закрывающая скобка для ${name}`);
}

function makePanel() {
  const { document } = parseHTML(`<!doctype html><html><body>
    <div id="modelPickerOverlay" class="hidden"></div>
    <h2 id="modelPickerTitle"></h2>
    <p id="modelPickerNote"></p>
    <div id="modelFilters" class="hidden"></div>
    <div id="modelList"></div>
    <button id="modelButton"></button>
    <div id="createError"></div>
  </body></html>`);
  const $ = id => document.getElementById(id);
  const calls = [];
  const lines = [
    // Переменная модуля app.js: без объявления присваивание в стенде создало бы
    // глобальную и утекало бы из стенда в стенд.
    'let rerunTurnId = null;',
    'let selectedTaskId = "T1";',
    'let currentTask = null;',
    'let modelCatalog = { models: [], thinkingLevels: ["off", "low", "high"] };',
    'let pendingModel = null;',
    'let pendingThinking = null;',
    'let localEnabled = false;',
    extractFunction(appSource, 'startRerunTurn'),
    extractFunction(appSource, 'rerunTurnWith'),
    extractFunction(appSource, 'chooseModel'),
    // Настоящий пикер: он и называет режим («Модель Pi» / «Повторить с параметрами»).
    // Тяжёлые части (список моделей и уровней) подменены — они не про MR-07.
    extractFunction(appSource, 'openModelPicker'),
    'function renderThinkingOptions() {}',
    'function renderModelList() {}',
    // Панель фильтров к MR-07 отношения не имеет: openModelPicker её только скрывает.
    'function renderModelFilters() {}',
    'function renderTaskDetails(task) { currentTask = task; }',
    'function updateModelChip() {}',
    'async function refreshTask() { calls.push({ refresh: true }); }',
    'function loadLocalModel() { return Promise.resolve(); }',
    'function savePendingModel() {}',
    'function localProviderId() { return "strata-iq3s"; }',
    'function alert(message) { calls.push({ alert: message }); }',
    'async function api(route, options) {',
    '  calls.push({ route, method: options?.method, body: options?.body ? JSON.parse(options.body) : null });',
    '  return route.startsWith("/api/models")',
    '    ? { models: [], thinkingLevels: ["off", "low", "high"] }',
    '    : { id: "T1", model: { provider: "other", id: "other" } };',
    '}',
    'return { startRerunTurn, rerunTurnWith, chooseModel, openModelPicker, calls, $ };',
  ].join('\n');
  let helpers;
  try {
    helpers = new Function('document', '$', 'calls', lines)(document, $, calls);
  } catch (error) {
    fs.writeFileSync(path.join(root, '.local', 'web-rerun-stand.js'), lines);
    throw new Error(`${error.message}\nсобранный стенд: .local/web-rerun-stand.js`);
  }
  return { document, $, calls, ...helpers };
}

test('кнопка хода открывает пикер в режиме повтора, а не смены модели сессии', () => {
  const panel = makePanel();
  panel.startRerunTurn({ id: 'assistant-7' });
  assert.equal(panel.$('modelPickerOverlay').classList.contains('hidden'), false, 'пикер открыт');
  assert.equal(panel.$('modelPickerTitle').textContent, 'Повторить с параметрами');
  assert.ok(panel.$('modelPickerNote').textContent.includes('запросить этот ответ заново'), panel.$('modelPickerNote').textContent);
  assert.ok(panel.$('modelPickerNote').textContent.includes('применяется к сессии'), 'обещания «только на один запрос» нет');
});

test('обычный выбор модели называет себя иначе', () => {
  const panel = makePanel();
  panel.openModelPicker();
  assert.equal(panel.$('modelPickerTitle').textContent, 'Модель Pi');
});

test('выбор модели в режиме повтора уходит на /rerun с выбранной моделью', async () => {
  const panel = makePanel();
  panel.startRerunTurn({ id: 'assistant-7' });
  await panel.chooseModel({ provider: 'other', id: 'other' });

  // `/api/models` в списке — это сам пикер: он читает каталог, открываясь.
  const taskCalls = () => panel.calls.filter(call => String(call.route).startsWith('/api/tasks'));
  const post = taskCalls()[0];
  assert.equal(post.route, '/api/tasks/T1/rerun', `ожидался повтор, а не смена модели: ${JSON.stringify(panel.calls)}`);
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, { turnId: 'assistant-7', model: { provider: 'other', id: 'other' } });
  assert.equal(panel.$('modelPickerOverlay').classList.contains('hidden'), true, 'пикер закрывается сразу');
  assert.ok(panel.calls.some(call => call.refresh), 'сессия перечитывается: приходит второй вариант ответа');
});

test('режим повтора одноразовый: следующий выбор модели снова меняет модель сессии', async () => {
  const panel = makePanel();
  panel.startRerunTurn({ id: 'assistant-7' });
  await panel.chooseModel({ provider: 'other', id: 'other' });
  panel.calls.length = 0;

  await panel.chooseModel({ provider: 'third', id: 'third' });
  // `/api/models` в списке — это сам пикер: он читает каталог, открываясь.
  const taskCalls = () => panel.calls.filter(call => String(call.route).startsWith('/api/tasks'));
  const post = taskCalls()[0];
  assert.equal(post.route, '/api/tasks/T1/model', `без повтора выбор модели прежний: ${JSON.stringify(panel.calls)}`);
  assert.deepEqual(post.body, { provider: 'third', id: 'third' });
});

test('без выбранной сессии повтор ничего не делает', async () => {
  const panel = makePanel();
  panel.startRerunTurn({ id: 'assistant-7' });
  // Пикер читает каталог асинхронно — даём его вызову осесть, иначе проверка ловила бы его.
  await new Promise(resolve => setTimeout(resolve, 0));
  await panel.rerunTurnWith(null);
  assert.deepEqual(panel.calls.filter(call => String(call.route).startsWith('/api/tasks')), [], 'запрос не уходит');
});
