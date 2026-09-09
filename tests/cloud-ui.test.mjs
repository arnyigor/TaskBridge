import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewState, applyEvent, applyEvents, cursorKey } from '../cloud/web/event-reducer.mjs';

function event(seq, type, payload = {}, extra = {}) {
  return { eventId: `e${seq}`, taskId: 't', seq, type, payload, timestamp: new Date().toISOString(), ...extra };
}

test('assistant deltas append and coalesced batches keep seq continuity', () => {
  const view = createViewState();
  applyEvent(view, event(1, 'assistant_delta', { messageId: 'msg_1', text: 'Checking ' }));
  applyEvent(view, event(2, 'assistant_delta', { messageId: 'msg_1', text: 'the ' }));
  applyEvent(view, event(3, 'assistant_delta_batch', { messageId: 'msg_1', text: 'tests', count: 2 }, { seqFrom: 3, seqTo: 4 }));
  const message = view.messages.get('msg_1');
  assert.equal(message.text, 'Checking the tests');
  assert.equal(view.lastSeq, 4, 'the batch advances the cursor to seqTo');
});

test('assistant snapshot replaces instead of appending', () => {
  const view = createViewState();
  applyEvent(view, event(1, 'assistant_delta', { messageId: 'msg_1', text: 'partial' }));
  applyEvent(view, event(2, 'assistant_snapshot', { messageId: 'msg_1', text: 'complete text' }));
  assert.equal(view.messages.get('msg_1').text, 'complete text');
  // assistant_end carries the final durable representation.
  applyEvent(view, event(3, 'assistant_end', { messageId: 'msg_1', text: 'complete text', stopReason: 'stop' }));
  assert.equal(view.messages.get('msg_1').status, 'COMPLETE');
});

test('replayed events with an already-applied seq are ignored', () => {
  const view = createViewState();
  applyEvents(view, [event(1, 'assistant_delta', { messageId: 'm', text: 'a' }), event(2, 'assistant_delta', { messageId: 'm', text: 'b' })]);
  assert.equal(view.lastSeq, 2);
  const changed = applyEvent(view, event(2, 'assistant_delta', { messageId: 'm', text: 'b' }));
  assert.equal(changed, false);
  assert.equal(view.messages.get('m').text, 'ab');
  // A snapshot with its own new seq still applies (authoritative replace).
  assert.equal(applyEvent(view, event(3, 'assistant_snapshot', { messageId: 'm', text: 'ab' })), true);
});

test('out-of-order arrival renders in seq order', () => {
  const view = createViewState();
  applyEvent(view, event(2, 'assistant_delta', { messageId: 'msg_2', text: 'second' }));
  applyEvent(view, event(1, 'assistant_delta', { messageId: 'msg_1', text: 'first' }));
  assert.deepEqual(view.order, ['msg_1', 'msg_2']);
  assert.equal(view.lastSeq, 2);
});

test('tool updates honour delta vs snapshot and the failure path', () => {
  const view = createViewState();
  applyEvent(view, event(1, 'tool_started', { toolCallId: 'c1', toolName: 'bash', args: { command: './gradlew test' } }));
  applyEvent(view, event(2, 'tool_updated', { toolCallId: 'c1', mode: 'delta', output: '> Task :compileKotlin\n' }));
  applyEvent(view, event(3, 'tool_updated', { toolCallId: 'c1', mode: 'delta', output: '> Task :test\n' }));
  applyEvent(view, event(4, 'tool_updated', { toolCallId: 'c1', mode: 'snapshot', output: 'BUILD SUCCESSFUL\n' }));
  applyEvent(view, event(5, 'tool_finished', { toolCallId: 'c1', exitCode: 0, durationMs: 18231, summary: 'BUILD SUCCESSFUL' }));
  const record = view.tools.get('c1');
  assert.equal(record.output, 'BUILD SUCCESSFUL\n', 'a snapshot replaces the accumulated output');
  assert.equal(record.status, 'ok');
  assert.equal(record.durationMs, 18231);

  applyEvent(view, event(6, 'tool_started', { toolCallId: 'c2', toolName: 'bash', args: {} }));
  applyEvent(view, event(7, 'tool_failed', { toolCallId: 'c2', error: { code: 'PROCESS_EXIT_NONZERO', message: 'Process exited with code 1' } }));
  assert.equal(view.tools.get('c2').status, 'err');
  assert.equal(view.tools.get('c2').error, 'Process exited with code 1');
});

test('terminal events finalize open messages, tools and approvals', () => {
  const view = createViewState();
  applyEvent(view, event(1, 'task_state', { status: 'RUNNING', current: 'Pi is working' }));
  applyEvent(view, event(2, 'assistant_delta', { messageId: 'm', text: 'working' }));
  applyEvent(view, event(3, 'tool_started', { toolCallId: 'c1', toolName: 'bash', args: {} }));
  applyEvent(view, event(4, 'approval_required', { approvalId: 'a1', toolName: 'bash', args: { command: 'rm -rf' }, risk: 'destructive' }));
  assert.equal(view.status, 'RUNNING');
  assert.equal(view.approvals.get('a1').status, 'PENDING');

  applyEvent(view, event(5, 'task_failed', { status: 'FAILED', error: 'boom', errorCode: 'MODEL_ERROR' }));
  assert.equal(view.status, 'FAILED');
  assert.equal(view.error, 'boom');
  assert.equal(view.messages.get('m').status, 'COMPLETE');
  assert.equal(view.tools.get('c1').status, 'err');

  applyEvent(view, event(6, 'approval_resolved', { approvalId: 'a1', decision: 'DENY', status: 'DENIED' }));
  assert.equal(view.approvals.get('a1').status, 'DENIED');
});

test('user messages render as their own turn and the cursor key is per task', () => {
  const view = createViewState();
  applyEvent(view, event(1, 'user_message', { text: 'do not touch the DB' }));
  assert.equal(view.messages.get('user:1').role, 'user');
  assert.equal(view.messages.get('user:1').text, 'do not touch the DB');
  assert.equal(cursorKey('task_123'), 'taskbridge.lastSeq.task_123');
});
