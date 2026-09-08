import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';
import { ChatState } from '../web/chat-state.mjs';

async function terminal(api, id) {
  for (let i = 0; i < 150; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Task did not finish');
}

test('HTTP + Pi RPC: follow-up, history replay, SSE cursor, rejected send, compact, cancel, deletion', { timeout: 20000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'hello' });
  const id = created.id;
  let task = await terminal(api, id);
  assert.equal(task.status, 'SUCCEEDED', fixture.logs());
  assert.equal(task.lastUsage.totalTokens, 1100);
  await api(`/api/tasks/${id}/message`, { text: 'continue', files: [{ name: 'sample.txt', size: 1, base64: 'eA==' }] });
  task = await terminal(api, id);
  assert.equal(task.status, 'SUCCEEDED');
  const events = await api(`/api/tasks/${id}/events?limit=0`);
  const state = new ChatState(task);
  for (const event of events) state.apply(event);
  state.snapshot(task);
  assert.deepEqual(state.turns.filter(x => x.role === 'assistant').map(x => x.text), ['Ответ 1', 'Ответ 2']);
  assert.equal(state.turns[2].files[0].name, 'sample.txt');
  assert.equal(state.current.active, false);
  // Restart with no live runtime: import complete persisted events into Pi, keep
  // the same TaskBridge id and include the prior turns in the resumed process.
  await fixture.restart();
  await api(`/api/tasks/${id}/message`, { text: 'after restart' });
  task = await terminal(api, id);
  assert.equal(task.status, 'SUCCEEDED');
  assert.match(task.assistantText, /Ответ 3$/);
  assert.ok((await api(`/api/tasks/${id}/state`)).state.messageCount >= 6);
  assert.equal((await api('/api/tasks')).length, 1);
  // The next restart uses the native session file (including the new turn).
  await fixture.restart();
  await api(`/api/tasks/${id}/message`, { text: 'after second restart' });
  task = await terminal(api, id);
  assert.match(task.assistantText, /Ответ 4$/);
  const resumedEvents = await api(`/api/tasks/${id}/events?limit=0`);
  const lastSeq = resumedEvents.at(-1).seq;
  assert.deepEqual(await api(`/api/tasks/${id}/events?limit=0&after=${lastSeq}`), []);
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/tasks/${id}/stream?after=0`, { headers: { 'Last-Event-ID': String(lastSeq - 1) }, signal: controller.signal });
  const reader = stream.body.getReader();
  let received = '';
  while (!received.includes('\ndata:')) received += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  const replay = received.split('\n').filter(x => x.startsWith('data:')).map(x => JSON.parse(x.slice(5)));
  assert.deepEqual(replay.map(x => x.seq), [lastSeq]);
  await assert.rejects(api(`/api/tasks/${id}/message`, { text: 'reject' }), /Fixture rejected/);
  assert.equal((await api(`/api/tasks/${id}/events?limit=0`)).filter(x => x.type === 'USER_MESSAGE').length, 3);
  await api(`/api/tasks/${id}/auto-compaction`, { enabled: false });
  assert.equal((await api(`/api/tasks/${id}`)).autoCompactionEnabled, false);
  await api(`/api/tasks/${id}/compact`, {});
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await api(`/api/tasks/${id}`)).compaction.count, 1);
  await api(`/api/tasks/${id}/message`, { text: 'slow' });
  await api(`/api/tasks/${id}/cancel`, {});
  task = await terminal(api, id);
  assert.equal(task.status, 'CANCELLED');
  const cancelledEvents = await api(`/api/tasks/${id}/events?limit=0`);
  assert.equal(cancelledEvents.filter(x => x.type === 'TASK_CANCELLED').length, 1);
  // A failed model response must never be reported as successful verification.
  await api(`/api/tasks/${id}/message`, { text: 'model-error' });
  task = await terminal(api, id);
  assert.equal(task.status, 'FAILED');
  assert.equal(task.errorCode, 'MODEL_ERROR');
  await api(`/api/tasks/${id}`, undefined, 'DELETE');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal((await api('/api/tasks')).length, 0);
});
