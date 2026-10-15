import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

// Пункт 2.2 плана: просмотрщик кода должен открываться на нужном месте. Пути с
// диапазоном строк пишут в отчётах («src/app.js#L10-L25»), и оператор не должен
// искать эти строки вручную. Тест выполняет настоящие функции панели.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `в app.js нет функции ${name}`);
  let parens = 0;
  let index = source.indexOf('(', start);
  for (; index < source.length; index++) {
    if (source[index] === '(') parens++;
    else if (source[index] === ')') { parens--; if (parens === 0) break; }
  }
  let depth = 0;
  for (index = source.indexOf('{', index); index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') { depth--; if (depth === 0) return source.slice(start, index + 1); }
  }
  throw new Error(`не найдена закрывающая скобка для ${name}`);
}

test('a path with a line range is parsed, and a bare path stays a path', () => {
  const parse = new Function(`${extractFunction(appSource, 'parsePathWithLines')}; return parsePathWithLines;`)();
  assert.deepEqual(parse('src/app.js#L10-L25'), { path: 'src/app.js', from: 10, to: 25 });
  assert.deepEqual(parse('src/app.js#L10'), { path: 'src/app.js', from: 10, to: 10 });
  assert.deepEqual(parse('src/app.kt:120-124'), { path: 'src/app.kt', from: 120, to: 124 });
  assert.deepEqual(parse('src/app.kt:7'), { path: 'src/app.kt', from: 7, to: 7 });
  assert.deepEqual(parse('docs/api-contract.md'), { path: 'docs/api-contract.md', from: null, to: null });
  // Перевёрнутый диапазон приводится к порядку, а не открывает файл наоборот.
  assert.deepEqual(parse('src/app.js#L25-L10'), { path: 'src/app.js', from: 25, to: 25 });
  // Голый диапазон без пути — не повод гадать, какой это файл.
  assert.equal(parse('L10-L25'), null);
  assert.equal(parse(''), null);
});

test('numbered lines continue from the requested start and mark the range', () => {
  // Ровно четыре строки: фикстура без хвостовых пробелов, иначе «лишняя» строка
  // считалась бы настоящей (это уже ловилось тестом).
  const { document } = parseHTML('<!doctype html><html><body><pre><code>' + ['aaa', 'bbb', 'ccc', 'ddd'].join(String.fromCharCode(10)) + '</code></pre></body></html>');
  const stand = new Function('document', `${extractFunction(appSource, 'numberCodeLines')}; return numberCodeLines;`)(document);
  const block = document.querySelector('code');
  // Сервер отдал строки 120..122: нумерация обязана продолжаться с 120.
  stand(block, 120, 122);
  const spans = [...block.querySelectorAll('span.line')];
  assert.equal(spans.length, 4, `строки разбиты: ${spans.length}`);
  assert.equal(block.style.counterReset, 'viewerLine 119', 'счётчик начинается перед строкой 120');
  assert.deepEqual(
    spans.map(span => span.className),
    ['line rangeHit', 'line rangeHit', 'line rangeHit', 'line'],
    'подсвечены ровно запрошенные строки',
  );
  assert.equal(block.textContent, ['aaa', 'bbb', 'ccc', 'ddd'].join(String.fromCharCode(10)), 'текст кода не потерян');
});

test('without a range the numbering starts at one and nothing is highlighted', () => {
  const { document } = parseHTML('<!doctype html><html><body><pre><code>first\nsecond</code></pre></body></html>');
  const stand = new Function('document', `${extractFunction(appSource, 'numberCodeLines')}; return numberCodeLines;`)(document);
  const block = document.querySelector('code');
  stand(block);
  assert.equal(block.style.counterReset, 'viewerLine 0');
  assert.equal([...block.querySelectorAll('span.line')].filter(span => span.classList.contains('rangeHit')).length, 0);
});
