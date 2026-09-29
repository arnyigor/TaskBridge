// Спойлер для нескольких картинок в одном сообщении: appendUserTurn сворачивает
// N > 1 превью в details.imageSpoiler, а одну картинку и вложения без превью
// рендерит как раньше. Тест выполняет НАСТОЯЩИЙ исходник из web/app.js в
// DOM-стенде (linkedom), а не повторяет его логику — иначе тест проверял бы сам себя.
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

const HTML = `<!doctype html><html><body><div id="msgsInner"></div></body></html>`;

/** Собирает appendUserTurn в стенде linkedom из реального исходника. */
function makeAppendUserTurn() {
  const { document } = parseHTML(HTML);
  const $ = (id) => document.getElementById(id);
  const factory = new Function(
    'document', '$', 'selectedTaskId', 'hideEmptyState', 'scrollBottom',
    [
      extractConst(appSource, 'IMAGE_EXT_RE'),
      extractConst(appSource, 'IMAGE_MIME_RE'),
      extractFunction(appSource, 'isImageFile'),
      extractFunction(appSource, 'fileUrl'),
      extractFunction(appSource, 'imagePreview'),
      extractFunction(appSource, 'fileCard'),
      // Иконки чипов файлов и их обработчики кликов — только разметка/действия,
      // логике спойлера не нужны; важно лишь то, что исполняется при рендере.
      'const messageIcon = () => document.createElement("span");',
      'const isRunnableFile = () => false;',
      'const machineActionAlert = () => {};',
      'const copyButton = (text) => Object.assign(document.createElement("span"), { textContent: "copy" });',
      'const timeEl = () => null;',
      extractFunction(appSource, 'appendUserTurn'),
      'return appendUserTurn;',
    ].join('\n'),
  );
  return { document, appendUserTurn: factory(document, (id) => document.getElementById(id), 'task-1', () => {}, () => {}) };
}

// timeEl/copyButton подменены выше; selectedTaskId и hideEmptyState приходят
// параметрами фабрики.

const image = (id, name) => ({ id, name, mimeType: 'image/png' });
const plain = (id, name) => ({ id, name });

test('одна картинка и вложения без превью рендерятся без спойлера', () => {
  const { document, appendUserTurn } = makeAppendUserTurn();
  const turn = appendUserTurn('скрин', [image('f1', 'a.png')]);
  assert.equal(turn.querySelectorAll('details.imageSpoiler').length, 0);
  // Единственное превью — прямо в body, как раньше.
  assert.equal(turn.querySelectorAll('.chatImage').length, 1);
  assert.equal(turn.querySelectorAll('.fileChip').length, 1);
});

test('более одной картинки уходят под свёрнутый спойлер', () => {
  const { document, appendUserTurn } = makeAppendUserTurn();
  const turn = appendUserTurn('скрины', [image('f1', 'a.png'), image('f2', 'b.png'), image('f3', 'c.png')]);
  const spoilers = turn.querySelectorAll('details.imageSpoiler');
  assert.equal(spoilers.length, 1);
  const spoiler = spoilers[0];
  // Свёрнут по умолчанию: раскрытие — только тапом по summary.
  assert.equal(spoiler.hasAttribute('open'), false);
  assert.match(spoiler.querySelector('summary').textContent, /3 изображений/);
  // Все превью внутри спойлера, чипы файлов — рядом, вне спойлера.
  assert.equal(spoiler.querySelectorAll('.chatImage').length, 3);
  assert.equal(spoiler.querySelectorAll('.chatImage')[0].querySelector('summary'), null);
  assert.equal(turn.querySelectorAll('.attachedFiles .fileChip').length, 3);
});

test('две картинки и файл без превью — спойлер только на превью', () => {
  const { document, appendUserTurn } = makeAppendUserTurn();
  const turn = appendUserTurn('скрин и лог', [image('f1', 'a.png'), image('f2', 'b.png'), plain('f3', 'build.log')]);
  assert.equal(turn.querySelectorAll('details.imageSpoiler').length, 1);
  assert.equal(turn.querySelectorAll('details.imageSpoiler .chatImage').length, 2);
  // Вложение без превью не считается картинкой и не уходит под спойлер.
  assert.equal(turn.querySelectorAll('.attachedFiles .fileChip').length, 3);
});
