import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ChatState } from '../web/chat-state.mjs';

const task = { id: 'large-compact', prompt: 'Public large-history test', status: 'RUNNING' };
function history(count) {
  const events = [];
  const add = pi => events.push({ taskId: task.id, seq: events.length + 1, type: 'PI_EVENT', data: { pi } });
  const text = delta => add({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
  add({ type: 'message_start', message: { role: 'assistant' } });
  text('before');
  let cut;
  for (let i = 0; i < count; i++) {
    if (i === count / 2) {
      add({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'before' }] } });
      add({ type: 'compaction_end', result: { summary: 'Public summary' } });
      cut = events.length;
      add({ type: 'message_start', message: { role: 'assistant' } });
      text('after');
    }
    add({ type: 'tool_execution_start', toolName: 'read', toolCallId: `t-${i}`, args: { path: 'sample.txt' } });
    add({ type: 'tool_execution_end', toolName: 'read', toolCallId: `t-${i}`, isError: false });
  }
  add({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'after' }] } });
  add({ type: 'agent_settled' });
  return { events, cut };
}
const normalized = state => state.displayTurns.map(item => ({ id: item.id, role: item.role, text: item.text, active: item.active, tools: item.tools?.map(t => [t.id, t.state]) }));

for (const count of [1000, 10000]) {
  test(`C14: ${count} tools retain order/state through compact and paginated reconstruction`, t => {
    const { events, cut } = history(count);
    const live = new ChatState(task);
    const started = performance.now();
    let maxProjectionMs = 0;
    for (const event of events) {
      live.apply(event);
      if (event.seq % 250 === 0) {
        const start = performance.now();
        void live.displayTurns;
        maxProjectionMs = Math.max(maxProjectionMs, performance.now() - start);
      }
    }
    const applyAndProjectionMs = performance.now() - started;
    const segments = live.displayTurns.filter(item => item.role === 'assistant');
    assert.deepEqual(segments.map(item => item.text), ['before', 'after']);
    assert.deepEqual(segments.map(item => item.tools.length), [count / 2, count / 2]);
    assert(segments.every(item => !item.active && item.tools.every(tool => tool.state === 'done')));
    assert.equal(new Set(segments.flatMap(item => item.tools.map(tool => tool.id))).size, count);
    assert.equal(live.turns.filter(item => item.role === 'assistant').length, 1);

    const tail = new ChatState(task, { seedInitial: false });
    events.slice(cut).forEach(event => tail.apply(event));
    tail.revealWindowStart(events[cut].seq);
    const backfillStart = performance.now();
    tail.prependOlder(task, events.slice(0, cut), true);
    const backfillMs = performance.now() - backfillStart;
    assert.deepEqual(normalized(tail), normalized(live));
    assert.equal(tail.windowEvents.length, 0);
    assert.equal(tail.current.id, 'assistant-initial');
    events.forEach(event => assert.equal(tail.apply(event), false));
    assert.equal(tail.tools.size, count);
    t.diagnostic(JSON.stringify({ tools: count, events: events.length, applyAndProjectionMs, maxProjectionMs, backfillMs }));
  });
}
