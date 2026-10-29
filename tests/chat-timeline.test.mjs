import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ChatState } from '../web/chat-state.mjs';
import { trimStreamingDeltas } from '../src/event-trim.mjs';
import { TaskStore } from '../src/task-store.mjs';

const task = { id: 'timeline', prompt: 'Question', status: 'RUNNING' };
const start = { type: 'message_start', message: { role: 'assistant' } };
const delta = (type, value) => ({ type: 'message_update', assistantMessageEvent: { type: `${type}_delta`, delta: value } });
const end = content => ({ type: 'message_end', message: { role: 'assistant', content } });
const events = frames => frames.map((pi, i) => ({ taskId: task.id, seq: i + 1, type: 'PI_EVENT', data: { pi } }));
const replay = log => { const state = new ChatState(task); log.forEach(event => state.apply(event)); return state; };
const projection = state => state.projectTurns(state.turns).map(turn => ({
  id: turn.id, role: turn.role, text: turn.text, thinking: turn.thinking,
  tools: turn.tools?.map(tool => [tool.id, tool.state]),
}));

const interleaved = events([
  start, delta('text', 'before'),
  { type: 'tool_execution_start', toolName: 'read', toolCallId: 'a' },
  { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'b' },
  delta('text', 'after'),
  { type: 'tool_execution_end', toolCallId: 'b' },
  { type: 'tool_execution_end', toolCallId: 'a' },
  end([{ type: 'text', text: 'beforeafter' }]),
]);

test('TIMELINE-02: tools split an open message; final content and trimming preserve its chronology', () => {
  const live = new ChatState(task);
  let first, tools;
  for (const event of interleaved) {
    live.apply(event);
    const views = live.projectTurns(live.turns).filter(turn => turn.role === 'assistant');
    if (views[1]) {
      first ||= views[0];
      tools ||= views[1];
      assert.equal(views[1], tools);
      assert.equal(views[0], first);
    }
  }
  assert.deepEqual(live.projectTurns(live.turns).filter(turn => turn.role === 'assistant').map(turn => [turn.text, turn.tools.map(tool => tool.id)]), [
    ['before', []], ['', ['a', 'b']], ['after', []],
  ]);
  assert.equal(tools.tools[0], live.tools.get('a'));
  assert.equal(tools.tools[1], live.tools.get('b'));
  assert.equal(live.current.text, 'beforeafter');
  assert.deepEqual(projection(replay(trimStreamingDeltas(interleaved))), projection(live));
  assert.equal(live.turns.filter(turn => turn.role === 'assistant').length, 1);
  const views = live.projectTurns(live.turns).filter(turn => turn.role === 'assistant');
  assert(views.every(turn => turn.canonicalTurn === live.current));
  assert.equal(views.filter(turn => turn.segmentActions).length, 1);
  for (let cut = 1; cut < interleaved.length; cut++) {
    const tail = new ChatState(task, { seedInitial: false });
    interleaved.slice(cut).forEach(event => tail.apply(event));
    tail.prependOlder(task, interleaved.slice(0, cut), true);
    assert.deepEqual(projection(tail), projection(live), `pagination cut ${cut}`);
  }
});

test('TIMELINE-02: thinking → text → thinking retains block order with or without deltas', () => {
  const log = events([
    start, delta('thinking', 'reason one'), delta('text', 'answer'), delta('thinking', 'reason two'),
    end([{ type: 'thinking', thinking: 'reason one' }, { type: 'text', text: 'answer' }, { type: 'thinking', thinking: 'reason two' }]),
  ]);
  const live = replay(log);
  assert.deepEqual(live.projectTurns(live.turns).filter(turn => turn.role === 'assistant').map(turn => [turn.thinking, turn.text]), [
    ['reason one', ''], ['', 'answer'], ['reason two', ''],
  ]);
  assert.deepEqual(projection(replay(trimStreamingDeltas(log))), projection(live));
});

test('TIMELINE-02: ordinary trimmed messages keep stable segment IDs and canonical text', () => {
  const log = events([
    start, delta('text', 'one'), end([{ type: 'text', text: 'one' }]),
    { type: 'tool_execution_start', toolName: 'read', toolCallId: 'a' },
    { type: 'tool_execution_end', toolCallId: 'a' },
    start, delta('thinking', 'why'), delta('text', 'two'),
    end([{ type: 'thinking', thinking: 'why' }, { type: 'text', text: 'two' }]),
  ]);
  const live = replay(log);
  const trimmed = trimStreamingDeltas(log);
  assert(trimmed.length < log.length, 'ordinary deltas still get trimmed');
  assert.deepEqual(projection(replay(trimmed)), projection(live));
  assert.equal(live.current.text, 'one\n\ntwo');
});

test('TIMELINE-02: SQLite pruning and reopening preserve text on both sides of tools', async t => {
  await fs.mkdir('.local', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.local/timeline-store-'));
  const store = new TaskStore(root);
  let reopened;
  t.after(async () => { store.close(); reopened?.close(); await fs.rm(root, { recursive: true, force: true }); });
  await store.create(task);
  for (const event of interleaved) await store.appendEvent(task.id, event);
  await store.pruneStreamingDeltas(task.id);
  store.close();
  reopened = new TaskStore(root);
  const stored = trimStreamingDeltas(await reopened.readEvents(task.id, 0));
  assert.deepEqual(projection(replay(stored)), projection(replay(interleaved)));
});
