// Дёрганье шапки: renderSysState не должен трогать DOM, если текст не изменился,
// и свёрнутая строка не должна содержать быстро колеблющиеся PP/TG.
//
// Тест выполняет НАСТОЯЩИЙ исходник renderSysState из web/app.js в DOM-стенде
// (linkedom), а не повторяет его логику — иначе тест проверял бы сам себя.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

/** Вырезает исходник функции по имени: от `function name(` до парной `}`. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `в app.js нет функции ${name}`);
  let depth = 0;
  let i = source.indexOf('{', start);
  const open = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`не найдена закрывающая скобка для ${name} (начиная с ${open})`);
}

/** Вырезает `const name = ...` до конца строки (для стрелочных хелперов). */
function extractConst(source, name) {
  const m = new RegExp(`const ${name} = [^\\n]+`, 'u').exec(source);
  assert.ok(m, `в app.js нет const ${name}`);
  return m[0];
}

const HTML = `<!doctype html><html><body>
  <details id="sysState" class="sysState"><summary>—</summary><div id="sysStateBody">Нет данных</div></details>
  <div id="liveMetrics"></div>
</body></html>`;

/** Собирает renderSysState в стенде linkedom из реального исходника. */
function makeRenderer() {
  const { document } = parseHTML(HTML);
  const $ = (id) => document.getElementById(id);
  const factory = new Function(
    'document', '$', 'Number',
    [
      extractConst(appSource, 'mbToGb'),
      extractFunction(appSource, 'fmtMetric'),
      extractFunction(appSource, 'renderSysState'),
      'return renderSysState;',
    ].join('\n'),
  );
  return { document, $, renderSysState: factory(document, $, Number) };
}

const baseInfo = (over = {}) => ({
  system: {
    ram: { used: 20480, total: 106000, ratio: 0.19 },
    cpu: { load: 0.2, cores: 16 },
    gpu: [{ name: 'RTX', memoryUsedMb: 15000, memoryTotalMb: 16384, utilization: 60, powerDrawW: 200, powerLimitW: 350, temperatureC: 65 }],
  },
  engine: {
    configured: true,
    reachable: true,
    model: 'qwen-27b-q3',
    contextWindow: 102400,
    metrics: { available: true, pp: 1137, tg: 35.6, kvRatio: 0.7475, contextWindow: 102400 },
  },
  ...over,
});

test('renderSysState не переписывает summary/body, когда текст не изменился', () => {
  const { document, renderSysState } = makeRenderer();
  const el = document.getElementById('sysState');
  const body = document.getElementById('sysStateBody');

  renderSysState(baseInfo());
  const summaryNode = el.querySelector('summary').firstChild;
  const bodyNode = body.firstChild;
  const summaryText = el.querySelector('summary').textContent;
  const bodyText = body.textContent;
  assert.ok(summaryNode && bodyNode, 'после первого рендера в узлах есть текст');

  // Меняются только скорости — то, что колеблется каждые пару секунд.
  renderSysState(baseInfo({
    engine: { ...baseInfo().engine, metrics: { available: true, pp: 1245, tg: 41.2, kvRatio: 0.7475, contextWindow: 102400 } },
  }));

  assert.equal(el.querySelector('summary').textContent, summaryText, 'текст свёрнутой строки не изменился');
  assert.equal(el.querySelector('summary').firstChild, summaryNode, 'узел summary не пересоздавался (иначе мигание)');
  assert.equal(body.firstChild, bodyNode, 'узел body не пересоздавался');
  assert.equal(body.textContent, bodyText, 'текст body не изменился');
});

test('свёрнутая строка содержит KV, но не PP/TG', () => {
  const { document, renderSysState } = makeRenderer();
  renderSysState(baseInfo());
  const summary = document.getElementById('sysState').querySelector('summary').textContent;
  assert.match(summary, /KV 75%/u, `ожидался KV в строке: ${summary}`);
  assert.doesNotMatch(summary, /PP/u, `PP не должен попадать в свёрнутую строку: ${summary}`);
  assert.doesNotMatch(summary, /TG/u, `TG не должен попадать в свёрнутую строку: ${summary}`);
  // Скорости остаются в отдельной живой строке.
  const live = document.getElementById('liveMetrics').textContent;
  assert.match(live, /PP/u, `PP ожидается в liveMetrics: ${live}`);
  assert.match(live, /TG/u, `TG ожидается в liveMetrics: ${live}`);
});

test('renderSysState всё же обновляет DOM, когда данные действительно изменились', () => {
  const { document, renderSysState } = makeRenderer();
  renderSysState(baseInfo());
  const before = document.getElementById('sysStateBody').textContent;
  renderSysState(baseInfo({ system: { ...baseInfo().system, ram: { used: 40960, total: 106000, ratio: 0.39 } } }));
  const after = document.getElementById('sysStateBody').textContent;
  assert.notEqual(after, before, 'изменение RAM должно обновлять тело панели');
  assert.match(after, /39%/u);
});

test('строка об автодетекте порта появляется только при autoDetected', () => {
  const { document, renderSysState } = makeRenderer();
  renderSysState(baseInfo({ engine: { ...baseInfo().engine, autoDetected: false, baseUrl: 'http://127.0.0.1:8080' } }));
  assert.doesNotMatch(document.getElementById('sysStateBody').textContent, /автоматически/u);
  renderSysState(baseInfo({ engine: { ...baseInfo().engine, autoDetected: true, baseUrl: 'http://127.0.0.1:8090' } }));
  const text = document.getElementById('sysStateBody').textContent;
  assert.match(text, /автоматически/u);
  assert.match(text, /8090/u);
});
