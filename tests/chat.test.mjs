import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { ChatState, ACTIVE_STATUSES } from '../web/chat-state.mjs';
import * as transportModule from '../web/transport.mjs';

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

// app.js is a module in the browser; the harness runs it as a script, so the
// names it imports are resolved from the real modules — and only those. A name
// used without an import throws here, exactly as it would in the browser.
function resolveImports(source, modules) {
  const names = {};
  const pattern = /^import\s+(.+?)\s+from\s+'([^']+)';?$/gm;
  for (const match of source.matchAll(pattern)) {
    const clause = match[1];
    const module = modules[match[2]];
    if (!module) throw new Error(`app.js imports an unknown module: ${match[2]}`);
    const braced = clause.match(/{([^}]*)}/);
    if (braced) {
      for (const raw of braced[1].split(',')) {
        const name = raw.trim();
        if (!name) continue;
        if (!(name in module)) throw new Error(`app.js imports ${name}, which ${match[2]} does not export`);
        names[name] = module[name];
      }
    }
    const defaultName = clause.replace(/{[^}]*}/, '').replace(/,/g, '').trim();
    if (defaultName) {
      if (!('default' in module)) throw new Error(`${match[2]} has no default export`);
      names[defaultName] = module.default;
    }
  }
  return names;
}
class TestWebSocket {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    sockets.push(this);
  }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.listeners.open?.(); }
  deliver(frame) { this.listeners.message?.({ data: JSON.stringify(frame) }); }
  drop() { this.readyState = 3; this.listeners.close?.(); }
}

