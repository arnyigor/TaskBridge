// Фикстуры OMP-02 и CODE-01..CODE-04.
//
// Каждый прогон строится с нуля, поэтому агент не видит следов предыдущего.
// Две фикстуры — на Node.js с настоящими тестами, одна — Java с настоящей
// компиляцией (kotlinc на стенде нет, см. docs/omp-02-comparison.md), одна —
// большой сгенерированный файл, где нужна точечная якорная правка.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** CODE-01: пять небольших классов + Main; цены лежат в double (рубли). */
async function buildJava(dir) {
  const sources = await fs.readdir(path.join(here, 'code-01-java'));
  const target = path.join(dir, 'src', 'shop');
  await fs.mkdir(target, { recursive: true });
  for (const file of sources.filter(name => name.endsWith('.java'))) {
    await fs.copyFile(path.join(here, 'code-01-java', file), path.join(target, file));
  }
}

/** CODE-02 и CODE-04: статический Node.js-проект. */
async function copyTree(from, to) {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, target);
    } else {
      await fs.copyFile(source, target);
    }
  }
}

/** CODE-03: файл на несколько тысяч строк, генерируется детерминированно. */
function buildLargeSource() {
  const lines = [
    '// Сгенерированный модуль: 200 однотипных функций и общая обрезка окна.',
    '// Правки должны быть точечными: любое случайное изменение здесь — collateral damage.',
    '',
  ];
  for (let i = 0; i < 200; i += 1) {
    const index = String(i).padStart(3, '0');
    lines.push(`/** Партия ${index}: коэффициент ${i + 1} и проверка типа.`);
    for (let j = 0; j < 12; j += 1) {
      lines.push(` * Пояснение ${j + 1} к партии ${index}: правила нумерации и округления не менялись.`);
    }
    lines.push(' */');
    lines.push(`export function scale${index}(value) {`);
    lines.push(`  const coefficient = ${i + 1};`);
    lines.push('  if (typeof value !== \"number\" || Number.isNaN(value)) {');
    lines.push(`    throw new TypeError('scale${index}: ожидалось число');`);
    lines.push('  }');
    lines.push('  return value * coefficient;');
    lines.push('}');
    lines.push('');
  }
  lines.push('/** Окно значений: ровно length элементов, начиная с индекса start. */');
  lines.push('export function sliceWindow(values, start, length) {');
  lines.push('  if (!Array.isArray(values)) {');
  lines.push("    throw new TypeError('sliceWindow: ожидался массив');");
  lines.push('  }');
  lines.push('  if (length <= 0) {');
  lines.push('    return [];');
  lines.push('  }');
  lines.push('  return values.slice(start, start + length + 1);');
  lines.push('}');
  lines.push('');
  lines.push('/** Среднее по окну; пустое окно даёт 0. */');
  lines.push('export function windowAverage(values, start, length) {');
  lines.push('  const window = sliceWindow(values, start, length);');
  lines.push('  if (window.length === 0) {');
  lines.push('    return 0;');
  lines.push('  }');
  lines.push('  return window.reduce((sum, value) => sum + value, 0) / window.length;');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function buildLargeTests() {
  return [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { sliceWindow, windowAverage, scale000, scale100, scale199 } from '../src/big.mjs';",
    '',
    'const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];',
    '',
    "test('окно берёт ровно length элементов', () => {",
    '  assert.deepEqual(sliceWindow(values, 2, 3), [3, 4, 5]);',
    '});',
    '',
    "test('окно с нуля', () => {",
    '  assert.deepEqual(sliceWindow(values, 0, 3), [1, 2, 3]);',
    '});',
    '',
    "test('окно обрезается по концу массива', () => {",
    '  assert.deepEqual(sliceWindow([1, 2, 3], 1, 5), [2, 3]);',
    '});',
    '',
    "test('пустая длина даёт пустое окно', () => {",
    '  assert.deepEqual(sliceWindow(values, 2, 0), []);',
    '});',
    '',
    "test('среднее считается по тем же элементам', () => {",
    '  assert.equal(windowAverage(values, 2, 3), 4);',
    '});',
    '',
    "test('однотипные функции не тронуты', () => {",
    '  assert.equal(scale000(2), 2);',
    '  assert.equal(scale100(1), 101);',
    '  assert.equal(scale199(2), 400);',
    '});',
    '',
  ].join('\n');
}

/** Собирает рабочую копию сценария. Вызов детерминирован: годится и для pristine-копии. */
export async function prepareWorkspace(id, dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  if (id === 'CODE-01') {
    await buildJava(dir);
    return dir;
  }
  if (id === 'CODE-02') {
    await copyTree(path.join(here, 'code-02-node'), dir);
    return dir;
  }
  if (id === 'CODE-04') {
    await copyTree(path.join(here, 'code-04-node'), dir);
    return dir;
  }
  if (id === 'CODE-03') {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.mkdir(path.join(dir, 'test'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'big.mjs'), buildLargeSource());
    await fs.writeFile(path.join(dir, 'test', 'big.test.mjs'), buildLargeTests());
    await fs.writeFile(path.join(dir, 'package.json'), `${JSON.stringify({
      name: 'large-file-fixture',
      private: true,
      type: 'module',
      scripts: { test: 'node --test' },
    }, null, 2)}\n`);
    return dir;
  }
  throw new Error(`неизвестный сценарий: ${id}`);
}

/** Снимок файлов проекта: что агент реально изменил. */
export async function snapshot(dir) {
  const files = new Map();
  const walk = async relative => {
    const entries = await fs.readdir(path.join(dir, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'out' || entry.name === 'node_modules') continue;
        await walk(next);
        continue;
      }
      files.set(next.replaceAll('\\', '/'), await fs.readFile(path.join(dir, next), 'utf8'));
    }
  };
  await walk('');
  return files;
}

/**
 * Приблизительный размер правки: обрезаем общий префикс и суффикс, остальное
 * считаем добавленным/удалённым. Для точечных правок совпадает с diff точно,
 * для массовых переписываний даёт верхнюю оценку — этого достаточно, чтобы
 * отличить «одна строка» от «переписал файл».
 */
export function approxDiff(before, after) {
  const left = before.split('\n');
  const right = after.split('\n');
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endLeft = left.length - 1;
  let endRight = right.length - 1;
  while (endLeft >= start && endRight >= start && left[endLeft] === right[endRight]) {
    endLeft -= 1;
    endRight -= 1;
  }
  return { removed: endLeft - start + 1, added: endRight - start + 1 };
}

export function diffSnapshots(before, after) {
  const changed = [];
  for (const [file, body] of after) {
    if (!before.has(file)) changed.push({ file, change: 'added' });
    else if (before.get(file) !== body) changed.push({ file, change: 'modified' });
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.push({ file, change: 'deleted' });
  }
  return changed;
}
