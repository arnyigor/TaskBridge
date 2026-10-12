// Состояние контекста в веб-панели (§4 плана тестирования, баг 2026-10-12).
//
// Тест выполняет НАСТОЯЩИЕ функции из web/app.js (renderContext, answerReserveTokens,
// providerSendsOutputLimit, contextUsagePercent) на стенде linkedom, как
// tests/web-project-dashboard.test.mjs: иначе он проверял бы сам себя.
//
// Повод — живая сессия 8855fa011534 (openai-codex/gpt-5.5): история 217767 ток. при
// окне 272000 и `maxTokens` 128000 в каталоге. Панель показывала «История + резерв
// ответа (217 767 + 128 000) больше окна (272 000) — провайдер ответит 400» и
// советовала окно 345775, хотя резерва в запросе нет: адаптер Codex лимит вывода не
// отправляет вовсе, и все ходы этой сессии получили ответ (промпт 217571 токен прошёл).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

/**
 * Вырезает исходник функции по имени: от `function name(` до парной `}`.
 * Скобки в подписи учитываются: тело начинается после закрывающей скобки
 * параметров, иначе аннотация вида `call = {}` обрывает функцию на самой себе.
 */
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

/**
 * Стенд: реальные функции панели + минимальные зависимости. Переменная модуля
 * `localStatus` (живое окно движка) объявляется здесь, `withLocal` её выставляет.
 */
function makePanel() {
  const { document } = parseHTML(`<!doctype html><html><body>
    <div id="contextBar" class="hidden"></div>
    <div id="contextBarFill"></div>
    <div id="contextState"></div>
    <div id="usage"></div>
    <button id="autoCompaction"></button>
  </body></html>`);
  const $ = id => document.getElementById(id);
  const lines = [
    'let localStatus = null;',
    extractFunction(appSource, 'fmtMetric'),
    extractFunction(appSource, 'modelContextWindow'),
    extractFunction(appSource, 'liveEnginePrompt'),
    extractFunction(appSource, 'sessionContextUsed'),
    extractFunction(appSource, 'contextUsagePercent'),
    extractFunction(appSource, 'providerSendsOutputLimit'),
    extractFunction(appSource, 'answerReserveTokens'),
    extractFunction(appSource, 'renderContext'),
    'function withLocal(status, t) { localStatus = status; renderContext(t); }',
    'return { renderContext, withLocal, contextUsagePercent, answerReserveTokens, providerSendsOutputLimit };',
  ].join('\n');
  let helpers;
  try {
    helpers = new Function('document', '$', lines)(document, $);
  } catch (error) {
    fs.writeFileSync(path.join(root, '.local', 'web-context-stand.js'), lines);
    throw new Error(`${error.message}\nсобранный стенд: .local/web-context-stand.js`);
  }
  return { document, $, ...helpers };
}

/**
 * `toLocaleString('ru-RU')` разделяет разряды неразрывным пробелом (U+00A0), а в
 * тексте теста стоит обычный: иначе проверка падала бы на самом разделителе, а не
 * на формулировке.
 */
const plain = text => String(text ?? '').replace(/ /g, ' ');

/** Живая сессия 8855fa011534: кодекс, история 217767, окно 272000, каталог 128000. */
const codex = {
  id: '8855fa011534',
  status: 'SUCCEEDED',
  model: { provider: 'openai-codex', id: 'gpt-5.5', contextWindow: 272000, maxTokens: 128000 },
  requestedModel: { provider: 'openai-codex', id: 'gpt-5.5' },
  lastUsage: { input: 2019, output: 196, cacheRead: 215552, totalTokens: 217767 },
  metrics: { pp: 125.1, tg: 108.5 },
  runtime: { state: 'IDLE', activity: null },
  autoCompactionEnabled: true,
};

test('у Codex резерва в запросе нет — панель не обещает 400 и не советует окно 345775', () => {
  const panel = makePanel();
  assert.equal(0, panel.answerReserveTokens(codex), 'лимит вывода Codex не отправляет');
  panel.withLocal(null, codex);
  const state = plain(panel.$('contextState').textContent);
  assert.equal('Заполнен больше половины', state, `история 80% окна — обычное состояние, а не отказ: ${state}`);
  assert.ok(!state.includes('резерв ответа'), 'резерва в запросе нет — и в тексте его быть не должно');
  assert.ok(!state.includes('400'), 'обещание 400 не подтверждается: эта же сессия получала ответы');
  assert.ok(!state.includes('345775'), 'совет поднять окно до 345775 не нужен');
  // За числами панель дописывает скорости хода (PP/TG) — здесь важны сами числа.
  assert.ok(
    plain(panel.$('usage').textContent).startsWith('217 767 / 272 000 (80%)'),
    plain(panel.$('usage').textContent),
  );
});

test('у Codex история больше окна — отказ настоящий, но по другой причине', () => {
  const panel = makePanel();
  const tooLong = { ...codex, lastUsage: { input: 280000, output: 10, totalTokens: 280010 } };
  panel.withLocal(null, tooLong);
  const state = plain(panel.$('contextState').textContent);
  assert.ok(state.includes('История больше окна (280 010 из 272 000)'), state);
  assert.ok(!state.includes('резерв ответа'), `резерва нет, а он снова в тексте: ${state}`);
});

test('у локального движка резерв остаётся: 99.4K + 32.8K при окне 131072 — отказ', () => {
  const panel = makePanel();
  const task = {
    ...codex,
    model: { provider: 'strata-iq3s', id: 'qwen3.8-flash-next-iq3-s', contextWindow: 262144, maxTokens: 32768 },
    requestedModel: { provider: 'strata-iq3s', id: 'qwen3.8-flash-next-iq3-s' },
    lastUsage: { input: 98265, output: 1111, totalTokens: 99376 },
  };
  // Живое окно движка ниже каталожного: 131072, как в реальном случае 2026-09-30.
  panel.withLocal({ models: [{ id: 'qwen3.8-flash-next-iq3-s', provider: 'strata-iq3s', contextWindow: 131072 }] }, task);
  const state = plain(panel.$('contextState').textContent);
  assert.equal(32768, panel.answerReserveTokens(task), 'движок лимит вывода получает полем запроса');
  assert.ok(state.includes('резерв ответа (99 376 + 32 768)'), state);
  assert.ok(state.includes('400'), `движок такой запрос отклоняет: ${state}`);
});

test('кто отправляет лимит вывода, а кто нет', () => {
  const panel = makePanel();
  assert.equal(false, panel.providerSendsOutputLimit('openai-codex'));
  for (const provider of ['openai', 'anthropic', 'google', 'mistral', 'strata-iq3s', 'llamacpp']) {
    assert.equal(true, panel.providerSendsOutputLimit(provider), provider);
  }
});