async function ui({ coarsePointer = false, cloud = false } = {}) {
  const { document, window } = parseHTML(await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8'));
  window.matchMedia = () => ({ matches: coarsePointer }); // desktop (fine pointer) unless a test opts in
  const intervals = [];
  const streams = [];
  const copied = [];
  const sockets = [];
  const tasks = { a: task('a'), b: { ...task('b'), prompt: 'Другой чат' } };
  let fetchHook;
  // Sessions have their own address, so the app reads location and writes
  // history; linkedom provides neither.
  const urls = [];
  // Named *_stub to avoid shadowing this file's own history() event helper.
  const historyStub = {
    pushState: (state, title, url) => urls.push({ method: 'push', url }),
    replaceState: (state, title, url) => urls.push({ method: 'replace', url })
  };
  const locationStub = { pathname: '/', href: 'http://localhost/', hostname: cloud ? 'taskbridge.example.app' : 'localhost' };
  if (cloud) {
    globalThis.__taskbridgeTestCloud = { url: 'wss://relay.example.app/api/relay', machineId: 'home-pc', deviceToken: 'device-token' };
  }
  const appSource = await fs.readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const imported = resolveImports(appSource, {
    './chat-state.mjs': { ChatState, ACTIVE_STATUSES },
    './transport.mjs': transportModule,
    // app.js takes `marked` as a named import and DOMPurify as the default one.
    './vendor/marked.js': { marked: { setOptions() {}, parse: text => text } },
    './vendor/purify.mjs': { default: { sanitize: html => html } }
  });
  const context = vm.createContext({ document, window, console, URL, history: historyStub, location: locationStub,
    WebSocket: TestWebSocket,
    __TASKBRIDGE_CLOUD__: cloud ? globalThis.__taskbridgeTestCloud : undefined,
    ...imported,
    setTimeout, clearTimeout, setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    EventSource: class { constructor(url) { this.url = url; streams.push(this); } close() { this.closed = true; } },
    navigator: { clipboard: { writeText: async text => { copied.push(text); } } },
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
  });
  const app = appSource.replace(/^import [^\n]*\n/gm, '').replace(/init\(\);\s*$/, '');
  vm.runInContext(app + '\nthis.testing = {selectTask, refreshTask, startNewTask, sendContinueMessage, openImport, routeFromLocation, openSessionFromLocation, loadTasks, copySessionLink, transport, cloudMode, stopTarget, updateStopButton, setLastTasks: (list) => { lastTasks = list; }};', context);
  return { ...context.testing, document, window, streams, sockets, tasks, urls, copied, location: locationStub, setFetchHook: hook => { fetchHook = hook; } };
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

  // The list is grouped by project, searchable, and marks the session the user
  // has just left in the terminal.
  doc.getElementById('resumeSessionButton').onclick();
  await settle();
  assert.equal(doc.getElementById('importOverlay').classList.contains('hidden'), false);
  assert.match(doc.getElementById('importList').textContent, /Тестовый проект/);
  assert.match(doc.getElementById('importList').textContent, /Начни с SessionManager/);
  assert.match(doc.getElementById('importList').textContent, /только что из терминала/);
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

test('DOM: sessions carry their own address, and a deep link opens that session', async () => {
  const app = await ui();
  app.urls.length = 0;

  // Selecting a session writes its address into the URL.
  await app.selectTask('b');
  assert.deepEqual(app.urls, [{ method: 'push', url: '/session/b' }]);
  assert.match(app.document.getElementById('taskTitle').textContent, /Другой чат/);

  // A link opened later (reload, bookmark, phone) restores the same session.
  app.urls.length = 0;
  app.location.pathname = '/session/a';
  assert.equal(await app.routeFromLocation(), undefined);
  assert.match(app.document.getElementById('taskTitle').textContent, /Первый вопрос/);
  assert.deepEqual(app.urls, [], 'the address already matches the open session');

  // An address for a session that no longer exists falls back to the list
  // instead of leaving a dead URL behind.
  app.urls.length = 0;
  app.location.pathname = '/session/gone';
  assert.equal(await app.openSessionFromLocation([{ id: 'a' }, { id: 'b' }]), false);
  assert.deepEqual(app.urls, [{ method: 'replace', url: '/' }]);

  // "New session" returns to the list address.
  app.urls.length = 0;
  app.startNewTask();
  assert.deepEqual(app.urls, [{ method: 'push', url: '/' }]);
});

test('DOM: the sessions screen groups active and recent sessions and shares their link', async () => {
  const app = await ui();
  const doc = app.document;

  // Both fixture sessions are finished: everything lands under "Недавние".
  await app.loadTasks();
  assert.deepEqual([...doc.querySelectorAll('.taskGroup')].map(node => node.textContent), ['Недавние · 2']);

  // A running session moves to the top group with its model and relative time.
  app.tasks.a.status = 'RUNNING';
  app.tasks.a.model = { provider: 'llamacpp', id: 'qwen-27b-q3' };
  app.tasks.a.updatedAt = new Date().toISOString();
  await app.loadTasks();
  assert.deepEqual([...doc.querySelectorAll('.taskGroup')].map(node => node.textContent), ['Активные · 1', 'Недавние · 1']);
  const first = doc.querySelector('.taskRow');
  assert.equal(first.dataset.id, 'a');
  assert.match(first.textContent, /RUNNING/);
  assert.match(first.textContent, /llamacpp\/qwen-27b-q3/);
  assert.match(first.textContent, /только что|мин назад/);

  // Sharing hands over the session address, which is what a phone needs.
  await app.copySessionLink('a');
  assert.deepEqual(app.copied, [`http://localhost/session/a`]);
});

test('DOM: commands sit above the answer and below the reasoning block', async () => {
  const app = await ui();
  await app.selectTask('a');

  // Reasoning only appears once Pi streams thinking, so feed one delta and let
  // the normal refresh path render it.
  app.setFetchHook(async (url) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (!pathname.endsWith('/events')) return null;
    return { ok: true, json: async () => [...history('a'), { taskId: 'a', seq: 99, type: 'PI_EVENT',
      data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Сначала подумаю про SessionManager.' } } } }] };
  });
  await app.refreshTask();

  // The fixture's tool calls belong to the last assistant turn, which is also
  // where the injected thinking delta lands.
  const body = [...app.document.querySelectorAll('.turn .body')].filter(node => node.querySelector('.msg.s-bot')).at(-1);
  assert.ok(body, 'no assistant turn rendered');
  const children = [...body.children].map(node => node.className.split(' ').filter(Boolean).join(' '));
  const indexOf = kind => [...body.children].findIndex(node => node.classList.contains(kind));
  const reasoning = indexOf('reasoning');
  const tool = indexOf('tool');
  const answer = indexOf('msg');

  assert.ok(reasoning >= 0, `no reasoning block: ${children}`);
  assert.ok(tool >= 0, `no tool chips: ${children}`);
  assert.ok(answer >= 0, `no answer bubble: ${children}`);
  assert.ok(reasoning < tool, `reasoning must precede commands: ${children}`);
  assert.ok(tool < answer, `commands must precede the answer: ${children}`);
  // The answer stays readable without scrolling past a long tool list.
  assert.match(body.querySelector('.md').textContent, /Первый ответ|Второй ответ/);
});

test('DOM: a queued prompt is reported as queued, not as an error', async () => {
  const app = await ui();
  await app.loadTasks();

  // The sessions list marks the wait, so the reason is visible without opening
  // the session.
  app.tasks.a.status = 'QUEUED';
  app.tasks.a.queueReason = 'MODEL_BUSY';
  await app.loadTasks();
  assert.match(app.document.querySelector('.taskRow[data-id="a"]').textContent, /ждёт модель/);

  // Sending while the model is busy reports the queue instead of failing.
  app.setFetchHook(async (url) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (pathname.endsWith('/message')) {
      return { ok: true, json: async () => ({ id: 'a', status: 'QUEUED', queueReason: 'MODEL_BUSY' }) };
    }
    return null;
  });
  await app.selectTask('a');
  const prompt = app.document.getElementById('prompt');
  prompt.value = 'ещё вопрос';
  const form = app.document.getElementById('form');
  form.dispatchEvent(new app.window.Event('submit', { cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const status = app.document.getElementById('createError');
  assert.match(status.textContent, /в очереди/);
  assert.equal(status.classList.contains('error'), false, 'a queued prompt is not an error');
  assert.equal(prompt.value, '', 'the composer is cleared: the text is safe in the queue');
});

test('text after a tool round starts on a new line instead of being glued on', () => {
  const state = new ChatState(task());
  const frame = (seq, pi) => state.apply({ seq, type: 'PI_EVENT', data: { pi } });
  const assistant = text => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });

  frame(1, { type: 'agent_start' });
  frame(2, { type: 'message_start', message: { role: 'assistant' } });
  frame(3, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Сейчас проверю файл' } });
  frame(4, assistant('Сейчас проверю файл'));
  frame(5, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } });
  frame(6, { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: false });
  frame(7, { type: 'message_start', message: { role: 'assistant' } });
  frame(8, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Готово: файл создан' } });
  frame(9, assistant('Готово: файл создан'));

  // No leading break, and the continuation is its own paragraph.
  assert.equal(state.current.text, 'Сейчас проверю файл\n\nГотово: файл создан');
});

test('the new line appears even when the continuation arrives without message_end', () => {
  const state = new ChatState(task());
  const frame = (seq, pi) => state.apply({ seq, type: 'PI_EVENT', data: { pi } });
  frame(1, { type: 'message_start', message: { role: 'assistant' } });
  frame(2, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'первая часть' } });
  frame(3, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a.txt' } });
  frame(4, { type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', isError: false });
  frame(5, { type: 'message_start', message: { role: 'assistant' } });
  frame(6, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'вторая часть' } });
  assert.equal(state.current.text, 'первая часть\n\nвторая часть');
});

test('DOM: Ctrl+Enter asks for an immediate send, plain Enter accepts the queue', async () => {
  const app = await ui();
  // linkedom has no requestSubmit: make it perform a real submit event.
  const form = app.document.getElementById('form');
  form.requestSubmit = () => form.dispatchEvent(new app.window.Event('submit', { cancelable: true }));
  await app.selectTask('a');
  const bodies = [];
  app.setFetchHook(async (url, options = {}) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (pathname.endsWith('/message')) {
      bodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: 'a', status: 'RUNNING' }) };
    }
    return null;
  });

  const prompt = app.document.getElementById('prompt');
  const key = (ctrlKey) => {
    const event = new app.window.Event('keydown', { cancelable: true });
    event.key = 'Enter';
    event.shiftKey = false;
    event.isComposing = false;
    event.ctrlKey = ctrlKey;
    prompt.dispatchEvent(event);
  };
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

  const submit = async (text, ctrlKey) => {
    prompt.value = text;
    key(ctrlKey);
    await settle();
  };

  await submit('в очередь', false);
  await submit('срочно', true);

  assert.equal(bodies.length, 2, JSON.stringify(bodies));
  assert.equal(bodies[0].queue, true, 'Enter: take a place in the queue');
  assert.ok(!bodies[0].now, 'Enter does not skip the queue');
  assert.equal(bodies[1].now, true, 'Ctrl+Enter: send immediately');
  assert.ok(!bodies[1].queue, 'Ctrl+Enter does not queue');
  assert.equal(bodies[1].text, 'срочно');
});

