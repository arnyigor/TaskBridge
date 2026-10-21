// Синтетические фикстуры OMP-02b: четыре узких сценария на структурные инструменты.
//
//   node experiments/omp-02b/fixtures/build.mjs <каталог>
//
// Всё строится детерминированно и с известным ответом: ground-truth.json пишется
// рядом, проверка (checks.mjs) не спрашивает модель о правильности.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const write = async (file, body) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
};

// Строка — либо текст, либо [текст, число вызовов в этой строке]. Номера строк
// считаются сами: руками их не ведём, иначе гейм-трут в тесте разъедется с файлом.
function assemble(rows) {
  const lines = [];
  const calls = [];
  for (const row of rows) {
    const [text, count] = Array.isArray(row) ? row : [row, 0];
    lines.push(text);
    for (let index = 0; index < count; index += 1) calls.push({ line: lines.length });
  }
  return { text: `${lines.join('\n')}\n`, calls };
}

// ── AST-01: вызовы функции против строк, комментариев и одноимённого определения
async function buildAst01(root) {
  const dir = path.join(root, 'ast01');
  await write(path.join(dir, 'src/parse.js'), [
    '// Общий разбор значений: единственная настоящая реализация.',
    'export function parseUnits(input) {',
    '  if (input == null) return 0;',
    '  const text = String(input).replace(/,/g, ".");',
    "  const match = /-?\\d+(?:\\.\\d+)?/.exec(text);",
    '  return match ? Number(match[0]) : 0;',
    '}',
    '',
  ].join('\n'));

  const a = assemble([
    "import { parseUnits } from './parse.js';",
    '',
    'export function widthOf(spec) {',
    ['  return parseUnits(spec.width);', 1],
    '}',
    '',
    '// Раньше здесь было parseUnits(spec.width) — это комментарий, не вызов.',
    'export function heightOf(spec) {',
    ['  return parseUnits(spec.height);', 1],
    '}',
    '',
    'export function diagonalOf(spec) {',
    ['  return parseUnits(spec.height) * parseUnits(spec.width);', 2],
    '}',
    '',
    '/* parseUnits(spec.extra) — закомментировано */',
    'export function areaOf(spec) {',
    ['  const width = parseUnits(spec.width);', 1],
    ['  const height = parseUnits(spec.height);', 1],
    '  return width * height;',
    '}',
    '',
  ]);

  const b = assemble([
    "import { parseUnits } from './parse.js';",
    '',
    "export const SAMPLE = 'parseUnits(42)';",
    '',
    'export function totalOf(rows) {',
    '  let total = 0;',
    '  for (const row of rows) {',
    ['    total += parseUnits(row.value);', 1],
    '  }',
    '  return total;',
    '}',
    '',
    ['export const zero = () => parseUnits(0);', 1],
    '',
  ]);

  const c = assemble([
    "import { parseUnits as parseShared } from './parse.js';",
    '',
    'function parseUnits(value) {',
    '  return Number(value) || 0;',
    '}',
    '',
    'export function normalize(value) {',
    ['  return parseShared(value);', 1],
    '}',
    '',
  ]);

  await write(path.join(dir, 'src/a.js'), a.text);
  await write(path.join(dir, 'src/b.js'), b.text);
  await write(path.join(dir, 'src/c.js'), c.text);
  await write(path.join(dir, 'README.md'), '# ast01\n\nНебольшой проект: разбор значений.\n');

  const calls = [
    ...a.calls.map(item => ({ file: 'src/a.js', line: item.line })),
    ...b.calls.map(item => ({ file: 'src/b.js', line: item.line })),
    ...c.calls.map(item => ({ file: 'src/c.js', line: item.line })),
  ];
  return {
    dir: 'ast01',
    question: 'Найди ВСЕ места, где вызывается функция `parseUnits` из `src/parse.js` (включая вызовы через алиас `parseShared`). Определение функции, комментарии и строковые литералы вызовами не считаются. Запиши результат в файл `answer.json` в корне проекта строго в формате {"calls":[{"file":"src/a.js","line":4}]} — по одной записи на каждый вызов; если в строке два вызова, добавь две записи с этой строкой. Ничего больше в проекте не меняй.',
    answer: { calls },
  };
}

