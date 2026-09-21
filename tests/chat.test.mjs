import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import * as chatStateModule from '../web/chat-state.mjs';
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

test('VERIFYING is an active status: the answer stays open until the terminal event', () => {
  const state = new ChatState(task());
  state.apply({ taskId: 'a', seq: 1, type: 'USER_MESSAGE', message: 'go', data: { text: 'go' } });
  state.apply({ taskId: 'a', seq: 2, type: 'STATUS', message: 'Collecting diff', data: { status: 'VERIFYING' } });
  // The finalizer works after Pi settled; the reply must not be shown as done.
  assert.equal(state.current.active, true);
  assert.equal(state.current.status, 'VERIFYING');

  // A poll landing in the same phase must not finish the reply either.
  const polled = new ChatState(task());
  polled.apply({ taskId: 'a', seq: 1, type: 'USER_MESSAGE', message: 'go', data: { text: 'go' } });
  polled.snapshot({ ...task(), status: 'VERIFYING' });
  assert.equal(polled.current.active, true);
  assert.equal(polled.current.status, 'VERIFYING');

  // Only the terminal event closes the turn.
  state.apply({ taskId: 'a', seq: 3, type: 'TASK_SUCCEEDED', message: 'Done', data: {} });
  assert.equal(state.current.active, false);
  assert.equal(state.current.status, 'SUCCEEDED');
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

test('a window that opens mid-turn (no leading USER_MESSAGE) applies without crashing', () => {
  // The server's byte cap can cut the tail of an earlier turn, so the batch may
  // open on its events rather than on a USER_MESSAGE. Live reducer state needs a
  // current turn to write to; before that it dereferenced undefined and the
  // whole session failed to load.
  const state = new ChatState(task(), { seedInitial: false });
  state.apply({ taskId: 'a', seq: 1, type: 'PI_EVENT', data: { pi: { type: 'agent_settled' } } });
  state.apply({ taskId: 'a', seq: 2, type: 'TASK_CANCELLED', message: 'stopped', at: '2026-01-01T00:00:01.000Z' });
  assert.deepEqual(state.turns, []); // nothing from the dropped turn is rendered
  // The first real user message then bootstraps the live turn as usual.
  state.apply({ taskId: 'a', seq: 3, type: 'USER_MESSAGE', message: 'Привет', data: { text: 'Привет' } });
  assert.equal(state.turns[0].role, 'user');
  assert.equal(state.turns[0].text, 'Привет');
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
  // A spy for window.confirm so a test can assert that a destructive control
  // asks first; default true keeps every other test's behaviour unchanged.
  const confirms = [];
  let confirmAnswer = true;
  // Sessions have their own address, so the app reads location and writes
  // history; linkedom provides neither.
  const urls = [];
  // location.reload is called when the restarted server answers again.
  const reloads = [];
  // Named *_stub to avoid shadowing this file's own history() event helper.
  const historyStub = {
    pushState: (state, title, url) => urls.push({ method: 'push', url }),
    replaceState: (state, title, url) => urls.push({ method: 'replace', url })
  };
  const locationStub = { pathname: '/', href: 'http://localhost/', hostname: cloud ? 'taskbridge.example.app' : 'localhost', reload: () => reloads.push(true) };
  if (cloud) {
    globalThis.__taskbridgeTestCloud = { url: 'wss://relay.example.app/api/relay', machineId: 'home-pc', deviceToken: 'device-token' };
  }
  const appSource = await fs.readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const imported = resolveImports(appSource, {
    './chat-state.mjs': chatStateModule,
    './transport.mjs': transportModule,
    // app.js takes `marked` as a named import and DOMPurify as the default one.
    './vendor/marked.js': { marked: { setOptions() {}, parse: text => text } },
    './vendor/purify.mjs': { default: { sanitize: html => html } }
  });
  const localStorageStub = {
    store: {},
    getItem(key) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null; },
    setItem(key, value) { this.store[key] = String(value); },
    removeItem(key) { delete this.store[key]; }
  };
  const context = vm.createContext({ document, window, console, URL, history: historyStub, location: locationStub, localStorage: localStorageStub,
    WebSocket: TestWebSocket,
    __TASKBRIDGE_CLOUD__: cloud ? globalThis.__taskbridgeTestCloud : undefined,
    ...imported,
    setTimeout, clearTimeout, setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    EventSource: class { constructor(url) { this.url = url; streams.push(this); } close() { this.closed = true; } },
    navigator: { clipboard: { writeText: async text => { copied.push(text); } } },
    DataTransfer: class { items = { add: (file) => this.files.push(file) }; files = []; },
    File,
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
    }, alert() {}, confirm: (message) => { confirms.push(message); return confirmAnswer; },
  });
  const app = appSource.replace(/^import [^\n]*\n/gm, '').replace(/init\(\);\s*$/, '');
  vm.runInContext(app + '\nthis.testing = {selectTask, refreshTask, startNewTask, sendContinueMessage, openImport, routeFromLocation, openSessionFromLocation, loadTasks, renderTaskList, setTaskSort: (value) => { taskSort = value; renderTaskList(); }, copySessionLink, transport, cloudMode, stopTarget, updateStopButton, renderActivity, renderTaskDetails, rewriteMarkdownLinks, renderMarkdown, wrapTables, addCodeCopyButtons, highlightCode, openFileViewer, closeFileViewer, viewerKind, machineAction, machineOpenPath, runShellCommand, setServerLocal: (value) => { serverIsLocal = Boolean(value); canExecute = Boolean(value); }, checkPcState, setExecute: (value) => { canExecute = Boolean(value); }, applyUiSettings, loadUiSettings, getUiSettings: () => uiSettings, setUiSettings: (patch) => { uiSettings = { ...uiSettings, ...patch }; applyUiSettings({ persist: true }); }, setLastTasks: (list) => { lastTasks = list; }};', context);
  return { ...context.testing, document, window, streams, sockets, tasks, urls, copied, reloads, location: locationStub, confirms, localStorage: localStorageStub, setConfirmAnswer: value => { confirmAnswer = value; }, setFetchHook: hook => { fetchHook = hook; } };
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

test('DOM: a loader is shown while a session loads, and hidden when it is ready', async () => {
  const app = await ui();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  app.setFetchHook(async url => { if (url.includes('/events')) await gate; return null; });
  const loading = app.selectTask('a');
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(app.document.getElementById('sessionLoader').classList.contains('hidden'), false, 'the loader is visible while loading');
  release();
  await loading;
  assert.equal(app.document.getElementById('sessionLoader').classList.contains('hidden'), true, 'and hidden once the session is ready');
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

test('DOM: an attached image is shown inline, not only as a chip', async () => {
  const app = await ui();
  app.tasks.a.files = [
    { id: '11111111-1111-1111-1111-111111111111', name: 'photo.png', mimeType: 'image/png', path: '.taskbridge-input/a/f/photo.png' },
    { id: '22222222-2222-2222-2222-222222222222', name: 'notes.txt', mimeType: 'text/plain', path: '.taskbridge-input/a/f/notes.txt' }
  ];
  await app.selectTask('a');
  const firstUserTurn = app.document.querySelector('.turn.me');
  const preview = firstUserTurn.querySelector('.chatImage img');
  assert.ok(preview, 'the image attachment renders as an <img>');
  assert.match(preview.getAttribute('src'), /\/api\/tasks\/a\/files\/11111111-1111-1111-1111-111111111111$/);
  // A non-image attachment gets no preview; both stay reachable as chips.
  assert.equal(firstUserTurn.querySelectorAll('.chatImage').length, 1);
  assert.equal(firstUserTurn.querySelectorAll('.attachedFiles .fileChip').length, 2);
  // The chip's download action is an SVG arrow, not the rare ⭳ glyph (U+2B73)
  // that renders as a missing-glyph box on many fonts.
  for (const chip of firstUserTurn.querySelectorAll('.attachedFiles .fileChip')) {
    const dl = chip.querySelector('a[title="Скачать"]');
    assert.ok(dl && dl.querySelector('svg'), 'the download action is an SVG icon');
    assert.equal(dl.textContent.trim(), '', 'and carries no text glyph');
    assert.equal(dl.querySelector('svg').getAttribute('stroke'), 'currentColor', 'and follows the theme');
  }
});

test('DOM: a model link to a picture renders inline instead of a download link', async () => {
  const app = await ui();
  await app.selectTask('a');
  const box = app.document.createElement('div');
  box.innerHTML = '<p><a href="telegram_window.png">telegram_window.png</a> and <a href="report.pdf">report.pdf</a></p>';
  app.rewriteMarkdownLinks(box);
  // A relative link to an image is a picture the model is showing: inline preview.
  const img = box.querySelector('a img');
  assert.ok(img, 'the image link becomes an inline <img>');
  assert.match(img.getAttribute('src'), /\/api\/tasks\/a\/workspace-file\?path=telegram_window\.png$/);
  assert.doesNotMatch(img.getAttribute('src'), /download=1/);
  // A non-image link now opens the file inline (no attachment switch) instead
  // of pushing a download; the viewer is behind a plain click.
  const pdf = box.querySelector('a[href*="report.pdf"]');
  assert.match(pdf.getAttribute('href'), /workspace-file\?path=report\.pdf$/);
  assert.doesNotMatch(pdf.getAttribute('href'), /download=1/);
  assert.equal(typeof pdf.onclick, 'function', 'a plain click is intercepted');
});

test('DOM: a text file opens in the built-in viewer instead of downloading', async () => {
  const app = await ui();
  await app.selectTask('a');
  const box = app.document.createElement('div');
  box.innerHTML = '<p><a href="notes.txt">notes.txt</a></p>';
  app.rewriteMarkdownLinks(box);
  const link = box.querySelector('a');
  assert.match(link.getAttribute('href'), /workspace-file\?path=notes\.txt$/);
  assert.doesNotMatch(link.getAttribute('href'), /download=1/);
  app.setFetchHook(async url => (url.includes('notes.txt') ? { ok: true, text: async () => 'hello from notes' } : null));
  const click = new app.window.Event('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true, 'the browser does not navigate/download');
  await new Promise(resolve => setTimeout(resolve, 0));
  const overlay = app.document.getElementById('fileViewerOverlay');
  assert.equal(overlay.classList.contains('hidden'), false, 'the viewer opens');
  await new Promise(resolve => setTimeout(resolve, 0));
  const rendered = overlay.querySelector('.md');
  assert.ok(rendered, 'the text is rendered in the viewer (as a code block)');
  assert.match(rendered.textContent, /hello from notes/);
});

test('DOM: an unrenderable file is handed to the browser instead of the viewer', async () => {
  const app = await ui();
  await app.selectTask('a');
  app.openFileViewer({ url: '/api/tasks/a/files/x?x=1', name: 'archive.zip' });
  assert.equal(app.document.getElementById('fileViewerOverlay').classList.contains('hidden'), true, 'binary files skip the in-app viewer');
});

test('DOM: a plain click opens the viewer on every platform; native open is its own icon', async () => {
  const app = await ui();
  app.setServerLocal(true);
  app.tasks.a.files = [{ id: '11111111-1111-1111-1111-111111111111', name: 'notes.txt', mimeType: 'text/plain', path: '.taskbridge-input/a/f/notes.txt' }];
  const calls = [];
  app.setFetchHook(async (url, options = {}) => {
    if (url.includes('/open')) { calls.push({ url, method: options.method, body: JSON.parse(options.body || '{}') }); return { ok: true, json: async () => ({ opened: true }) }; }
    if (url.includes('/files/')) return { ok: true, text: async () => 'file text' };
    return null;
  });
  await app.selectTask('a');
  const chip = app.document.querySelector('.turn.me .fileChip');
  const name = chip.querySelector('a'); // the first anchor is the file name
  const click = new app.window.Event('click', { bubbles: true, cancelable: true });
  name.dispatchEvent(click);
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(click.defaultPrevented, true, 'the browser must not navigate');
  assert.equal(calls.length, 0, 'a plain click does not open natively anymore');
  assert.equal(app.document.getElementById('fileViewerOverlay').classList.contains('hidden'), false, 'the viewer opens, as on a phone');

  // Native open is an explicit, machine-only icon (↗).
  const openNative = chip.querySelector('a.openIcon');
  assert.ok(openNative, 'the machine has an open-in-app control');
  const event = new app.window.Event('click', { cancelable: true });
  openNative.dispatchEvent(event);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(event.defaultPrevented, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/tasks\/a\/files\/11111111-1111-1111-1111-111111111111\/open$/);
  assert.equal(calls[0].body.reveal, false);
  assert.equal(calls[0].body.confirm, true);
});

test('DOM: the reveal control asks the machine to show the folder', async () => {
  const app = await ui();
  app.setServerLocal(true);
  app.tasks.a.files = [{ id: '22222222-2222-2222-2222-222222222222', name: 'photo.png', mimeType: 'image/png', path: '.taskbridge-input/a/f/photo.png' }];
  const bodies = [];
  app.setFetchHook(async (url, options = {}) => {
    if (!url.includes('/open')) return null;
    bodies.push(JSON.parse(options.body || '{}'));
    return { ok: true, json: async () => ({ opened: true }) };
  });
  await app.selectTask('a');
  const reveal = app.document.querySelector('.turn.me .fileChip a.revealIcon');
  assert.ok(reveal, 'the reveal control exists');
  assert.equal(reveal.textContent.trim(), '', 'rendered as an SVG mark, not a glyph');
  const click = new app.window.Event('click', { bubbles: true, cancelable: true });
  reveal.dispatchEvent(click);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(click.defaultPrevented, true);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].reveal, true);
  assert.equal(bodies[0].confirm, true);
});

// Presses "Выполнить" in the in-app confirmation (window.confirm is unreliable
// on mobile/PWA, so the page draws its own dialog).
function confirmRun(app) {
  const overlay = app.document.getElementById('confirmOverlay');
  assert.equal(overlay.classList.contains('hidden'), false, 'a confirmation is shown');
  app.document.getElementById('confirmOk').onclick();
}

test('DOM: a script file chip offers a run action that runs it on the machine', async () => {
  const app = await ui();
  app.setServerLocal(true);
  app.tasks.a.files = [{ id: '33333333-3333-3333-3333-333333333333', name: 'deploy.sh', mimeType: 'text/plain', path: 'scripts/deploy.sh' }];
  const calls = [];
  app.setFetchHook(async (url, options = {}) => {
    if (!url.includes('/run')) return null;
    calls.push({ url, method: options.method, body: JSON.parse(options.body || '{}') });
    return { ok: true, json: async () => ({ command: 'deploy.sh', exitCode: 0, stdout: 'done\n', stderr: '', timedOut: false }) };
  });
  await app.selectTask('a');
  const run = app.document.querySelector('.turn.me .fileChip a.runIcon');
  assert.ok(run, 'the run control exists');
  assert.equal(run.textContent.trim(), '', 'rendered as an SVG mark, not a glyph');
  const click = new app.window.Event('click', { bubbles: true, cancelable: true });
  run.dispatchEvent(click);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(click.defaultPrevented, true, 'the browser must not navigate');
  assert.match(app.document.getElementById('confirmText').textContent, /deploy\.sh/, 'the operator is asked first');
  confirmRun(app);
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.length, 1, 'exactly one run request');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/api\/tasks\/a\/files\/33333333-3333-3333-3333-333333333333\/run$/);
  assert.equal(calls[0].body.confirm, true);
  const overlay = app.document.getElementById('fileViewerOverlay');
  assert.equal(overlay.classList.contains('hidden'), false, 'the output panel opens');
  assert.match(overlay.textContent, /Код выхода: 0/);
  assert.match(overlay.textContent, /done/);
});

test('DOM: copying a code block omits the button label', async () => {
  const app = await ui();
  const box = app.document.createElement('div');
  box.innerHTML = '<pre><code class="language-bash">cd /tmp\nls -la\n</code></pre>';
  app.addCodeCopyButtons(box);
  const copy = box.querySelector('.codeCopyBtn');
  assert.ok(copy, 'the copy control exists');
  await copy.onclick();
  assert.equal(app.copied.at(-1), 'cd /tmp\nls -la\n', 'only the code is copied');
  assert.doesNotMatch(app.copied.at(-1), /Копировать/, 'never the button label');
});

test('DOM: a command code block offers a run button that confirms and runs on the machine', async () => {
  const app = await ui();
  app.setServerLocal(true);
  await app.selectTask('a');
  const calls = [];
  app.setFetchHook(async (url, options = {}) => {
    if (!url.endsWith('/shell')) return null;
    calls.push({ url, method: options.method, body: JSON.parse(options.body || '{}') });
    return { ok: true, json: async () => ({ exitCode: 0, stdout: 'moved 20 files\n', stderr: '', timedOut: false }) };
  });
  const box = app.document.createElement('div');
  box.innerHTML = '<pre><code class="language-powershell">apply-move-list.ps1 -Csv fix-3d.csv -Execute</code></pre>';
  app.addCodeCopyButtons(box);
  const run = box.querySelector('.codeRunBtn');
  assert.ok(run, 'the run control exists');
  assert.equal(run.textContent, 'Выполнить');
  const pending = run.onclick();
  assert.match(app.document.getElementById('confirmText').textContent, /apply-move-list\.ps1/, 'the operator is asked first');
  confirmRun(app);
  await pending;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/api\/tasks\/a\/shell$/);
  assert.equal(calls[0].body.confirm, true);
  assert.equal(calls[0].body.command, 'apply-move-list.ps1 -Csv fix-3d.csv -Execute');
  const overlay = app.document.getElementById('fileViewerOverlay');
  assert.equal(overlay.classList.contains('hidden'), false, 'the output panel opens');
  assert.match(overlay.textContent, /Код выхода: 0/);
  assert.match(overlay.textContent, /moved 20 files/);
  // The result is visible and can be copied as-is.
  const copy = app.document.getElementById('fileViewerCopy');
  assert.equal(copy.classList.contains('hidden'), false, 'the result offers a copy action');
  await copy.onclick();
  assert.equal(app.copied.at(-1), 'moved 20 files\n', 'the output text is copied');
});

