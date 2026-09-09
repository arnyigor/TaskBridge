import test from 'node:test';
import assert from 'node:assert/strict';
import { trimStreamingDeltas } from '../src/event-trim.mjs';

const pi = (seq, frame) => ({ seq, type: 'PI_EVENT', data: { pi: frame } });

test('deltas between a closed message_start/message_end are dropped', () => {
  const events = [
    pi(1, { type: 'message_start', message: { role: 'assistant' } }),
    pi(2, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } }),
    pi(3, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } }),
    pi(4, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ab' }] } }),
  ];
  const result = trimStreamingDeltas(events);
  assert.deepEqual(result.map(e => e.seq), [1, 4]);
});

test('deltas for a still-open message (no closing message_end in this batch) are kept', () => {
  const events = [
    pi(1, { type: 'message_start', message: { role: 'assistant' } }),
    pi(2, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } }),
    pi(3, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } }),
  ];
  const result = trimStreamingDeltas(events);
  assert.deepEqual(result.map(e => e.seq), [1, 2, 3]);
});

test('a second, later message is trimmed independently of an earlier closed one', () => {
  const events = [
    pi(1, { type: 'message_start', message: { role: 'assistant' } }),
    pi(2, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } }),
    pi(3, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } }),
    pi(4, { type: 'message_start', message: { role: 'user' } }),
    pi(5, { type: 'message_end', message: { role: 'user' } }),
    pi(6, { type: 'message_start', message: { role: 'assistant' } }),
    pi(7, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'c' } }),
    pi(8, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'd' } }),
  ];
  const result = trimStreamingDeltas(events);
  // seq 7,8 belong to the still-open final message (started at 6, no end yet) and survive;
  // seq 2 (closed at 1..3) is dropped.
  assert.deepEqual(result.map(e => e.seq), [1, 3, 4, 5, 6, 7, 8]);
});

test('non-PI events, tool events and empty input pass through untouched', () => {
  assert.deepEqual(trimStreamingDeltas([]), []);
  const events = [
    { seq: 1, type: 'USER_MESSAGE', data: { text: 'hi' } },
    pi(2, { type: 'tool_execution_start', toolCallId: 'x' }),
    pi(3, { type: 'tool_execution_end', toolCallId: 'x' }),
    pi(4, { type: 'agent_settled' }),
  ];
  assert.deepEqual(trimStreamingDeltas(events), events);
});

test('a thinking_delta-only message_update is dropped the same way as a text_delta one', () => {
  const events = [
    pi(1, { type: 'message_start', message: { role: 'assistant' } }),
    pi(2, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } }),
    pi(3, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } }),
  ];
  assert.deepEqual(trimStreamingDeltas(events).map(e => e.seq), [1, 3]);
});
