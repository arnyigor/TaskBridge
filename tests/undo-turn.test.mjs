import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';

async function fixture(t, status = 'FAILED') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-undo-test-'));
  const store = new TaskStore(root);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const manager = new TaskManager({ projects: [{ id: 'p', path: root, useWorktree: false }] }, root, store);
  const task = { id: 'a', createdAt: new Date().toISOString(), status, workspacePath: root, prompt: 'original', files: [], compaction: { count: 0 } };
  await store.create(task);
  manager.tasks.set('a', task);
  return { manager, store, task };
}

const at = () => ({ at: new Date().toISOString(), taskId: 'a' });

test('undoLastTurn permanently removes the clean failed exchange', async t => {
  const { manager, store } = await fixture(t);
  await store.appendEvent('a', { ...at(), type: 'USER_MESSAGE', message: 'сделай', data: { text: 'сделай' } });
  await store.appendEvent('a', { ...at(), type: 'STATUS', message: 'Running', data: { status: 'RUNNING' } });
  await store.appendEvent('a', { ...at(), type: 'TASK_FAILED', message: 'boom', data: { errorCode: 'MODEL_ERROR' } });

  const result = await manager.undoLastTurn('a');
  assert.deepEqual(result, { ok: true, text: 'сделай', fromSeq: 1, dropInitial: false });

  const events = await store.readEvents('a', 0);
  assert.equal(events.some(e => e.type === 'USER_MESSAGE'), false, 'the message is gone from history');
  assert.ok(events.some(e => e.type === 'TURN_TRUNCATED'), 'a live marker notifies SSE clients');
  assert.equal(events.at(-1).data.fromSeq, 1);
  assert.equal(events.at(-1).data.text, 'сделай');

  // Nothing left to retract: no second USER_MESSAGE may ever be removed.
  await assert.rejects(() => manager.undoLastTurn('a'), err => err.code === 'NOT_ALLOWED');
});

test('undoLastTurn refuses when the model produced text or ran tools', async t => {
  const text = await fixture(t);
  await text.store.appendEvent('a', { ...at(), type: 'USER_MESSAGE', message: 'сделай', data: { text: 'сделай' } });
  await text.store.appendEvent('a', { ...at(), type: 'PI_EVENT', message: '', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'частичный ответ' } } } });
  await text.store.appendEvent('a', { ...at(), type: 'TASK_FAILED', message: 'boom', data: {} });
  await assert.rejects(() => text.manager.undoLastTurn('a'), err => err.code === 'NOT_ALLOWED');
  assert.ok((await text.store.readEvents('a', 0)).some(e => e.type === 'USER_MESSAGE'), 'history is untouched after a refusal');

  const tools = await fixture(t);
  await tools.store.appendEvent('a', { ...at(), type: 'USER_MESSAGE', message: 'сделай', data: { text: 'сделай' } });
  await tools.store.appendEvent('a', { ...at(), type: 'PI_EVENT', message: '', data: { pi: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' } } });
  await tools.store.appendEvent('a', { ...at(), type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} });
  await assert.rejects(() => tools.manager.undoLastTurn('a'), err => err.code === 'NOT_ALLOWED');
});

test('reasoning and an empty message_start do not block the retry', async t => {
  const { manager, store } = await fixture(t, 'CANCELLED');
  await store.appendEvent('a', { ...at(), type: 'USER_MESSAGE', message: 'сделай', data: { text: 'сделай' } });
  await store.appendEvent('a', { ...at(), type: 'PI_EVENT', message: '', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } });
  await store.appendEvent('a', { ...at(), type: 'PI_EVENT', message: '', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'думаю...' } } } });
  await store.appendEvent('a', { ...at(), type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} });
  const result = await manager.undoLastTurn('a');
  assert.equal(result.text, 'сделай');
  assert.equal(result.dropInitial, false);
});

test('undoLastTurn refuses a succeeded or still-active session', async t => {
  const ok = await fixture(t, 'FAILED');
  await ok.store.appendEvent('a', { ...at(), type: 'USER_MESSAGE', message: 'сделай', data: { text: 'сделай' } });
  await ok.store.appendEvent('a', { ...at(), type: 'TASK_SUCCEEDED', message: 'Done', data: {} });
  await assert.rejects(() => ok.manager.undoLastTurn('a'), err => err.code === 'NOT_ALLOWED');

  const active = await fixture(t, 'RUNNING');
  await active.store.appendEvent('a', { ...at(), type: 'USER_MESSAGE', message: 'сделай', data: { text: 'сделай' } });
  await assert.rejects(() => active.manager.undoLastTurn('a'), err => err.code === 'NOT_ALLOWED');
});

