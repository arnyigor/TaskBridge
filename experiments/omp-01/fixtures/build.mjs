// Синтетические фикстуры OMP-01: маленький JS-проект с посаженной ошибкой и
// каталог курсов для поисковых задач. Всё строится заново перед каждым прогоном,
// поэтому агент не видит следов предыдущего (по ТЗ — каждый тест с чистого листа).
import fs from 'node:fs/promises';
import path from 'node:path';

const FILES = {
  'package.json': JSON.stringify({
    name: 'omp-fixture',
    private: true,
    type: 'module',
    scripts: { test: 'node --test test/calculator.test.mjs test/format.test.mjs' },
  }, null, 2) + '\n',
  // Ошибка специально не в тесте, а в коде: тест описывает ожидаемое поведение.
  'src/calculator.mjs': `export function add(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) {\n  // BUG: сложение вместо умножения\n  return a + b;\n}\n\nexport function divide(a, b) {\n  if (b === 0) throw new Error('division by zero');\n  return a / b;\n}\n`,
  'src/format.mjs': `import { add, multiply } from './calculator.mjs';\n\nexport function summary(a, b) {\n  return \`sum=\${add(a, b)} product=\${multiply(a, b)}\`;\n}\n\nexport function area(width, height) {\n  return multiply(width, height);\n}\n`,
  'src/report.mjs': `import { summary } from './format.mjs';\n\nexport function report(width, height) {\n  const area = summary(width, height);\n  return \`field \${width}x\${height}: \${area}\`;\n}\n`,
  'test/calculator.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, multiply, divide } from '../src/calculator.mjs';\n\ntest('add', () => assert.equal(add(2, 3), 5));\ntest('multiply', () => assert.equal(multiply(3, 4), 12));\ntest('divide', () => assert.equal(divide(12, 4), 3));\n`,
  'test/format.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { summary, area } from '../src/format.mjs';\n\ntest('summary', () => assert.equal(summary(2, 3), 'sum=5 product=6'));\ntest('area', () => assert.equal(area(3, 4), 12));\n`,
  'README.md': '# Внутренний калькулятор\n\n`src/calculator.mjs` — арифметика, `src/format.mjs` — подписи, `src/report.mjs` — отчёт по полю.\nТесты: `npm test` (node:test).\n',
  'Learning/UnrealEngine/Unreal Engine For Filmmakers/00.Intro.mp4': 'video\n',
  'Learning/UnrealEngine/Unreal Engine For Filmmakers/Chapter 01/chapter.md': '# Chapter 01\n',
  'Learning/UnrealEngine/Other Unreal Course/Intro.mp4': 'video\n',
  'Learning/Blender/Blender Guru - Donut/01.Modeling.mp4': 'video\n',
  'Learning/Houdini/Houdini Course 01/01.Interface.mp4': 'video\n',
};

/** Проект с ошибкой (E01 ищет причину, D01/D02 исправляют копию). */
export async function buildProject(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  for (const [relative, body] of Object.entries(FILES)) {
    if (!relative.startsWith('src/') && !relative.startsWith('test/') && !['package.json', 'README.md'].includes(relative)) continue;
    const target = path.join(dir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }
  return dir;
}

/** Каталог курсов для поисковых сценариев. */
export async function buildCatalog(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  for (const [relative, body] of Object.entries(FILES)) {
    if (!relative.startsWith('Learning/')) continue;
    const target = path.join(dir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }
  return dir;
}

/** Снимок файлов проекта: что агент реально изменил. */
export async function snapshot(dir) {
  const files = new Map();
  const walk = async relative => {
    const entries = await fs.readdir(path.join(dir, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) { await walk(next); continue; }
      files.set(next.replaceAll('\\', '/'), await fs.readFile(path.join(dir, next), 'utf8'));
    }
  };
  await walk('');
  return files;
}

export function diffSnapshots(before, after) {
  const changed = [];
  for (const [file, body] of after) {
    if (!before.has(file)) changed.push({ file, change: 'added' });
    else if (before.get(file) !== body) changed.push({ file, change: 'modified' });
  }
  for (const file of before.keys()) if (!after.has(file)) changed.push({ file, change: 'deleted' });
  return changed;
}
