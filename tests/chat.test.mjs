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

test('seedInitial:false starts with no synthetic first turn, and the first real USER_MESSAGE bootstraps current', () => {
  const state = new ChatState(task(), { seedInitial: false });
  assert.deepEqual(state.turns, []);
  const events = history();
  for (const event of events.slice(4)) state.apply(event); // starts at the seq-5 USER_MESSAGE boundary
  assert.equal(state.turns[0].role, 'user');
  assert.equal(state.turns[0].text, 'Второй вопрос');
  const bots = state.turns.filter(x => x.role === 'assistant');
  assert.deepEqual(bots.map(x => x.text), ['Второй ответ']);
});

test('prependOlder splices reconstructed older turns onto the front without touching live tail state', () => {
  const events = history();
  const tail = new ChatState(task(), { seedInitial: false });
  for (const event of events.slice(4)) tail.apply(event);
  const liveTurnBefore = tail.current;
  const cursorBefore = tail.cursor;

  const prepended = tail.prependOlder(task(), events.slice(0, 4), true);

  assert.equal(prepended.length, 2);
  assert.equal(tail.turns.length, 4); // [older user, older bot, newer user, newer bot]
  assert.equal(tail.turns[0].role, 'user');
  assert.equal(tail.turns[0].text, 'Первый вопрос');
  assert.equal(tail.turns[1].text, 'Первый ответ');
  assert.equal(tail.turns[2].text, 'Второй вопрос');
  assert.equal(tail.turns[3].text, 'Второй ответ');
  // Prepending older history must never disturb the reducer's idea of "now".
  assert.equal(tail.current, liveTurnBefore);
  assert.equal(tail.cursor, cursorBefore);

  // A genuinely new live event afterward still lands on the same
  // (already-known) live turn, proving prepend didn't fork reducer state.
  tail.apply({ taskId: 'a', seq: 13, type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '!' } } } });
  assert.equal(tail.turns[3].text, 'Второй ответ!');
});