test('undoLastTurn can retract the very first prompt of a session', async t => {
  const { manager, store, task } = await fixture(t, 'CANCELLED');
  // A cancel right after the first frame: no USER_MESSAGE exists at all.
  await store.appendEvent('a', { ...at(), type: 'PI_EVENT', message: '', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } });
  await store.appendEvent('a', { ...at(), type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} });
  const result = await manager.undoLastTurn('a');
  assert.deepEqual(result, { ok: true, text: 'original', fromSeq: 1, dropInitial: true });
  const events = await store.readEvents('a', 0);
  assert.equal(events.length, 1, 'only the marker is left');
  assert.equal(events[0].type, 'TURN_TRUNCATED');
  assert.equal(events[0].data.dropInitial, true);
  assert.equal(manager.getTask('a').prompt, task.prompt, 'the session keeps its identity');
});

test('truncateEvents keeps everything before the cursor', async t => {
  const { store } = await fixture(t);
  for (let seq = 1; seq <= 3; seq++) await store.appendEvent('a', { ...at(), type: 'TASK_QUEUED', message: String(seq) });
  await store.truncateEvents('a', 2);
  const events = await store.readEvents('a', 0);
  assert.deepEqual(events.map(e => e.seq), [1]);
  // The next append continues from the truncated position; the first one is
  // always the TURN_TRUNCATED marker (undoLastTurn), so live SSE cursors
  // never skip over a re-used seq.
  await store.appendEvent('a', { ...at(), type: 'TASK_QUEUED', message: 'next' });
  assert.equal((await store.readEvents('a', 0)).at(-1).seq, 2);
  await assert.rejects(() => store.truncateEvents('a', 0), err => err.code === 'INPUT_INVALID');
});

test('deleteTurns drops the chosen message and everything after it', async t => {
  const { manager, store } = await fixture(t, 'SUCCEEDED');
  await store.appendEvent('a', { ...at(), type: 'USER_MESSAGE', message: 'уточнение', data: { text: 'уточнение' } });
  await store.appendEvent('a', { ...at(), type: 'TASK_SUCCEEDED', message: 'Done', data: {} });

  const result = await manager.deleteTurns('a', 'user-1');
  assert.deepEqual(result, { ok: true, fromSeq: 1, dropInitial: false });
  const events = await store.readEvents('a', 0);
  assert.equal(events.length, 1, 'only the marker is left');
  assert.equal(events[0].type, 'TURN_TRUNCATED');
  assert.equal(events[0].data.reason, 'delete');

  await assert.rejects(() => manager.deleteTurns('a', 'user-9'), err => err.code === 'NOT_FOUND');
  await assert.rejects(() => manager.deleteTurns('a', 'assistant-1'), err => err.code === 'INPUT_INVALID');
});

test('deleteTurns can drop the whole first exchange', async t => {
  const { manager, store } = await fixture(t, 'CANCELLED');
  await store.appendEvent('a', { ...at(), type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} });
  const result = await manager.deleteTurns('a', 'user-initial');
  assert.deepEqual(result, { ok: true, fromSeq: 1, dropInitial: true });
  assert.equal((await store.readEvents('a', 0))[0].data.dropInitial, true);
});

test('history mutations are refused while the session works', async t => {
  const { manager, store } = await fixture(t, 'RUNNING');
  await store.appendEvent('a', { ...at(), type: 'USER_MESSAGE', message: 'уточнение', data: { text: 'уточнение' } });
  await assert.rejects(() => manager.deleteTurns('a', 'user-1'), err => err.code === 'NOT_ALLOWED');
  await assert.rejects(() => manager.editTurn('a', { turnId: 'user-1', text: 'правка' }), err => err.code === 'NOT_ALLOWED');
  assert.equal((await store.readEvents('a', 0)).length, 1, 'nothing was written');
});

