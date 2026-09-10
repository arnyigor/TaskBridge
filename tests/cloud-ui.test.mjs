import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { buildTurns } from '../cloud/public/cloud-chat.mjs';

const event = (seq, pi) => ({ seq, type: 'PI_EVENT', data: { pi } });

test('cloud chat renders Markdown and reconstructs reasoning plus tools', () => {
  const events = [
    { seq: 1, type: 'USER_MESSAGE', data: { text: 'Сделай отчёт' } },
    event(2, { type: 'message_start', message: { role: 'assistant' } }),
    event(3, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Проверяю данные' } }),
    event(4, { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'report.md' } }),
    event(5, { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', isError: false }),
    event(6, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '**Готово**' } }),
    event(7, { type: 'message_end', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Проверяю данные' },
      { type: 'text', text: '**Готово**\n\n| A | B |\n|---|---|\n| 1 | 2 |' }
    ] } })
  ];

  const turns = buildTurns({ prompt: 'Сделай отчёт' }, events);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].thinking, 'Проверяю данные');
  assert.equal(turns[1].tools[0].status, 'done');
  assert.match(marked.parse(turns[1].text), /<strong>Готово<\/strong>/);
  assert.match(marked.parse(turns[1].text), /<table>/);
});
