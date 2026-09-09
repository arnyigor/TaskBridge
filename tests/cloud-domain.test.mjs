import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { EventSequence, uuidv7, nextSeqFrom } from '../src/events/event-sequence.mjs';
import { EventNormalizer, taskStateFromLocalStatus } from '../src/events/event-normalizer.mjs';
import { SnapshotPolicy, createSnapshotState } from '../src/events/event-snapshot.mjs';
import { sanitizeForCloud, buildPathAliases, redactText } from '../src/cloud/sanitize.mjs';
import { canTransition, isDurableEvent, isHighPriorityEvent } from '../src/domain/task-event.mjs';
import { parseCommand, compareCommands, commandPriority } from '../src/domain/cloud-command.mjs';

test('task state transitions are explicit and terminal states never move', () => {
  assert.equal(canTransition('QUEUED', 'STARTING'), true);
  assert.equal(canTransition('RUNNING', 'COMPLETED'), true);
  assert.equal(canTransition('COMPLETED', 'RUNNING'), false);
  assert.equal(canTransition('ABORTED', 'RUNNING'), false);
  assert.equal(canTransition('QUEUED', 'COMPLETED'), false);
  assert.equal(taskStateFromLocalStatus('SUCCEEDED'), 'COMPLETED');
  assert.equal(taskStateFromLocalStatus('CANCELLED'), 'ABORTED');
  assert.equal(taskStateFromLocalStatus('PREPARING'), 'STARTING');
  assert.equal(isDurableEvent('tool_started'), true);
  assert.equal(isDurableEvent('assistant_delta'), false);
  assert.equal(isHighPriorityEvent('task_failed'), true);
  assert.equal(isHighPriorityEvent('assistant_delta'), false);
});

test('event sequence is monotonic, restores after restart and never reuses a cursor', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-cloud-seq-'));
  const store = new TaskStore(root);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });

  const first = new EventSequence({ store });
  assert.equal(first.allocate('task_a'), 1);
  assert.equal(first.allocate('task_a'), 2);
  assert.equal(first.allocate('task_b'), 1);
  assert.equal(nextSeqFrom(0), 1);
  assert.equal(nextSeqFrom('41'), 42);

  // A new process must continue where the previous one stopped.
  const second = new EventSequence({ store });
  assert.equal(second.allocate('task_a'), 3);
  assert.equal(second.observe('task_a', 100), 100);
  assert.equal(second.allocate('task_a'), 101);
  // observe never moves a cursor backwards
  assert.equal(second.observe('task_a', 5), 101);
});