test('a truncation marker keeps the cursor monotonic, so a live client still sees it', async t => {
  const { manager, store } = await fixture(t, 'SUCCEEDED');
  await store.appendEvent('a', { ...at(), type: 'USER_MESSAGE', message: 'вопрос', data: { text: 'вопрос' } });
  await store.appendEvent('a', { ...at(), type: 'PI_EVENT', message: '', data: { pi: { type: 'agent_settled' } } });
  const high = Math.max(...(await store.readEvents('a', 0)).map(e => e.seq));

  await manager.deleteTurns('a', 'user-1');

  const marker = (await store.readEvents('a', 0)).find(e => e.type === 'TURN_TRUNCATED');
  assert.equal(marker.seq, high + 1, 'the marker lands above every seq the client has seen');
  assert.deepEqual((await store.readEvents('a', 0, high)).map(e => e.type), ['TURN_TRUNCATED'], 'and `after=<cursor>` returns it');
});

test('editTurn refuses anything but a non-empty operator message', async t => {
  const { manager, store } = await fixture(t, 'SUCCEEDED');
  await store.appendEvent('a', { ...at(), type: 'USER_MESSAGE', message: 'опечатко', data: { text: 'опечатко' } });
  // An answer is re-run, not edited; and an edit always re-sends something.
  await assert.rejects(() => manager.editTurn('a', { turnId: 'assistant-1', text: 'x' }), err => err.code === 'INPUT_INVALID');
  await assert.rejects(() => manager.editTurn('a', { turnId: 'nope', text: 'x' }), err => err.code === 'INPUT_INVALID');
  await assert.rejects(() => manager.editTurn('a', { turnId: 'user-1', text: null }), err => err.code === 'INPUT_INVALID');
  await assert.rejects(() => manager.editTurn('a', { turnId: 'user-1', text: '   ' }), err => err.code === 'INPUT_INVALID');
  assert.equal((await store.readEvents('a', 0)).length, 1, 'nothing was written by any refusal');
});

test('forkTask branches the conversation through the chosen exchange and leaves the source alone', async t => {
  const { manager, store } = await fixture(t, 'SUCCEEDED');
  await store.appendEvent('a', { ...at(), type: 'USER_MESSAGE', message: 'второе', data: { text: 'второе' } });
  await store.appendEvent('a', { ...at(), type: 'TASK_SUCCEEDED', message: 'Done', data: {} });
  await store.appendEvent('a', { ...at(), type: 'USER_MESSAGE', message: 'третье', data: { text: 'третье' } });
  await store.appendEvent('a', { ...at(), type: 'TASK_SUCCEEDED', message: 'Done', data: {} });

  const source = await store.readEvents('a', 0);
  const second = source.find(e => e.type === 'USER_MESSAGE' && e.data.text === 'второе');
  const third = source.find(e => e.type === 'USER_MESSAGE' && e.data.text === 'третье');
  const forked = await manager.forkTask('a', `user-${second.seq}`);

  assert.equal(forked.forkedFrom, 'a');
  assert.equal(forked.status, 'SUCCEEDED');
  assert.notEqual(forked.id, 'a');

  // The branch stops at the end of the chosen exchange, so it never carries a
  // question nobody has asked yet — and every copied event names the new session.
  const expected = source.filter(e => e.seq < third.seq);
  const copied = await store.readEvents(forked.id, 0);
  assert.equal(copied.at(-1).type, 'TASK_FORKED');
  assert.deepEqual(
    copied.slice(0, expected.length).map(e => `${e.type}|${JSON.stringify(e.data)}`),
    expected.map(e => `${e.type}|${JSON.stringify(e.data)}`)
  );
  assert.ok(copied.every(e => e.taskId === forked.id), 'the copy belongs to the new session');
  assert.deepEqual((await store.readEvents('a', 0)).map(e => e.seq), source.map(e => e.seq), 'the source is untouched');

  // Only an existing exchange can be a branch point — and both ends of that
  // exchange (the message and the answer) name the very same fork.
  await assert.rejects(() => manager.forkTask('a', 'nonsense'), err => err.code === 'INPUT_INVALID');
  await assert.rejects(() => manager.forkTask('a', 'user-999'), err => err.code === 'NOT_FOUND');
  const fromAnswer = await manager.forkTask('a', `assistant-${second.seq}`);
  const answerCopy = await store.readEvents(fromAnswer.id, 0);
  assert.deepEqual(
    answerCopy.slice(0, expected.length).map(e => `${e.type}|${JSON.stringify(e.data)}`),
    expected.map(e => `${e.type}|${JSON.stringify(e.data)}`)
  );
});