// ── AST-02: методы с заданной синтаксической структурой среди похожих
async function buildAst02(root) {
  const dir = path.join(root, 'ast02');
  await write(path.join(dir, 'res.js'), [
    'export const res = {',
    '  json: (value) => value,',
    '  status: (code) => ({ code, json: (value) => ({ code, value }) }),',
    '};',
    '',
  ].join('\n'));

  const rows = ['// HTTP-обработчики. Найди те, что внутри try/catch отвечают res.status(500).', "import { res } from './res.js';", ''];
  const target = new Set();
  for (let index = 1; index <= 40; index += 1) {
    const name = `handle${String(index).padStart(2, '0')}`;
    rows.push(`export async function ${name}(req) {`);
    const withErrorResponse = index % 10 === 3 || index % 10 === 7; // 8 подходящих
    const rethrows = !withErrorResponse && index % 2 === 0;
    if (withErrorResponse) {
      target.add(name);
      rows.push('  try {');
      rows.push('    const value = await load(req);');
      rows.push('    return res.json(value);');
      rows.push('  } catch (error) {');
      rows.push('    return res.status(500).json({ error: error.message });');
      rows.push('  }');
    } else if (rethrows) {
      rows.push('  try {');
      rows.push('    const value = await load(req);');
      rows.push('    return res.json(value);');
      rows.push('  } catch (e) {');
      rows.push('    throw e;');
      rows.push('  }');
    } else {
      rows.push('  const value = await load(req);');
      rows.push('  return res.json(value);');
    }
    rows.push('}');
    rows.push('');
  }
  rows.push('async function load(req) { return req.value; }');
  await write(path.join(dir, 'handlers.js'), `${rows.join('\n')}\n`);
  return {
    dir: 'ast02',
    question: 'Среди функций в `handlers.js` найди те, что в своём блоке `catch` отвечают `res.status(500)`. Запиши в `answer.json` в корне проекта: {"methods":["handle03"]} — только имена функций, без пояснений. Ничего не меняй.',
    answer: { methods: [...target].sort() },
  };
}

// ── EDIT-01: пять строк внутри одной функции в большом файле
async function buildEdit01(root) {
  const dir = path.join(root, 'edit01');
  const rows = ['// Утилиты для окон и страниц. Правь только то, что просят.', ''];
  for (let index = 1; index <= 40; index += 1) {
    rows.push(`export function page${String(index).padStart(2, '0')}(items) {`);
    rows.push(`  return items.slice(${index}, ${index} + 10);`);
    rows.push('}');
    rows.push('');
  }
  const startLine = rows.length + 1;
  rows.push('export function sliceWindow(items, start, end) {');
  rows.push('  if (end > items.length) end = items.length;');
  rows.push('  if (start > end) return [];');
  rows.push('  const result = items.slice(start, end + 1);');
  rows.push('  return result;');
  rows.push('}');
  const endLine = rows.length;
  rows.push('');
  rows.push('export const total = (items) => items.reduce((sum, item) => sum + item, 0);');
  await write(path.join(dir, 'work.js'), `${rows.join('\n')}\n`);
  await write(path.join(dir, 'verify.js'), [
    "import { sliceWindow } from './work.js';",
    'const cases = [',
    '  [[1, 2, 3, 4], 1, 3, [2, 3]],',
    '  [[1, 2, 3, 4], 0, 4, [1, 2, 3, 4]],',
    '  [[1, 2, 3], 2, 2, []],',
    '  [[1, 2, 3], 3, 5, []],',
    '  [[1, 2, 3, 4, 5], 1, 2, [2]],',
    '];',
    'let ok = true;',
    'for (const [items, start, end, expected] of cases) {',
    '  const actual = sliceWindow(items, start, end);',
    '  if (JSON.stringify(actual) !== JSON.stringify(expected)) {',
    '    ok = false;',
    "    console.log('FAIL', JSON.stringify({ items, start, end, expected, actual }));",
    '  }',
    '}',
    "console.log(ok ? 'VERIFY_OK' : 'VERIFY_FAIL');",
    'process.exit(ok ? 0 : 1);',
    '',
  ].join('\n'));
  return {
    dir: 'edit01',
    question: 'В файле `work.js` функция `sliceWindow` должна возвращать элементы с индекса `start` включительно до `end` НЕ включительно (как `Array.prototype.slice`). Сейчас она работает неверно. Исправь ТОЛЬКО тело `sliceWindow`, остальной файл не меняй. Проверка корректности выполняется автоматически.',
    edit: { file: 'work.js', withinLines: [startLine, endLine], maxChangedLines: 12 },
  };
}

