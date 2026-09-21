/**
 * Выполнение физической части сгенерированного HTML в песочнице Node.
 *
 * Зачем: многие модели считают Δv во время исполнения и не пишут его в ответ. Проверять
 * отчёт модели нельзя, а «прогнать в браузере» в пакетном режиме нечем — поэтому запускаем
 * скрипт сами, с заглушками DOM/Canvas, и перехватываем всё, что он пишет в элементы и в
 * консоль. Так мы получаем фактические числа, а не обещания.
 *
 *   node bench/run-moon-html.mjs <путь.html> [секунд]
 *
 * Ограничение: если числа появляются только по кадрам анимации (requestAnimationFrame),
 * перехватить их не удастся — тогда инструмент честно скажет, что числа не извлекаются.
 */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const file = process.argv[2];
const seconds = Number(process.argv[3] ?? 20);
if (!file) { console.log('укажи путь к html'); process.exit(2); }

const html = fs.readFileSync(file, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
if (!scripts.length) { console.log('в файле нет встроенного скрипта'); process.exit(0); }

const writes = [];
const logs = [];
const numbers = new Set();

const record = (where, value) => {
  const text = String(value ?? '');
  if (!text.trim()) return;
  writes.push(`${where} = ${text.slice(0, 200)}`);
  for (const m of text.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*(?:km\/s|км\/с|m\/s|м\/с)/gi)) numbers.add(`${m[1]} (${where})`);
  for (const m of text.matchAll(/(?:delta|Δ|dv|tli)[^0-9]{0,12}([0-9]+(?:[.,][0-9]+)?)/gi)) numbers.add(`${m[1]} (${where})`);
};

function fakeElement(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {}, dataset: {},
    children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, setAttribute() {}, getAttribute: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    focus() {}, blur() {}, click() {},
    getBoundingClientRect: () => ({ width: 1200, height: 800, top: 0, left: 0 }),
    // getContext нужен любому элементу: модели берут canvas и через getElementById,
    // и через createElement — без этого скрипт падает на первой же строке рисования.
    getContext: () => ctx2d,
  };
  let _text = '';
  Object.defineProperty(el, 'textContent', { get: () => _text, set: v => { _text = String(v); record(`${el.id || el.tagName}.textContent`, v); } });
  Object.defineProperty(el, 'innerText', { get: () => _text, set: v => { _text = String(v); record(`${el.id || el.tagName}.innerText`, v); } });
  Object.defineProperty(el, 'innerHTML', { get: () => _text, set: v => { _text = String(v); record(`${el.id || el.tagName}.innerHTML`, v); } });
  Object.defineProperty(el, 'value', { get: () => _text, set: v => { _text = String(v); } });
  Object.defineProperty(el, 'width', { get: () => 1200, set: () => {} });
  Object.defineProperty(el, 'height', { get: () => 800, set: () => {} });
  return el;
}

const ctx2d = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'canvas') return fakeElement('canvas');
    if (prop === 'measureText') return () => ({ width: 10 });
    return () => {};
  },
});

const elements = new Map();
const document = {
  getElementById: id => { if (!elements.has(id)) { const el = fakeElement(); el.id = id; elements.set(id, el); } return elements.get(id); },
  querySelector: sel => document.getElementById(sel),
  querySelectorAll: () => [],
  createElement: tag => { const el = fakeElement(tag); if (tag === 'canvas') el.getContext = () => ctx2d; return el; },  addEventListener() {}, removeEventListener() {},
  body: fakeElement('body'), documentElement: fakeElement('html'),
  hidden: false, visibilityState: 'visible',
};
document.body.appendChild = () => {};

// Искусственный планировщик: модели разбивают поиск на порции через setTimeout/
// requestAnimationFrame, чтобы не морозить UI. Без прогонки этой очереди вызов поиска
// возвращает пустоту — что и случилось на первом запуске (вернулся {} за 0 с).
let seq = 0;
let virtualNow = 0;
const queue = [];
const schedule = (fn, ms) => { queue.push({ fn, t: virtualNow + (ms || 0), seq: seq++ }); return seq; };
const drain = (maxSteps = 200000, maxWallMs = 30000) => {
  const started = Date.now();
  let steps = 0;
  while (queue.length && steps < maxSteps && Date.now() - started < maxWallMs) {
    queue.sort((a, b) => (a.t - b.t) || (a.seq - b.seq));
    const job = queue.shift();
    virtualNow = job.t;
    steps += 1;
    try { job.fn(); } catch (e) { logs.push('таймер упал: ' + String(e.message ?? e).slice(0, 120)); }
  }
  return { steps, left: queue.length };
};

