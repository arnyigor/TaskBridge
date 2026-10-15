import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatState } from '../web/chat-state.mjs';

// Этап M2 плана: факт инъекции памяти виден в ленте чата. «Работает ли память»
// перестаёт быть гаданием: числа и источники лежат рядом с ходом, к которому
// относились, а не только в логах сервера.

const task = { id: 't', status: 'RUNNING', prompt: 'вопрос' };

test('MEMORY_INJECTED becomes one collapsible note with numbers and sources', () => {
  const chat = new ChatState(task);
  const applied = chat.apply({
    taskId: 't', seq: 5, type: 'MEMORY_INJECTED',
    message: 'Память: 3 заметок (~210 токенов)',
    data: { notes: 3, tokens: 210, globalNotes: 1, globalTokens: 40, sources: ['core/project/queue.md', '_global/decision/prefs.md'] },
  });
  assert.equal(applied, true);
  const notes = chat.turns.filter(turn => turn.role === 'note');
  assert.equal(notes.length, 1, JSON.stringify(chat.turns.map(turn => turn.role)));
  assert.equal(notes[0].text, 'Память: 3 заметок (~210 токенов)');
  assert.deepEqual(notes[0].memory.sources, ['core/project/queue.md', '_global/decision/prefs.md']);
  assert.equal(notes[0].memory.notes, 3);
  assert.equal(notes[0].memory.globalNotes, 1);

  // Повтор того же события (догон после переподключения) не добавляет вторую заметку.
  chat.apply({ taskId: 't', seq: 5, type: 'MEMORY_INJECTED', message: 'Память: 3 заметок', data: { notes: 3 } });
  assert.equal(chat.turns.filter(turn => turn.role === 'note').length, 1, 'заметка не дублируется');
});

test('an injection without a source list still shows the fact', () => {
  const chat = new ChatState(task);
  chat.apply({ taskId: 't', seq: 7, type: 'MEMORY_INJECTED', message: 'Память: 1 заметок (~50 токенов)', data: { notes: 1, tokens: 50 } });
  const note = chat.turns.find(turn => turn.role === 'note');
  assert.deepEqual(note.memory.sources, []);
  assert.equal(note.text, 'Память: 1 заметок (~50 токенов)');
});

test('the injection note does not add a turn of its own', () => {
  // Порядок событий важен: редьюсер отвергает seq меньше уже применённого.
  const withEvent = new ChatState(task);
  const without = new ChatState(task);
  for (const chat of [withEvent, without]) {
    chat.apply({ taskId: 't', seq: 2, type: 'USER_MESSAGE', message: 'вопрос', data: { text: 'вопрос' } });
  }
  withEvent.apply({ taskId: 't', seq: 3, type: 'MEMORY_INJECTED', message: 'Память: 2 заметок (~120 токенов)', data: { notes: 2, tokens: 120 } });
  for (const chat of [withEvent, without]) {
    chat.apply({ taskId: 't', seq: 4, type: 'STATUS', data: { status: 'RUNNING' } });
  }

  const count = (chat, role) => chat.turns.filter(turn => turn.role === role).length;
  assert.equal(count(withEvent, 'note'), 1, 'заметка о памяти появилась');
  assert.equal(count(without, 'note'), 0, 'без события заметки нет');
  // Инвариант: инъекция не создаёт «ответ» и не съедает существующие ходы.
  assert.equal(count(withEvent, 'assistant'), count(without, 'assistant'));
  assert.equal(count(withEvent, 'user'), count(without, 'user'));
});