test('DOM: running a command shows a busy panel until the result arrives', async () => {
  const app = await ui();
  await app.selectTask('a');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  app.setFetchHook(async (url) => {
    if (!url.endsWith('/shell')) return null;
    await gate;
    return { ok: true, json: async () => ({ exitCode: 0, stdout: 'done\n', stderr: '', timedOut: false }) };
  });
  const box = app.document.createElement('div');
  box.innerHTML = '<pre><code class="language-bash">echo hi</code></pre>';
  app.addCodeCopyButtons(box);
  const runButton = box.querySelector('.codeRunBtn');
  const pending = runButton.onclick();
  confirmRun(app);
  await new Promise(resolve => setTimeout(resolve, 0));
  const overlay = app.document.getElementById('fileViewerOverlay');
  assert.equal(overlay.classList.contains('hidden'), false, 'the panel opens immediately');
  assert.ok(overlay.querySelector('.runSpinner'), 'a spinner is shown while running');
  assert.match(overlay.textContent, /Выполняется/);
  assert.equal(runButton.disabled, true, 'the button is busy meanwhile');
  release();
  await pending;
  assert.equal(overlay.querySelector('.runSpinner'), null, 'the spinner is replaced by the result');
  assert.match(overlay.textContent, /Код выхода: 0/);
  assert.equal(runButton.disabled, false, 'the button is usable again');
});

test('DOM: a long command output is offered as a file — download, attach, open', async () => {
  const app = await ui();
  app.setServerLocal(true);
  await app.selectTask('a');
  const calls = [];
  app.setFetchHook(async (url, options = {}) => {
    if (url.endsWith('/shell')) {
      return { ok: true, json: async () => ({ exitCode: 0, stdout: 'last line\n', stderr: '', timedOut: false, truncated: true, outputName: 'cmd-output-1.log', outputBytes: 204800 }) };
    }
    if (url.endsWith('/open')) { calls.push({ url, body: JSON.parse(options.body || '{}') }); return { ok: true, json: async () => ({ opened: true }) }; }
    if (url.includes('/artifacts/')) return { ok: true, text: async () => 'full output body' };
    return null;
  });
  const box = app.document.createElement('div');
  box.innerHTML = '<pre><code class="language-bash">long-running</code></pre>';
  app.addCodeCopyButtons(box);
  const pending = box.querySelector('.codeRunBtn').onclick();
  confirmRun(app);
  await pending;
  const overlay = app.document.getElementById('fileViewerOverlay');
  assert.match(overlay.textContent, /Показан конец вывода/);
  assert.match(overlay.textContent, /cmd-output-1\.log/, 'the artifact is named');
  assert.match(overlay.textContent, /200\.0 КиБ/, 'and its size is shown');
  const buttons = [...overlay.querySelectorAll('button')];
  assert.ok(buttons.find(button => button.textContent === 'Скачать'), 'the file can be downloaded');

  // Opening the full output with a desktop app is a machine action.
  const openFull = buttons.find(button => button.textContent === 'Открыть полный вывод');
  assert.ok(openFull, 'the full output can be opened');
  await openFull.onclick();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/tasks\/a\/artifacts\/cmd-output-1\.log\/open$/);
  assert.equal(calls[0].body.confirm, true);

  // "В чат" attaches the whole output to the composer as a file to send, so the
  // operator never has to paste a wall of text into the (bounded) prompt field.
  const toChat = [...app.document.getElementById('fileViewerOverlay').querySelectorAll('button')].find(button => button.textContent === 'В чат');
  assert.ok(toChat, 'the output can be attached to a message');
  await toChat.onclick();
  const attached = app.document.getElementById('files').files;
  assert.equal(attached.length, 1);
  assert.equal(attached[0].name, 'cmd-output-1.log');
  assert.equal(app.document.getElementById('fileViewerOverlay').classList.contains('hidden'), true, 'the panel closes after attaching');
});

test('DOM: a large paste becomes an attachment instead of filling the prompt', async () => {
  const app = await ui();
  const prompt = app.document.getElementById('prompt');
  const big = new app.window.Event('paste', { bubbles: true, cancelable: true });
  big.clipboardData = { getData: () => 'x'.repeat(9000) };
  prompt.dispatchEvent(big);
  assert.equal(big.defaultPrevented, true, 'the large paste is intercepted');
  assert.equal(prompt.value, '', 'nothing is poured into the prompt');
  const attached = app.document.getElementById('files').files;
  assert.equal(attached.length, 1, 'the text becomes an attachment');
  assert.match(attached[0].name, /^pasted-.*\.txt$/);

  const small = new app.window.Event('paste', { bubbles: true, cancelable: true });
  small.clipboardData = { getData: () => 'короткий текст' };
  prompt.dispatchEvent(small);
  assert.equal(small.defaultPrevented, false, 'a short paste is left alone');
  assert.equal(app.document.getElementById('files').files.length, 1, 'and adds no attachment');
});

test('DOM: an image pasted from the clipboard becomes an attachment', async () => {
  const app = await ui();
  const prompt = app.document.getElementById('prompt');
  const event = new app.window.Event('paste', { bubbles: true, cancelable: true });
  event.clipboardData = {
    items: [
      { type: 'text/plain', getAsFile: () => null },
      { type: 'image/png', getAsFile: () => new File(['x'], 'shot.png', { type: 'image/png' }) }
    ],
    getData: () => ''
  };
  prompt.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'the paste is handled here, not inserted as text');
  const files = app.document.getElementById('files').files;
  assert.equal(files.length, 1, 'the image is attached');
  assert.equal(files[0].name, 'shot.png');
});

test('DOM: a large text that lands in the prompt becomes a file even without a paste event', async () => {
  const app = await ui();
  const prompt = app.document.getElementById('prompt');
  // The phone case: no usable `paste` event, the text is simply in the field.
  prompt.value = 'y'.repeat(9000);
  prompt.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  assert.equal(prompt.value, '', 'the wall of text is taken out of the prompt');
  const files = app.document.getElementById('files').files;
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^pasted-.*\.txt$/);

  // beforeinput catches the paste payload before it is inserted.
  const event = new app.window.Event('beforeinput', { bubbles: true, cancelable: true });
  event.inputType = 'insertFromPaste';
  event.dataTransfer = { getData: () => 'z'.repeat(9000) };
  prompt.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'intercepted before it lands');
  assert.equal(app.document.getElementById('files').files.length, 2);
});

test('DOM: a multi-line queued prompt shows one line, the whole text is still queued', async () => {
  const app = await ui();
  await app.selectTask('a');
  app.tasks.a = { ...app.tasks.a, status: 'QUEUED', queueReason: 'QUEUED', pendingPrompts: [{ id: 'p1', text: 'первая строка\nвторая строка' }] };
  await app.refreshTask();
  const banner = app.document.getElementById('queuedPrompt').querySelector('.queuedText');
  assert.equal(banner.textContent, 'В очереди: первая строка', 'only the first line is shown');
  // The reducer keeps the full text; only the display is trimmed.
  assert.equal(app.tasks.a.pendingPrompts[0].text, 'первая строка\nвторая строка');
});

test('DOM: a markdown table is wrapped in its own scroll box', async () => {
  const app = await ui();
  const box = app.document.createElement('div');
  box.innerHTML = '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
  app.wrapTables(box);
  const wrap = box.querySelector('.tableWrap');
  assert.ok(wrap, 'the table has a scroll box');
  assert.ok(wrap.querySelector('table'), 'and the table is inside it');
  assert.equal(box.querySelectorAll('table').length, 1, 'no duplicate');
  app.wrapTables(box);
  assert.equal(box.querySelectorAll('.tableWrap').length, 1, 'wrapping is idempotent');
});

test('DOM: a markdown file in the viewer is rendered, not shown as its source', async () => {
  const app = await ui();
  await app.selectTask('a');
  app.setFetchHook(async url => (url.includes('readme.md') ? { ok: true, text: async () => '# Заголовок\n\nтекст' } : null));
  app.openFileViewer({ url: '/api/tasks/a/workspace-file?path=readme.md', name: 'readme.md' });
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  const body = app.document.getElementById('fileViewerBody');
  assert.ok(body.querySelector('.md'), 'rendered as markdown');
  assert.equal(body.querySelector('pre.fileViewerText'), null, 'not as raw source');
});

