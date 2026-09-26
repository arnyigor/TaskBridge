import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatState } from '../web/chat-state.mjs';

test('web also preserves the question when KMP deletes an answer', () => {
  const task = { id: 't', prompt: 'original', status: 'SUCCEEDED' };
  const chat = new ChatState(task);
  chat.apply({ taskId: 't', seq: 1, type: 'USER_MESSAGE', data: { text: 'keep' } });
  chat.apply({ taskId: 't', seq: 2, type: 'PI_EVENT', data: { pi: { type: 'agent_settled' } } });
  chat.apply({ taskId: 't', seq: 3, type: 'TURN_TRUNCATED', data: { fromSeq: 2, keepUser: true, reason: 'delete' } });
  chat.snapshot(task);
  assert.equal(chat.turns.at(-1).id, 'user-1');
  assert.equal(chat.turns.at(-1).text, 'keep');
  assert.equal(chat.turns.some(t => t.id === 'assistant-1'), false);
});