test('uuidv7 ids sort by creation time', () => {
  const early = uuidv7(Date.now() - 1000);
  const late = uuidv7(Date.now());
  assert.match(early, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(early < late);
});

test('Pi frames become normalized task events with tool lifecycle and message ids', () => {
  const normalizer = new EventNormalizer();
  const events = [];
  events.push(...normalizer.normalizePiFrame('t', { type: 'agent_start' }));
  events.push(...normalizer.normalizePiFrame('t', { type: 'message_start', message: { role: 'assistant', content: [] } }));
  events.push(...normalizer.normalizePiFrame('t', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Checking ' } }));
  events.push(...normalizer.normalizePiFrame('t', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'tests' } }));
  events.push(...normalizer.normalizePiFrame('t', { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: './gradlew test' } }));
  events.push(...normalizer.normalizePiFrame('t', { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', isError: false, exitCode: 0 }));
  events.push(...normalizer.normalizePiFrame('t', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Checking tests' }], stopReason: 'stop' } }));
  events.push(...normalizer.normalizePiFrame('t', { type: 'agent_settled' }));

  assert.deepEqual(events.map(event => event.type), [
    'turn_started',
    'assistant_delta',
    'assistant_delta',
    'tool_started',
    'tool_finished',
    'assistant_end',
    'turn_finished'
  ]);
  const deltas = events.filter(event => event.type === 'assistant_delta');
  assert.equal(deltas[0].payload.messageId, 'msg_1');
  assert.equal(events.find(event => event.type === 'assistant_end').payload.text, 'Checking tests');
  assert.equal(events.find(event => event.type === 'tool_started').payload.toolCallId, 'call_1');
  assert.equal(events.find(event => event.type === 'tool_finished').payload.exitCode, 0);
  // The normalizer keeps the full assistant text for snapshot generation.
  assert.equal(normalizer.assistantText('t'), 'Checking tests');
});

test('tool update declares delta versus snapshot mode', () => {
  const normalizer = new EventNormalizer();
  const delta = normalizer.normalizePiFrame('t', { type: 'tool_execution_update', toolCallId: 'c', output: 'chunk' })[0];
  const snapshot = normalizer.normalizePiFrame('t', { type: 'tool_execution_update', toolCallId: 'c', mode: 'snapshot', output: 'all' })[0];
  assert.equal(delta.payload.mode, 'delta');
  assert.equal(snapshot.payload.mode, 'snapshot');
});

test('local TaskManager events map onto the cloud protocol', () => {
  const normalizer = new EventNormalizer();
  const queued = normalizer.normalizeLocalEvent('t', { type: 'TASK_QUEUED', message: 'Task queued' });
  const status = normalizer.normalizeLocalEvent('t', { type: 'STATUS', message: 'Pi is working', data: { status: 'RUNNING' } });
  const user = normalizer.normalizeLocalEvent('t', { type: 'USER_MESSAGE', message: 'do it', data: { text: 'do it', mode: 'steer', files: [{ name: 'a.txt', size: 3 }] } });
  const failed = normalizer.normalizeLocalEvent('t', { type: 'TASK_FAILED', message: 'boom', data: { errorCode: 'MODEL_ERROR' } });
  const done = normalizer.normalizeLocalEvent('t', { type: 'TASK_SUCCEEDED', message: 'Done' });
  const aborted = normalizer.normalizeLocalEvent('t', { type: 'TASK_CANCELLED', message: 'Task cancelled' });
  assert.equal(queued[0].type, 'task_created');
  assert.equal(status[0].payload.status, 'RUNNING');
  assert.equal(user[0].type, 'user_message');
  assert.equal(user[0].payload.files[0].name, 'a.txt');
  assert.equal(failed[0].type, 'task_failed');
  assert.equal(failed[0].payload.errorCode, 'MODEL_ERROR');
  assert.equal(done[0].type, 'task_finished');
  assert.equal(aborted[0].type, 'task_aborted');
});

test('assistant snapshots fire on interval or size, whichever comes first', () => {
  const policy = new SnapshotPolicy({ intervalMs: 1000, bytes: 10 });
  const state = createSnapshotState(0);
  policy.note(state, 'msg_1', 'abc', 0);
  assert.equal(policy.due(state, 500), false);
  policy.note(state, 'msg_1', 'defghijk', 600); // 11 bytes total
  assert.equal(policy.due(state, 600), true);
  policy.mark(state, 600);
  assert.equal(policy.due(state, 700), false);
  assert.equal(policy.due(state, 1700), true);
});

test('sanitizeForCloud redacts secrets and aliases absolute project paths', () => {
  assert.match(redactText('Authorization: Bearer abc123def'), /\[REDACTED\]/);
  assert.match(redactText('api_key=super-secret-value'), /\[REDACTED\]/);
  assert.match(redactText('sk-abcdefghijklmnopqrstuvwx'), /\[REDACTED_KEY\]/);
  assert.match(redactText('ghp_abcdefghijklmnopqrstuvwxyz012345'), /\[REDACTED_TOKEN\]/);
  assert.match(redactText('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'), /\[REDACTED_PRIVATE_KEY\]/);

  const aliases = buildPathAliases({ PROJECT_ROOT: 'G:\\Android\\Projects\\TaskBridge' });
  const sanitized = sanitizeForCloud({
    command: 'type G:\\Android\\Projects\\TaskBridge\\src\\server.mjs',
    sibling: 'G:\\Android\\Projects\\TaskBridgeOther\\x',
    token: 'should-be-dropped'
  }, { aliases });
  assert.match(sanitized.command, /\$\{PROJECT_ROOT\}/);
  // A prefix that is not a real path boundary must be left alone.
  assert.match(sanitized.sibling, /TaskBridgeOther/);
  assert.equal(sanitized.token, '[REDACTED]');
});

test('commands are validated and ordered by priority', () => {
  const base = { commandId: 'c1', machineId: 'm', seq: 1, type: 'START_TASK', payload: {} };
  assert.equal(parseCommand(base).type, 'START_TASK');
  assert.throws(() => parseCommand({ ...base, type: 'NOPE' }), { code: 'COMMAND_REJECTED' });
  assert.throws(() => parseCommand({ ...base, seq: 0 }), { code: 'COMMAND_REJECTED' });
  assert.throws(() => parseCommand({ ...base, commandId: '' }), { code: 'COMMAND_REJECTED' });

  assert.ok(commandPriority('ABORT_TASK') < commandPriority('START_TASK'));
  const ordered = [{ type: 'START_TASK', seq: 1 }, { type: 'ABORT_TASK', seq: 5 }, { type: 'FOLLOW_UP', seq: 3 }].sort(compareCommands);
  assert.deepEqual(ordered.map(c => c.type), ['ABORT_TASK', 'FOLLOW_UP', 'START_TASK']);
});