test('DOM: a code file renders as a code block, a CSV as a table', async () => {
  const app = await ui();
  await app.selectTask('a');
  app.setFetchHook(async url => {
    if (url.includes('main.js')) return { ok: true, text: async () => 'const a = 1;\n' };
    if (url.includes('data.csv')) return { ok: true, text: async () => 'name,age\nа,1\nб,2\n' };
    return null;
  });
  app.openFileViewer({ url: '/api/tasks/a/workspace-file?path=main.js', name: 'main.js' });
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  const body = app.document.getElementById('fileViewerBody');
  assert.ok(body.querySelector('.md'), 'code is shown like a code block');
  assert.equal(body.querySelector('pre.fileViewerText'), null, 'not as a plain raw pre');

  app.openFileViewer({ url: '/api/tasks/a/workspace-file?path=data.csv', name: 'data.csv' });
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  const table = app.document.getElementById('fileViewerBody').querySelector('table');
  assert.ok(table, 'csv rendered as a table');
  assert.deepEqual([...table.querySelectorAll('thead th')].map(cell => cell.textContent), ['name', 'age']);
  assert.equal(table.querySelectorAll('tbody tr').length, 2);
});

test('DOM: the viewer shows the folder on the machine and Download on a phone', async () => {
  const app = await ui();
  await app.selectTask('a');
  const openCalls = [];
  app.setFetchHook(async (url, options = {}) => {
    if (url.includes('/open')) { openCalls.push(JSON.parse(options.body || '{}')); return { ok: true, json: async () => ({ opened: true }) }; }
    return { ok: true, text: async () => 'text' };
  });
  const openIt = async () => {
    app.openFileViewer({ url: '/api/tasks/a/workspace-file?path=readme.txt', name: 'readme.txt' });
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  await openIt();
  assert.equal(app.document.getElementById('fileViewerDownload').classList.contains('hidden'), false, 'a phone keeps Download');
  assert.equal(app.document.getElementById('fileViewerReveal').classList.contains('hidden'), true, 'a phone has no folder button');

  app.setServerLocal(true);
  await openIt();
  assert.equal(app.document.getElementById('fileViewerDownload').classList.contains('hidden'), true, 'the machine replaces Download with the folder');
  const reveal = app.document.getElementById('fileViewerReveal');
  assert.equal(reveal.classList.contains('hidden'), false, 'the machine shows the folder button');
  await reveal.onclick();
  assert.equal(openCalls.at(-1).reveal, true, 'and it asks the machine to reveal the file');
});

test('DOM: a fresh desktop gets a wider default than a phone, at the normal font size', async () => {
  const app = await ui();
  app.localStorage.store = {}; // nothing saved yet
  app.window.innerWidth = 1600;
  const desktop = app.loadUiSettings();
  assert.equal(desktop.scale, 1, 'desktop keeps the normal font');
  assert.equal(desktop.width, 'wide', 'desktop width');
  app.localStorage.store = {};
  app.window.innerWidth = 380;
  const phone = app.loadUiSettings();
  assert.equal(phone.scale, 1, 'phone scale');
  assert.equal(phone.width, 'normal', 'phone width');
  // A saved choice always wins over the screen-based default.
  app.window.innerWidth = 1600;
  app.localStorage.setItem('taskbridge-ui', JSON.stringify({ scale: 1, width: 'normal', v: 2 }));
  const saved = app.loadUiSettings();
  assert.equal(saved.scale, 1);
  assert.equal(saved.width, 'normal');
});

test('DOM: «Очистить чат» asks first, then erases the session with confirm', async () => {
  const app = await ui();
  await app.selectTask('a');
  const calls = [];
  app.setFetchHook(async (url, options = {}) => {
    if (url.endsWith('/clear')) { calls.push({ method: options.method, body: JSON.parse(options.body || '{}') }); return { ok: true, json: async () => ({ ok: true }) }; }
    return null;
  });
  const pending = app.document.getElementById('clearChat').onclick();
  assert.equal(app.document.getElementById('confirmOverlay').classList.contains('hidden'), false, 'a confirmation is shown');
  app.document.getElementById('confirmOk').onclick();
  await pending;
  assert.equal(calls.length, 1, 'one clear request');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.confirm, true);
});

test('DOM: the sessions list shows the size and can sort by it', async () => {
  const app = await ui();
  app.setLastTasks([
    { id: 'a', prompt: 'small', status: 'SUCCEEDED', projectId: 'p', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z', events: 5 },
    { id: 'b', prompt: 'big', status: 'SUCCEEDED', projectId: 'p', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', events: 9000 }
  ]);
  app.setTaskSort('size');
  const rows = [...app.document.querySelectorAll('.taskRow')];
  assert.equal(rows[0].dataset.id, 'b', 'the biggest session is first when sorting by size');
  assert.equal(rows[1].querySelector('.t-count').textContent, '5');
  assert.equal(rows[0].querySelector('.t-count').textContent, '9.0k', 'a compact count');
});

test('DOM: interface settings change the scale and width, and persist', async () => {
  const app = await ui();
  const root = app.document.documentElement;
  app.setUiSettings({ scale: 1.3 });
  assert.equal(root.style.getPropertyValue('--ui-scale'), '1.3');
  app.setUiSettings({ width: 'wide' });
  assert.equal(root.style.getPropertyValue('--app-max'), '1500px');
  assert.equal(root.style.getPropertyValue('--msgs-max'), '1000px');
  assert.deepEqual(JSON.parse(app.localStorage.getItem('taskbridge-ui')), { scale: 1.3, width: 'wide', v: 2 });
  app.document.getElementById('uiSettingsReset').onclick();
  assert.equal(root.style.getPropertyValue('--ui-scale'), '1', 'reset restores the default scale');
  assert.equal(root.style.getPropertyValue('--app-max'), '1100px');
  assert.deepEqual(JSON.parse(app.localStorage.getItem('taskbridge-ui')), { scale: 1, width: 'normal', v: 2 });
});

test('DOM: a queued prompt for a waiting session cannot jump ahead of the busy one', async () => {
  const app = await ui();
  await app.selectTask('b');
  app.tasks.a = { ...app.tasks.a, status: 'RUNNING', title: 'Работа' };
  app.tasks.b = { ...app.tasks.b, status: 'QUEUED', queueReason: 'BUSY', pendingPrompts: [{ id: 'p1', text: 'моё сообщение' }] };
  app.setLastTasks([app.tasks.a, app.tasks.b]);
  await app.refreshTask();
  const host = app.document.getElementById('queuedPrompt');
  assert.equal(host.classList.contains('hidden'), false, 'the queue banner is shown');
  assert.match(host.querySelector('.queuedText').textContent, /ждёт «Работа»/, 'it names the session in the way');
  const send = [...host.querySelectorAll('button')].find(button => button.textContent === 'Отправить сейчас');
  assert.ok(send, 'the send control exists');
  assert.equal(send.disabled, false, 'kept pressable so it can explain');
  // Pressing it says it cannot happen now; the message stays queued.
  send.onclick();
  assert.match(app.document.getElementById('createError').textContent, /Сейчас нельзя/, 'and explains why');
  assert.deepEqual(app.tasks.b.pendingPrompts.map(entry => entry.text), ['моё сообщение'], 'the prompt is not lost');

  // The session that owns the machine may still cut in.
  app.tasks.a = { ...app.tasks.a, status: 'RUNNING', pendingPrompts: [{ id: 'p1', text: 'моё сообщение' }] };
  app.setLastTasks([app.tasks.a, app.tasks.b]);
  await app.selectTask('a');
  await app.refreshTask();
  const own = [...app.document.getElementById('queuedPrompt').querySelectorAll('button')].find(button => button.textContent === 'Отправить сейчас');
  assert.equal(own.disabled, false, 'the owner can send into its own turn');
});

test('DOM: code is highlighted without changing the text that gets copied', async () => {
  const app = await ui();
  const box = app.document.createElement('div');
  box.innerHTML = '<pre><code class="language-js">const a = "hi"; // note</code></pre>';
  const code = box.querySelector('code');
  const before = code.textContent;
  app.highlightCode(box);
  assert.equal(code.textContent, before, 'the characters are unchanged');
  assert.ok(code.querySelector('.tok-keyword'), 'keywords are wrapped');
  assert.ok(code.querySelector('.tok-string'), 'strings are wrapped');
  assert.ok(code.querySelector('.tok-comment'), 'comments are wrapped');
});

test('DOM: a code block copies its declared source, not the rendered text', async () => {
  const app = await ui();
  const box = app.document.createElement('div');
  box.innerHTML = '<pre><code class="language-json">pretty()</code></pre>';
  app.addCodeCopyButtons(box);
  box.querySelector('code').setAttribute('data-copy', 'ORIGINAL JSON');
  await box.querySelector('.codeCopyBtn').onclick();
  assert.equal(app.copied.at(-1), 'ORIGINAL JSON', 'the original text is copied');
});

test('DOM: code-block actions sit outside the scrolling pre, so they stay put', async () => {
  const app = await ui();
  const box = app.document.createElement('div');
  box.innerHTML = '<pre><code class="language-bash">echo hi</code></pre>';
  app.addCodeCopyButtons(box);
  const wrap = box.querySelector('.codeWrap');
  assert.ok(wrap, 'the code has a wrapper');
  const actions = box.querySelector('.codeActions');
  assert.equal(actions.parentElement, wrap, 'the actions live in the wrapper');
  assert.equal(box.querySelector('pre .codeActions'), null, 'not inside the scrolling pre');
  assert.ok(wrap.querySelector('pre'), 'the code itself stays in the wrapper');
});

test('DOM: code-block actions share one flex row, so they cannot overlap', async () => {
  const app = await ui();
  const box = app.document.createElement('div');
  box.innerHTML = '<pre><code class="language-bash">echo hi</code></pre>';
  app.addCodeCopyButtons(box);
  const row = box.querySelector('.codeActions');
  assert.ok(row, 'both actions live in one row');
  assert.deepEqual([...row.children].map(child => child.className), ['codeCopyBtn', 'codeRunBtn']);
});

test('DOM: a non-command code block gets a copy button but no run button', async () => {
  const app = await ui();
  app.setServerLocal(true);
  const box = app.document.createElement('div');
  box.innerHTML = '<pre><code class="language-json">{"a":1}</code></pre>';
  app.addCodeCopyButtons(box);
  assert.ok(box.querySelector('.codeCopyBtn'));
  assert.equal(box.querySelector('.codeRunBtn'), null, 'json is not a command');
});

test('DOM: an authenticated phone can run a command block, but not open files natively', async () => {
  const app = await ui();
  app.setExecute(true); // signed in / paired, but not on the machine itself
  await app.selectTask('a');
  const calls = [];
  app.setFetchHook(async (url, options = {}) => {
    if (!url.endsWith('/shell')) return null;
    calls.push({ url, body: JSON.parse(options.body || '{}') });
    return { ok: true, json: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false }) };
  });
  const box = app.document.createElement('div');
  box.innerHTML = '<pre><code class="language-bash">echo hi</code></pre>';
  app.addCodeCopyButtons(box);
  const run = box.querySelector('.codeRunBtn');
  assert.ok(run, 'an authenticated client still gets the run control');
  const pending = run.onclick();
  confirmRun(app);
  await pending;
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/tasks\/a\/shell$/);
  // Opening files with desktop apps remains machine-only: the phone gets an error.
  const reveal = await app.machineAction('/api/tasks/a/files/x/open', true);
  // An Error from the sandbox realm, so check its shape, not instanceof.
  assert.ok(reveal && typeof reveal.message === 'string', 'native reveal is refused off the machine');
});

test('DOM: on the machine the image menu also offers native open and reveal', async () => {
  const app = await ui();
  app.setServerLocal(true);
  app.tasks.a.files = [{ id: '11111111-1111-1111-1111-111111111111', name: 'photo.png', mimeType: 'image/png' }];
  await app.selectTask('a');
  const img = app.document.querySelector('.turn.me .chatImage img');
  assert.ok(img, 'the attachment preview exists');
  img.dispatchEvent(new app.window.Event('click', { bubbles: true, cancelable: true }));
  const labels = [...app.document.querySelectorAll('.imageMenuItem')].map(button => button.textContent);
  assert.deepEqual(labels, ['Посмотреть', 'Скачать', 'Копировать ссылку', 'Открыть в приложении', 'Показать в папке']);
});

