// Выбор нескольких сообщений в веб-панели (как «Select messages» в ChatGPT).
//
// Тест выполняет НАСТОЯЩИЕ функции из web/app.js (selectedMessagesText, copyButton,
// messageCopyButton, startSelectingMessages, toggleTurnSelection, copySelectedMessages)
// на стенде linkedom — как tests/web-project-dashboard.test.mjs. Главное, что здесь
// проверяется: в буфер уходит текст САМОГО сообщения, а не блока рассуждения внутри
// ответа (у него своя кнопка копирования, и в DOM она идёт первой).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

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
 * Стенд: лента, собранная как в app.js (turn .body > .msgActions > .copyBtn), и
 * настоящие функции режима выбора. Иконки подменены: копированию важен не значок, а
 * `title` и `_text`, которые ставит настоящий copyButton.
 */
function makeChat() {
  const { document } = parseHTML(`<!doctype html><html><body>
    <div id="msgsInner">
      <div class="turn me"><div class="body"><div class="msg s-me">Первый вопрос</div><div class="msgActions"></div></div></div>
      <div class="turn pi"><div class="body">
        <details class="reasoning"><summary></summary></details>
        <div class="msg">Ответ агента</div>
        <div class="msgActions"></div>
      </div></div>
      <div class="systemNote">Контекст сжат</div>
      <div class="turn pi"><div class="body"><div class="msg">Без текста, только инструменты</div><div class="msgActions"></div></div></div>
    </div>
    <div id="selectBar" class="hidden"><span id="selectCount"></span><button id="selectCopy" disabled></button><button id="selectCancel"></button></div>
  </body></html>`);
  const $ = id => document.getElementById(id);
  const copied = [];
  const notices = [];
  const lines = [
    'let selectingMessages = false;',
    `const MESSAGE_COPY_TITLES = ${JSON.stringify(['Скопировать сообщение', 'Скопировать ответ'])};`,
    extractFunction(appSource, 'selectedMessages'),
    extractFunction(appSource, 'selectedMessagesText'),
    extractFunction(appSource, 'messageCopyButton'),
    extractFunction(appSource, 'selectableTurns'),
    extractFunction(appSource, 'selectedTurns'),
    extractFunction(appSource, 'selectedTurnTexts'),
    extractFunction(appSource, 'toggleTurnSelection'),
    extractFunction(appSource, 'updateSelectBar'),
    extractFunction(appSource, 'startSelectingMessages'),
    extractFunction(appSource, 'stopSelectingMessages'),
    extractFunction(appSource, 'copyButton'),
    'async function copySelectedMessages() {',
    '  const texts = selectedMessages(selectedTurnTexts());',
    '  if (!texts.length) return;',
    '  const ok = await copyText(texts.join("\\n\\n"));',
    '  stopSelectingMessages();',
    '  showNotice(ok ? (texts.length === 1 ? "Сообщение скопировано" : `Скопировано сообщений: ${texts.length}`) : "Не удалось скопировать");',
    '}',
    'return { selectedMessages, selectedMessagesText, messageCopyButton, selectableTurns, selectedTurns, selectedTurnTexts, toggleTurnSelection, startSelectingMessages, stopSelectingMessages, copySelectedMessages, copyButton, $ };',
  ].join('\n');
  let helpers;
  try {
    helpers = new Function(
      'document', '$', 'copied', 'notices', 'copyText', 'showNotice', 'messageIcon', lines,
    )(
      document, $, copied, notices,
      async text => { copied.push(text); return true; },
      text => notices.push(text),
      () => document.createElement('span'),
    );
  } catch (error) {
    fs.writeFileSync(path.join(root, '.local', 'web-select-stand.js'), lines);
    throw new Error(`${error.message}\nсобранный стенд: .local/web-select-stand.js`);
  }
  // Кнопки копирования ставит настоящий copyButton — как в ленте.
  const turns = [...$('msgsInner').querySelectorAll('.turn')];
  turns[0].querySelector('.msgActions').append(helpers.copyButton('Первый вопрос', 'Скопировать сообщение'));
  const reasoning = turns[1].querySelector('.reasoning');
  reasoning.append(helpers.copyButton('размышления модели', 'Скопировать рассуждение'));
  turns[1].querySelector('.msgActions').append(helpers.copyButton('Ответ агента', 'Скопировать ответ'));
  turns[2].querySelector('.msgActions').append(helpers.copyButton('', 'Скопировать ответ'));
  return { document, copied, notices, turns, ...helpers };
}

