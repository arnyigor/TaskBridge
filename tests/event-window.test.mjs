import test from 'node:test';
import assert from 'node:assert/strict';
import { windowByTurns, capEventsByBytes } from '../src/event-window.mjs';

const user = (seq) => ({ seq, type: 'USER_MESSAGE', message: `msg ${seq}` });
const other = (seq, type = 'STATUS') => ({ seq, type });

// Three turns: [user1, other, other], [user4, other], [user6, other, other]
const threeTurns = [user(1), other(2), other(3), user(4), other(5), user(6), other(7), other(8)];

test('fewer turns than requested returns everything and reachedStart', () => {
  const result = windowByTurns(threeTurns, 5);
  assert.deepEqual(result.events, threeTurns);
  assert.equal(result.reachedStart, true);
});

test('requesting exactly the available turn count still reachedStart (no earlier boundary to stop before)', () => {
  const result = windowByTurns(threeTurns, 3);
  assert.deepEqual(result.events, threeTurns);
  assert.equal(result.reachedStart, true);
});

test('requesting fewer turns than available cuts at a turn boundary, not reachedStart', () => {
  const result = windowByTurns(threeTurns, 2);
  assert.deepEqual(result.events.map(e => e.seq), [4, 5, 6, 7, 8]);
  assert.equal(result.reachedStart, false);
});

test('requesting 1 turn returns only the last turn', () => {
  const result = windowByTurns(threeTurns, 1);
  assert.deepEqual(result.events.map(e => e.seq), [6, 7, 8]);
  assert.equal(result.reachedStart, false);
});

test('before excludes events at or after that seq before windowing', () => {
  // Load the batch strictly before seq 6 (the last turn), asking for 1 turn.
  const result = windowByTurns(threeTurns, 1, 6);
  assert.deepEqual(result.events.map(e => e.seq), [4, 5]);
  assert.equal(result.reachedStart, false);
});

test('before combined with a large count reaches the start', () => {
  const result = windowByTurns(threeTurns, 10, 6);
  assert.deepEqual(result.events.map(e => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(result.reachedStart, true);
});

test('no count (0/undefined) returns the scoped events unwindowed, reachedStart true', () => {
  assert.deepEqual(windowByTurns(threeTurns, 0).events, threeTurns);
  assert.equal(windowByTurns(threeTurns, 0).reachedStart, true);
  assert.deepEqual(windowByTurns(threeTurns, undefined).events, threeTurns);
});

test('an events list with no USER_MESSAGE at all always reachedStart', () => {
  const events = [other(1), other(2), other(3)];
  const result = windowByTurns(events, 1);
  assert.deepEqual(result.events, events);
  assert.equal(result.reachedStart, true);
});

test('empty input', () => {
  assert.deepEqual(windowByTurns([], 5), { events: [], reachedStart: true });
});

test('capEventsByBytes bounds the payload by size, from the newest end', () => {
  const big = (size, count) => Array.from({ length: count }, (_, i) => ({ seq: i + 1, type: i % 3 === 0 ? 'USER_MESSAGE' : 'PI_EVENT', text: 'x'.repeat(size) }));
  const events = big(1000, 12);
  const capped = capEventsByBytes(events, 4000);
  assert.ok(capped.length > 0 && capped.length < events.length, `kept ${capped.length} of ${events.length}`);
  assert.equal(capped.at(-1), events.at(-1), 'the newest event is always kept');
  assert.deepEqual(capped, events.slice(events.length - capped.length), 'a contiguous tail');

  // A single event larger than the budget is still returned, so the chat shows
  // something instead of an empty page (the turn-alignment step must not clear
  // the only kept event).
  assert.equal(capEventsByBytes([{ seq: 1, type: 'PI_EVENT', text: 'x'.repeat(9000) }], 1000).length, 1);
  assert.equal(capEventsByBytes([user(1), other(2), { seq: 3, type: 'PI_EVENT', text: 'x'.repeat(90000) }], 1000).at(-1).seq, 3);
  // Under the budget, nothing is dropped.
  assert.equal(capEventsByBytes(events.slice(0, 1), 100000).length, 1);
});

test('a byte cut is re-aligned forward to the next turn boundary', () => {
  const events = [
    { seq: 1, type: 'PI_EVENT', text: 'x'.repeat(5000) },
    { seq: 2, type: 'PI_EVENT', text: 'lead' },
    { seq: 3, type: 'USER_MESSAGE', message: 'b' },
    { seq: 4, type: 'PI_EVENT', text: 'tail' }
  ];
  const capped = capEventsByBytes(events, 600);
  assert.equal(capped[0].type, 'USER_MESSAGE');
  assert.equal(capped[0].seq, 3);

  // When no boundary survives the cut, the slice is kept as-is: one event is
  // always kept, so the chat is never blank.
  const noBoundary = capEventsByBytes([user(1), { seq: 2, type: 'PI_EVENT', text: 'x'.repeat(5000) }], 100);
  assert.equal(noBoundary.length, 1);
  assert.equal(noBoundary[0].seq, 2);

  // No cut (the whole window fits): a first turn that has no USER_MESSAGE of its
  // own must be returned untouched, not dropped by the re-alignment.
  const uncut = [other(1), other(2), user(3), other(4)];
  assert.deepEqual(capEventsByBytes(uncut, 100000), uncut);
});

// A session driven by tool calls has a USER_MESSAGE only for the prompts sent to
// it, so the cut has to align on Pi's own frames as well: otherwise the page is
// served mid-message and the client shows it as a torn «Часть истории» piece.
test('a byte cut with no USER_MESSAGE re-aligns forward to the next message or turn start', () => {
  const frame = (seq, type) => ({ seq, type: 'PI_EVENT', data: { pi: { type } } });
  const events = [
    frame(1, 'message_start'),
    { seq: 2, type: 'PI_EVENT', text: 'x'.repeat(5000) },
    frame(3, 'message_start'),
    frame(4, 'tool_execution_start'),
    frame(5, 'message_end')
  ];
  // budget 400 keeps [3, 4, 5]: the slice opens on the tail of an earlier turn,
  // so it must advance to the message_start at seq 3.
  assert.deepEqual(capEventsByBytes(events, 400).map(e => e.seq), [3, 4, 5]);
  // The same for turn_start, which Pi emits before the first message of a turn.
  const turns = [
    frame(1, 'turn_start'),
    { seq: 2, type: 'PI_EVENT', text: 'x'.repeat(5000) },
    frame(3, 'turn_start'),
    frame(4, 'message_start')
  ];
  assert.deepEqual(capEventsByBytes(turns, 400).map(e => e.seq), [3, 4]);
  // A mid-message delta is not a boundary: nothing survives the cut, so the
  // newest events are kept as they are rather than dropped.
  const deltas = [
    frame(1, 'message_start'),
    { seq: 2, type: 'PI_EVENT', text: 'x'.repeat(5000) },
    frame(3, 'message_update'),
    frame(4, 'message_update')
  ];
  assert.deepEqual(capEventsByBytes(deltas, 400).map(e => e.seq), [3, 4]);
});
