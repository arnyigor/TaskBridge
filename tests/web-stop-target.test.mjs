import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ACTIVE_STATUSES } from '../web/chat-state.mjs';

// Оператор 2026-10-14: «сообщение не отправляется, и я не могу никак перезапустить».
// STOP обязана отменять ЛЮБОЕ действие: у зависшей отправки статус сессии может быть
// уже терминальным, и тогда «есть что останавливать» по статусу не выводится.
// Тест выполняет НАСТОЯЩИЕ функции панели (stopTarget/stuckSendTarget), а не их копию.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

/** Вырезает исходник функции по имени: от `function name(` до парной `}`. */
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

/** Стенд: реальные функции панели + состояние, которым они управляют. */
function stand() {
  const lines = [
    'let lastTasks = [];',
    'let selectedTaskId = null;',
    'let currentTask = null;',
    'let locallyQueuedPrompts = [];',
    'let lastPrompt = null;',
    'const ACTIVE_STATUSES = arguments[0];',
    // chatState нужен только для «активен ли текущий ход»: в стенде хода нет.
    'let chatState = null;',
    extractFunction(appSource, 'stopTarget'),
    extractFunction(appSource, 'stuckSendTarget'),
    `return {
      setTasks: value => { lastTasks = value; },
      select: (id, task = null) => { selectedTaskId = id; currentTask = task ?? lastTasks.find(t => t.id === id) ?? null; },
      queue: text => { locallyQueuedPrompts.push({ local: true, text }); },
      clearQueue: () => { locallyQueuedPrompts.length = 0; },
      setFailedPrompt: value => { lastPrompt = value; },
      stopTargetId: () => stopTarget()?.id ?? null,
    };`,
  ].join('\n');
  return new Function(lines)(ACTIVE_STATUSES);
}

test('a stuck send makes STOP available even in a finished session', () => {
  const panel = stand();
  panel.setTasks([{ id: 'a', title: 'Сессия A', status: 'SUCCEEDED' }]);
  panel.select('a');
  assert.equal(panel.stopTargetId(), null, 'в терминальной сессии без отправок останавливать нечего');

  panel.queue('текст, который не уходит');
  assert.equal(panel.stopTargetId(), 'a', 'зависшая отправка делает STOP доступным');

  panel.clearQueue();
  panel.setFailedPrompt({ id: 'a', text: 'не ушло', failedSend: true });
  assert.equal(panel.stopTargetId(), 'a', 'неподтверждённая отправка — второй повод');

  panel.setFailedPrompt({ id: 'a', text: 'не ушло', failedSend: false });
  assert.equal(panel.stopTargetId(), null, 'подтверждённая отправка — уже не повод');
});

test('a working session is still stoppable, and a stuck stop stays stoppable', () => {
  const panel = stand();
  panel.setTasks([{ id: 'b', title: 'Сессия B', status: 'RUNNING' }, { id: 'c', title: 'C', status: 'CANCELLING' }]);
  panel.select('b');
  assert.equal(panel.stopTargetId(), 'b');
  panel.select('c');
  assert.equal(panel.stopTargetId(), 'c', 'залипшая остановка должна повторяться');
});