test('DOM: a queued prompt is shown with buttons to send it now or drop it', async () => {
  const app = await ui();
  const calls = [];
  app.setFetchHook(async (url, options = {}) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (pathname.endsWith('/pending/send')) { calls.push('send'); return { ok: true, json: async () => ({ id: 'a', status: 'RUNNING' }) }; }
    if (pathname.endsWith('/pending')) { calls.push('drop'); return { ok: true, json: async () => ({ id: 'a', status: 'SUCCEEDED' }) }; }
    if (/\/api\/tasks\/a$/.test(pathname)) {
      return { ok: true, json: async () => ({ ...app.tasks.a, pendingPrompts: [{ text: 'позже спрошу', mode: 'auto' }] }) };
    }
    return null;
  });

  await app.selectTask('a');
  const row = app.document.getElementById('queuedPrompt');
  assert.equal(row.classList.contains('hidden'), false, 'the queued prompt is visible');
  assert.match(row.textContent, /позже спрошу/);
  const buttons = [...row.querySelectorAll('button')].map(button => button.textContent);
  assert.deepEqual(buttons, ['Отправить сейчас', 'Убрать']);

  row.querySelectorAll('button')[0].onclick();
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['send']);
});

test('DOM: several queued messages are summarised with their count', async () => {
  const app = await ui();
  app.setFetchHook(async (url) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (/\/api\/tasks\/a$/.test(pathname)) {
      return { ok: true, json: async () => ({ ...app.tasks.a, pendingPrompts: [
        { text: 'первое', mode: 'auto' }, { text: 'второе', mode: 'auto' }
      ] }) };
    }
    return null;
  });
  await app.selectTask('a');
  const row = app.document.getElementById('queuedPrompt');
  assert.equal(row.classList.contains('hidden'), false);
  assert.match(row.textContent, /В очереди \(2\): первое/);
});