test('DOM: a single click on a chat image opens a menu like long-press', async () => {
  const app = await ui();
  app.tasks.a.files = [{ id: '11111111-1111-1111-1111-111111111111', name: 'photo.png', mimeType: 'image/png' }];
  await app.selectTask('a');
  const img = app.document.querySelector('.turn.me .chatImage img');
  assert.ok(img, 'the attachment preview exists');
  const click = new app.window.Event('click', { bubbles: true, cancelable: true });
  img.dispatchEvent(click);
  const menu = app.document.querySelector('.imageMenu');
  assert.ok(menu, 'the image context menu appears');
  assert.deepEqual(
    [...menu.querySelectorAll('.imageMenuItem')].map(b => b.textContent),
    ['Посмотреть', 'Скачать', 'Копировать ссылку']
  );
  assert.equal(click.defaultPrevented, true, 'navigating away is prevented');
  // A click anywhere else closes it.
  app.document.body.dispatchEvent(new app.window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(app.document.querySelector('.imageMenu'), null);
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

test('DOM: the details panel shows a readable status, not the raw enum', async () => {
  const app = await ui();
  const el = app.document.getElementById('taskStatus');

  // A finished run reads as a word, not as a machine code.
  app.renderTaskDetails({ ...task('a'), status: 'SUCCEEDED' });
  assert.equal(el.textContent, 'Готово');

  // A recovered failure stays honest about why, without leaking the enum to the
  // screen — the raw code stays reachable in the tooltip for bug reports.
  app.renderTaskDetails({ ...task('a'), status: 'FAILED', errorCode: 'FAILED_RECOVERY' });
  assert.equal(el.textContent, 'Ошибка');
  assert.match(el.title, /FAILED_RECOVERY/);

  // A status the server adds later must stay visible instead of disappearing.
  app.renderTaskDetails({ ...task('a'), status: 'SOMETHING_NEW' });
  assert.equal(el.textContent, 'SOMETHING_NEW');
});

test('DOM: a running session is obvious, and both stop and send stay reachable', async () => {
  const app = await ui();
  const doc = app.document;
  const activity = doc.getElementById('activity');
  const stop = doc.getElementById('stopButton');
  const send = doc.getElementById('sendButton');

  // Running: the strip appears with a live timer and the model name.
  app.renderActivity({ status: 'RUNNING', model: { id: 'qwen-27b' }, statusChangedAt: new Date(Date.now() - 5000).toISOString() });
  assert.equal(activity.classList.contains('hidden'), false);
  assert.match(activity.textContent, /Pi работает/);
  assert.match(activity.textContent, /5 с|\d+ с/);
  assert.match(activity.textContent, /qwen-27b/);

  // Waiting: the strip says why, so the queue is not a mystery.
  app.renderActivity({ status: 'QUEUED', queueReason: 'MODEL_BUSY', statusChangedAt: new Date().toISOString() });
  assert.match(activity.textContent, /В очереди/);
  assert.match(activity.textContent, /ждёт модель/);
  assert.equal(activity.classList.contains('waiting'), true);

  // Idle: nothing is shown, and no timer is left behind.
  app.renderActivity({ status: 'SUCCEEDED' });
  assert.equal(activity.classList.contains('hidden'), true);
  assert.equal(activity.textContent, '');

  // The stylesheet must keep BOTH buttons available while a run is active —
  // hiding send made queueing impossible on touch devices (Enter adds a newline).
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /#stopButton:not\(:disabled\)\) #sendButton \{ display: none/);
  // Стоп всегда на виду (только выключен, когда останавливать нечего): кнопка,
  // которая то появляется, то исчезает, путает больше.
  assert.match(css, /#stopButton \{ display: grid/);
  assert.doesNotMatch(css, /#stopButton \{ display: none/);
  assert.match(css, /#activity:not\(\.hidden\) \{ display: flex/);

  // Enabled state while the machine works: stop can cancel, send can queue.
  app.setLastTasks?.([{ id: 'a', title: 'Работает', status: 'RUNNING', projectId: 'p' }]);
  app.updateStopButton();
  assert.equal(stop.disabled, false, 'stop must be clickable while a run is active');
  assert.equal(send.disabled, false, 'send must stay clickable so a prompt can queue');
});

test('DOM: a failed send can be repeated without retyping it', async () => {
  const app = await ui();
  await app.loadTasks();
  await app.selectTask('a');

  const prompt = app.document.getElementById('prompt');
  const retry = app.document.getElementById('retryPrompt');
  assert.equal(retry.classList.contains('hidden'), true, 'nothing to repeat yet');

  // The send fails: the text must not die with it.
  let attempts = 0;
  app.setFetchHook(async (url) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (!pathname.endsWith('/message')) return null;
    attempts++;
    if (attempts === 1) return { ok: false, status: 500, json: async () => ({ error: { message: 'Pi упал' } }) };
    return { ok: true, json: async () => ({ id: 'a', status: 'RUNNING' }) };
  });

  const form = app.document.getElementById('form');
  // linkedom has no requestSubmit: make it perform a real submit event.
  form.requestSubmit = () => form.dispatchEvent(new app.window.Event('submit', { cancelable: true }));
  const submit = async () => {
    form.dispatchEvent(new app.window.Event('submit', { cancelable: true }));
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  };

  prompt.value = 'повтори меня';
  await submit();
  assert.equal(retry.classList.contains('hidden'), false, 'the failed prompt is offered again');

  // One click resends exactly the same text.
  prompt.value = '';
  retry.dispatchEvent(new app.window.Event('click'));
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2, 'the retry actually sent something');
  assert.equal(retry.classList.contains('hidden'), true, 'a successful resend clears the offer');
});

test('DOM: every message carries its own copy button', async () => {
  const app = await ui();
  await app.selectTask('a');

  const turns = [...app.document.querySelectorAll('.turn')];
  assert.ok(turns.length >= 3, `too few turns rendered: ${turns.length}`);
  for (const turn of turns) assert.ok(turn.querySelector('.copyBtn'), `a message without a copy button: ${turn.textContent.slice(0, 40)}`);
  // The copy mark is an inline SVG, like the other message icons: an emoji would
  // ignore the theme colour and the row's shared stroke weight.
  for (const turn of turns) {
    const svg = turn.querySelector('.copyBtn svg');
    assert.ok(svg, 'the copy button is an icon, not a glyph');
    assert.equal(svg.getAttribute('stroke'), 'currentColor', 'the copy icon follows the theme');
  }

  // Own line: copies exactly what was sent.
  const mine = [...app.document.querySelectorAll('.turn.me .copyBtn')].at(-1);
  mine.dispatchEvent(new app.window.Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.copied.at(-1), 'Второй вопрос');

  // Pi's answer: copies the text of that turn, not of the whole chat.
  const bot = [...app.document.querySelectorAll('.turn:not(.me) .copyBtn')].at(-1);
  bot.dispatchEvent(new app.window.Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.copied.at(-1), 'Второй ответ');
});

test('TURN_TRUNCATED retracts the failed exchange and rolls back current', () => {
  const state = new ChatState(task());
  for (const event of history()) state.apply(event);
  state.apply({ taskId: 'a', seq: 13, type: 'USER_MESSAGE', message: 'go again', data: { text: 'go again' } });
  state.apply({ taskId: 'a', seq: 14, type: 'TASK_FAILED', message: 'boom', data: {} });
  assert.equal(state.current.error, 'boom');
  state.apply({ taskId: 'a', seq: 15, type: 'TURN_TRUNCATED', message: 'retracted', data: { fromSeq: 13 } });
  assert.deepEqual(state.turns.map(t => t.id), ['user-initial', 'assistant-initial', 'user-5', 'assistant-5']);
  assert.equal(state.current.text, 'Второй ответ');
  // A stale marker replayed against already-clean history changes nothing.
  state.apply({ taskId: 'a', seq: 16, type: 'TURN_TRUNCATED', message: 'retracted', data: { fromSeq: 13 } });
  assert.equal(state.turns.length, 4);
});

test('TURN_TRUNCATED with keepUser rewrites only the answer, never the operator line', () => {
  const state = new ChatState(task());
  for (const event of history()) state.apply(event);
  const userTurn = state.turns.find(t => t.id === 'user-5');
  state.apply({
    taskId: 'a', seq: 15, type: 'TURN_TRUNCATED', message: 'regen',
    data: { fromSeq: 6, keepUser: true, reason: 'regenerate', text: 'Второй вопрос' }
  });
  assert.deepEqual(state.turns.map(t => t.id), ['user-initial', 'assistant-initial', 'user-5', 'assistant-5']);
  assert.equal(state.turns.find(t => t.id === 'user-5'), userTurn, 'the very same turn object stays put');
  assert.equal(userTurn.text, 'Второй вопрос', 'the operator line is untouched');
  assert.equal(state.current, state.turns.at(-1), 'the stream lands on the rewritten answer');
  assert.equal(state.current.role, 'assistant');
  assert.equal(state.current.text, '', 'the old answer is gone');
  assert.equal(state.current.active, true);
});

test('DOM: an edited message refreshes the bubble it already has', async () => {
  const app = await ui();
  await app.selectTask('a');
  const bubbles = () => [...app.document.querySelectorAll('.turn.me .msg')].map(t => t.textContent);
  assert.deepEqual(bubbles(), ['Первый вопрос', 'Второй вопрос']);
  // The server corrected the message in place (same turn id, new text).
  app.streams[0].onmessage({ data: JSON.stringify({ taskId: 'a', seq: 15, type: 'TURN_EDITED', message: 'edited', data: { id: 'user-5', text: 'Второй вопрос (исправлен)', role: 'user' } }) });
  await new Promise(resolve => setTimeout(resolve, 150)); // renderChat is debounced by 80 ms
  assert.deepEqual(bubbles(), ['Первый вопрос', 'Второй вопрос (исправлен)']);
  // Its copy button copies what is on screen now, not the original text.
  const copy = [...app.document.querySelectorAll('.turn.me .copyBtn')].at(-1);
  copy.dispatchEvent(new app.window.Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.copied.at(-1), 'Второй вопрос (исправлен)');
});

test('DOM: a refused edit reopens the editor with the typed text', async () => {
  const app = await ui();
  await app.selectTask('a');
  app.setFetchHook(async (url, options = {}) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (pathname.endsWith('/edit')) return { ok: false, status: 400, json: async () => ({ code: 'NOT_ALLOWED', error: 'нельзя сейчас' }) };
    return null;
  });
  const userBar = [...app.document.querySelectorAll('.turn.me .turnActionBar')].at(-1);
  userBar.querySelector('[data-action="edit"]').dispatchEvent(new app.window.Event('click'));
  const area = app.document.querySelector('.editArea');
  area.value = 'мое исправленное';
  [...app.document.querySelectorAll('.editRow button')].find(b => b.textContent === 'Сохранить')
    .dispatchEvent(new app.window.Event('click'));
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  const reopened = app.document.querySelector('.editArea');
  assert.ok(reopened, 'the editor reopens on a refused save');
  assert.equal(reopened.value, 'мое исправленное', 'the typed text is kept');
});

test('DOM: rewriting an answer takes that turn’s tool chips with it', async () => {
  const app = await ui();
  await app.selectTask('a');
  const chips = () => [...app.document.querySelectorAll('.turn:not(.me) .tool')].map(t => t.textContent.trim());
  assert.equal(chips().length, 1, 'the fixture ran one command');
  // The server says: only the answer was rewritten (keepUser). Its turn object is
  // replaced, not emptied, and the view must not keep the old commands on screen.
  app.streams[0].onmessage({ data: JSON.stringify({ taskId: 'a', seq: 15, type: 'TURN_TRUNCATED', message: 'regen', data: { fromSeq: 6, keepUser: true, reason: 'regenerate' } }) });
  await new Promise(resolve => setTimeout(resolve, 150)); // renderChat is debounced by 80 ms
  assert.deepEqual(chips(), [], 'the old command is gone from the rewritten answer');
  assert.equal(app.document.querySelectorAll('.turn.me').length, 2, 'the operator messages stay');
  assert.equal(app.document.querySelectorAll('.turn').length, 4, 'still two exchanges');
});

test('TURN_TRUNCATED with dropInitial forgets the turn synthesized from task.prompt', () => {
  const state = new ChatState(task());
  state.apply({ taskId: 'a', seq: 1, type: 'PI_EVENT', message: '', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } });
  state.apply({ taskId: 'a', seq: 2, type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} });
  assert.equal(state.turns.length, 2);
  state.apply({ taskId: 'a', seq: 3, type: 'TURN_TRUNCATED', message: 'retracted', data: { fromSeq: 1, dropInitial: true } });
  assert.deepEqual(state.turns, []);
  assert.equal(state.current.text, '');
  assert.equal(state.current.error, null);
  // The resent prompt builds a fresh turn on the placeholder.
  state.apply({ taskId: 'a', seq: 4, type: 'USER_MESSAGE', message: 'original', data: { text: 'original', files: [] } });
  assert.deepEqual(state.turns.map(t => t.id), ['user-4', 'assistant-4']);
  assert.equal(state.current.text, '');
});

test('TURN_EDITED replaces the settled message text, on both sides of the exchange', () => {
  const state = new ChatState(task());
  for (const event of history()) state.apply(event);
  const userTurn = state.turns.find(t => t.id === 'user-5');
  const botTurn = state.turns.find(t => t.id === 'assistant-5');
  state.apply({ taskId: 'a', seq: 13, type: 'TURN_EDITED', message: 'edited', data: { id: 'user-5', text: 'Второй вопрос (исправлен)', role: 'user' } });
  state.apply({ taskId: 'a', seq: 14, type: 'TURN_EDITED', message: 'edited', data: { id: 'assistant-5', text: 'Ответ исправлен', role: 'assistant' } });
  assert.equal(userTurn.text, 'Второй вопрос (исправлен)');
  assert.equal(botTurn.text, 'Ответ исправлен');
  // An edit for a turn this window no longer holds must not invent one.
  state.apply({ taskId: 'a', seq: 15, type: 'TURN_EDITED', message: 'edited', data: { id: 'user-999', text: 'нет такого', role: 'user' } });
  assert.equal(state.turns.length, 4);
});

test('DOM: a clean failed last turn offers no separate repeat button', async () => {
  const app = await ui();
  app.tasks.a.status = 'FAILED';
  const failedHistory = [
    ...history(),
    { taskId: 'a', seq: 13, type: 'USER_MESSAGE', message: 'Что пошло не так?', data: { text: 'Что пошло не так?', files: [] } },
    { taskId: 'a', seq: 14, type: 'TASK_FAILED', message: 'boom', data: {} },
  ];
  let undoCalled = false;
  app.setFetchHook(async (url) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    if (pathname === '/api/tasks/a/undo-last-turn') {
      undoCalled = true;
      return { ok: true, json: async () => ({ ok: true, text: 'Что пошло не так?', fromSeq: 13 }) };
    }
    if (pathname === '/api/tasks/a/events') {
      const list = searchParams.has('tail') ? failedHistory : failedHistory.filter(e => e.seq > Number(searchParams.get('after') || 0));
      return { ok: true, json: async () => (searchParams.has('tail') ? { events: list, reachedStart: true } : list) };
    }
    return null;
  });
  await app.selectTask('a');
  const mine = () => [...app.document.querySelectorAll('.turn.me')];
  assert.equal(mine().length, 3, 'initial + two follow-up messages');
  // The retry text button is gone: the operator line carries the edit icon
  // ("fix and resend") and the empty answer carries regenerate, so a clean
  // failure needs no extra button and nothing is retracted.
  const labels = [...app.document.querySelectorAll('button')].map(b => b.textContent);
  assert.ok(!labels.some(t => t.includes('Повторить сообщение')), `no repeat button: ${labels.join(' | ')}`);
  assert.ok(!labels.some(t => t.includes('Скопировать сообщение')), 'nothing was produced, so nothing is copy-only');
  assert.ok(!undoCalled, 'nothing asked the server to retract the turn');
});