test('prependOlder with reachedStart:false does not synthesize a task.prompt turn', () => {
  // A batch that itself starts at a real USER_MESSAGE boundary (as
  // windowByTurns always guarantees for reachedStart:false) must not get a
  // synthetic task.prompt turn prepended ahead of it.
  const events = history();
  const state = new ChatState(task(), { seedInitial: false });
  state.prependOlder(task(), events.slice(4), false);
  assert.equal(state.turns[0].text, 'Второй вопрос');
  assert.equal(state.turns.filter(x => x.text === task().prompt).length, 0);
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

async function ui({ coarsePointer = false } = {}) {
  const { document, window } = parseHTML(await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8'));
  window.matchMedia = () => ({ matches: coarsePointer }); // desktop (fine pointer) unless a test opts in
  const intervals = [];
  const streams = [];
  const tasks = { a: task('a'), b: { ...task('b'), prompt: 'Другой чат' } };
  let fetchHook;
  const context = vm.createContext({ document, window, console, ChatState, ACTIVE_STATUSES,
    setTimeout, clearTimeout, setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    EventSource: class { constructor(url) { this.url = url; streams.push(this); } close() { this.closed = true; } },
    DataTransfer: class { items = { add: (file) => this.files.push(file) }; files = []; },
    fetch: async (url, options) => {
      if (fetchHook) { const intercepted = await fetchHook(url, options); if (intercepted) return intercepted; }
      const path = new URL(url, 'http://localhost');
      let body;
      if (path.pathname === '/api/tasks') body = Object.values(tasks);
      else if (path.pathname.endsWith('/events')) {
        const all = history(path.pathname.split('/')[3]).filter(x => x.seq > Number(path.searchParams.get('after') || 0));
        // The fixture's history is small enough to always fit in one page,
        // so a tail request always "reaches start" — real pagination is
        // covered separately in tests/event-window.test.mjs and the
        // prependOlder tests above.
        body = path.searchParams.has('tail') ? { events: all, reachedStart: true } : all;
      }
      else if (path.pathname.endsWith('/artifacts')) body = [];
      else body = tasks[path.pathname.split('/')[3]];
      return { ok: true, json: async () => body };
    }, alert() {}, confirm: () => true,
    marked: { setOptions() {}, parse: text => text },
    DOMPurify: { sanitize: html => html },
  });
  const app = (await fs.readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/^import [^\n]*\n/gm, '').replace(/init\(\);\s*$/, '');
  vm.runInContext(app + '\nthis.testing = {selectTask, refreshTask, startNewTask, sendContinueMessage, openImport, refreshImportSuggestion};', context);
  return { ...context.testing, document, window, streams, tasks, setFetchHook: hook => { fetchHook = hook; } };
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
  assert.equal(app.document.getElementById('taskTitle').textContent, 'Другой чат');
  assert.equal(app.streams.length, 1);
  assert.match(app.streams[0].url, /\/b\/stream/);
});

test('DOM: Enter submits on desktop but only inserts a newline on touch devices', async () => {
  for (const coarsePointer of [false, true]) {
    const app = await ui({ coarsePointer });
    const form = app.document.getElementById('form');
    let submitted = 0;
    form.requestSubmit = () => { submitted += 1; };
    const prompt = app.document.getElementById('prompt');
    const event = new app.window.Event('keydown');
    event.key = 'Enter';
    event.shiftKey = false;
    event.isComposing = false;
    prompt.dispatchEvent(event);
    assert.equal(submitted, coarsePointer ? 0 : 1, `coarsePointer=${coarsePointer}`);
  }
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

test('DOM: the Pi importer groups sessions by project, previews one and imports a copy', async () => {
  const app = await ui();
  const calls = [];
  const now = new Date().toISOString();
  const key = 'k'.repeat(64);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  app.setFetchHook(async (url, options = {}) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    if (pathname === '/api/native-sessions') {
      return { ok: true, json: async () => ([{
        id: 'fixture', name: 'Тестовый проект', path: 'G:/Projects/TaskBridge',
        sessions: [{ key, name: 'TaskBridge architecture', mtime: now, preview: 'Начни с SessionManager', existingTaskId: null }],
        suggestion: { key, name: 'TaskBridge architecture', mtime: now, preview: 'Начни с SessionManager' }
      }]) };
    }
    if (pathname === '/api/native-sessions/preview') {
      calls.push({ route: pathname, projectId: searchParams.get('projectId'), key: searchParams.get('key') });
      return { ok: true, json: async () => ({ projectId: 'fixture', key, name: 'TaskBridge architecture', mtime: now,
        projectPath: 'G:/Projects/TaskBridge', model: { provider: 'llamacpp', id: 'qwen3.8-27b' }, thinkingLevel: 'medium',
        messageCount: 146, tokens: 48921, lastUser: 'не обязательно именно в терминале', lastAssistant: 'Да, тогда архитектуру', existingTaskId: null }) };
    }
    if (pathname === '/api/tasks/from-session') {
      calls.push({ route: pathname, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ id: 'imported', prompt: 'Начни', status: 'SUCCEEDED' }) };
    }
    return null; // everything else goes to the default stub
  });

  const doc = app.document;
  // linkedom implements neither select.value nor oninput/onchange, so values are
  // pinned and events dispatched explicitly.
  const pin = (el, value) => Object.defineProperty(el, 'value', { value, writable: true, configurable: true });
  const fire = (el, type) => el.dispatchEvent(new app.window.Event(type));

  // A freshly updated terminal session is offered for the project in view.
  pin(doc.getElementById('project'), 'fixture');
  await app.refreshImportSuggestion(true);
  const banner = doc.getElementById('piSessionSuggestion');
  assert.equal(banner.classList.contains('hidden'), false);
  assert.match(banner.textContent, /TaskBridge architecture/);

  // The list is grouped by project and searchable.
  doc.getElementById('resumeSessionButton').onclick();
  await settle();
  assert.equal(doc.getElementById('importOverlay').classList.contains('hidden'), false);
  assert.match(doc.getElementById('importList').textContent, /Тестовый проект/);
  assert.match(doc.getElementById('importList').textContent, /Начни с SessionManager/);
  pin(doc.getElementById('importSearch'), 'нет-такого');
  fire(doc.getElementById('importSearch'), 'input');
  assert.match(doc.getElementById('importList').textContent, /Ничего не найдено/);
  pin(doc.getElementById('importSearch'), '');
  fire(doc.getElementById('importSearch'), 'input');

  // Choosing a session previews the real conversation before writing anything.
  doc.querySelector('#importList .sessionPickerItem').onclick();
  await settle();
  const preview = doc.getElementById('importPreview').textContent;
  assert.match(preview, /llamacpp\/qwen3.8-27b/);
  assert.match(preview, /48.921/);
  assert.match(preview, /не обязательно именно в терминале/);
  assert.deepEqual(calls.filter(call => call.route === '/api/native-sessions/preview'), [{ route: '/api/native-sessions/preview', projectId: 'fixture', key }]);
  assert.equal(calls.some(call => call.route === '/api/tasks/from-session'), false, 'nothing is imported before the confirmation');

  // Confirming imports a safe copy: clone mode, no closed-terminal confirmation.
  const confirmButton = [...doc.querySelectorAll('#importPreview button')]
    .find(button => /Продолжить в TaskBridge/.test(button.textContent));
  assert.ok(confirmButton, `no confirm button in: ${preview}`);
  confirmButton.onclick();
  await settle();
  const importCall = calls.find(call => call.route === '/api/tasks/from-session');
  assert.deepEqual(importCall.body, { projectId: 'fixture', sessionKey: key, mode: 'clone' });
  assert.equal(doc.getElementById('importOverlay').classList.contains('hidden'), true);
});

test('DOM: take-over mode warns and requires the explicit closed-terminal confirmation', async () => {
  const app = await ui();
  const calls = [];
  const now = new Date().toISOString();
  const key = 't'.repeat(64);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  app.setFetchHook(async (url, options = {}) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (pathname === '/api/native-sessions') {
      return { ok: true, json: async () => ([{ id: 'fixture', name: 'P', path: 'G:/p', suggestion: null,
        sessions: [{ key, name: 'Session', mtime: now, preview: 'hi', existingTaskId: null }] }]) };
    }
    if (pathname === '/api/native-sessions/preview') {
      return { ok: true, json: async () => ({ projectId: 'fixture', key, name: 'Session', mtime: now, projectPath: 'G:/p',
        model: null, thinkingLevel: null, messageCount: 2, tokens: null, lastUser: 'hi', lastAssistant: 'hey', existingTaskId: null }) };
    }
    if (pathname === '/api/tasks/from-session') {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: 'imported', status: 'SUCCEEDED' }) };
    }
    return null;
  });

  const doc = app.document;
  const pin = (el, value) => Object.defineProperty(el, 'value', { value, writable: true, configurable: true });
  const fire = (el, type) => el.dispatchEvent(new app.window.Event(type));
  // linkedom implements neither select.value nor onchange, so pin and dispatch.
  pin(doc.getElementById('importMode'), 'take-over');
  fire(doc.getElementById('importMode'), 'change');
  doc.getElementById('resumeSessionButton').onclick();
  await settle();
  doc.querySelector('#importList .sessionPickerItem').onclick();
  await settle();
  assert.match(doc.getElementById('importPreview').textContent, /не открывайте её одновременно в терминальном Pi/i);

  const confirmButton = [...doc.querySelectorAll('#importPreview button')]
    .find(button => /Продолжить в TaskBridge/.test(button.textContent));
  confirmButton.onclick();
  await settle();
  assert.deepEqual(calls, [{ projectId: 'fixture', sessionKey: key, mode: 'take-over', confirmedClosed: true }]);
});