test('DOM: an ordinary request goes through the transport, not straight to fetch', async () => {
  const app = await ui();
  const seen = [];
  app.setFetchHook(async (url, options = {}) => {
    seen.push({ url, method: options.method, body: options.body });
    if (String(url).includes('/api/tasks')) return { ok: true, json: async () => ([]) };
    return null;
  });
  await app.loadTasks();
  const call = seen.find(entry => String(entry.url).endsWith('/api/tasks'));
  assert.ok(call, JSON.stringify(seen));
  assert.equal(call.method, 'GET');

  // A body handed over as a JSON string arrives as an object, so a transport that
  // is not HTTP (the cloud relay) can carry the structure.
  const bodies = [];
  app.setFetchHook(async (url, options = {}) => {
    bodies.push({ url, method: options.method, body: options.body });
    return { ok: true, json: async () => ({ id: 'a', status: 'QUEUED' }) };
  });
  await app.sendContinueMessage('a', 'привет', {});
  const posted = bodies.find(entry => String(entry.url).includes('/message'));
  assert.equal(posted.method, 'POST');
  assert.equal(JSON.parse(posted.body).text, 'привет');

  // An API failure keeps its code, and the auth gate still appears for AUTH_REQUIRED.
  app.setFetchHook(async () => ({ ok: false, status: 401, json: async () => ({ code: 'AUTH_REQUIRED', error: 'нужен код' }) }));
  await assert.rejects(async () => {
    try { await app.loadTasks(); }
    catch (error) { assert.match(error.message, /AUTH_REQUIRED/); throw error; }
  }, /AUTH_REQUIRED/);
  assert.equal(app.document.getElementById('authGate').classList.contains('hidden'), false, 'the pairing gate is shown');
});