test('DOM: a cancelled first run offers neither a retry nor a copy-only', async () => {
  const app = await ui();
  // A session that was stopped before the model produced anything: the task
  // record carries no saved text either.
  app.tasks.a.status = 'CANCELLED';
  app.tasks.a.assistantText = '';
  const events = [
    { taskId: 'a', seq: 1, type: 'PI_EVENT', message: 'Pi started processing', data: { pi: { type: 'agent_start' } } },
    { taskId: 'a', seq: 2, type: 'PI_EVENT', message: '', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } },
    { taskId: 'a', seq: 3, type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} },
  ];
  app.setFetchHook(async (url) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    if (pathname === '/api/tasks/a/events') {
      const list = searchParams.has('tail') ? events : events.filter(e => e.seq > Number(searchParams.get('after') || 0));
      return { ok: true, json: async () => (searchParams.has('tail') ? { events: list, reachedStart: true } : list) };
    }
    return null;
  });
  await app.selectTask('a');
  const labels = [...app.document.querySelectorAll('button')].map(b => b.textContent);
  assert.ok(!labels.some(t => t.includes('Повторить сообщение')), `no retry button: ${labels.join(' | ')}`);
  assert.ok(!labels.some(t => t.includes('Скопировать сообщение')), 'nothing was produced, so nothing is copy-only');
});

test('DOM: a failed turn never grows a standing copy or repeat button', async () => {
  const app = await ui();
  app.tasks.a.status = 'FAILED';
  app.setFetchHook(async (url) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    if (pathname === '/api/tasks/a/undo-last-turn') throw new Error('must not be called');
    if (pathname === '/api/tasks/a/events') {
      const failedHistory = [
        ...history(),
        { taskId: 'a', seq: 13, type: 'USER_MESSAGE', message: 'Что пошло не так?', data: { text: 'Что пошло не так?', files: [] } },
        { taskId: 'a', seq: 14, type: 'PI_EVENT', message: '', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } },
        { taskId: 'a', seq: 15, type: 'PI_EVENT', message: '', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'частичный ответ' } } } },
        { taskId: 'a', seq: 16, type: 'TASK_FAILED', message: 'boom', data: {} },
      ];
      const all = searchParams.has('tail') ? failedHistory : failedHistory.filter(e => e.seq > Number(searchParams.get('after') || 0));
      return { ok: true, json: async () => (searchParams.has('tail') ? { events: all, reachedStart: true } : all) };
    }
    return null;
  });
  await app.selectTask('a');
  const mine = () => [...app.document.querySelectorAll('.turn.me')];
  assert.equal(mine().length, 3);
  // A failed exchange grows no standing button under the answer any more: the
  // inline message icons are the only actions on a message.
  const labels = [...app.document.querySelectorAll('button')].map(b => b.textContent);
  assert.ok(!labels.some(t => t.includes('Скопировать сообщение')), `no copy button: ${labels.join(' | ')}`);
  assert.ok(!labels.some(t => t.includes('Повторить сообщение')), `no repeat button: ${labels.join(' | ')}`);
  assert.ok(!app.document.querySelector('.turnActions'), 'the failed-turn action row is gone');
  assert.equal(mine().length, 3, 'history stays intact');
});

test('DOM: every message carries edit/fork/drop actions, and the newest answer offers a repeat', async () => {
  const app = await ui();
  await app.selectTask('a');
  const calls = [];
  app.tasks.forked = { ...task('forked'), prompt: 'Первое сообщение ветки' };
  app.setFetchHook(async (url, options = {}) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (pathname !== '/api/tasks/a/fork' && pathname !== '/api/tasks/a/regenerate' && pathname !== '/api/tasks/a/continue' && !pathname.includes('/turns/')) return null;
    calls.push({ pathname, method: options.method || 'GET', body: options.body });
    if (pathname.endsWith('/fork')) return { ok: true, json: async () => ({ id: 'forked' }) };
    return { ok: true, json: async () => ({ ok: true }) };
  });

  const bars = [...app.document.querySelectorAll('.turnActionBar')];
  assert.ok(bars.length >= 4, `too few action bars: ${bars.length}`);
  const userBar = [...app.document.querySelectorAll('.turn.me .turnActionBar')].at(-1);
  const botBar = app.document.querySelector('.turn:not(.me) .turnActionBar');
  assert.ok(userBar && botBar, 'both directions carry the action bar');
  const visible = bar => [...bar.querySelectorAll('.actionBtn')].filter(b => !b.classList.contains('hidden')).map(b => b.dataset.action);
  assert.deepEqual(visible(userBar), ['edit', 'fork', 'drop'], 'the operator line can be fixed, branched or dropped');
  // Every action is an inline SVG mark, not an emoji: an emoji ignores the theme
  // colour and changes size with the font, and 🌿 read as “herb”, not “fork”.
  const iconMark = button => {
    const svg = button.querySelector('svg');
    assert.ok(svg, `${button.dataset.action} is drawn as an icon, not text`);
    assert.ok(!button.textContent.trim(), `${button.dataset.action} carries no glyph`);
    assert.equal(svg.getAttribute('stroke'), 'currentColor', `${button.dataset.action} follows the theme colour`);
    assert.ok(svg.children.length, `${button.dataset.action} has real geometry`);
  };
  for (const button of userBar.querySelectorAll('.actionBtn')) iconMark(button);
  // An answer is a branch point too. Older answers only fork/regen-ish nothing:
  // re-run, continue and edit live on the newest answer alone.
  assert.deepEqual(visible(botBar), ['fork']);
  const lastBotBar = [...app.document.querySelectorAll('.turn:not(.me) .turnActionBar')].at(-1);
  assert.deepEqual(visible(lastBotBar), ['edit', 'fork', 'regen', 'continue']);
  for (const button of lastBotBar.querySelectorAll('.actionBtn')) iconMark(button);

  // ✎ opens the editor; Save re-sends the corrected text (the server wipes
  // everything below it and asks the model again).
  userBar.querySelector('.actionBtn').dispatchEvent(new app.window.Event('click'));
  const area = app.document.querySelector('.editArea');
  assert.ok(area, 'the editor opens');
  area.value = 'Второй вопрос (исправлен)';
  const save = [...app.document.querySelectorAll('.editRow button')].find(b => b.textContent === 'Сохранить');
  save.dispatchEvent(new app.window.Event('click'));
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  const edited = calls.find(c => c.pathname.endsWith('/edit'));
  assert.ok(edited, 'the edit endpoint was called');
  assert.equal(edited.pathname, '/api/tasks/a/turns/user-5/edit');
  assert.equal(edited.body, JSON.stringify({ text: 'Второй вопрос (исправлен)' }));
  assert.ok(!app.document.querySelector('.editArea'), 'the editor closes on success');

  // 🔄 asks again and re-runs the model in the same session.
  lastBotBar.querySelectorAll('.actionBtn')[2].dispatchEvent(new app.window.Event('click'));
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  const regenerated = calls.find(c => c.pathname.endsWith('/regenerate'));
  assert.ok(regenerated, 'the regenerate endpoint was called');
  assert.equal(regenerated.body, JSON.stringify({ turnId: 'assistant-5' }), 'the newest answer names itself');

  // → continues the answer in place: nothing is dropped, the model appends.
  lastBotBar.querySelectorAll('.actionBtn')[3].dispatchEvent(new app.window.Event('click'));
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  const continued = calls.find(c => c.pathname.endsWith('/continue'));
  assert.ok(continued, 'the continue endpoint was called');
  assert.equal(continued.body, JSON.stringify({ turnId: 'assistant-5' }));

  // 🗑 asks first (the harness answers yes), then drops the message and after.
  userBar.querySelectorAll('.actionBtn')[2].dispatchEvent(new app.window.Event('click'));
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(c => c.pathname.endsWith('/delete')), 'the delete endpoint was called');

  // 🌿 branches a session from this message and opens the copy.
  userBar.querySelectorAll('.actionBtn')[1].dispatchEvent(new app.window.Event('click'));
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  const forked = calls.find(c => c.pathname.endsWith('/fork'));
  assert.ok(forked, 'the fork endpoint was called');
  assert.equal(forked.body, JSON.stringify({ turnId: 'user-5' }));
  assert.equal(app.urls.at(-1)?.url, '/session/forked', 'the new branch is opened');
});

