import test from 'node:test';
import assert from 'node:assert/strict';
import { trimStreamingDeltas, lightenEvent } from '../src/event-trim.mjs';

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

// The same field list as lightenEvent in the KMP client (ChatEventLighteningTest):
// these payloads are megabytes and are read by no client, so shipping them can only
// make a page unreadable.
test('lightenEvent drops the payloads no client reads and keeps the rest of the frame', () => {
  const drop = frame => lightenEvent(pi(1, frame)).data.pi;
  assert.deepEqual(drop({ type: 'agent_end', messages: [{ role: 'assistant' }], willRetry: false }), { type: 'agent_end', willRetry: false });
  assert.deepEqual(drop({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [1], stopReason: 'stop' }), { type: 'turn_end', stopReason: 'stop' });
  assert.deepEqual(drop({ type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'x' }] } }), { type: 'message_end' });
  assert.deepEqual(drop({ type: 'tool_execution_end', toolCallId: 't', toolName: 'bash', result: { giant: true } }), { type: 'tool_execution_end', toolCallId: 't', toolName: 'bash' });
  assert.deepEqual(drop({ type: 'tool_execution_update', toolCallId: 't', toolName: 'read', partialResult: { giant: true } }), { type: 'tool_execution_update', toolCallId: 't', toolName: 'read' });
  assert.deepEqual(drop({ type: 'tool_execution_start', toolCallId: 't', toolName: 'write', args: { path: 'a.txt', content: 'x'.repeat(1000) } }), { type: 'tool_execution_start', toolCallId: 't', toolName: 'write', args: { path: 'a.txt' } });
});

// What the clients DO read must survive: the assistant's own text, and a subagent's
// result (the progress line parses it).
test('lightenEvent keeps assistant text, user messages and subagent results', () => {
  const end = pi(1, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ответ' }] } });
  assert.deepEqual(lightenEvent(end).data.pi, end.data.pi);
  const start = pi(2, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'вопрос' }] } });
  assert.deepEqual(lightenEvent(start).data.pi, start.data.pi);
  const sub = pi(3, { type: 'tool_execution_end', toolCallId: 't', toolName: 'subagent', result: { details: { results: [] } } });
  assert.deepEqual(lightenEvent(sub).data.pi, sub.data.pi);
});

// A page is lightened only when it has to be, so nothing that already fits changes.
test('lightenEvent leaves anything untouched when there is nothing to drop', () => {
  const events = [
    { seq: 1, type: 'USER_MESSAGE', data: { text: 'привет' } },
    pi(2, { type: 'agent_settled' }),
    pi(3, { type: 'agent_end' }),
    pi(4, { type: 'tool_execution_end', toolCallId: 't', toolName: 'bash' }),
    { seq: 5, type: 'PI_EVENT', message: 'no frame' },
  ];
  for (const event of events) assert.equal(lightenEvent(event), event, 'the very same object is returned');
});