const sandbox = {
  document,
  window: null,
  console: { log: (...a) => { const s = a.map(String).join(' '); logs.push(s.slice(0, 200)); for (const m of s.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*(?:km\/s|км\/с|m\/s|м\/с)/gi)) numbers.add(`${m[1]} (console)`); }, warn() {}, error() {}, info() {} },
  Math, Date, JSON, Number, String, Array, Object, Boolean, isNaN, isFinite, parseFloat, parseInt, Set, Map, Infinity, NaN,
  performance: { now: () => Date.now() },
  requestAnimationFrame: fn => schedule(fn, 16),
  cancelAnimationFrame: () => {},
  setTimeout: schedule, clearTimeout: id => { const j = queue.find(x => x.seq === id); if (j) j.fn = () => {}; }, setInterval: schedule, clearInterval: () => {},
  alert() {}, prompt: () => null,
  devicePixelRatio: 1, innerWidth: 1200, innerHeight: 800,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  // window.* — модели навешивают обработчики и слушают resize; без этих методов скрипт
  // падает на верхнем уровне, и дальше не инициализируется ничего, включая функции поиска.
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  navigator: { userAgent: 'node-sandbox', language: 'en' },
  location: { href: 'file:///moon_mission.html', search: '' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  focus() {}, scrollTo() {}, open() {}, close() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);
const started = Date.now();
let error = null;
for (const [i, code] of scripts.entries()) {
  try {
    vm.runInContext(code, context, { timeout: Math.max(1000, seconds * 1000), filename: `${path.basename(file)}#script${i + 1}` });
  } catch (e) {
    error = String(e.message ?? e).slice(0, 200);
  }
}
const elapsed = Math.round((Date.now() - started) / 1000);
// Прогоняем отложенные задачи: именно там живёт асинхронный поиск (см. комментарий выше).
const drained = drain();

// Ищем глобальные функции поиска, если скрипт их выставил.
const exposed = Object.keys(context).filter(k => typeof context[k] === 'function' && /search|optim|solve|find|burn|tli|simulate|compute/i.test(k));

// Если скрипт выставил функцию поиска наружу — вызываем её сами и забираем результат:
// это фактическое число из кода модели, а не её пересказ.
const searchFn = ['runSearch', 'searchTLI', 'search', 'solve', 'optimize', 'findBurn', 'runOptimization', 'computeTrajectory'].find(n => typeof context[n] === 'function');
let invoked = null;
if (searchFn) {
  const t0 = Date.now();
  try {
    const value = context[searchFn]();
    const afterDrain = drain();
    invoked = { name: searchFn, seconds: Math.round((Date.now() - t0) / 1000), drainSteps: afterDrain.steps, value: JSON.stringify(value ?? null).slice(0, 800) };
  } catch (e) {
    invoked = { name: searchFn, error: String(e.message ?? e).slice(0, 200) };
  }
}

console.log(`Файл: ${path.basename(file)}`);
console.log(`Скриптов: ${scripts.length}, выполнение: ${elapsed} с${error ? `, ошибка: ${error}` : ', без ошибок'}`);
console.log(`Отложенных задач выполнено: ${drained.steps}${drained.left ? ` (осталось ${drained.left} — упёрлись в предел)` : ''}`);
console.log(`Скриптов: ${scripts.length}, выполнение: ${elapsed} с${error ? `, ошибка: ${error}` : ', без ошибок'}`);
console.log(`Записей в элементы UI: ${writes.length}, строк в console: ${logs.length}`);
if (exposed.length) console.log(`Глобальные функции поиска: ${exposed.join(', ')}`);
if (invoked) {
  console.log(`\nВызвана функция «${invoked.name}»${invoked.seconds !== undefined ? ` (${invoked.seconds} с)` : ''}:`);
  console.log('  ' + (invoked.error ? 'ошибка: ' + invoked.error : invoked.value));
  if (!invoked.error) {
    for (const m of String(invoked.value).matchAll(/"?([a-zA-Z_]*(?:dv|delta|dist|min|tli|km)[a-zA-Z_]*)"?\s*:\s*(-?[0-9.]+)/gi)) numbers.add(`${m[1]} = ${m[2]} (возврат ${invoked.name})`);
  }
}

if (numbers.size) {
  console.log('\nЧисла, похожие на метрики:');
  [...numbers].slice(0, 20).forEach(n => console.log('  ' + n));
} else {
  console.log('\nЧисла не извлекаются: поиск, судя по всему, идёт внутри кадра анимации (requestAnimationFrame), которую мы не запускаем.');
}
if (logs.length) {
  console.log('\nПоследние строки console:');
  logs.slice(-8).forEach(l => console.log('  ' + l));
}

fs.mkdirSync('G:/Android/AndroidStudioProjects/Taskbridge/data/runtime/batch', { recursive: true });
fs.writeFileSync('G:/Android/AndroidStudioProjects/Taskbridge/data/runtime/batch/sandbox-' + path.basename(file) + '.json',
  JSON.stringify({ file: path.basename(file), scripts: scripts.length, error, numbers: [...numbers], exposed, invoked, writes: writes.slice(-40), logs: logs.slice(-40) }, null, 2) + '\n');