test('DOM: cloud mode says what the machine is doing and hides PC-only controls', async t => {
  const app = await ui({ cloud: true });
  // The cloud transport reconnects forever by design; stop it when the test ends.
  t.after(() => app.transport.close());
  const doc = app.document;

  // The page knows it is the cloud copy: PC-only controls were marked in the
  // markup and the stylesheet hides exactly those.
  assert.equal(doc.body.classList.contains('cloud-mode'), true);
  const marked = [...doc.querySelectorAll('[data-pc-only]')].map(node => node.id || node.className);
  assert.ok(marked.length >= 6, marked.join(','));
  assert.ok(marked.includes('resumeSessionButton'), 'native Pi import is PC-only');
  assert.ok(marked.includes('mcpButton'), 'MCP settings are PC-only');
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  assert.match(css, /body\.cloud-mode \[data-pc-only\] \{ display: none; \}/);

  // The banner is live and names the machine (the state depends on whether the
  // test relay answers, so only the invariant is asserted here).
  const banner = doc.getElementById('modeBanner');
  assert.equal(banner.classList.contains('hidden'), false, 'the banner is visible');
  assert.match(banner.textContent, /home-pc/, banner.textContent);
  assert.match(banner.textContent, /Облачный режим:/, banner.textContent);
});

// TODO(cloud-ui): drive the relay socket from the harness (open/AUTH_OK/
// MACHINE_STATUS) to cover the online/offline banner transitions. The socket
// itself is exercised in tests/web-transport.test.mjs and the relay tests; here
// the harness stops at the transport handshake.
test.skip('DOM: cloud mode follows the machine status frames', () => {});

test('DOM: stop points at the session that is actually running', async () => {
  const app = await ui();
  const doc = app.document;
  const idle = { id: 'a', title: 'Простой', status: 'SUCCEEDED', projectId: 'p' };
  const busy = { id: 'b', title: 'Работает', status: 'RUNNING', projectId: 'p' };
  // The list is what the screen renders from; the selected session is the idle
  // one, and the stop button must still reach the running one.
  app.setLastTasks?.([idle, busy]);
  assert.equal(app.stopTarget().id, 'b');

  // With a waiting session in the list and nothing selected, the actual
  // generation still wins: that is the thing the operator wants to stop.
  app.setLastTasks?.([{ ...idle, status: 'QUEUED' }, busy]);
  assert.equal(app.stopTarget().id, 'b');

  // Nothing to stop: the button is disabled instead of firing at a random id.
  app.setLastTasks?.([idle]);
  assert.equal(app.stopTarget(), null);
  app.updateStopButton();
  assert.equal(doc.getElementById('stopButton').disabled, true);
});