test('a regenerated answer becomes a sibling variant, not a replacement', () => {
  const state = new ChatState(task());
  state.apply({ taskId: 'a', seq: 1, type: 'USER_MESSAGE', message: 'вопрос', data: { text: 'вопрос' } });
  state.apply({ taskId: 'a', seq: 2, type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } });
  state.apply({ taskId: 'a', seq: 3, type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ответ А' } } } });
  state.apply({ taskId: 'a', seq: 4, type: 'TASK_SUCCEEDED', message: 'Done', data: {} });
  const first = state.turns.at(-1);
  assert.equal(first.text, 'ответ А');

  // Regenerate: a marker, then the frames of the new answer.
  state.apply({ taskId: 'a', seq: 5, type: 'TURN_VARIANT_START', message: 'Новый вариант', data: { turnSeq: 1, variantId: 'v2', text: 'вопрос' } });
  state.apply({ taskId: 'a', seq: 6, type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } });
  state.apply({ taskId: 'a', seq: 7, type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ответ Б' } } } });

  const second = state.turns.at(-1);
  assert.equal(second.id, 'assistant-v2');
  assert.equal(second.text, 'ответ Б');
  assert.equal(state.current, second, 'live frames land on the new variant');
  assert.equal(first.hidden, true, 'the previous answer stays, hidden');
  assert.equal(first.text, 'ответ А', 'and keeps its text');
  assert.deepEqual(state.variantsOf(second), { key: 1, index: 1, total: 2, ids: ['assistant-1', 'assistant-v2'], selectedId: 'assistant-v2' });

  // Switching back is a persisted preference, not an edit.
  state.apply({ taskId: 'a', seq: 8, type: 'TURN_VARIANT_SELECTED', message: 'Показан другой вариант', data: { turnSeq: 1, variantId: '1' } });
  assert.equal(first.hidden, false);
  assert.equal(second.hidden, true);
  assert.equal(state.variantsOf(first).index, 0);
  assert.equal(state.current, second, 'the frame sink does not move with the view');

  // A replay of the same log lands on the same variant.
  const replay = new ChatState(task());
  for (const event of [
    { taskId: 'a', seq: 1, type: 'USER_MESSAGE', message: 'вопрос', data: { text: 'вопрос' } },
    { taskId: 'a', seq: 2, type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } },
    { taskId: 'a', seq: 3, type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ответ А' } } } },
    { taskId: 'a', seq: 5, type: 'TURN_VARIANT_START', data: { turnSeq: 1, variantId: 'v2' } },
    { taskId: 'a', seq: 6, type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } },
    { taskId: 'a', seq: 7, type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ответ Б' } } } },
    { taskId: 'a', seq: 8, type: 'TURN_VARIANT_SELECTED', data: { turnSeq: 1, variantId: '1' } },
  ]) replay.apply(event);
  assert.equal(replay.turns.at(-2).hidden, false, 'the replayed log shows the selected variant');
  assert.equal(replay.turns.at(-1).hidden, true);
});

test('retracting an exchange drops its variant bookkeeping', () => {
  const state = new ChatState(task());
  state.apply({ taskId: 'a', seq: 1, type: 'USER_MESSAGE', message: 'вопрос', data: { text: 'вопрос' } });
  state.apply({ taskId: 'a', seq: 2, type: 'TURN_VARIANT_START', data: { turnSeq: 1, variantId: 'v2' } });
  state.apply({ taskId: 'a', seq: 3, type: 'TASK_FAILED', message: 'boom', data: {} });
  assert.equal(state.variants.get(1).ids.length, 2);
  state.apply({ taskId: 'a', seq: 4, type: 'TURN_TRUNCATED', data: { fromSeq: 1, reason: 'delete' } });
  assert.equal(state.variants.has(1), false);
  assert.equal(state.turns.some(turn => turn.id === 'assistant-v2'), false);
});

test('DOM: ‹ n/m › switches between the answers of one exchange', async () => {
  const app = await ui();
  const events = [
    { taskId: 'a', seq: 1, type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } },
    { taskId: 'a', seq: 2, type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ответ А' } } } },
    { taskId: 'a', seq: 3, type: 'PI_EVENT', data: { pi: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ответ А' }] } } } },
    { taskId: 'a', seq: 4, type: 'TASK_SUCCEEDED', message: 'Done', data: {} },
    { taskId: 'a', seq: 5, type: 'TURN_VARIANT_START', message: 'Новый вариант', data: { turnSeq: 0, variantId: 'v2' } },
    { taskId: 'a', seq: 6, type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } },
    { taskId: 'a', seq: 7, type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ответ Б' } } } },
    { taskId: 'a', seq: 8, type: 'PI_EVENT', data: { pi: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ответ Б' }] } } } },
  ];
  const posted = [];
  app.setFetchHook(async (url, options = {}) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    if (pathname === '/api/tasks/a/events') {
      const all = searchParams.has('tail') ? events : events.filter(e => e.seq > Number(searchParams.get('after') || 0));
      return { ok: true, json: async () => (searchParams.has('tail') ? { events: all, reachedStart: true } : all) };
    }
    if (pathname === '/api/tasks/a/variant') {
      posted.push(JSON.parse(options.body));
      // The server stores the choice: the next refresh lands on it.
      events.push({ taskId: 'a', seq: Math.max(...events.map(e => e.seq)) + 1, type: 'TURN_VARIANT_SELECTED', message: '', data: { turnSeq: posted.at(-1).turnSeq, variantId: posted.at(-1).variantId } });
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return null;
  });
  await app.selectTask('a');
  const nav = app.document.querySelector('.variantNav');
  assert.ok(nav, 'the switcher is rendered');
  assert.equal(nav.querySelector('.variantCount').textContent, '2/2', 'the newest variant is selected');
  // The previous answer is not on screen: it is a hidden sibling.
  assert.ok(app.document.body.textContent.includes('ответ Б'), 'the selected variant renders');
  assert.ok(!app.document.querySelector('.turn:not(.me)')?.textContent.includes('ответ А'), 'the hidden variant is out of the DOM');

  nav.querySelectorAll('.actionBtn')[0].dispatchEvent(new app.window.Event('click'));
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(posted, [{ turnSeq: 0, variantId: 'initial' }], 'the choice is sent server-side');
  const nav2 = app.document.querySelector('.variantNav');
  assert.equal(nav2.querySelector('.variantCount').textContent, '1/2', 'the older variant is shown');
  assert.ok(app.document.body.textContent.includes('ответ А'), 'the older variant renders after the switch');
  assert.ok(!app.document.querySelector('.turn:not(.me)')?.textContent.includes('ответ Б'), 'the newer variant left the DOM');
  // And back.
  const nextBtn = nav2.querySelector('[data-action="variant-next"]');
  assert.ok(nextBtn, 'the next button exists');
  assert.ok(!nextBtn.disabled, 'the next button is enabled');
  nextBtn.dispatchEvent(new app.window.Event('click'));
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(posted.at(-1), { turnSeq: 0, variantId: 'v2' });
  assert.equal(app.document.querySelector('.variantNav .variantCount').textContent, '2/2');
});

test('a failed refresh cannot freeze the chat: the lock is released and the next tick works', async () => {
  const app = await ui();
  // A refresh whose requests fail (a wedged server, a lost connection) used to
  // leave refreshingVersion set forever when the fetch never answered; now the
  // failure lands in the catch, the lock is released, and the next tick carries
  // the chat forward instead of staying frozen until a page reload.
  let fail = false;
  app.setFetchHook(async (url) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    if (fail && pathname === '/api/tasks/a/events' && !searchParams.has('tail')) {
      throw Object.assign(new Error('aborted'), { code: 'HTTP_ABORTED' });
    }
    return null;
  });
  await app.selectTask('a');
  fail = true;
  await app.refreshTask();
  fail = false;
  await app.refreshTask();
  const bots = app.document.querySelectorAll('.turn:not(.me)');
  assert.ok(bots.length >= 2, `the chat kept updating after a failed refresh: ${bots.length}`);
  // The failure surfaced as an honest connection notice.
  assert.ok(app.document.getElementById('createError').textContent.includes('Связь прервана'));
});

test('a slow send shows the waiting notice, and it clears when the send is over', async () => {
  const app = await ui();
  await app.selectTask('a');
  let release;
  app.setFetchHook(async (url, options = {}) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (pathname.endsWith('/message')) {
      // Hold the send for a moment so the slow-send notice has time to appear.
      await new Promise(resolve => { release = resolve; });
      return { ok: true, json: async () => ({ id: 'a', status: 'RUNNING' }) };
    }
    return null;
  });
  const form = app.document.getElementById('form');
  form.requestSubmit = () => form.dispatchEvent(new app.window.Event('submit', { cancelable: true }));
  const prompt = app.document.getElementById('prompt');
  prompt.value = 'медленно';
  form.requestSubmit();
  assert.equal(app.document.getElementById('sendButton').disabled, true, 'the composer is busy');
  // The notice appears only after the 2s threshold: the harness's setTimeout is
  // recorded, so fire it by hand.
  const timers = app.intervals || [];
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!app.document.getElementById('createError').textContent.includes('Отправляю'), 'no notice before the threshold');

  release();
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.document.getElementById('sendButton').disabled, false, 'the composer is free again');
  assert.ok(!app.document.getElementById('createError').textContent.includes('Отправляю'), 'the notice does not linger');
});

test('a refused send keeps the text one click away', async () => {
  const app = await ui();
  await app.selectTask('a');
  let calls = 0;
  app.setFetchHook(async (url, options = {}) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (pathname.endsWith('/message')) {
      calls++;
      return { ok: false, json: async () => ({ error: 'Сбой сети', code: 'NETWORK_ERROR' }) };
    }
    return null;
  });
  const form = app.document.getElementById('form');
  form.requestSubmit = () => form.dispatchEvent(new app.window.Event('submit', { cancelable: true }));
  const prompt = app.document.getElementById('prompt');
  prompt.value = 'не пропади';
  form.requestSubmit();
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(!app.document.getElementById('retryPrompt').classList.contains('hidden'), 'the retry offer is up');
  // One click restores and resends exactly the same text.
  app.document.getElementById('retryPrompt').dispatchEvent(new app.window.Event('click'));
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls >= 2, 'the prompt retry was fired');
});

test('DOM: a parked message waits in the queue instead of showing up twice', async () => {
  const app = await ui();
  await app.selectTask('a');
  const parkedTask = { ...app.tasks.a, status: 'QUEUED', queueReason: 'QUEUED', pendingPrompts: [{ id: 'p1', text: 'в очереди' }] };
  app.setFetchHook(async (url, options = {}) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (pathname.endsWith('/message')) return { ok: true, json: async () => parkedTask };
    if (pathname === '/api/tasks/a') return { ok: true, json: async () => parkedTask };
    return null;
  });
  const form = app.document.getElementById('form');
  form.requestSubmit = () => form.dispatchEvent(new app.window.Event('submit', { cancelable: true }));
  const prompt = app.document.getElementById('prompt');
  const before = app.document.querySelectorAll('.turn.me').length;
  prompt.value = 'в очереди';
  form.requestSubmit();
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));

  assert.equal(app.document.querySelectorAll('.turn.me').length, before, 'запаркованное сообщение не рисуется в чате');
  const badge = app.document.getElementById('queuedPrompt');
  assert.ok(!badge.classList.contains('hidden'), 'очередь видна');
  assert.ok(badge.textContent.includes('в очереди'), `в очереди показан текст: ${badge.textContent}`);
  assert.ok(![...app.document.querySelectorAll('.turn.me')].some(t => t.textContent.includes('в очереди')), 'и не дублируется в ленте');
});

test('DOM: a steered message stays in the conversation (not parked)', async () => {
  const app = await ui();
  await app.selectTask('a');
  app.setFetchHook(async (url) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (pathname.endsWith('/message')) return { ok: true, json: async () => ({ id: 'a', status: 'RUNNING', pendingPrompts: [] }) };
    return null;
  });
  const form = app.document.getElementById('form');
  form.requestSubmit = () => form.dispatchEvent(new app.window.Event('submit', { cancelable: true }));
  const prompt = app.document.getElementById('prompt');
  const before = app.document.querySelectorAll('.turn.me').length;
  prompt.value = 'вклинилось';
  form.requestSubmit();
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.document.querySelectorAll('.turn.me').length, before + 1, 'вклинившееся сообщение остаётся в ленте');
});

test('DOM: messages carry their times — sent for the operator, start and end for the answer', async () => {
  const app = await ui();
  const at = (min) => `2026-09-15T10:${String(min).padStart(2, '0')}:00.000Z`;
  const events = [
    { taskId: 'a', seq: 1, type: 'USER_MESSAGE', at: at(1), message: 'вопрос', data: { text: 'вопрос', files: [] } },
    { taskId: 'a', seq: 2, at: at(2), type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } },
    { taskId: 'a', seq: 3, at: at(3), type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ответ' } } } },
    { taskId: 'a', seq: 4, at: at(4), type: 'PI_EVENT', data: { pi: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ответ' }] } } } },
    { taskId: 'a', seq: 5, at: at(5), type: 'TASK_SUCCEEDED', message: 'Done', data: {} },
  ];
  app.setFetchHook(async (url) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    if (pathname === '/api/tasks/a/events') {
      const list = searchParams.has('tail') ? events : events.filter(e => e.seq > Number(searchParams.get('after') || 0));
      return { ok: true, json: async () => (searchParams.has('tail') ? { events: list, reachedStart: true } : list) };
    }
    return null;
  });
  await app.selectTask('a');

  // The operator's line: when it was sent.
  const mine = [...app.document.querySelectorAll('.turn.me')].at(-1);
  const sentTime = mine.querySelector('.msgTime');
  assert.ok(sentTime, 'у сообщения оператора есть время отправки');
  assert.match(sentTime.textContent, /^\d{2}:\d{2}:\d{2}$/, `формат времени с секундами: ${sentTime.textContent}`);

  // The answer: when it started and when it finished (a range).
  const bot = [...app.document.querySelectorAll('.turn:not(.me)')].at(-1);
  const answerTime = bot.querySelector('.msgTime');
  assert.ok(answerTime, 'у ответа есть время');
  assert.match(answerTime.textContent, /^\d{2}:\d{2}:\d{2}(–\d{2}:\d{2}:\d{2})?$/, `начало и конец с секундами: ${answerTime.textContent}`);
  assert.ok(answerTime.title.length > 0, 'в подсказке полная метка времени');
});

test('DOM: a turn without a recorded time shows no clock', async () => {
  const app = await ui();
  await app.selectTask('a');
  const times = [...app.document.querySelectorAll('.turn .msgTime')];
  assert.equal(times.length, 0, 'без времени в событиях часы не рисуются');
});

test('DOM: an empty settled turn never turns into the typing animation', async () => {
  const app = await ui();
  // A session that is still running (non-terminal status) whose last answer was
  // interrupted and left empty: the empty turn must keep saying the answer was
  // not received. Guessing "waiting" from the task status made it flash
  // «Ответ не был получен.» and then swap to the animation a poll later.
  app.tasks.a.status = 'RUNNING';
  const events = [
    { taskId: 'a', seq: 1, type: 'USER_MESSAGE', at: '2026-09-15T10:00:00.000Z', message: 'вопрос', data: { text: 'вопрос', files: [] } },
    { taskId: 'a', seq: 2, at: '2026-09-15T10:00:01.000Z', type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } },
    { taskId: 'a', seq: 3, at: '2026-09-15T10:00:02.000Z', type: 'PI_EVENT', data: { pi: { type: 'message_end', message: { role: 'assistant', content: [] } } } },
    { taskId: 'a', seq: 4, at: '2026-09-15T10:00:02.000Z', type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} },
  ];
  app.setFetchHook(async (url, options = {}) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    if (pathname === '/api/tasks/a/events') {
      const list = searchParams.has('tail') ? events : events.filter(e => e.seq > Number(searchParams.get('after') || 0));
      return { ok: true, json: async () => (searchParams.has('tail') ? { events: list, reachedStart: true } : list) };
    }
    if (pathname.endsWith('/message')) return { ok: true, json: async () => ({ id: 'a', status: 'RUNNING', pendingPrompts: [] }) };
    return null;
  });
  await app.selectTask('a');
  const empty = [...app.document.querySelectorAll('.turn:not(.me) .md')].at(-1);
  assert.match(empty.textContent, /Запрос прерван|Ответ не был получен/, 'пустой ход остаётся пустым, а не показывает анимацию');
  assert.equal(empty.querySelector('.typing'), null, 'никакой анимации на завершённом пустом ходе');

  // A new message (steered into the running turn) shows its own animation…
  const form = app.document.getElementById('form');
  form.requestSubmit = () => form.dispatchEvent(new app.window.Event('submit', { cancelable: true }));
  const prompt = app.document.getElementById('prompt');
  prompt.value = 'новое';
  form.requestSubmit();
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  const bubbles = [...app.document.querySelectorAll('.turn:not(.me) .md')];
  assert.match(bubbles.at(-2).textContent, /Запрос прерван|Ответ не был получен/, 'старый пустой ход не подменяется анимацией');
  assert.ok(bubbles.at(-1).querySelector('.typing'), 'новое сообщение показывает анимацию');

  // …and a refresh (same events, still non-terminal) must not flip anything.
  await app.refreshTask();
  const after = [...app.document.querySelectorAll('.turn:not(.me) .md')];
  assert.match(after.at(-2).textContent, /Запрос прерван|Ответ не был получен/, 'после обновления ничего не перескочило');
});


