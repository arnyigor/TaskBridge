// Блок «Результаты инструментов» на упавшем ходе (§7 плана 1.3, MR-04 Web).
//
// Проверяются НАСТОЯЩИЕ функции из web/app.js (toolEvidenceBlock,
// syncToolEvidence) на стенде linkedom — как tests/web-context-state.test.mjs,
// иначе тест проверял бы сам себя. Привязка блока к ходу проверяется отдельно,
// на реальном reducer (tests/chat.test.mjs).
//
// Главное, что здесь закрепляется: вывод инструмента — это произвольное
// содержимое файла, поэтому он попадает на экран только через textContent, а
// список ограничен и свёрнут, чтобы не ломать прокрутку.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

/** Исходник функции по имени: от `function name(` до парной `}`. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `в app.js нет функции ${name}`);
  let index = source.indexOf('{', start);
  let depth = 0;
  for (; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`не найдена закрывающая скобка для ${name}`);
}

function makeStand() {
  const { document } = parseHTML('<!doctype html><html><body><div id="msgsInner"></div></body></html>');
  const source = [
    extractFunction(appSource, 'toolEvidenceBlock'),
    extractFunction(appSource, 'syncToolEvidence'),
    'return { toolEvidenceBlock, syncToolEvidence };',
  ].join('\n');
  return { document, ...new Function('document', source)(document) };
}

const entry = (toolName, target, excerpt) => ({ toolName, target, excerpt });

test('блок показывает инструмент, цель и выжимку, и по умолчанию свёрнут', () => {
  const { document, toolEvidenceBlock } = makeStand();
  const block = toolEvidenceBlock([
    entry('bash', 'ls "F:/Install/Learning"', 'Android Blender Davinchi'),
    entry('read', 'example.txt', 'hello from example.txt'),
  ]);
  document.getElementById('msgsInner').append(block);

  assert.equal(block.tagName.toLowerCase(), 'details');
  assert.equal(Boolean(block.open), false, 'свёрнут: список не должен двигать чат');
  assert.equal(block.querySelector('summary').textContent, 'Результаты инструментов · 2');
  assert.match(block.textContent, /bash: ls "F:\/Install\/Learning"/);
  assert.match(block.textContent, /hello from example\.txt/);
});

test('вывод инструмента с HTML попадает на экран только текстом', () => {
  const { document, toolEvidenceBlock } = makeStand();
  const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const block = toolEvidenceBlock([entry('bash', '<b>cat</b>', payload)]);
  document.getElementById('msgsInner').append(block);

  assert.equal(block.querySelectorAll('script').length, 0, 'script не должен появиться в DOM');
  assert.equal(block.querySelectorAll('img').length, 0, 'img из вывода не должен появиться в DOM');
  assert.equal(block.querySelector('.evidenceText').textContent, payload, 'текст сохранён дословно');
  assert.match(block.querySelector('.evidenceHead').textContent, /<b>cat<\/b>/, 'заголовок тоже текст');
});

test('токеноподобный текст показывается как есть и никуда не копируется', () => {
  const { document, toolEvidenceBlock, syncToolEvidence } = makeStand();
  const secret = 'DEEPSEEK_API_KEY=sk-abcdef0123456789abcdef';
  const md = document.createElement('div');
  const node = { md, copyBtn: { _text: 'ответ модели' } };
  syncToolEvidence(node, [entry('bash', 'env', secret)]);

  assert.match(md.textContent, /sk-abcdef0123456789abcdef/, 'выжимка видна оператору');
  assert.equal(node.copyBtn._text, 'ответ модели', 'кнопка «Скопировать ответ» не берёт доказательства');
});

test('пустой список не создаёт пустой блок', () => {
  const { document, syncToolEvidence } = makeStand();
  const md = document.createElement('div');
  syncToolEvidence({ md }, []);
  syncToolEvidence({ md }, null);
  syncToolEvidence({ md }, undefined);
  assert.equal(md.querySelectorAll('.toolEvidence').length, 0);
});

test('повторная синхронизация не плодит копии, а смена списка заменяет блок', () => {
  const { document, syncToolEvidence } = makeStand();
  const md = document.createElement('div');
  const node = { md };
  const first = [entry('bash', 'ls', 'one')];

  syncToolEvidence(node, first);
  syncToolEvidence(node, first);
  syncToolEvidence(node, first);
  assert.equal(md.querySelectorAll('.toolEvidence').length, 1, 'три вызова — один блок');

  syncToolEvidence(node, [entry('bash', 'ls', 'one'), entry('read', 'a.txt', 'two')]);
  assert.equal(md.querySelectorAll('.toolEvidence').length, 1);
  assert.equal(md.querySelector('.toolEvidence summary').textContent, 'Результаты инструментов · 2');

  // updateText() пересобирает .md целиком: блок обязан вернуться.
  md.innerHTML = '<p>ответ</p>';
  syncToolEvidence(node, first);
  assert.equal(md.querySelectorAll('.toolEvidence').length, 1, 'блок восстановлен после перерисовки ответа');

  syncToolEvidence(node, []);
  assert.equal(md.querySelectorAll('.toolEvidence').length, 0, 'доказательства сняты — блок убран');
});

test('длинный список помещается в свёрнутый details и не растягивает ленту', () => {
  const { document, toolEvidenceBlock } = makeStand();
  const many = Array.from({ length: 10 }, (_, i) => entry('bash', `cmd-${i}`, 'x'.repeat(240)));
  const block = toolEvidenceBlock(many);
  document.getElementById('msgsInner').append(block);

  assert.equal(Boolean(block.open), false);
  assert.equal(block.querySelectorAll('.evidenceRow').length, 10);
  const text = block.textContent;
  assert.ok(text.length < 4000, `текст блока: ${text.length} символов`);
  assert.ok([...block.querySelectorAll('.evidenceText')].every(el => el.textContent.length <= 240));
});