// ── EDIT-02: структурная замена в нескольких файлах, не трогая одноимённые
async function buildEdit02(root) {
  const dir = path.join(root, 'edit02');
  await write(path.join(dir, 'api.js'), [
    'export function fetchUser(id) {',
    "  return { id, name: 'legacy', source: 'api' };",
    '}',
    '',
  ].join('\n'));
  await write(path.join(dir, 'api2.js'), [
    'export function fetchUserById(id) {',
    "  return { id, name: 'current', source: 'api2' };",
    '}',
    '',
  ].join('\n'));

  const services = [];
  for (let index = 1; index <= 8; index += 1) {
    const file = `svc${index}.js`;
    services.push(file);
    await write(path.join(dir, file), [
      "import { fetchUser } from './api.js';",
      '',
      `export function label${index}(id) {`,
      '  const user = fetchUser(id);',
      '  return `${user.name}:${user.id}`;',
      '}',
      '',
    ].join('\n'));
  }

  const lookalikes = [];
  for (let index = 1; index <= 3; index += 1) {
    const file = `local${index}.js`;
    lookalikes.push(file);
    await write(path.join(dir, file), [
      'function fetchUser(id) {',
      `  return { id, name: 'local${index}' };`,
      '}',
      '',
      `export function localLabel${index}(id) {`,
      '  const user = fetchUser(id);',
      '  return user.name;',
      '}',
      '',
    ].join('\n'));
  }

  await write(path.join(dir, 'verify.js'), [
    ...services.map((file, index) => `import { label${index + 1} } from './${file}';`),
    ...lookalikes.map((file, index) => `import { localLabel${index + 1} } from './${file}';`),
    "import fs from 'node:fs';",
    'let ok = true;',
    "const check = (name, value) => { if (value !== name) { ok = false; console.log('FAIL', value, '!=', name); } };",
    ...services.map((file, index) => `check('current:${index + 1}', label${index + 1}(${index + 1}));`),
    ...lookalikes.map((file, index) => `check('local${index + 1}', localLabel${index + 1}(${index + 1}));`),
    '// Одноимённые функции в local*.js обязаны остаться нетронутыми.',
    ...lookalikes.map(file => `if (!fs.readFileSync('./${file}', 'utf8').includes('function fetchUser(')) { ok = false; console.log('FAIL lookalike', '${file}'); }`),
    ...services.map(file => `if (fs.readFileSync('./${file}', 'utf8').includes('fetchUser(')) { ok = false; console.log('FAIL old api', '${file}'); }`),
    "console.log(ok ? 'VERIFY_OK' : 'VERIFY_FAIL');",
    'process.exit(ok ? 0 : 1);',
    '',
  ].join('\n'));

  return {
    dir: 'edit02',
    question: 'Восемь сервисов `svc1.js`…`svc8.js` вызывают устаревшую `fetchUser` из `api.js`. Переведи их на `fetchUserById` из `api2.js`, сохранив поведение (метка `name:id`). Функции с тем же именем `fetchUser` в `local1.js`…`local3.js` — другие, их трогать нельзя. Правь только нужное.',
    edit: {
      files: services,
      untouched: lookalikes,
      requires: { absent: 'fetchUser(', present: 'fetchUserById' },
    },
  };
}

export async function buildFixtures(root) {
  await fs.rm(root, { recursive: true, force: true });
  const scenarios = [
    await buildAst01(root),
    await buildAst02(root),
    await buildEdit01(root),
    await buildEdit02(root),
  ];
  const ground = Object.fromEntries(scenarios.map(item => [item.dir, item]));
  await write(path.join(root, 'ground-truth.json'), `${JSON.stringify(ground, null, 2)}\n`);
  return scenarios;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = path.resolve(process.argv[2] || '.local/omp02b/fixtures');
  const built = await buildFixtures(target);
  console.log(`собрано: ${built.map(item => item.dir).join(', ')} → ${target}`);
}