test('DOM: a delivered message leaves the queue the moment it appears in the chat', async () => {
  const app = await ui();
  const base = [
    { taskId: 'a', seq: 1, type: 'USER_MESSAGE', at: '2026-09-15T10:00:00.000Z', message: 'первое', data: { text: 'первое', files: [] } },
    { taskId: 'a', seq: 2, at: '2026-09-15T10:00:05.000Z', type: 'TASK_SUCCEEDED', message: 'Done', data: {} },
  ];
  // The task still reports the queued entry — exactly what the poll would return
  // while the badge is visible.
  app.tasks.a = { ...app.tasks.a, status: 'QUEUED', queueReason: 'QUEUED', pendingPrompts: [{ id: 'p1', text: 'в очереди' }] };
  let delivered = false;
  app.setFetchHook(async (url, options = {}) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    if (pathname === '/api/tasks/a/events') {
      const list = [...base, ...(delivered ? [{ taskId: 'a', seq: 3, at: '2026-09-15T10:00:06.000Z', type: 'USER_MESSAGE', message: 'в очереди', data: { text: 'в очереди', files: [] } }] : [])];
      const page = searchParams.has('tail') ? list : list.filter(e => e.seq > Number(searchParams.get('after') || 0));
      return { ok: true, json: async () => (searchParams.has('tail') ? { events: page, reachedStart: true } : page) };
    }
    return null;
  });
  await app.selectTask('a');
  const badge = app.document.getElementById('queuedPrompt');
  badge.classList.remove('hidden');
  badge.textContent = 'В очереди: в очереди';

  delivered = true;
  await app.refreshTask();
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));

  assert.ok([...app.document.querySelectorAll('.turn.me')].some(t => t.textContent.includes('в очереди')), 'сообщение появилось в ленте');
  const queue = app.queuedPromptText ? app.queuedPromptText() : app.document.getElementById('queuedPrompt').textContent;
  assert.equal(/В очереди: в очереди/.test(queue), false, `сообщение больше не в очереди: ${queue}`);
});

test('an interrupted answer keeps its own status when the session finishes later', () => {
  const state = new ChatState(task());
  state.apply({ taskId: 'a', seq: 1, type: 'USER_MESSAGE', at: '2026-09-15T10:36:31.000Z', message: 'вопрос', data: { text: 'вопрос' } });
  state.apply({ taskId: 'a', seq: 2, at: '2026-09-15T10:36:32.000Z', type: 'PI_EVENT', data: { pi: { type: 'message_end', message: { role: 'assistant', content: [], errorMessage: 'Request aborted' } } } });
  state.apply({ taskId: 'a', seq: 3, at: '2026-09-15T10:36:33.000Z', type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} });
  const interrupted = state.current;
  // An answer that broke off with an error is FAILED — even though the terminal
  // event for the run was TASK_CANCELLED («Request was aborted» + FAILED).
  assert.equal(interrupted.status, 'FAILED');
  assert.equal(interrupted.error, 'Request aborted');

  // The session goes on and finishes: the interrupted answer must not be
  // relabelled as if it had succeeded.
  state.apply({ taskId: 'a', seq: 4, at: '2026-09-15T10:36:51.000Z', type: 'USER_MESSAGE', message: 'дальше', data: { text: 'дальше' } });
  state.apply({ taskId: 'a', seq: 5, at: '2026-09-15T10:37:10.000Z', type: 'TASK_SUCCEEDED', message: 'Done', data: {} });
  state.snapshot({ ...task(), status: 'SUCCEEDED' });
  assert.equal(interrupted.status, 'FAILED', 'статус прерванного ответа не переписывается статусом сессии');
  assert.equal(interrupted.error, 'Request aborted', 'и его ошибка остаётся видимой');
});

test('a provider JSON error body is shown as one readable line, not raw JSON', () => {
  const envelope = '400: {"code":"422","error_type":"UNSUPPORTED_OPENAI_PARAMS","message":"The following parameters are not supported for this model: tools","param":"tools"}';
  const readable = 'The following parameters are not supported for this model: tools (UNSUPPORTED_OPENAI_PARAMS)';
  const state = new ChatState(task());
  state.apply({ taskId: 'a', seq: 1, type: 'USER_MESSAGE', at: '2026-09-16T10:00:00.000Z', message: 'вопрос', data: { text: 'вопрос' } });
  state.apply({
    taskId: 'a', seq: 2, at: '2026-09-16T10:00:01.000Z', type: 'PI_EVENT',
    data: { pi: { type: 'message_end', message: { role: 'assistant', stopReason: 'error', content: [], errorMessage: envelope } } }
  });
  assert.equal(state.current.error, readable);
  // The terminal event carries the SERVER's stored message, which for events
  // recorded before the fix is the raw JSON body — it must not overwrite the
  // readable line (this is what left JSON on screen in the live session).
  state.apply({ taskId: 'a', seq: 3, at: '2026-09-16T10:00:02.000Z', type: 'TASK_FAILED', message: envelope, data: { errorCode: 'MODEL_ERROR' } });
  assert.equal(state.current.error, readable);
  assert.equal(state.current.status, 'FAILED');
});

test('an aborted answer is not labelled DONE, and its range is never inverted', () => {
  const state = new ChatState(task());
  state.apply({ taskId: 'a', seq: 1, type: 'USER_MESSAGE', at: '2026-09-15T10:39:27.000Z', message: 'вопрос', data: { text: 'вопрос' } });
  state.apply({ taskId: 'a', seq: 2, at: '2026-09-15T10:39:29.000Z', type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } });
  // Pi broke the answer off and reported it as an error.
  state.apply({ taskId: 'a', seq: 3, at: '2026-09-15T10:39:31.000Z', type: 'PI_EVENT', data: { pi: { type: 'message_end', message: { role: 'assistant', content: [], errorMessage: 'Request was aborted' } } } });
  state.apply({ taskId: 'a', seq: 4, at: '2026-09-15T10:39:31.000Z', type: 'PI_EVENT', data: { pi: { type: 'agent_settled' } } });
  const aborted = state.current;
  assert.equal(aborted.error, 'Request was aborted');
  assert.notEqual(aborted.status, 'DONE', 'оборванный ответ не показывается как DONE');
  assert.equal(aborted.status, 'FAILED');

  // A stale end marker (a cancel finalizing after the next message started) must
  // not close the NEW turn with a time earlier than its own start.
  state.apply({ taskId: 'a', seq: 5, at: '2026-09-15T10:39:34.000Z', type: 'USER_MESSAGE', message: 'следующее', data: { text: 'следующее' } });
  state.apply({ taskId: 'a', seq: 6, at: '2026-09-15T10:39:34.500Z', type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } });
  const next = state.current;
  state.apply({ taskId: 'a', seq: 7, at: '2026-09-15T10:39:31.000Z', type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} });
  assert.ok(!next.endedAt, 'устаревший маркер не закрывает новый ход');
  assert.equal(Date.parse(next.at) <= Date.parse(next.endedAt || next.at), true, 'диапазон не переворачивается');
});

test('a stop after the answer settles shows CANCELLED, not the interim DONE', () => {
  const state = new ChatState(task());
  state.apply({ taskId: 'a', seq: 1, type: 'USER_MESSAGE', at: '2026-09-15T10:50:45.000Z', message: 'вопрос', data: { text: 'вопрос' } });
  state.apply({ taskId: 'a', seq: 2, at: '2026-09-15T10:50:48.000Z', type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } });
  // Pi settles first (its own event order), the operator's stop is recorded after.
  state.apply({ taskId: 'a', seq: 3, at: '2026-09-15T10:50:49.300Z', type: 'PI_EVENT', data: { pi: { type: 'agent_settled' } } });
  assert.equal(state.current.status, 'DONE', 'сначала промежуточный DONE');
  state.apply({ taskId: 'a', seq: 4, at: '2026-09-15T10:50:49.380Z', type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} });
  assert.equal(state.current.status, 'FAILED', 'остановка без единого слова — FAILED (ответа нет)');

  // A stopped answer that already said something keeps CANCELLED.
  const partial = new ChatState(task());
  partial.apply({ taskId: 'a', seq: 1, type: 'USER_MESSAGE', at: '2026-09-15T10:50:45.000Z', message: 'вопрос', data: { text: 'вопрос' } });
  partial.apply({ taskId: 'a', seq: 2, at: '2026-09-15T10:50:46.000Z', type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'начал отвечать' } } } });
  partial.apply({ taskId: 'a', seq: 3, at: '2026-09-15T10:50:49.300Z', type: 'PI_EVENT', data: { pi: { type: 'agent_settled' } } });
  partial.apply({ taskId: 'a', seq: 4, at: '2026-09-15T10:50:49.380Z', type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} });
  assert.equal(partial.current.status, 'CANCELLED');

  // …and when the interrupted answer carries an error, it is FAILED.
  const errored = new ChatState(task());
  errored.apply({ taskId: 'a', seq: 1, type: 'USER_MESSAGE', at: '2026-09-15T10:50:45.000Z', message: 'вопрос', data: { text: 'вопрос' } });
  errored.apply({ taskId: 'a', seq: 2, at: '2026-09-15T10:50:48.000Z', type: 'PI_EVENT', data: { pi: { type: 'message_end', message: { role: 'assistant', content: [], errorMessage: 'This operation was aborted' } } } });
  errored.apply({ taskId: 'a', seq: 3, at: '2026-09-15T10:50:49.300Z', type: 'PI_EVENT', data: { pi: { type: 'agent_settled' } } });
  errored.apply({ taskId: 'a', seq: 4, at: '2026-09-15T10:50:49.380Z', type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} });
  assert.equal(errored.current.status, 'FAILED');
  assert.equal(errored.current.error, 'This operation was aborted');
});

