import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { ChatState } from '../web/chat-state.mjs';

async function terminal(api, id) {
  for (let i = 0; i < 150; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Task did not finish');
}

test('multipart upload streams files into the task workspace and discards staging', { timeout: 20000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base, root } = fixture;
  const form = new FormData();
  form.append('files', new Blob([Buffer.from('привет upload\n')]), 'заметка.txt');
  form.append('files', new Blob([Buffer.from([0, 1, 2, 255, 0])]), 'data.bin');
  const response = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'x-taskbridge-upload': '1' }, body: form });
  assert.equal(response.status, 201, fixture.logs());
  const upload = await response.json();
  assert.equal(upload.files.length, 2);
  assert.equal(upload.files[0].name, 'заметка.txt');
  assert.equal(upload.files[0].size, Buffer.byteLength('привет upload\n'));
  assert.match(upload.token, /^[a-f0-9-]{36}$/);
  const created = await api('/api/tasks', {
    projectId: 'fixture', prompt: 'with upload',
    files: upload.files.map(file => ({ id: file.id })), uploadToken: upload.token
  });
  let task = null;
  for (let i = 0; i < 150; i++) {
    task = await api(`/api/tasks/${created.id}`);
    if (['SUCCEEDED', 'FAILED'].includes(task.status)) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(task.status, 'SUCCEEDED', fixture.logs());
  assert.equal(task.attachments.length, 2);
  assert.ok(task.attachments.every(file => file.path.startsWith('.taskbridge-input/')));
  const note = task.attachments.find(file => file.name === 'заметка.txt');
  const served = await fetch(`${base}/api/tasks/${created.id}/files/${note.id}`);
  assert.equal(Buffer.from(await served.arrayBuffer()).toString('utf8'), 'привет upload\n');
  // The staging directory is removed once the task owns the files.
  assert.deepEqual(await fs.readdir(path.join(root, 'data', 'uploads')).catch(() => []), []);
});

test('events requests are capped by server.maxEventsPerRequest', { timeout: 20000 }, async t => {
  const fixture = await startFixture(undefined, { server: { maxEventsPerRequest: 5 } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'cap' });
  let task = null;
  for (let i = 0; i < 150; i++) {
    task = await api(`/api/tasks/${created.id}`);
    if (['SUCCEEDED', 'FAILED'].includes(task.status)) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  // Count the real rows through a second connection to the same database.
  const store = new TaskStore(path.join(root, 'data'));
  const total = Number(store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE task_id = ?').get(created.id).n);
  store.close();
  assert.ok(total > 5, `expected more than 5 stored events, got ${total}`);
  const capped = await api(`/api/tasks/${created.id}/events?limit=0`);
  assert.ok(capped.length > 0 && capped.length <= 5, `capped length ${capped.length}`);
});

test('HTTP + Pi RPC: follow-up, history replay, SSE cursor, rejected send, compact, cancel, deletion', { timeout: 20000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'hello' });
  const id = created.id;
  let task = await terminal(api, id);
  assert.equal(task.status, 'SUCCEEDED', fixture.logs());
  assert.deepEqual(task.engine, { profileId: null, auto: false, reason: null });
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
  // The fixture project runs without a worktree, so both git actions must be refused.
  const info = await api('/api/info');
  assert.equal(info.engine.configured, false);
  await assert.rejects(api(`/api/tasks/${id}/apply`, {}), /worktree/);
  await assert.rejects(api(`/api/tasks/${id}/worktree`, undefined, 'DELETE'), /worktree/);
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
