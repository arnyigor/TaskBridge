import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { ChatState, ACTIVE_STATUSES } from '../web/chat-state.mjs';

const task = (id = 'a') => ({ id, prompt: 'Первый вопрос', status: 'SUCCEEDED', assistantText: 'Первый ответВторой ответ', thinkingText: '', model: { contextWindow: 65536 }, lastUsage: { totalTokens: 13081 } });
function history(id = 'a') {
  const frames = [
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Первый ответ' } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Первый ответ' }] } },
    { type: 'agent_settled' },
    { user: 'Второй вопрос' },
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Второй ответ' } },
    { type: 'tool_execution_start', toolCallId: 'tool1', toolName: 'bash', args: { command: 'echo hello' } },
    { type: 'tool_execution_end', toolCallId: 'tool1', toolName: 'bash', isError: false },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Второй ответ' }] } },
    { type: 'agent_settled' },
  ];
  return frames.map((frame, i) => ({ taskId: id, seq: i + 1, type: frame.user ? 'USER_MESSAGE' : 'PI_EVENT', message: frame.user || frame.type, data: frame.user ? { files: [{ name: 'photo.png' }] } : { pi: frame } }));
}

test('multi-turn replay, duplicate delivery and terminal status preserve exact answers', () => {
  const state = new ChatState(task());
  const events = history();
  for (const event of [...events, ...events]) state.apply(event);
  state.snapshot(task(), true);
  const bots = state.turns.filter(x => x.role === 'assistant');
  assert.deepEqual(bots.map(x => x.text), ['Первый ответ', 'Второй ответ']);
  assert.ok(bots.every(x => !x.active));
  assert.equal(bots[1].tools.length, 1);
  assert.equal(bots[1].tools[0].label, 'echo hello');
  assert.equal(bots[1].tools[0].state, 'done');
  assert.equal(state.turns[2].files[0].name, 'photo.png');
});

test('completed empty/cancelled replies and unfinished tools stop animating', () => {
  const state = new ChatState(task());
  state.apply({ seq: 1, type: 'PI_EVENT', data: { pi: { type: 'tool_execution_start', toolName: 'read', toolCallId: 'x' } } });
  state.snapshot({ ...task(), status: 'CANCELLED' }, true);
  assert.equal(state.current.active, false);
  assert.equal(state.current.tools[0].state, 'interrupted');
});

test('parallel tools finish by call id, including error-named successful paths', () => {
  const state = new ChatState(task());
  for (const [i, frame] of [
    { type: 'tool_execution_start', toolName: 'read', toolCallId: 'a', args: { path: 'error.png' } },
    { type: 'tool_execution_start', toolName: 'read', toolCallId: 'b' },
    { type: 'tool_execution_end', toolName: 'read', toolCallId: 'a', isError: false },
    { type: 'tool_execution_end', toolName: 'read', toolCallId: 'b', isError: true },
  ].entries()) state.apply({ seq: i + 1, type: 'PI_EVENT', data: { pi: frame } });
  assert.deepEqual(state.current.tools.map(x => x.state), ['done', 'error']);
});

test('steering during a message does not move its remaining text into the next reply', () => {
  const state = new ChatState(task());
  for (const event of history().slice(0, 2)) state.apply(event);
  state.apply({ seq: 3, type: 'USER_MESSAGE', message: 'Уточнение' });
  state.apply({ seq: 4, type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '!' } } } });
  assert.equal(state.turns[1].text, 'Первый ответ!');
  assert.equal(state.current.text, '');
});

async function ui() {
  const { document, window } = parseHTML(await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8'));
  const intervals = [];
  const streams = [];
  const tasks = { a: task('a'), b: { ...task('b'), prompt: 'Другой чат' } };
  let fetchHook;
  const context = vm.createContext({ document, window, console, ChatState, ACTIVE_STATUSES,
    setTimeout, clearTimeout, setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    EventSource: class { constructor(url) { this.url = url; streams.push(this); } close() { this.closed = true; } },
    fetch: async (url, options) => {
      if (fetchHook) { const intercepted = await fetchHook(url, options); if (intercepted) return intercepted; }
      const path = new URL(url, 'http://localhost');
      let body;
      if (path.pathname === '/api/tasks') body = Object.values(tasks);
      else if (path.pathname.endsWith('/events')) body = history(path.pathname.split('/')[3]).filter(x => x.seq > Number(path.searchParams.get('after') || 0));
      else if (path.pathname.endsWith('/artifacts')) body = [];
      else body = tasks[path.pathname.split('/')[3]];
      return { ok: true, json: async () => body };
    }, alert() {}, confirm: () => true,
    marked: { setOptions() {}, parse: text => text },
    DOMPurify: { sanitize: html => html },
  });
  const app = (await fs.readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/^import [^\n]*\n/gm, '').replace(/init\(\);\s*$/, '');
  vm.runInContext(app + '\nthis.testing = {selectTask, refreshTask, startNewTask, sendContinueMessage};', context);
  return { ...context.testing, document, streams, tasks, setFetchHook: hook => { fetchHook = hook; } };
}

test('DOM: saved answers survive repeated polls, context loads immediately, reconnect is deduplicated', async () => {
  const app = await ui();
  await app.selectTask('a');
  const text = app.document.getElementById('msgsInner').textContent;
  assert.match(text, /Первый ответ/);
  assert.match(text, /Второй ответ/);
  assert.match(app.document.getElementById('usage').textContent, /20%/);
  await app.refreshTask();
  await app.refreshTask();
  for (const event of history()) app.streams[0].onmessage({ data: JSON.stringify(event) });
  assert.equal(app.document.getElementById('msgsInner').textContent, text);
  assert.equal(app.document.querySelectorAll('.typing').length, 0);
  assert.equal(app.document.querySelectorAll('.tool').length, 1);
  assert.match(app.streams[0].url, /after=12$/);
});

test('DOM: a slow history response cannot replace a newer selected chat', async () => {
  const app = await ui();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  app.setFetchHook(async url => { if (url.includes('/a/events')) await gate; });
  const first = app.selectTask('a');
  await app.selectTask('b');
  release();
  await first;
  assert.equal(app.document.getElementById('taskTitle').textContent, 'b');
  assert.equal(app.streams.length, 1);
  assert.match(app.streams[0].url, /\/b\/stream/);
});

test('DOM: late poll and late stream cannot revive a chat after New session', async () => {
  const app = await ui();
  await app.selectTask('a');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  app.setFetchHook(async url => { if (url === '/api/tasks/a') await gate; });
  const poll = app.refreshTask();
  app.startNewTask();
  release();
  await poll;
  app.streams[0].onmessage({ data: JSON.stringify(history()[0]) });
  assert.ok(app.document.getElementById('emptyState'));
  assert.equal(app.document.querySelectorAll('.turn').length, 0);
});