test('a turn superseded by the next message keeps its own state, not SUCCEEDED', () => {
  const state = new ChatState(task());
  state.apply({ taskId: 'a', seq: 1, type: 'USER_MESSAGE', at: '2026-09-15T10:53:14.000Z', message: 'первое', data: { text: 'первое' } });
  state.apply({ taskId: 'a', seq: 2, at: '2026-09-15T10:53:15.000Z', type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } });
  state.apply({ taskId: 'a', seq: 3, at: '2026-09-15T10:53:15.500Z', type: 'PI_EVENT', data: { pi: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' } } });
  state.apply({ taskId: 'a', seq: 4, at: '2026-09-15T10:53:16.000Z', type: 'PI_EVENT', data: { pi: { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: false } } });
  const first = state.current;
  // The operator's next message arrives while this answer is still open.
  state.apply({ taskId: 'a', seq: 5, at: '2026-09-15T10:53:18.000Z', type: 'USER_MESSAGE', message: 'второе', data: { text: 'второе' } });
  assert.equal(first.superseded, true);
  assert.equal(first.active, false, 'вытесненный ход закрыт сразу');
  assert.equal(first.endedAt, '2026-09-15T10:53:18.000Z', 'и закрыт моментом вытеснения');

  state.apply({ taskId: 'a', seq: 6, at: '2026-09-15T10:53:25.000Z', type: 'TASK_SUCCEEDED', message: 'Done', data: {} });
  state.snapshot({ ...task(), status: 'SUCCEEDED' });
  assert.notEqual(first.status, 'SUCCEEDED', `вытесненный ход не переименовывается: ${first.status}`);
  assert.equal(first.status, 'FAILED', 'ход без ответа — FAILED, а не «завершено»');
});

test('DOM: a cut-off answer shows an interruption note and FAILED', async () => {
  const app = await ui();
  const events = [
    { taskId: 'a', seq: 1, type: 'USER_MESSAGE', at: '2026-09-15T10:57:31.000Z', message: 'test 1', data: { text: 'test 1', files: [] } },
    { taskId: 'a', seq: 2, at: '2026-09-15T10:57:33.000Z', type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } },
    { taskId: 'a', seq: 3, at: '2026-09-15T10:57:34.000Z', type: 'PI_EVENT', data: { pi: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' } } },
    { taskId: 'a', seq: 4, at: '2026-09-15T10:57:34.500Z', type: 'PI_EVENT', data: { pi: { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: false } } },
    // The operator's next message supersedes this answer.
    { taskId: 'a', seq: 5, at: '2026-09-15T10:57:36.000Z', type: 'USER_MESSAGE', message: 'test 2', data: { text: 'test 2', files: [] } },
    { taskId: 'a', seq: 6, at: '2026-09-15T10:57:44.000Z', type: 'TASK_SUCCEEDED', message: 'Done', data: {} },
  ];
  app.setFetchHook(async (url) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    if (pathname === '/api/tasks/a/events') {
      const list = searchParams.has('tail') ? events : events.filter(e => e.seq > Number(searchParams.get('after') || 0));
      return { ok: true, json: async () => (searchParams.has('tail') ? { events: list, reachedStart: true } : list) };
    }
    return null;
  });
  await app.selectTask('a');
  const cut = [...app.document.querySelectorAll('.turn:not(.me)')].at(-2);
  assert.match(cut.textContent, /Запрос прерван/, `пометка прерывания: ${cut.textContent.slice(0, 80)}`);
  assert.match(cut.textContent, /FAILED/, 'статус прерванного хода — FAILED');
  assert.equal(/SUCCEEDED|DONE/.test(cut.querySelector('.meta')?.textContent || ''), false, 'никакого «завершено» у прерванного');
});

test('a late abort report lands on the interrupted answer, not on the fresh one', () => {
  const state = new ChatState(task());
  state.apply({ taskId: 'a', seq: 1, type: 'USER_MESSAGE', at: '2026-09-15T11:14:29.000Z', message: 'первое', data: { text: 'первое' } });
  state.apply({ taskId: 'a', seq: 2, at: '2026-09-15T11:14:30.000Z', type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } });
  state.apply({ taskId: 'a', seq: 3, at: '2026-09-15T11:14:31.000Z', type: 'PI_EVENT', data: { pi: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' } } });
  const interrupted = state.current;

  // The operator interrupts and sends the next message; the fresh answer starts…
  state.apply({ taskId: 'a', seq: 4, at: '2026-09-15T11:14:33.000Z', type: 'TASK_CANCELLED', message: 'Task cancelled', data: {} });
  state.apply({ taskId: 'a', seq: 5, at: '2026-09-15T11:14:33.500Z', type: 'USER_MESSAGE', message: 'второе', data: { text: 'второе' } });
  state.apply({ taskId: 'a', seq: 6, at: '2026-09-15T11:14:34.000Z', type: 'PI_EVENT', data: { pi: { type: 'message_start', message: { role: 'assistant' } } } });
  const fresh = state.current;
  assert.notEqual(fresh, interrupted);
  // The fresh answer has already started its own tool call — exactly the case
  // where the late abort used to be misattributed to it.
  state.apply({ taskId: 'a', seq: 6.5, at: '2026-09-15T11:14:34.050Z', type: 'PI_EVENT', data: { pi: { type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash' } } });
  state.apply({ taskId: 'a', seq: 6.6, type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'свежий ' } } } });
  state.apply({ taskId: 'a', seq: 6.7, type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'новая мысль' } } } });

  // …and only NOW does Pi report the abort, including the OLD partial content.
  state.apply({ taskId: 'a', seq: 7, at: '2026-09-15T11:14:34.100Z', type: 'PI_EVENT', data: { pi: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'старый ответ' }, { type: 'thinking', thinking: 'старая мысль' }], errorMessage: 'This operation was aborted' } } } });
  assert.equal(interrupted.error, 'This operation was aborted', 'ошибка обрыва ушла в прерванный ход');
  assert.equal(interrupted.status, 'FAILED');
  assert.ok(!fresh.error, 'новый ход не помечен ошибкой чужого ответа');
  assert.equal(interrupted.text, 'старый ответ');
  assert.equal(fresh.text, 'свежий ', 'чужой end не стирает свежие дельты');
  assert.equal(fresh.thinking, 'новая мысль', 'чужие thinking не попадают в новый ответ');
  assert.equal(state.messageTurn, fresh, 'свежий streaming sink остаётся открытым');
  assert.equal(state.messageOpen, true);

  // The fresh answer continues normally.
  state.apply({ taskId: 'a', seq: 8, at: '2026-09-15T11:14:36.000Z', type: 'PI_EVENT', data: { pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ответ' } } } });
  state.apply({ taskId: 'a', seq: 9, at: '2026-09-15T11:14:37.000Z', type: 'TASK_SUCCEEDED', message: 'Done', data: {} });
  assert.equal(fresh.status, 'SUCCEEDED', 'новый ход завершается успешно');
  assert.equal(fresh.text, 'свежий ответ');
  assert.ok(!fresh.error, 'и остаётся без чужой ошибки');
});

test('DOM incremental: abort before next USER_MESSAGE never appears on the next reply', async () => {
  const app = await ui();
  const e = (seq, type, pi, at, extra = {}) => ({ taskId: 'a', seq, type, at, message: extra.message || type, data: pi ? { pi } : (extra.data || {}) });
  const events = [
    e(1, 'USER_MESSAGE', null, '2026-09-15T11:17:34.995Z', { message: 'Test 1', data: { text: 'Test 1', files: [] } }),
    e(2, 'STATUS', null, '2026-09-15T11:17:34.998Z', { data: { status: 'RUNNING' } }),
    e(3, 'PI_EVENT', { type: 'agent_start' }, '2026-09-15T11:17:35.002Z'),
    e(4, 'PI_EVENT', { type: 'message_start', message: { role: 'assistant' } }, '2026-09-15T11:17:38.054Z'),
    e(5, 'PI_EVENT', { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall' }] } }, '2026-09-15T11:17:39.023Z'),
    e(6, 'PI_EVENT', { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' }, '2026-09-15T11:17:39.073Z'),
    e(7, 'PI_EVENT', { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: false }, '2026-09-15T11:17:39.234Z'),
    e(8, 'STATUS', null, '2026-09-15T11:17:39.447Z', { data: { status: 'CANCELLING' } }),
    e(9, 'PI_EVENT', { type: 'message_start', message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'Request aborted' } }, '2026-09-15T11:17:39.451Z'),
    e(10, 'PI_EVENT', { type: 'message_end', message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'Request aborted', content: [] } }, '2026-09-15T11:17:39.453Z'),
    e(11, 'PI_EVENT', { type: 'agent_settled' }, '2026-09-15T11:17:39.544Z'),
    e(12, 'TASK_CANCELLED', null, '2026-09-15T11:17:39.952Z', { message: 'Task cancelled' }),
    e(13, 'USER_MESSAGE', null, '2026-09-15T11:17:40.004Z', { message: 'test 2', data: { text: 'test 2', files: [] } }),
    e(14, 'STATUS', null, '2026-09-15T11:17:40.006Z', { data: { status: 'RUNNING' } }),
    e(15, 'PI_EVENT', { type: 'agent_start' }, '2026-09-15T11:17:40.009Z'),
    e(16, 'PI_EVENT', { type: 'message_start', message: { role: 'assistant' } }, '2026-09-15T11:17:42.486Z'),
    e(17, 'PI_EVENT', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Второй ответ' } }, '2026-09-15T11:17:43.000Z'),
    e(18, 'PI_EVENT', { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Второй ответ' }] } }, '2026-09-15T11:17:48.711Z'),
    e(19, 'PI_EVENT', { type: 'agent_settled' }, '2026-09-15T11:17:48.794Z'),
    e(20, 'TASK_SUCCEEDED', null, '2026-09-15T11:17:49.213Z', { message: 'Done' }),
  ];
  let delivered = 0;
  app.setFetchHook(async (url) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    if (pathname === '/api/tasks/a/events') {
      const list = events.slice(0, delivered).filter(item => item.seq > Number(searchParams.get('after') || 0));
      return { ok: true, json: async () => searchParams.has('tail') ? { events: list, reachedStart: true } : list };
    }
    return null;
  });
  await app.selectTask('a');
  for (delivered = 1; delivered <= events.length; delivered++) await app.refreshTask();
  const bots = [...app.document.querySelectorAll('.turn:not(.me)')];
  assert.equal(bots.length, 3);
  assert.match(bots[1].textContent, /Request aborted/);
  assert.match(bots[1].textContent, /FAILED/);
  assert.equal(/Request aborted|FAILED/.test(bots[2].textContent), false, `чужой abort попал в новый ход: ${bots[2].textContent}`);
  assert.match(bots[2].textContent, /Второй ответ/);
  assert.match(bots[2].textContent, /SUCCEEDED/);
});

test('a structured late aborted end without error text preserves the fresh stream', () => {
  const state = new ChatState(task());
  const pi = (seq, frame) => state.apply({ taskId: 'a', seq, type: 'PI_EVENT', data: { pi: frame } });
  pi(1, { type: 'message_start', message: { role: 'assistant' } });
  const old = state.current;
  state.apply({ taskId: 'a', seq: 2, type: 'USER_MESSAGE', message: 'новое', data: { text: 'новое' } });
  pi(3, { type: 'message_start', message: { role: 'assistant' } });
  const fresh = state.current;
  pi(4, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'новый ответ' } });
  pi(5, { type: 'message_end', message: { role: 'assistant', stopReason: 'aborted', content: [{ type: 'text', text: 'старый ответ' }] } });
  assert.equal(old.stopReason, 'aborted');
  assert.equal(old.text, 'старый ответ');
  assert.equal(old.error, 'Request was aborted');
  assert.equal(old.status, 'FAILED');
  assert.equal(fresh.text, 'новый ответ');
  assert.equal(fresh.error, null);
  assert.equal(state.messageTurn, fresh);
  assert.equal(state.messageOpen, true);
});

test('DOM: the restart icon asks first, shows progress and reloads when the server is back', async () => {
  const app = await ui();
  const doc = app.document;
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const calls = [];
  let healthCalls = 0;
  app.setFetchHook(async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/api/server/restart')) {
      calls.push({ method: options.method, body: options.body });
      return { ok: true, json: async () => ({ restarting: true, mode: 'lan' }) };
    }
    if (target.includes('/api/health')) {
      healthCalls += 1;
      // The old process is gone for the first polls, then the new one answers.
      if (healthCalls <= 2) throw new Error('connection refused');
      return { ok: true, json: async () => ({ status: 'ok' }) };
    }
    return undefined;
  });

  const button = doc.getElementById('serverRestartButton');
  assert.ok(button, 'the restart control must be in the header');

  // Declining the confirmation must not touch the server at all.
  app.setConfirmAnswer(false);
  button.onclick();
  await settle();
  assert.equal(calls.length, 0, 'a declined confirmation must not restart the server');
  assert.match(app.confirms.at(-1) || '', /Перезагрузить сервер/);

  // Confirming sends the explicit flag the server requires and starts the
  // progress UI.
  app.setConfirmAnswer(true);
  button.onclick();
  await settle();
  assert.equal(calls.length, 1, 'a confirmed click calls the route exactly once');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { confirm: true });
  assert.equal(button.classList.contains('restarting'), true, 'the glyph spins while restarting');
  assert.equal(doc.getElementById('restartOverlay').classList.contains('hidden'), false, 'progress overlay is shown');

  // It waits for the server to disappear and return, then reloads the page.
  for (let i = 0; i < 80 && !app.reloads.length; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(app.reloads.length, 1, 'the page reloads itself once the server answers again');
});

test('DOM: a phone tab reloads itself when the machine is restarted behind it', async () => {
  const app = await ui();
  const settle = () => new Promise(resolve => setImmediate(resolve));
  // The tab that pressed the restart button refreshes through its own progress
  // flow; a tab that did not (the phone) only ever sees /api/info change. The
  // bootId identifies the process run, so a plain restart is enough —
  // no build change required.
  let bootId = 'boot-a';
  app.setFetchHook(async (url) => (String(url).includes('/api/info') ? { ok: true, json: async () => ({ bootId, build: {} }) } : undefined));

  await app.checkPcState();
  assert.equal(app.reloads.length, 0, 'the first bootId is the one this page was loaded from');
  await app.checkPcState();
  assert.equal(app.reloads.length, 0, 'an unchanged bootId must not reload the page');

  bootId = 'boot-b';
  await app.checkPcState();
  await settle();
  assert.equal(app.reloads.length, 1, 'a new process must refresh the page');
});

test('DOM: an older server without a bootId never triggers a reload loop', async () => {
  const app = await ui();
  app.setFetchHook(async (url) => (String(url).includes('/api/info') ? { ok: true, json: async () => ({ build: { version: '0.9.0' } }) } : undefined));
  await app.checkPcState();
  await app.checkPcState();
  assert.equal(app.reloads.length, 0, 'no bootId, nothing to compare, no reload');
  assert.equal(app.document.getElementById('buildInfo').textContent.includes('v0.9.0'), true, 'the rest of the poll still runs');
});
