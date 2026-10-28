import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { ChatState } from '../web/chat-state.mjs';
import { trimStreamingDeltas } from '../src/event-trim.mjs';

const task = { id: 'compact', prompt: 'Question', status: 'RUNNING' };
const frame = (seq, pi) => ({ seq, type: 'PI_EVENT', data: { pi } });
const text = value => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: value } });
const compact = { type: 'compaction_end', result: { summary: 'Summary' } };
const projection = state => state.displayTurns.map(t => ({ id: t.id, role: t.role, text: t.text, tools: t.tools?.map(x => x.id) }));

for (const name of ['auto', 'manual']) {
  test(`real Pi ${name} fixture preserves order, canonical identity and replay`, async () => {
    const fixture = JSON.parse(await fs.readFile(new URL(`./fixtures/compaction/pi-1.4.0-${name}.json`, import.meta.url)));
    const live = new ChatState(fixture.task);
    for (const event of fixture.events) { live.apply(event); void live.displayTurns; }
    const replay = new ChatState(fixture.task);
    for (const event of fixture.events) replay.apply(event);
    assert.deepEqual(projection(live), projection(replay));
    for (const event of fixture.events) live.apply(event); // reconnect duplicates
    assert.deepEqual(projection(live), projection(replay));
    assert.equal(live.turns.filter(t => t.role === 'assistant').length, 1);
    const displayed = live.displayTurns;
    const golden = JSON.parse(await fs.readFile(new URL(`./fixtures/compaction/pi-1.4.0-${name}.expected.json`, import.meta.url)));
    assert.deepEqual(projection(live).map(t => ({ ...t, tools: t.tools || [] })), golden);
    if (name === 'auto') {
      assert.deepEqual(displayed.map(t => t.role), ['user', 'assistant', 'note', 'assistant', 'note']);
      assert.deepEqual(displayed.filter(t => t.role === 'assistant').map(t => t.text), ['BEFORE', 'AFTER']);
    } else {
      assert.deepEqual(displayed.map(t => t.role), ['user', 'assistant', 'note']);
    }
    const segments = displayed.filter(t => t.role === 'assistant');
    assert.equal(segments.filter(t => t.segmentActions).length, 1);
    assert(segments.every(t => t.canonicalTurn === live.current));
    assert.equal(new Set(displayed.map(t => t.id)).size, displayed.length);
    assert(segments.every(t => !t.active));
  });
}

test('real Pi fixture survives SQLite pruning, reopen and history trimming', async t => {
  await fs.mkdir('.local', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.local/compact-store-test-'));
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/compaction/pi-1.4.0-auto.json', import.meta.url)));
  const store = new TaskStore(root);
  let reopened;
  t.after(async () => { store.close(); reopened?.close(); await fs.rm(root, { recursive: true, force: true }); });
  await store.create(fixture.task);
  const live = new ChatState(fixture.task);
  for (const event of fixture.events) {
    await store.appendEvent(fixture.task.id, event);
    live.apply(event);
    if (event.data.pi.type === 'message_end') await store.pruneStreamingDeltas(fixture.task.id);
  }
  store.close();
  reopened = new TaskStore(root);
  const persisted = trimStreamingDeltas(await reopened.readEvents(fixture.task.id, 0));
  const replay = new ChatState(fixture.task);
  for (const event of persisted) replay.apply(event);
  assert.deepEqual(projection(replay), projection(live));
});

test('full message_end after a boundary replaces deltas without duplication', () => {
  const state = new ChatState(task);
  [text('before'), compact, text('after'), { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'beforeafter' }] } }]
    .forEach((pi, i) => state.apply(frame(i + 1, pi)));
  assert.deepEqual(state.displayTurns.filter(t => t.role === 'assistant').map(t => t.text), ['before', 'after']);
  assert.equal(state.current.text, 'beforeafter');
});

test('history trimming retains a compact boundary inside a streamed message', () => {
  const events = [
    { type: 'message_start', message: { role: 'assistant' } }, text('before'), compact, text('after'),
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'beforeafter' }] } },
  ].map((pi, i) => frame(i + 1, pi));
  const live = new ChatState(task);
  const replay = new ChatState(task);
  for (const event of events) live.apply(event);
  for (const event of trimStreamingDeltas(events)) replay.apply(event);
  assert.deepEqual(projection(replay), projection(live));
});