test('тексты соединяются пустой строкой, пустые пропускаются', () => {
  const chat = makeChat();
  assert.deepEqual(chat.selectedMessages(['  a ', '', '   ', 'b\n']), ['a', 'b']);
  assert.equal(chat.selectedMessagesText(['  a ', '', '   ', 'b\n']), 'a\n\nb');
  assert.equal(chat.selectedMessagesText([]), '');
  assert.equal(chat.selectedMessagesText(['   ']), '');
});

test('в режим выбора попадают только сообщения, у которых есть что копировать', () => {
  const chat = makeChat();
  chat.startSelectingMessages();
  assert.equal(chat.selectableTurns().length, 3, 'системная строка — не сообщение ленты');
  const note = chat.$('msgsInner').querySelector('.systemNote');
  assert.equal(chat.selectableTurns().includes(note), false, 'systemNote в режим выбора не попадает');
  assert.equal(chat.turns.length, 3, 'заметка не станет «.turn» и не попадёт в счётчик');
  assert.equal(chat.$('selectCount').textContent, 'Отметьте сообщения');
  assert.equal(chat.$('selectCopy').disabled, true, 'без отметок копировать нечего');
});

test('в буфер уходит текст сообщения, а не рассуждение внутри ответа', async () => {
  const chat = makeChat();
  chat.startSelectingMessages();
  // Отмечаем в обратном порядке: второй ответ, потом первый вопрос.
  chat.toggleTurnSelection(chat.turns[1]);
  chat.toggleTurnSelection(chat.turns[0]);
  assert.equal(chat.$('selectCount').textContent, 'Выбрано: 2');
  assert.equal(chat.$('selectCopy').disabled, false);

  await chat.copySelectedMessages();
  assert.deepEqual(chat.copied, ['Первый вопрос\n\nОтвет агента'], 'порядок ленты, а не порядок нажатий');
  assert.equal(chat.copied[0].includes('размышления модели'), false, 'рассуждение не копируется вместе с ответом');
  assert.deepEqual(chat.notices, ['Скопировано сообщений: 2']);
  assert.equal(chat.$('selectBar').classList.contains('hidden'), true, 'режим выбора закрывается после копирования');
  assert.equal(chat.selectedTurns().length, 0, 'отметки сняты');
});

test('сообщение без текста не добавляет пустой абзац', async () => {
  const chat = makeChat();
  chat.startSelectingMessages();
  chat.toggleTurnSelection(chat.turns[0]);
  chat.toggleTurnSelection(chat.turns[2]);
  await chat.copySelectedMessages();
  assert.deepEqual(chat.copied, ['Первый вопрос'], 'ход из одних инструментов ничего не добавляет');
  // Счётчик называет то, что реально попало в буфер, а не число отмеченных.
  assert.deepEqual(chat.notices, ['Сообщение скопировано']);
});

test('выход из режима снимает отметки, а вне режима тап ничего не делает', () => {
  const chat = makeChat();
  chat.startSelectingMessages();
  chat.toggleTurnSelection(chat.turns[0]);
  chat.stopSelectingMessages();
  assert.equal(chat.selectedTurns().length, 0);
  assert.equal(chat.$('selectBar').classList.contains('hidden'), true);
  chat.toggleTurnSelection(chat.turns[0]);
  assert.equal(chat.selectedTurns().length, 0, 'вне режима выбора тап по сообщению его не отмечает');
});
