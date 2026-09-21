// Дёрганье шапки: renderMachineLoad не должен трогать DOM, если текст не изменился,
// и в панель статуса не должны попадать быстро колеблющиеся PP/TG (они живут
// отдельной живой строкой над полем ввода).
//
// Тест выполняет НАСТОЯЩИЙ исходник renderMachineLoad из web/app.js в DOM-стенде
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
  <details id="pcState" class="pcState"><summary class="statusDot"></summary>
    <div class="pcStateBody"><div id="pcStateStatus"></div><div id="pcStateSystem"></div></div>
  </details>
  <div id="liveMetrics"></div>
</body></html>`;

/** Собирает renderMachineLoad в стенде linkedom из реального исходника. */
function makeRenderer() {
  const { document } = parseHTML(HTML);
  const $ = (id) => document.getElementById(id);
  const factory = new Function(
    'document', '$', 'Number',
    [
      extractConst(appSource, 'mbToGb'),
      extractFunction(appSource, 'fmtMetric'),
      extractFunction(appSource, 'renderMachineLoad'),
      'return renderMachineLoad;',
    ].join('\n'),
  );
  return { document, $, renderMachineLoad: factory(document, $, Number) };
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

test('renderMachineLoad не переписывает панель и живую строку, когда текст не изменился', () => {
  const { document, renderMachineLoad } = makeRenderer();
  const panel = document.getElementById('pcStateSystem');
  const live = document.getElementById('liveMetrics');

  renderMachineLoad(baseInfo());
  const panelNode = panel.firstChild;
  const liveBefore = live.textContent;
  const panelText = panel.textContent;
  assert.ok(panelNode, 'после первого рендера в узлах есть текст');

  // Меняются только скорости — то, что колеблется каждые пару секунд.
  renderMachineLoad(baseInfo({
    engine: { ...baseInfo().engine, metrics: { available: true, pp: 1245, tg: 41.2, kvRatio: 0.7475, contextWindow: 102400 } },
  }));

  assert.equal(panel.textContent, panelText, 'текст панели не изменился');
  // Identity, not `assert.equal(nodeA, nodeB)`: a failing comparison would be
  // formatted with util.inspect on a linkedom node, and following its parent
  // links never ends — the test file hung for a minute instead of failing.
  assert.ok(panel.firstChild === panelNode, 'узел панели не пересоздавался (иначе мигание)');
  // Сами скорости — то, что колеблется: они обязаны дойти до живой строки.
  assert.notEqual(live.textContent, liveBefore, 'живая строка обновляется');
  // «1 245» из toLocaleString — с неразрывным пробелом, поэтому проверяем цифры.
  assert.match(live.textContent, /PP 1\u00a0245/u, `новая скорость должна попасть в живую строку: ${live.textContent}`);
});

test('в панели статуса есть KV, но нет PP/TG', () => {
  const { document, renderMachineLoad } = makeRenderer();
  renderMachineLoad(baseInfo());
  const panel = document.getElementById('pcStateSystem').textContent;
  assert.match(panel, /Контекст \(KV\): 75%/u, `ожидался KV в панели: ${panel}`);
  assert.doesNotMatch(panel, /PP/u, `PP не должен попадать в панель: ${panel}`);
  assert.doesNotMatch(panel, /TG/u, `TG не должен попадать в панель: ${panel}`);
  // Скорости остаются в отдельной живой строке над полем ввода.
  const live = document.getElementById('liveMetrics').textContent;
  assert.match(live, /PP/u, `PP ожидается в liveMetrics: ${live}`);
  assert.match(live, /TG/u, `TG ожидается в liveMetrics: ${live}`);
});

test('renderMachineLoad всё же обновляет панель, когда данные действительно изменились', () => {
  const { document, renderMachineLoad } = makeRenderer();
  renderMachineLoad(baseInfo());
  const before = document.getElementById('pcStateSystem').textContent;
  renderMachineLoad(baseInfo({ system: { ...baseInfo().system, ram: { used: 40960, total: 106000, ratio: 0.39 } } }));
  const after = document.getElementById('pcStateSystem').textContent;
  assert.notEqual(after, before, 'изменение RAM должно обновлять панель');
  assert.match(after, /39%/u);
});

test('строка об автодетекте порта появляется только при autoDetected', () => {
  const { document, renderMachineLoad } = makeRenderer();
  renderMachineLoad(baseInfo({ engine: { ...baseInfo().engine, autoDetected: false, baseUrl: 'http://127.0.0.1:8080' } }));
  assert.doesNotMatch(document.getElementById('pcStateSystem').textContent, /автоматически/u);
  renderMachineLoad(baseInfo({ engine: { ...baseInfo().engine, autoDetected: true, baseUrl: 'http://127.0.0.1:8090' } }));
  const text = document.getElementById('pcStateSystem').textContent;
  assert.match(text, /автоматически/u);
  assert.match(text, /8090/u);
});