test('two successful boundaries give three stable views, tools stay on their side', () => {
  const state = new ChatState(task);
  let seq = 0;
  const send = pi => state.apply(frame(++seq, pi));
  send(text('one'));
  send({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'a' });
  send(compact);
  const first = state.displayTurns[1];
  send({ type: 'message_start', message: { role: 'assistant' } });
  send(text('two'));
  send({ type: 'tool_execution_end', toolName: 'read', toolCallId: 'a' });
  send(compact);
  send({ type: 'message_start', message: { role: 'assistant' } });
  send(text('three'));
  const segments = state.displayTurns.filter(t => t.role === 'assistant');
  assert.deepEqual(segments.map(t => t.text), ['one', 'two', 'three']);
  assert.equal(segments[0], first);
  assert.equal(first.tools[0], state.tools.get('a'));
  assert.equal(first.tools[0].state, 'done');
  assert.deepEqual(segments.map(t => t.active), [false, false, true]);
  assert.deepEqual(segments.map(t => t.segmentActions), [false, false, true]);
});

for (const failure of [{ errorMessage: 'Failed' }, { aborted: true }, { cancelled: true }]) {
  test(`unsuccessful compact does not split or claim success: ${Object.keys(failure)[0]}`, () => {
    const state = new ChatState(task);
    state.apply(frame(1, text('one')));
    state.apply(frame(2, { ...compact, ...failure }));
    state.apply(frame(3, text('two')));
    assert.equal(state.displayTurns.filter(t => t.role === 'assistant').length, 1);
    assert(!state.displayTurns.some(t => t.role === 'note' && t.text.startsWith('Контекст сжат')));
  });
}

test('STOP settles every compact segment without changing the canonical answer', () => {
  const state = new ChatState(task);
  [text('one'), compact, text('two')].forEach((pi, i) => state.apply(frame(i + 1, pi)));
  state.apply({ seq: 4, type: 'TASK_CANCELLED' });
  const segments = state.displayTurns.filter(t => t.role === 'assistant');
  assert.deepEqual(segments.map(t => t.text), ['one', 'two']);
  assert(segments.every(t => t.final && !t.active));
  assert.equal(segments.at(-1).canonicalTurn.id, 'assistant-initial');
});

test('regeneration hides old segments and notes, selecting the original restores them', () => {
  const state = new ChatState(task);
  [text('one'), compact, text('two')].forEach((pi, i) => state.apply(frame(i + 1, pi)));
  state.apply({ seq: 4, type: 'TURN_VARIANT_START', data: { turnSeq: 0, variantId: 'v2' } });
  const visible = () => state.displayTurns.filter(t => !t.hidden);
  assert(!visible().some(t => t.role === 'note'));
  assert.equal(visible().filter(t => t.role === 'assistant').length, 1);
  state.apply({ seq: 5, type: 'TURN_VARIANT_SELECTED', data: { turnSeq: 0, variantId: 'initial' } });
  assert.deepEqual(visible().map(t => t.role), ['user', 'assistant', 'note', 'assistant']);
  assert(visible().filter(t => t.role === 'assistant').every(t => t.canonicalTurn.id === 'assistant-initial'));
});

test('backfilled complete exchange projects boundaries without changing the live sink', () => {
  const state = new ChatState(task, { seedInitial: false });
  state.apply({ seq: 10, type: 'USER_MESSAGE', message: 'new' });
  const sink = state.current;
  const older = state.prependOlder(task, [frame(1, text('one')), frame(2, compact), frame(3, text('two'))], true);
  assert.deepEqual(state.projectTurns(older).map(t => t.role), ['user', 'assistant', 'note', 'assistant']);
  assert.equal(state.current, sink);
  assert.equal(state.cursor, 10);
});

test('compaction during steering stays with the original message sink', () => {
  const state = new ChatState(task);
  state.apply(frame(1, { type: 'message_start', message: { role: 'assistant' } }));
  state.apply(frame(2, text('one')));
  const original = state.current;
  state.apply({ seq: 3, type: 'USER_MESSAGE', message: 'steer', data: { mode: 'steer' } });
  state.apply(frame(4, compact));
  state.apply(frame(5, text('two')));
  assert.equal(original.text, 'onetwo');
  assert.equal(state.current.text, '');
  const segments = state.displayTurns.filter(t => t.canonicalTurn === original);
  assert.deepEqual(segments.map(t => t.text), ['one', 'two']);
});
