import { ChatState, ACTIVE_STATUSES } from './chat-state.mjs';
import { selectTransport } from './transport.mjs';
import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.mjs';
const $ = (id) => document.getElementById(id);

// One interface, two realities (docs/cloud-ui.md): same-origin HTTP + SSE when the
// page is served by the machine, the relay protocol when it is served from the
// cloud. A deployment that runs in the cloud injects window.__TASKBRIDGE_CLOUD__.
const transport = selectTransport({
  location,
  cloud: globalThis.__TASKBRIDGE_CLOUD__ || null,
  fetchImpl: typeof fetch === 'function' ? fetch.bind(globalThis) : undefined,
  EventSourceImpl: typeof EventSource === 'function' ? EventSource : undefined
});

marked.setOptions({ gfm: true, breaks: true });

let selectedTaskId = null;
// Set from /api/auth. `serverIsLocal` means native open/reveal is possible —
// this page runs on the machine itself, so a desktop application would actually
// be the operator's. `canExecute` means running on the machine is possible —
// true on the machine and for an authenticated client too, so a paired phone can
// run a command on the PC (the PC does the work; the phone just asks).
let serverIsLocal = false;
let canExecute = false;
let source = null;
let refreshTimer = null;
let liveTurn = null;        // { body, md, meta } of the current bot turn
let liveThinking = '';
let liveText = '';
let nearBottom = true;
let textUpdateTimer = null;
let chatState = null;
let selectionVersion = 0;
let refreshingVersion = null;
let turnNodes = new Map();
let liveActive = false;
// An empty newest turn is not a failure while the session still works: the
// answer may simply not have started yet (queued, just steered, mid-interrupt).
// Without this the placeholder «Ответ не был получен.» flashed and was replaced
// by the real answer a moment later.
let liveAwaiting = false;
// An answer may have no text yet still have done real work (reasoning, tool
// calls): «Ответ не был получен.» is for a turn that produced NOTHING.
let liveHasWork = false;
let liveCutOff = false;
let modelBusy = null;  // true/false/null(unknown) — from /api/info, refreshed every 4s
// Последний ответ /api/info про аккаунты провайдеров: смена модели в сессии
// не требует нового опроса, а строка под моделью меняется сразу.
let lastProviderStatuses = {};

// Interactive tool approvals (§52–§55). The Pi extension asks TaskBridge before
// a risky tool call; the request stays pending until an operator answers here
// or from the remote PWA.
let pendingApprovals = new Map();

const HISTORY_PAGE_TURNS = 20;

// A refresh whose requests never answer used to freeze the chat until a page
// reload: refreshingVersion stayed set and every later refresh skipped itself.
// These are refresh-only timeouts — a SEND may legitimately wait minutes for a
// model to load, so it is never aborted by them.
const REFRESH_TIMEOUT_MS = 20000;
let currentTask = null;
let reachedHistoryStart = true;
let oldestLoadedSeq = null;
let loadingOlder = false;

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    // navigator.clipboard requires a secure context; TaskBridge is served
    // over plain HTTP on the LAN, so phones fall back to execCommand.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

// One call path for both realities (docs/cloud-ui.md). The local transport talks
// HTTP to this server; the cloud transport sends protocol frames to the machine
// and answers a PC-only screen with NOT_SUPPORTED instead of pretending.
async function api(path, options = {}) {
  const method = options.method || (options.body === undefined ? 'GET' : 'POST');
  const raw = options.body;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : null;
  // Call sites hand over an already serialized body; the transport takes objects
  // (and the cloud transport needs the structure, not a string).
  const body = raw === undefined ? undefined : (typeof raw === 'string' ? safeParse(raw) : raw);
  try {
    return await transport.request(method, path, body, timeoutMs);
  } catch (error) {
    if (error.code === 'AUTH_REQUIRED') showAuthGate();
    const network = !error.code || ['RELAY_OFFLINE', 'REQUEST_TIMEOUT'].includes(error.code);
    throw Object.assign(new Error(`${error.code || 'HTTP_ERROR'}: ${error.message}`), { code: error.code || 'HTTP_ERROR', network });
  }
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

// Every mutating request carries a commandId: a lost HTTP answer (Wi-Fi drop,
// phone sleep, reload) can then be retried with the SAME id and the server
// replays its recorded outcome instead of running the action twice.
function newCommandId() {
  return (globalThis.crypto && typeof crypto.randomUUID === 'function' && crypto.randomUUID())
    || `cmd-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function commandClientId() {
  try {
    let id = localStorage.getItem('tbClientId');
    if (!id) { id = newCommandId(); localStorage.setItem('tbClientId', id); }
    return id;
  } catch { return 'web-client'; }
}

// POST with a commandId. A transport-level failure (the answer was lost, not
// the command) is retried once with the same id; if that also fails, the
// server's command ledger decides: accepted → the operator is told the send
// is unconfirmed but may have landed, otherwise the error stands.
async function commandApi(path, payload) {
  const commandId = newCommandId();
  let networkError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await api(path, { method: 'POST', body: JSON.stringify({ ...payload, commandId, clientId: commandClientId() }) });
    } catch (error) {
      if (!error.network || attempt) { networkError = error; break; }
    }
  }
  const status = await api(`/api/commands/${encodeURIComponent(commandId)}`).catch(() => null);
  if (status && (status.status === 'ACCEPTED' || status.status === 'DISPATCHING' || status.status === 'COMPLETED')) {
    const ambiguous = new Error('Отправка не подтверждена: соединение пропало. Возможно, сервер получил сообщение — проверьте историю.');
    throw Object.assign(ambiguous, { commandId, ambiguous: true, cause: networkError });
  }
  throw Object.assign(networkError, { commandId });
}

/* ---------------- chat rendering ---------------- */

function hideEmptyState() {
  const e = $('emptyState');
  if (e) e.remove();
}

function botBadge() {
  const badge = document.createElement('div');
  badge.className = 'botBadge';
  badge.title = 'Ответ Pi';
  badge.setAttribute('aria-label', 'Ответ Pi');
  badge.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 L14 9 L21 12 L14 15 L12 22 L10 15 L3 12 L10 9 Z"/></svg>';
  return badge;
}

const IMAGE_MIME_RE = /^image\//;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const PDF_EXT_RE = /\.pdf$/i;
// Markdown shown in the built-in viewer is rendered, not dumped as raw text.
const MARKDOWN_EXT_RE = /\.(?:md|markdown|mdx)$/i;
const isMarkdownFile = name => MARKDOWN_EXT_RE.test(String(name || ''));
const CSV_EXT_RE = /\.(?:csv|tsv)$/i;
const viewerLanguage = name => (String(name).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';

// Minimal CSV/TSV reader: handles quoted fields (with "" escapes) so a cell that
// contains the delimiter is not split.
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function delimitedTable(name, text) {
  const rows = parseDelimited(text, /\.tsv$/i.test(name) ? '\t' : ',').filter(row => row.some(cell => cell !== ''));
  const wrap = document.createElement('div');
  wrap.className = 'tableWrap';
  const table = document.createElement('table');
  const [header, ...body] = rows;
  if (header) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const cell of header) { const th = document.createElement('th'); th.textContent = cell; tr.append(th); }
    thead.append(tr);
    table.append(thead);
  }
  const tbody = document.createElement('tbody');
  for (const row of body) {
    const tr = document.createElement('tr');
    for (const cell of row) { const td = document.createElement('td'); td.textContent = cell; tr.append(td); }
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  return wrap;
}
// Files the machine can run as scripts (mirror of scriptCommand on the server).
// Only these get the "выполнить" action.
const RUNNABLE_EXT_RE = /\.(?:bat|cmd|ps1|sh|bash|py|js|mjs|cjs|rb|pl)$/i;
// Text and source files are rendered in the built-in viewer. The list is by
// extension because the name is all a chat chip has; anything unknown is handed
// to the browser instead of guessing it is text and dumping binary noise.
const TEXT_EXT_RE = /\.(?:txt|text|md|markdown|log|csv|tsv|json|jsonl|ndjson|xml|ya?ml|toml|ini|cfg|conf|properties|env|patch|diff|sh|bash|zsh|bat|cmd|ps1|sql|c|h|cc|cpp|cxx|hpp|cs|java|kt|kts|gradle|py|rb|go|rs|swift|php|pl|lua|dart|ts|tsx|js|mjs|cjs|jsx|css|scss|less|sass|vue|svelte|html?|svg|gitignore|editorconfig)$/i;

// An attached file is treated as a picture when the server said its MIME type is
// an image or, failing that, when the name carries a known image extension.
function isImageFile(file) {
  if (!file || typeof file !== 'object') return false;
  return (typeof file.mimeType === 'string' && IMAGE_MIME_RE.test(file.mimeType))
    || IMAGE_EXT_RE.test(String(file.name || ''));
}

function fileUrl(taskId, fileId, download) {
  return `/api/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}${download ? '?download=1' : ''}`;
}

// Renders an uploaded image inline in the conversation instead of only a chip,
// so a picture sent to the chat is actually visible. Uses the same endpoint the
// download chip points at, which serves the file inline for image types.
function imagePreview(file, taskId) {
  if (!isImageFile(file) || !file.id) return null;
  const link = document.createElement('a');
  link.href = fileUrl(taskId, file.id, false);
  link.target = '_blank';
  link.rel = 'noopener';
  link.className = 'chatImage';
  link.title = file.name;
  const img = document.createElement('img');
  img.src = fileUrl(taskId, file.id, false);
  img.alt = file.name;
  img.loading = 'lazy';
  link.append(img);
  return link;
}

function fileCard(file, taskId) {
  const card = document.createElement('span');
  card.className = 'fileChip';
  const viewUrl = fileUrl(taskId, file.id, false);
  const open = document.createElement('a');
  open.href = viewUrl;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = `📎 ${file.name}`;
  // On the machine a plain click opens the file with its own application (the
  // localhost-only route). Everywhere else, and as a fallback, it opens the
  // built-in viewer. A modifier click still opens a new tab.
  // A plain click always opens the built-in viewer — the same behaviour on the
  // phone and on the PC. Native actions live on their own icons below.
  open.onclick = (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    openFileViewer({ url: viewUrl, name: file.name });
  };
  const download = document.createElement('a');
  download.href = fileUrl(taskId, file.id, true);
  download.className = 'downloadIcon';
  download.title = 'Скачать';
  download.setAttribute('aria-label', `Скачать ${file.name}`);
  // Inline SVG, not the glyph U+2B73: that rare codepoint is missing from many fonts and rendered as a tofu box instead of a download arrow.
  download.append(messageIcon('download'));
  // Reveal the file in the machine's file manager (Explorer/Finder/…). Only
  // shown where it can work — CSS keeps it hidden unless body.machine-local.
  const reveal = document.createElement('a');
  reveal.href = '#';
  reveal.className = 'revealIcon';
  reveal.title = 'Показать в папке';
  reveal.setAttribute('aria-label', `Показать ${file.name} в папке`);
  reveal.append(messageIcon('folder'));
  reveal.onclick = (event) => { event.preventDefault(); machineActionAlert(machineOpenPath(viewUrl), true); };
  // Script files get a "выполнить" action next to open/reveal. It runs on the
  // machine — allowed on the machine and for an authenticated client (a phone)
  // — so it is hidden only where running is impossible (CSS, body.machine-exec)
  // and always asks before running anything.
  // Machine-only: open with the OS application (↗). The folder icon (📂) is the
  // reveal action; both are explicit so a plain click stays consistent.
  const openNative = document.createElement('a');
  openNative.href = '#';
  openNative.className = 'openIcon';
  openNative.title = 'Открыть в приложении';
  openNative.setAttribute('aria-label', `Открыть ${file.name} в приложении`);
  openNative.append(messageIcon('external'));
  openNative.onclick = (event) => { event.preventDefault(); machineActionAlert(machineOpenPath(viewUrl), false); };
  const actions = [openNative, reveal];
  if (isRunnableFile(file.name)) {
    const run = document.createElement('a');
    run.href = '#';
    run.className = 'runIcon';
    run.title = 'Выполнить скрипт';
    run.setAttribute('aria-label', `Выполнить ${file.name}`);
    run.append(messageIcon('run'));
    run.onclick = (event) => { event.preventDefault(); runOnMachine(viewUrl, file.name, run); };
    actions.push(run);
  }
  card.append(open, ...actions, download);
  return card;
}

function renderOutputFiles(files) {
  const el = $('outputFiles');
  el.innerHTML = '';
  if (!files.length || !selectedTaskId) { el.textContent = '—'; return; }
  for (const f of files) el.append(fileCard(f, selectedTaskId));
}

// One copy button for every message — Pi's answers and the operator's own
// lines alike (a prompt is often repeated or moved to another session). The
// text is read at click time from `_text`, so a streaming turn copies what is
// on screen now. The mark is the same inline SVG as the other message icons;
// on click it becomes a check or a cross for a moment as feedback.
function copyButton(text = '', label = 'Скопировать сообщение') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copyBtn';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn._text = text;
  const show = name => { btn.textContent = ''; btn.append(messageIcon(name)); };
  show('copy');
  btn.onclick = async () => {
    const ok = await copyText(btn._text || '');
    show(ok ? 'check' : 'cross');
    setTimeout(() => show('copy'), 1200);
  };
  return btn;
}

// Message times: HH:MM locally, with the full stamp in the tooltip. Nothing is
// invented — a turn without a recorded time shows nothing.
function timeLabel(value) {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return {
    text: at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    full: at.toLocaleString('ru-RU')
  };
}

function timeEl(value, { range = null } = {}) {
  const start = timeLabel(value);
  if (!start) return null;
  // An end that precedes the start is a stale marker (an overlapping cancel
  // finalizing after the next message started), not a real duration.
  let end = range ? timeLabel(range) : null;
  if (end && Date.parse(range) < Date.parse(value)) end = null;
  const span = document.createElement('span');
  span.className = 'msgTime';
  span.textContent = end && end.text !== start.text ? `${start.text}–${end.text}` : start.text;
  span.title = end ? `${start.full} → ${end.full}` : start.full;
  span._shown = span.textContent;
  span._title = span.title;
  return span;
}

// Updates a turn's time in place (a streaming answer must not rebuild its row)
// and hides it when the turn carries no recorded time at all.
function setTurnTime(node, turn, host) {
  if (!host) return;
  const startVal = turn.at || turn.userAt;
  const next = timeEl(startVal, { range: turn.endedAt });
  if (!next) { node.timeEl?.remove(); node.timeEl = null; return; }
  if (node.timeEl && node.timeEl.parentElement === host) {
    if (node.timeEl._shown !== next.textContent) { node.timeEl.textContent = next.textContent; node.timeEl._shown = next.textContent; }
    if (node.timeEl._title !== next.title) { node.timeEl.title = next.title; node.timeEl._title = next.title; }
    return;
  }
  node.timeEl?.remove();
  node.timeEl = next;
  host.append(next);
}

function appendUserTurn(text, files = [], before = null, at = null) {
  hideEmptyState();
  const turn = document.createElement('div');
  turn.className = 'turn me';
  const body = document.createElement('div');
  body.className = 'body';
  const bubble = document.createElement('div');
  bubble.className = 'msg s-me';
  bubble.textContent = text;
  body.append(bubble);
  if (files.length && selectedTaskId) {
    const list = document.createElement('div');
    list.className = 'attachedFiles';
    for (const f of files) {
      const preview = f.id ? imagePreview(f, selectedTaskId) : null;
      if (preview) body.append(preview);
      list.append(f.id ? fileCard(f, selectedTaskId) : Object.assign(document.createElement('span'), { className: 'fileChip', textContent: `📎 ${f.name}` }));
    }
    body.append(list);
  }
  // Copy and any message actions (edit/fork/drop) share one row, so the copy
  // button is not stranded on a line above the rest of the icons.
  const msgActions = document.createElement('div');
  msgActions.className = 'msgActions';
  msgActions.append(copyButton(text, 'Скопировать сообщение'));
  const sentAt = timeEl(at);
  if (sentAt) msgActions.append(sentAt);
  body.append(msgActions);
  turn.append(body);
  $('msgsInner').insertBefore(turn, before);
  if (!before) scrollBottom();
  return turn;
}

function reasoningEl(text) {
  const details = document.createElement('details');
  details.className = 'reasoning';
  const summary = document.createElement('summary');
  summary.textContent = `Рассуждение · ${text.length} симв.`;
  const pre = document.createElement('pre');
  pre.className = 'r-text';
  pre.textContent = text;
  details.append(summary, pre);
  return details;
}

function appendBotTurn() {
  hideEmptyState();
  const turn = document.createElement('div');
  turn.className = 'turn';
  const body = document.createElement('div');
  body.className = 'body';
  const bubble = document.createElement('div');
  bubble.className = 'msg s-bot';
  const md = document.createElement('div');
  md.className = 'md';
  bubble.append(md);
  const meta = document.createElement('div');
  meta.className = 'meta';
  const copyBtn = copyButton('', 'Скопировать ответ');
  const metaRow = document.createElement('div');
  metaRow.className = 'metaRow';
  metaRow.append(botBadge(), meta, copyBtn);
  body.append(bubble, metaRow);
  turn.append(body);
  $('msgsInner').append(turn);
  liveTurn = { body, bubble, md, meta, metaRow, copyBtn, turn };
  updateThinking();
  updateText();
  scrollBottom();
}

function updateThinking() {
  if (!liveTurn) return;
  const el = liveTurn.body.querySelector(':scope > .reasoning');
  if (!liveThinking) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    liveTurn.body.insertBefore(reasoningEl(liveThinking), liveTurn.body.firstChild);
  } else {
    el.querySelector('.r-text').textContent = liveThinking;
    el.querySelector('summary').textContent = `Рассуждение · ${liveThinking.length} симв.`;
  }
  scrollBottom();
}

const TYPING_HTML = '<div class="typing"><i></i><i></i><i></i></div>';

// The turn OBJECT was replaced (a rewritten answer keeps the same id but is a
// new object), so everything that belonged to the previous answer has to go:
// its tool chips above all, or a regenerated reply would still show the old
// commands. `.reasoning`, inline images and the error line go with them.
function resetTurnDom(node) {
  for (const chip of (node.tools || new Map()).values()) chip.remove();
  node.tools = new Map();
  if (node.body) {
    node.body.querySelector(':scope > .reasoning')?.remove();
    for (const stale of [...node.body.querySelectorAll(':scope > .tool, :scope > .toolGroup, :scope > .chatImage')]) stale.remove();
    node.toolGroup = null;
  }
  node.md?.querySelector('.turnError')?.remove();
  if (node.copyBtn) node.copyBtn._text = '';
  // Force the next comparison to see "everything changed".
  node.text = node.thinking = node.status = node.error = node.active = undefined;
}

// A turn that was cut off without an answer (a stop, or a message that
// superseded it) says so — «Request was aborted» when Pi gave a reason, an
// explicit note when it did not.
function turnCutOff(turn) {
  if (!turn || turn.role !== 'assistant' || !turn.final) return false;
  if (String(turn.text || '').trim()) return false;
  return turn.superseded === true || turn.status === 'FAILED';
}

function updateText() {
  if (!liveTurn) return;
  const text = liveText.trim();
  if (text) renderMarkdown(liveTurn.md, text);
  else if (liveActive || liveAwaiting) liveTurn.md.innerHTML = TYPING_HTML;
  else if (liveCutOff) liveTurn.md.innerHTML = '<span class="muted">Запрос прерван</span>';
  else if (liveHasWork) liveTurn.md.innerHTML = '<span class="muted">Без текста</span>';
  else liveTurn.md.innerHTML = '<span class="muted">Ответ не был получен.</span>';
  scrollBottom();
}

// Whether an empty assistant turn is still waiting for its answer. Both signals
// belong to the TURN, never to the lagging task status: `active` while it is
// generating, and "not final yet" for one that never finished. Guessing from the
// task status flipped a poll late — «Ответ не был получен.» flashed and then
// became the typing animation.
function answerMayStillCome(turn) {
  return turn.active === true || turn.final !== true;
}

function toolIcon(state) {
  return state === 'run' ? '…' : state === 'error' ? '✕' : '✓';
}

// «1 действие», «2 действия», «9 действий»: a count is followed by a declined
// noun, and the wrong form is the first thing read in a one-line summary.
function pluralNoun(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// From this many calls on, a turn's tool chips collapse into one line.
const TOOL_GROUP_MIN = 3;

// Calls that never reported success: an error, an interruption, or one that was
// still running when the turn ended (its end event may never arrive). The fold
// must not claim a clean run while a chip inside it still shows «…».
function toolTrouble(turn) {
  let failed = 0;
  let unfinished = 0;
  for (const tool of turn.tools) {
    if (tool.state === 'error') failed += 1;
    else if (tool.state === 'interrupted' || tool.state === 'run') unfinished += 1;
  }
  return { failed, unfinished };
}

// The collapsed line: how many calls, what they were, and — while the turn is
// still running — which one is in flight (the chip for it is inside the folded
// list, so without this the session would look idle between tool calls).
function toolGroupSummary(turn) {
  const total = turn.tools.length;
  const word = pluralNoun(total, 'действие', 'действия', 'действий');
  if (turn.active) {
    // Parallel calls are real, and the finished one may well be the last in the
    // list: the name belongs to a call still running, or the line lies.
    const running = [...turn.tools].reverse().find(tool => tool.state === 'run');
    const current = running || turn.tools[total - 1];
    // The name first: the folded line is truncated with an ellipsis on a narrow
    // screen, and what is running now is the part worth the room.
    return `⚙ ${current.name} ${toolIcon(current.state)}${current.progress ? ` · ${current.progress.split('\n')[0]}` : ""} · ${total} ${word}`;
  }
  const counts = new Map();
  for (const tool of turn.tools) counts.set(tool.name, (counts.get(tool.name) || 0) + 1);
  // The marker and the counts come before the breakdown, so truncation cannot
  // hide a run that did not come out clean.
  const { failed, unfinished } = toolTrouble(turn);
  const mark = failed ? '✕' : unfinished ? '■' : '✓';
  const trouble = [
    failed ? `${failed} ${pluralNoun(failed, 'ошибка', 'ошибки', 'ошибок')}` : '',
    unfinished ? `${unfinished} прервано` : '',
  ].filter(Boolean).join(' · ');
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${count} ${name}`)
    .join(' · ');
  return `${mark} ${total} ${word}${trouble ? ` · ${trouble}` : ''} · ${breakdown}`;
}

// A turn's tools either sit inline or live inside one collapsed group. Both
// renderChat (live tail) and renderSettledTurn (history backfill) hand their
// finished turn here, so a turn looks the same whichever path built it.
function layoutTools(node, turn) {
  if (!node.body) return;
  const chips = turn.tools.map(tool => node.tools.get(tool.id)).filter(Boolean);
  if (chips.length < TOOL_GROUP_MIN) {
    // Only reachable if a rewritten turn lost tools: a group is created when
    // the threshold is crossed and never undone by new tools arriving.
    if (node.toolGroup) {
      for (const chip of chips) node.body.insertBefore(chip, node.toolGroup.el);
      node.toolGroup.el.remove();
      node.toolGroup = null;
    }
    return;
  }
  if (!node.toolGroup) {
    const el = document.createElement('details');
    el.className = 'toolGroup';
    const summary = document.createElement('summary');
    const list = document.createElement('div');
    list.className = 'toolGroupList';
    el.append(summary, list);
    // In front of the first chip, so the fold lands where the chips were —
    // above the answer and below the reasoning block.
    const anchor = chips[0].parentNode === node.body ? chips[0] : (node.bubble || node.metaRow);
    node.body.insertBefore(el, anchor);
    node.toolGroup = { el, summary, list, text: null, signature: null };
  }
  const group = node.toolGroup;
  // Re-appending a chip that is already inside would still mutate the DOM on
  // every poll — the style recalc this whole branch exists to avoid.
  for (const chip of chips) if (chip.parentNode !== group.list) group.list.append(chip);
  // Only a tool starting, ending or the turn settling can change the line, and
  // building it is a Map, a sort and a join per folded turn per poll. The
  // signature is what those events move; the text is rebuilt when it changes.
  const signature = groupSignature(turn);
  if (group.signature !== signature) {
    group.signature = signature;
    group.text = toolGroupSummary(turn);
  }
  if (group.summary.textContent !== group.text) group.summary.textContent = group.text;
}

// The line depends on the count, on the tool in flight, and — once the turn is
// settled — on how its calls ended. A state can change after the turn settles
// (an end event arriving late) or never arrive at all, so the settled signature
// carries those counts and not just the length.
function groupSignature(turn) {
  if (!turn.active) {
    const { failed, unfinished } = toolTrouble(turn);
    return `done:${turn.tools.length}:${failed}:${unfinished}`;
  }
  const running = [...turn.tools].reverse().find(tool => tool.state === 'run');
  const current = running || turn.tools[turn.tools.length - 1];
  return `run:${turn.tools.length}:${current.name}:${current.state}:${current.progress || ""}`;
}

function appendInlineImage(relPath) {
  if (!liveTurn || !selectedTaskId) return;
  const url = `/api/tasks/${selectedTaskId}/workspace-file?path=${encodeURIComponent(relPath)}`;
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.className = 'chatImage';
  link.title = relPath;
  const img = document.createElement('img');
  img.src = url;
  img.alt = relPath;
  img.loading = 'lazy';
  // A refused path (403) or a file that disappeared since the turn ran leaves a
  // broken-image icon in the conversation. chat-state already filters paths the
  // server will refuse, but a missing or out-of-workspace file can only be told
  // apart by trying — so the preview withdraws itself instead of lying.
  img.onerror = () => link.remove();
  link.append(img);
  liveTurn.body.insertBefore(link, liveTurn.bubble || liveTurn.metaRow);
  scrollBottom();
}

/* ---------------- image context menu ---------------- */

// A single click on a chat picture opens the same kind of menu the browser
// shows on a long press (view / save / copy link), instead of navigating away.
// The menu is a light DOM popup positioned at the tap point.
let imageMenu = null;

function closeImageMenu() {
  if (!imageMenu) return;
  imageMenu.remove();
  imageMenu = null;
}

function imageMenuItems(src, alt) {
  const downloadUrl = `${src}${src.includes('?') ? '&' : '?'}download=1`;
  const absolute = new URL(src, location.href).href;
  const items = [
    ['Посмотреть', () => { openFileViewer({ url: src, name: alt }); }],
    ['Скачать', () => triggerDownload(downloadUrl, alt)],
    ['Копировать ссылку', () => { copyText(absolute); }]
  ];
  // On the machine the same picture can be opened in the OS image viewer or
  // revealed in the file manager; on a phone/cloud these do not apply.
  const openPath = serverIsLocal ? machineOpenPath(src) : null;
  if (openPath) {
    items.push(['Открыть в приложении', () => machineActionAlert(openPath, false)]);
    items.push(['Показать в папке', () => machineActionAlert(openPath, true)]);
  }
  return items;
}

function openImageMenu(x, y, src, alt = '') {
  closeImageMenu();
  const menu = document.createElement('div');
  menu.className = 'imageMenu';
  menu.setAttribute('role', 'menu');
  for (const [label, action] of imageMenuItems(src, alt)) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'imageMenuItem';
    item.setAttribute('role', 'menuitem');
    item.textContent = label;
    item.onclick = () => { closeImageMenu(); action(); };
    menu.append(item);
  }
  document.body.append(menu);
  // Keep the popup inside the viewport; linkedom has no layout, so fall back
  // to the raw tap point when the measurements are unavailable.
  const width = menu.getBoundingClientRect().width || 0;
  const height = menu.getBoundingClientRect().height || 0;
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  menu.style.left = `${Math.max(8, width && vw ? Math.min(x, vw - width - 8) : x)}px`;
  menu.style.top = `${Math.max(8, height && vh ? Math.min(y, vh - height - 8) : y)}px`;
  imageMenu = menu;
}

// Any chat image served by the workspace/files API gets the menu. Event
// delegation keeps this working for images added later (streaming, history).
document.addEventListener('click', (event) => {
  if (imageMenu && imageMenu.contains(event.target)) return;
  // A picture shown by the file viewer is not a chat picture: its clicks belong
  // to the viewer, not to the chat context menu.
  const viewer = $('fileViewerOverlay');
  if (viewer && viewer.contains(event.target)) return;
  const target = event.target;
  if (target && target.tagName === 'IMG') {
    const src = target.getAttribute('src') || '';
    if (src.includes('/api/tasks/')) {
      event.preventDefault();
      openImageMenu(event.clientX || 0, event.clientY || 0, src, target.getAttribute('alt') || target.getAttribute('title') || '');
      return;
    }
  }
  closeImageMenu();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeImageMenu(); });

/* ---------------- in-app file viewer ---------------- */

// Opening a file means seeing it, not being offered a download. Text and source
// files render inside the app (identical on desktop and in the Android
// browser), pictures zoom in, and a PDF is embedded where the browser can render
// it. Only files nothing can display fall back to the browser's own handling.
function isAndroid() {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
}

// A slow text fetch must not paint over the file opened after it.
let fileViewerRequest = 0;
function viewerKind(name) {
  if (isImageFile({ name })) return 'image';
  if (PDF_EXT_RE.test(String(name || ''))) return 'pdf';
  if (TEXT_EXT_RE.test(String(name || ''))) return 'text';
  return 'binary';
}

function downloadUrlFor(url) {
  return `${url}${url.includes('?') ? '&' : '?'}download=1`;
}

function triggerDownload(url, name) {
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  if (name) a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

// A new tab the browser owns: it renders what it can (image, PDF, text) and
// downloads what it cannot. Used when the in-app viewer has nothing to add, and
// by the "open in a new tab" action.
function openExternal(url) {
  if (!url) return;
  if (window.open) window.open(url, '_blank', 'noopener');
  else if (location && typeof location.assign === 'function') location.assign(url);
}

function closeFileViewer() {
  const overlay = $('fileViewerOverlay');
  if (overlay) overlay.classList.add('hidden');
  const body = $('fileViewerBody');
  if (body) body.textContent = '';
}

/* ---------------- open on the machine (localhost only) ---------------- */

// The POST address for a machine action (open / run) on a task file. Derived
// from the read URL so one mapping covers uploads, artifacts and workspace
// files. Returns null for anything that is not a task file.
function machineActionPath(viewUrl, action) {
  if (!viewUrl) return null;
  let parsed;
  try { parsed = new URL(viewUrl, location.href); } catch { return null; }
  if (/^\/api\/tasks\/[^/]+\/workspace-file$/.test(parsed.pathname)) return `${parsed.pathname}/${action}?${parsed.searchParams.toString()}`;
  if (/^\/api\/tasks\/[^/]+\/(?:files\/[^/]+|artifacts\/[^/]+)$/.test(parsed.pathname)) return `${parsed.pathname}/${action}`;
  return null;
}
const machineOpenPath = viewUrl => machineActionPath(viewUrl, 'open');
const machineRunPath = viewUrl => machineActionPath(viewUrl, 'run');
const isRunnableFile = name => RUNNABLE_EXT_RE.test(String(name || ''));

// Ask the machine to open a file in its OS application or reveal it in the file
// manager. Returns null on success, or the error to show. The server accepts
// these only from a loopback Host, so this does nothing on a phone or in the
// cloud, where serverIsLocal is false.
async function machineAction(openPath, reveal = false) {
  if (!serverIsLocal || !openPath) return new Error('Открытие приложением доступно только на самом компьютере.');
  try { await api(openPath, { method: 'POST', body: { confirm: true, reveal } }); return null; }
  catch (error) { return error; }
}

// Fire-and-report variant for the menu/icon actions, which have nothing to fall
// back on: a failure is shown, not swallowed.
async function machineActionAlert(openPath, reveal = false) {
  const error = await machineAction(openPath, reveal);
  if (error) alert(error.message);
  return !error;
}

// Run a script on the machine and show what it printed. Machine-only, and the
// caller has already asked for confirmation: running a file is a real action,
// not a preview.
async function runOnMachine(viewUrl, name, button = null) {
  const runPath = machineRunPath(viewUrl);
  if (!runPath) return;
  if (!await confirmDialog(name, { title: 'Выполнить скрипт на компьютере?' })) return;
  await runWithProgress(`Выполнение: ${name}`, () => api(runPath, { method: 'POST', body: { confirm: true } }), button);
}

// A run can take a while, so the panel opens at once with a spinner and the
// clicked control goes busy — pressing «Выполнить» must never look like nothing
// happened. The result (or the error) then replaces the spinner.
async function runWithProgress(title, action, button = null) {
  if (button) { button.classList.add('running'); if ('disabled' in button) button.disabled = true; }
  showRunPending(title);
  try {
    showRunResult(title, await action());
  } catch (error) {
    showRunResult(title, { error: true, exitCode: null, stdout: '', stderr: error.message, timedOut: false });
  } finally {
    if (button) { button.classList.remove('running'); if ('disabled' in button) button.disabled = false; }
  }
}

function showRunPending(title) {
  const overlay = $('fileViewerOverlay');
  if (!overlay) return;
  $('fileViewerName').textContent = title;
  const body = $('fileViewerBody');
  body.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'runPending';
  const spinner = document.createElement('div');
  spinner.className = 'runSpinner';
  const label = document.createElement('div');
  label.className = 'fileViewerMessage';
  label.textContent = 'Выполняется…';
  wrap.append(spinner, label);
  body.append(wrap);
  // No file actions while a command runs: there is nothing to act on yet.
  $('fileViewerDownload').classList.add('hidden');
  $('fileViewerExternal').classList.add('hidden');
  const copy = $('fileViewerCopy'); if (copy) copy.classList.add('hidden');
  const reveal = $('fileViewerReveal'); if (reveal) reveal.classList.add('hidden');
  overlay.classList.remove('hidden');
}

// A confirmation drawn by the page itself, not window.confirm: some mobile/PWA
// contexts suppress native dialogs, which made the run action look dead on a
// phone. Falls back to confirm() only when the shell has no dialog (old cache).
function confirmDialog(message, { title = 'Подтвердите действие', ok = 'Выполнить' } = {}) {
  const overlay = $('confirmOverlay');
  if (!overlay) return Promise.resolve(typeof confirm === 'function' ? confirm(`${title}\n\n${message}`) : true);
  return new Promise(resolve => {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = message;
    $('confirmOk').textContent = ok;
    const finish = value => { overlay.classList.add('hidden'); resolve(value); };
    $('confirmOk').onclick = () => finish(true);
    $('confirmCancel').onclick = () => finish(false);
    overlay.classList.remove('hidden');
  });
}

// Run a shell command line from a code block, in the current session's workspace,
// after asking. Machine-only: a command line is arbitrary code.
async function runShellCommand(command, button = null) {
  if (!String(command || '').trim()) return;
  if (!selectedTaskId) {
    showRunResult('Выполнение команды', { error: true, exitCode: null, stdout: '', stderr: 'Сначала выберите сессию — команда выполняется в её рабочей папке.', timedOut: false });
    return;
  }
  if (!await confirmDialog(command, { title: 'Выполнить команду на компьютере?' })) return;
  await runWithProgress('Выполнение команды', () => api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/shell`, { method: 'POST', body: { confirm: true, command } }), button);
}

// Attach a run's output to the composer, so the operator can send it to the
// agent as a file instead of pasting a wall of text into the message box — the
// prompt field is bounded, and a big paste silently hits that bound.
async function attachOutputToChat(artifactUrl, name) {
  try {
    const response = await fetch(artifactUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    addFilesToComposer([new File([await response.text()], name, { type: 'text/plain' })]);
    closeFileViewer();
  } catch (error) {
    alert(error.message);
  }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} Б`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} КиБ`;
  return `${(value / 1048576).toFixed(1)} МиБ`;
}

function showRunResult(title, result) {
  const overlay = $('fileViewerOverlay');
  const output = [result.stdout, result.stderr].filter(part => part && part.length).join('\n--- stderr ---\n') || '(нет вывода)';
  if (!overlay) { alert(`${title}\n${output}`); return; }
  $('fileViewerName').textContent = title;
  const body = $('fileViewerBody');
  body.textContent = '';
  const head = document.createElement('div');
  head.className = 'fileViewerMessage';
  head.textContent = result.error
    ? 'Ошибка'
    : result.timedOut
      ? 'Прервано (таймаут)'
      : `Код выхода: ${result.exitCode}`;
  const pre = document.createElement('pre');
  pre.className = 'fileViewerText';
  pre.textContent = output;
  body.append(head);
  // The file actions go ABOVE the output: a long run fills the panel, and on a
  // phone the button under it was off-screen — it looked like it was missing.
  // A long run is not pasted into the chat: only its tail is shown, the whole
  // output lives in the session's artifacts. Point at it and let it be opened.
  if (result.outputName && selectedTaskId) {
    const artifact = `/api/tasks/${encodeURIComponent(selectedTaskId)}/artifacts/${encodeURIComponent(result.outputName)}`;
    const note = document.createElement('div');
    note.className = 'fileViewerMessage';
    note.textContent = result.truncated
      ? `Показан конец вывода. Полный вывод (${formatBytes(result.outputBytes)}) сохранён в файл «${result.outputName}».`
      : `Вывод (${formatBytes(result.outputBytes)}) сохранён в файл «${result.outputName}».`;
    body.append(note);
    const actions = document.createElement('div');
    actions.className = 'inline wrap';
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = 'Скачать';
    download.onclick = () => triggerDownload(downloadUrlFor(artifact), result.outputName);
    const toChat = document.createElement('button');
    toChat.type = 'button';
    toChat.textContent = 'В чат';
    toChat.title = 'Прикрепить вывод к сообщению';
    toChat.onclick = () => attachOutputToChat(artifact, result.outputName);
    actions.append(download, toChat);
    // Opening with a desktop application only makes sense on the machine itself.
    if (serverIsLocal) {
      const openFull = document.createElement('button');
      openFull.type = 'button';
      openFull.textContent = 'Открыть полный вывод';
      openFull.onclick = () => machineActionAlert(machineActionPath(artifact, 'open'), false);
      const revealFull = document.createElement('button');
      revealFull.type = 'button';
      revealFull.textContent = 'Показать в папке';
      revealFull.onclick = () => machineActionAlert(machineActionPath(artifact, 'open'), true);
      actions.append(openFull, revealFull);
    }
    body.append(actions);
  }
  body.append(pre);
  // No download/new-tab/folder here: this panel shows a command's output. The
  // one action that belongs is copying the text the operator is looking at.
  $('fileViewerDownload').classList.add('hidden');
  $('fileViewerExternal').classList.add('hidden');
  const runReveal = $('fileViewerReveal');
  if (runReveal) runReveal.classList.add('hidden');
  const copy = $('fileViewerCopy');
  if (copy) {
    copy.classList.remove('hidden');
    copy.textContent = 'Копировать';
    copy.onclick = async () => {
      const ok = await copyText(output);
      copy.textContent = ok ? 'Скопировано' : 'Ошибка';
      setTimeout(() => { copy.textContent = 'Копировать'; }, 1500);
    };
  }
  overlay.classList.remove('hidden');
}

function openFileViewer({ url, name = '', downloadUrl = null } = {}) {
  if (!url) return;
  const kind = viewerKind(name);
  const overlay = $('fileViewerOverlay');
  // No viewer in an older cached shell, a file nothing can render, or a PDF on
  // Android (Chrome there does not embed PDFs): let the browser open it, exactly
  // as before.
  if (!overlay || kind === 'binary' || (kind === 'pdf' && isAndroid())) { openExternal(url); return; }
  const request = ++fileViewerRequest;
  $('fileViewerName').textContent = name || 'Файл';
  const body = $('fileViewerBody');
  body.textContent = '';
  $('fileViewerExternal').classList.remove('hidden');
  const copyButton = $('fileViewerCopy');
  if (copyButton) { copyButton.classList.add('hidden'); copyButton.onclick = null; }
  // On the machine the file's folder is one click away, so it replaces Download;
  // a phone has no local folder, so it keeps Download.
  const revealButton = $('fileViewerReveal');
  if (revealButton) {
    revealButton.classList.toggle('hidden', !serverIsLocal);
    revealButton.onclick = () => machineActionAlert(machineActionPath(url, 'open'), true);
  }
  $('fileViewerDownload').classList.toggle('hidden', serverIsLocal);
  $('fileViewerDownload').onclick = () => triggerDownload(downloadUrl || downloadUrlFor(url), name);
  $('fileViewerExternal').onclick = () => openExternal(url);
  overlay.classList.remove('hidden');
  if (kind === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = name;
    body.append(img);
    return;
  }
  if (kind === 'pdf') {
    // Desktop browsers render a PDF in a frame; Android Chrome is branched off
    // above, so this is desktop-only.
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.title = name || 'PDF';
    body.append(frame);
    return;
  }
  // Text: fetch and show it, so the disposition header never turns "open" into
  // "save". A failed fetch leaves the new-tab action as the way out.
  const message = document.createElement('div');
  message.className = 'fileViewerMessage';
  message.textContent = 'Загрузка…';
  body.append(message);
  fetch(url).then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }).then(text => {
    if (request !== fileViewerRequest) return; // a newer file replaced this one
    body.textContent = '';
    const md = document.createElement('div');
    md.className = 'md';
    // Markdown is rendered (headings, tables, code, links).
    if (isMarkdownFile(name)) {
      body.append(md);
      renderMarkdown(md, text);
      return;
    }
    // A table-shaped file is shown as a table.
    if (CSV_EXT_RE.test(name)) {
      md.append(delimitedTable(name, text));
      body.append(md);
      return;
    }
    // Everything else textual is shown as a code block: monospace, horizontal
    // scroll, a copy button — the same look as code in the chat. JSON is
    // pretty-printed first. The block is read-only here, so its "Выполнить"
    // button (added for shell languages) is dropped.
    let source = text;
    if (/\.json$/i.test(name)) {
      try { source = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep the raw text */ }
    }
    body.append(md);
    renderMarkdown(md, '```' + viewerLanguage(name) + '\n' + source.replace(/\n+$/, '') + '\n```');
    // The block is read-only here, and the clipboard must hold the original file
    // — not the fence and not the pretty-printed JSON. `data-copy` says so.
    const block = md.querySelector('code');
    if (block) block.setAttribute('data-copy', text);
    for (const run of md.querySelectorAll('.codeRunBtn')) run.remove();
  }).catch(error => {
    if (request === fileViewerRequest) message.textContent = `Не удалось показать файл: ${error.message}`;
  });
}

// Close on the buttons, the backdrop and Escape, like the other overlays.
for (const id of ['fileViewerClose', 'fileViewerCloseIcon']) {
  const button = $(id);
  if (button) button.onclick = closeFileViewer;
}
const fileViewerOverlayEl = $('fileViewerOverlay');
if (fileViewerOverlayEl) fileViewerOverlayEl.onclick = (event) => { if (event.target === fileViewerOverlayEl) closeFileViewer(); };
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeFileViewer(); });


function appendSystemNote(text, before = null) {
  hideEmptyState();
  const note = document.createElement('div');
  note.className = 'systemNote';
  note.textContent = text;
  $('msgsInner').insertBefore(note, before);
  if (!before) scrollBottom();
  return note;
}

function renderContext(t) {
  const used = t.lastUsage?.totalTokens;
  const windowSize = t.model?.contextWindow;
  const bar = $('contextBar');
  const fill = $('contextBarFill');
  if (used == null) {
    $('usage').textContent = '—';
    bar.classList.add('hidden');
  } else if (windowSize) {
    const pct = Math.min(100, Math.round((used / windowSize) * 100));
    $('usage').textContent = `${used.toLocaleString('ru-RU')} / ${windowSize.toLocaleString('ru-RU')} (${pct}%)`;
    bar.classList.remove('hidden');
    fill.style.width = `${pct}%`;
    fill.classList.toggle('warn', pct >= 60 && pct < 85);
    fill.classList.toggle('danger', pct >= 85);
  } else {
    $('usage').textContent = `${used.toLocaleString('ru-RU')} ток.`;
    bar.classList.add('hidden');
  }
  // TG is measured from the model's own usage (web/app.js receives task.metrics),
  // so it is shown for cloud models too — the only speed they expose.
  if (t.metrics?.tg != null) $('usage').textContent += ` · TG ${fmtMetric(t.metrics.tg)} tok/s`;

  const autoBtn = $('autoCompaction');
  if (t.autoCompactionEnabled == null || t.sessionAvailable === false) {
    autoBtn.textContent = 'AUTO: —';
    autoBtn.disabled = true;
  } else {
    autoBtn.textContent = t.autoCompactionEnabled ? 'AUTO: ON' : 'AUTO: OFF';
    autoBtn.disabled = false;
    autoBtn.dataset.enabled = String(t.autoCompactionEnabled);
  }
}

function scrollBottom() {
  const box = $('msgs');
  if (box && nearBottom) box.scrollTop = box.scrollHeight;
}

$('msgs').addEventListener('scroll', () => {
  const m = $('msgs');
  nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
});

/* ---------------- task selection / stream ---------------- */

// renderTaskDetails() forces #project to show whichever task is open (it's
// disabled then, purely informational). Restoring the user's own choice for
// *new* tasks here keeps that from silently overwriting it every 2s poll.
let newTaskProjectId = null;

function setComposerMode(taskId) {
  const continuing = Boolean(taskId);
  $('newTaskButton').classList.toggle('hidden', !continuing);
  $('project').disabled = continuing;
  if (!continuing && newTaskProjectId && [...$('project').options].some(o => o.value === newTaskProjectId)) {
    $('project').value = newTaskProjectId;
  }
  const badge = $('continueBadge');
  badge.classList.toggle('hidden', !continuing);
  if (continuing) badge.textContent = `Продолжение сессии ${taskId}`;
  const hint = isTouchDevice()
    ? 'Enter — перенос строки, отправка — кнопкой.'
    : 'Enter — отправить (если Pi занят — сообщение дождётся очереди), Ctrl+Enter — вклиниться в текущий ответ, не останавливая команды, Shift+Enter — перенос строки.';
  promptEl.placeholder = continuing
    ? `Сообщение продолжит текущую сессию. ${hint}`
    : `Сообщение для Pi. ${hint}`;
}

$('project').addEventListener('change', () => {
  if (!selectedTaskId) newTaskProjectId = $('project').value;
});

const drafts = new Map(); // taskId | '__new__' -> { text, files: File[] }
const draftStorageKey = key => `tbDraft:${key}`;

function saveDraft(key) {
  const text = promptEl.value;
  const files = Array.from($('files').files || []);
  if (!text && !files.length) {
    drafts.delete(key);
    try { localStorage.removeItem(draftStorageKey(key)); } catch { /* private mode */ }
  } else {
    drafts.set(key, { text, files });
    // Files cannot survive a reload, the typed text can — a phone that
    // refreshes mid-thought must not wipe the composer (see 1.6).
    try { localStorage.setItem(draftStorageKey(key), JSON.stringify({ text })); } catch { /* storage full */ }
  }
}

function restoreDraft(key) {
  const draft = drafts.get(key);
  if (!draft) {
    // After a reload only the text is recoverable; attachments stay the
    // operator's to re-add (browsers do not let a page re-read local files).
    try {
      const saved = JSON.parse(localStorage.getItem(draftStorageKey(key)) || 'null');
      if (saved && saved.text) drafts.set(key, { text: saved.text, files: [] });
    } catch { /* unreadable entry: fall back to an empty composer */ }
  }
  const restored = drafts.get(key);
  promptEl.value = restored?.text || '';
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 240)}px`;
  const dt = new DataTransfer();
  for (const file of restored?.files || []) dt.items.add(file);
  $('files').files = dt.files;
  renderFileList();
  updateClearButton();
}

function resetSelection(id) {
  saveDraft(selectedTaskId || '__new__');
  selectionVersion += 1;
  selectedTaskId = id;
  if (source) source.close();
  source = null;
  clearInterval(refreshTimer);
  clearTimeout(textUpdateTimer);
  refreshTimer = null;
  textUpdateTimer = null;
  chatState = null;
  pendingApprovals = new Map();
  renderApprovals();
  turnNodes = new Map();
  liveTurn = null;
  liveThinking = liveText = '';
  nearBottom = true;
  currentTask = null;
  reachedHistoryStart = true;
  oldestLoadedSeq = null;
  loadingOlder = false;
  $('stopButton').disabled = true;
  $('compact').disabled = true;
  $('autoCompaction').disabled = true;
  $('sessionDetailsButton').classList.toggle('hidden', !id);
  $('detail').classList.toggle('hidden', !id);
  $('msgsInner').innerHTML = '';
  for (const field of ['taskTitle', 'taskStatus', 'taskModel', 'taskThinking', 'current', 'workspace', 'usage', 'compaction', 'artifacts', 'outputFiles', 'stateJson', 'applyInfo']) $(field).textContent = '—';
  $('worktreeActions').classList.add('hidden');
  $('contextBar').classList.add('hidden');
  $('createError').textContent = '';
  $('retryPrompt').classList.add('hidden');
  setComposerMode(id);
  restoreDraft(id || '__new__');
  updateModelChip();
  return selectionVersion;
}

function startNewTask({ replace = false } = {}) {
  resetSelection(null);
  syncSessionUrl(null, { replace });
  $('msgsInner').innerHTML = '<div class="empty" id="emptyState">Выбери сессию из списка или создай новую.</div>';
  document.querySelectorAll('.taskRow.active').forEach(row => row.classList.remove('active'));
  promptEl.focus();
}

function renderChat() {
  if (!chatState) return;
  // TURN_TRUNCATED (repeat message) removes turns from chatState; their DOM
  // nodes must go with them, or the retracted exchange stays on screen.
  for (const [id, node] of [...turnNodes]) {
    if (!chatState.turns.some(t => t.id === id)) {
      (node.wrap || node.turn)?.remove();
      turnNodes.delete(id);
    }
  }
  const newest = newestTurn();
  for (const turn of chatState.turns) {
    let node = turnNodes.get(turn.id);
    // A regenerated answer keeps its siblings hidden: only the selected variant
    // is on screen, and a hidden one must not stay in the DOM.
    if (turn.hidden) {
      if (node) { (node.wrap || node.turn)?.remove(); turnNodes.delete(turn.id); }
      continue;
    }
    if (!node) {
      if (turn.role === 'user') {
        node = { wrap: appendUserTurn(turn.text, turn.files, null, turn.at), text: turn.text };
        turnNodes.set(turn.id, node);
      } else if (turn.role === 'note') {
        turnNodes.set(turn.id, { wrap: appendSystemNote(turn.text) });
        continue;
      } else {
        liveText = liveThinking = '';
        liveActive = false;
        liveAwaiting = false;
        liveHasWork = false;
        liveCutOff = false;
        appendBotTurn();
        node = { ...liveTurn, tools: new Map() };
        turnNodes.set(turn.id, node);
      }
    }
    // The operator's line is checked on every pass, not only when it is first
    // created: an edited message keeps its id, so the node is reused and its text
    // has to be refreshed (a user bubble is never rebuilt from the turn object).
    if (turn.role === 'user') {
      if (node.text !== turn.text) {
        const bubble = node.wrap.querySelector('.msg.s-me');
        if (bubble) bubble.textContent = turn.text;
        const copy = node.wrap.querySelector('.copyBtn');
        if (copy) copy._text = turn.text;
        node.text = turn.text;
      }
      updateTurnActions(node, turn, turn === newest);
      continue;
    }
    if (turn.role !== 'assistant') continue;
    if (node.turnRef && node.turnRef !== turn) resetTurnDom(node);
    node.turnRef = turn;
    liveTurn = node;
    liveText = turn.text;
    liveThinking = turn.thinking;
    liveActive = turn.active;
    liveHasWork = Boolean(turn.thinking) || turn.tools.length > 0;
    liveCutOff = turnCutOff(turn);
    const awaiting = answerMayStillCome(turn);
    liveAwaiting = awaiting;
    if (node.text !== turn.text || node.active !== turn.active || node.awaiting !== awaiting || node.error !== turn.error) {
      updateText();
      node.copyBtn._text = turn.text;
      if (turn.error) {
        const error = document.createElement('div');
        error.className = 'turnError';
        error.textContent = turn.error;
        node.md.append(error);
      }
      node.text = turn.text;
      node.active = turn.active;
      node.awaiting = awaiting;
      node.error = turn.error;
    }
    setTurnTime(node, turn, node.metaRow);
    if (node.thinking !== turn.thinking) {
      updateThinking();
      node.thinking = turn.thinking;
    }
    for (const tool of turn.tools) {
      let chip = node.tools.get(tool.id);
      if (!chip) {
        chip = document.createElement('details');
        const summary = document.createElement('summary');
        const body = document.createElement('div');
        body.className = 'tool-body';
        body.textContent = tool.label;
        chip.append(summary, body);
        chip._summary = summary;
        // Commands belong above the answer (and below the reasoning block), so
        // a long tool list never pushes the reply out of view.
        node.body.insertBefore(chip, node.bubble || node.metaRow);
        node.tools.set(tool.id, chip);
      }
      // A settled turn's tools never change again; skipping the write (not
      // just re-computing it) avoids forcing style recalc on every poll once
      // history gets long — the actual source of the reported UI lag.
      if (chip._state !== tool.state || chip._progress !== tool.progress) {
        chip.className = `tool ${tool.state}`;
        chip._summary.textContent = `${tool.state === 'interrupted' ? '■' : toolIcon(tool.state)} ${tool.name}${tool.state === 'interrupted' ? ' · прервано' : ''}${tool.progress ? ` · ${tool.progress.replace(/\n/g, ' | ')}` : ''}`;
        chip._state = tool.state;
        chip._progress = tool.progress;
      }
      if (tool.state === 'done' && tool.imagePath && IMAGE_EXT_RE.test(tool.imagePath) && !chip.dataset.imageShown) {
        appendInlineImage(tool.imagePath);
        chip.dataset.imageShown = 'true';
      }
    }
    layoutTools(node, turn);
    if (node.status !== turn.status || turn.partial) {
      node.meta.textContent = turn.partial ? 'часть более раннего обмена' : (turn.status || '');
      node.status = turn.status;
    }
    // A partial turn has no id the server knows: edit/fork/drop would address
    // a message that does not exist.
    if (!turn.partial) updateTurnActions(node, turn, turn === newest);
  }
  scrollBottom();
}

/* ---------------- message actions: fix in place, drop, branch, repeat ---------------- */

// Icons on every settled message: a pencil fixes the text without asking the
// model again, a branch mark forks a new session from this message, a trash can
// drops the message with everything that followed it, and a refresh re-runs the
// newest answer. All four are inline SVG marks (see messageIcon), not emoji: an
// emoji ignores the theme colour, changes size with the font and can read as the
// wrong thing (🌿 was a herb, not a fork). They need a finished session — the
// server refuses to rewrite history while a run is in flight, so the whole bar is
// hidden on the streaming turn.
function updateTurnActions(node, turn, isNewest) {
  if (!node || turn.role === 'note') return;
  const element = node.wrap || node.turn;
  if (element) element.dataset.turnId = turn.id;
  if (!node.actionBar) {
    // Operator messages group the icons into the row that already holds copy;
    // answers put them into the meta row next to the copy button.
    const host = turn.role === 'user' ? (element && element.querySelector('.msgActions')) : node.metaRow;
    if (!host) return;
    const bar = document.createElement('span');
    bar.className = 'turnActionBar';
    node.buttons = {};
    if (turn.role === 'user') {
      // Editing re-sends: the text is corrected, everything below it is wiped and
      // the model is asked again — so this action lives on the operator's own
      // line only (an answer is re-run, never edited in place).
      node.buttons.edit = turnAction('edit', messageIcon('edit'), 'Изменить и отправить заново', () => beginEditTurn(node, turn));
      node.buttons.fork = turnAction('fork', messageIcon('fork'), 'Ответвить новую сессию от этого сообщения', () => forkTurn(turn));
      node.buttons.drop = turnAction('drop', messageIcon('drop'), 'Удалить это сообщение и всё после него', () => deleteTurn(turn));
      bar.append(node.buttons.edit, node.buttons.fork, node.buttons.drop);
    } else {
      // An answer is a branch point too — "continue differently from here" —
      // and both ends of an exchange name the same fork. It can also be edited
      // (in place, or as another variant of the exchange) and continued: what
      // the model writes next is appended to this very message.
      node.buttons.edit = turnAction('edit', messageIcon('edit'), 'Изменить ответ (можно сохранить как вариант)', () => beginEditAnswer(node, turn));
      node.buttons.fork = turnAction('fork', messageIcon('fork'), 'Ответвить новую сессию от этого ответа', () => forkTurn(turn));
      node.buttons.regen = turnAction('regen', messageIcon('regen'), 'Перегенерировать ответ', () => regenerateTurn(turn));
      node.buttons.more = turnAction('continue', messageIcon('continue'), 'Продолжить этот ответ', () => continueTurn(turn));
      bar.append(node.buttons.edit, node.buttons.fork, node.buttons.regen, node.buttons.more);
    }
    host.append(bar);
    node.actionBar = bar;
  }
  // A message that is still streaming cannot be edited, dropped or branched:
  // the server refuses to rewrite history while a run is in flight.
  const busy = turn.active === true;
  node.actionBar.classList.toggle('hidden', busy);
  node.buttons.fork?.classList.toggle('hidden', busy);
  node.buttons.drop?.classList.toggle('hidden', busy);
  // Regenerating, continuing and editing only ever touch the newest answer.
  node.buttons.regen?.classList.toggle('hidden', busy || isNewest !== true);
  node.buttons.more?.classList.toggle('hidden', busy || isNewest !== true);
  node.buttons.edit?.classList.toggle('hidden', busy || (turn.role === 'assistant' && isNewest !== true));
  updateVariantNav(node, turn, busy);
}

// ‹ n/m › — the switcher between the answers of one exchange. Regenerate keeps
// the previous answer as a sibling (nothing is deleted), so the operator can go
// back to the version that was better. The choice is stored server-side, so a
// reload shows the same variant.
function updateVariantNav(node, turn, busy) {
  if (!node.buttons) return; // the action row was never built for this turn
  const info = turn.role === 'assistant' ? chatState.variantsOf(turn) : null;
  if (!info) { node.variantNav?.remove(); node.variantNav = null; return; }
  if (!node.variantNav) {
    const nav = document.createElement('span');
    nav.className = 'variantNav';
    nav.dataset.turnId = turn.id;
    node.buttons.prev = turnAction('variant-prev', '‹', 'Предыдущий вариант ответа', () => selectVariantTurn(info, -1));
    node.buttons.next = turnAction('variant-next', '›', 'Следующий вариант ответа', () => selectVariantTurn(info, 1));
    const count = document.createElement('span');
    count.className = 'variantCount';
    nav.append(node.buttons.prev, count, node.buttons.next);
    node.variantNav = nav;
    node.variantCount = count;
    // Inside the answer's meta row, next to the status: the switcher belongs to
    // the answer it switches.
    if (node.metaRow) node.metaRow.insertBefore(nav, node.metaRow.firstChild);
  }
  node.variantNav.classList.toggle('hidden', busy);
  node.variantCount.textContent = `${info.index + 1}/${info.total}`;
  node.buttons.prev.disabled = info.index === 0;
  node.buttons.next.disabled = info.index >= info.total - 1;
}

// Editing an ANSWER: no model is asked. "Сохранить" corrects the text in
// place; "Сохранить как ветку" turns it into another variant of the same
// exchange, keeping the previous answer switchable (‹ n/m ›).
function beginEditAnswer(node, turn) {
  if (!selectedTaskId) return;
  const host = node.body;
  const view = node.bubble;
  if (!host || !view || host.querySelector('.editBox')) return;
  const box = document.createElement('div');
  box.className = 'editBox';
  const area = document.createElement('textarea');
  area.className = 'editArea';
  area.value = turn.text ?? view.textContent ?? '';
  const row = document.createElement('div');
  row.className = 'editRow';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'small';
  save.textContent = 'Сохранить';
  save.title = 'Изменить этот ответ в истории, не отправляя модель заново';
  const branch = document.createElement('button');
  branch.type = 'button';
  branch.className = 'small';
  branch.textContent = 'Сохранить как ветку';
  branch.title = 'Сохранить правку как ещё один вариант этого ответа — предыдущий останется в ‹ n/m ›';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'small';
  cancel.textContent = 'Отмена';
  const note = document.createElement('span');
  note.className = 'muted small';
  row.append(save, branch, cancel, note);
  box.append(area, row);
  view.classList.add('hidden');
  host.insertBefore(box, view.nextSibling);
  const close = () => { box.remove(); view.classList.remove('hidden'); };
  const reopen = (message) => {
    area.value = area.value;
    view.classList.add('hidden');
    host.insertBefore(box, view.nextSibling);
    note.textContent = message;
  };
  cancel.onclick = close;
  save.onclick = async () => {
    const newText = area.value;
    close();
    save.disabled = branch.disabled = true;
    try {
      await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/turns/${encodeURIComponent(turn.id)}/edit`, {
        method: 'POST', body: JSON.stringify({ text: newText })
      });
      turn.text = newText; // instant; the server stores exactly this text
      await refreshTask();
    } catch (error) {
      save.disabled = branch.disabled = false;
      reopen(error.message);
    }
  };
  branch.onclick = async () => {
    const newText = area.value;
    close();
    save.disabled = branch.disabled = true;
    try {
      await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/turns/${encodeURIComponent(turn.id)}/edit`, {
        method: 'POST', body: JSON.stringify({ text: newText, branch: true })
      });
      await refreshTask();
    } catch (error) {
      save.disabled = branch.disabled = false;
      reopen(error.message);
    }
  };
  area.focus();
}

// "Continue": the model is asked to go on, and what it writes next is appended
// to the very message this belongs to — the answer grows, nothing is replaced.
async function continueTurn(turn) {
  if (!selectedTaskId) return;
  if (!confirm('Продолжить этот ответ? Модель допишет его с того места, где остановилась.')) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/continue`, {
      method: 'POST', body: JSON.stringify({ turnId: turn.id })
    });
    await refreshTask();
  } catch (error) {
    $('createError').textContent = error.message;
    $('createError').classList.add('error');
  }
}

async function selectVariantTurn(info, step) {
  if (!selectedTaskId) return;
  const target = info.ids[info.index + step];
  if (!target) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/variant`, {
      method: 'POST', body: JSON.stringify({ turnSeq: info.key, variantId: target.slice('assistant-'.length) })
    });
    await refreshTask();
  } catch (error) {
    $('createError').textContent = error.message;
    $('createError').classList.add('error');
  }
}

// The newest turn that is not an internal note — the only one "regenerate" may
// touch. Hidden variants are skipped: the operator is looking at the selected
// answer, and that is the one a re-run should replace.
function newestTurn() {
  if (!chatState) return null;
  for (let i = chatState.turns.length - 1; i >= 0; i--) {
    if (chatState.turns[i].role !== 'note' && !chatState.turns[i].hidden) return chatState.turns[i];
  }
  return null;
}

// Every icon in a message row is an inline SVG mark, not an emoji glyph: an
// emoji ignores the theme colour (currentColor), changes size with the font, and
// can read as the wrong thing (🌿 was a herb, not a fork). The action marks are
// Feather's edit-3, git-branch, trash-2 and refresh-cw, so the whole bar shares
// one stroke weight and colour and scales with the button's font-size (1em);
// copy, check and cross are the clipboard icon and its copy feedback.
const SVG_NS = 'http://www.w3.org/2000/svg';
const MESSAGE_ICONS = {
  edit: [['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' }]],
  fork: [['path', { d: 'M6 3v12' }], ['circle', { cx: '18', cy: '6', r: '3' }], ['circle', { cx: '6', cy: '18', r: '3' }], ['path', { d: 'M18 9a9 9 0 0 1-9 9' }]],
  drop: [['polyline', { points: '3 6 5 6 21 6' }], ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }], ['line', { x1: '10', y1: '11', x2: '10', y2: '17' }], ['line', { x1: '14', y1: '11', x2: '14', y2: '17' }]],
  regen: [['polyline', { points: '23 4 23 10 17 10' }], ['polyline', { points: '1 20 1 14 7 14' }], ['path', { d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }]],
  continue: [['path', { d: 'M5 12h14' }], ['polyline', { points: '13 6 19 12 13 18' }]],
  copy: [['rect', { x: '9', y: '9', width: '13', height: '13', rx: '2', ry: '2' }], ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]],
  check: [['polyline', { points: '20 6 9 17 4 12' }]],
  cross: [['line', { x1: '18', y1: '6', x2: '6', y2: '18' }], ['line', { x1: '6', y1: '6', x2: '18', y2: '18' }]],
  download: [['polyline', { points: '21 15 21 19 21 19 3 19 3 15' }], ['line', { x1: '7', y1: '10', x2: '12', y2: '15' }], ['line', { x1: '17', y1: '10', x2: '12', y2: '15' }], ['line', { x1: '12', y1: '15', x2: '12', y2: '3' }]],
  folder: [['path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }]],
  run: [['polygon', { points: '6 3 20 12 6 21 6 3' }]],
  external: [['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }], ['polyline', { points: '15 3 21 3 21 9' }], ['line', { x1: '10', y1: '14', x2: '21', y2: '3' }]]
};
function messageIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '1em');
  svg.setAttribute('height', '1em');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of MESSAGE_ICONS[name] || []) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    svg.append(el);
  }
  return svg;
}

function turnAction(action, icon, label, onclick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'actionBtn';
  button.dataset.action = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  if (typeof icon === 'string') button.textContent = icon;
  else button.append(icon);
  button.onclick = onclick;
  return button;
}

async function regenerateTurn(turn) {
  if (!selectedTaskId) return;
  if (!confirm('Перегенерировать ответ? Текущий ответ и всё, что после него, будут удалены.')) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/regenerate`, {
      method: 'POST', body: JSON.stringify({ turnId: turn.id })
    });
    await refreshTask();
  } catch (error) {
    $('createError').textContent = error.message;
    $('createError').classList.add('error');
  }
}

// A fork is a session of its own: the server copies the conversation through
// this message, then we open it so the operator can continue differently.
async function forkTurn(turn) {
  if (!selectedTaskId) return;
  try {
    const created = await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/fork`, {
      method: 'POST', body: JSON.stringify({ turnId: turn.id })
    });
    await loadTasks();
    await selectTask(created.id);
  } catch (error) {
    $('createError').textContent = error.message;
    $('createError').classList.add('error');
  }
}

function beginEditTurn(node, turn) {
  if (!selectedTaskId) return;
  const element = node.wrap || node.turn;
  const host = turn.role === 'user' ? (element && element.querySelector('.body')) : node.body;
  const view = turn.role === 'user' ? (element && element.querySelector('.msg.s-me')) : node.bubble;
  if (!host || !view || host.querySelector('.editBox')) return;
  const box = document.createElement('div');
  box.className = 'editBox';
  const area = document.createElement('textarea');
  area.className = 'editArea';
  area.value = turn.text ?? view.textContent ?? '';
  const row = document.createElement('div');
  row.className = 'editRow';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'small';
  save.textContent = 'Сохранить';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'small';
  cancel.textContent = 'Отмена';
  const note = document.createElement('span');
  note.className = 'muted small';
  row.append(save, cancel, note);
  box.append(area, row);
  view.classList.add('hidden');
  host.insertBefore(box, view.nextSibling);
  const close = () => { box.remove(); view.classList.remove('hidden'); };
  cancel.onclick = close;
  save.onclick = async () => {
    const newText = area.value;
    // Close at once — the server may take a while to start the run — and reopen
    // only if the request is refused, so the typed text is never lost.
    close();
    save.disabled = true;
    try {
      await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/turns/${encodeURIComponent(turn.id)}/edit`, {
        method: 'POST', body: JSON.stringify({ text: newText })
      });
      turn.text = newText; // instant; the server stores exactly this text
      // Everything below this message was wiped and the model was asked again:
      // the stream and this refresh bring the new answer in.
      await refreshTask();
    } catch (error) {
      area.value = newText;
      view.classList.add('hidden');
      host.insertBefore(box, view.nextSibling);
      save.disabled = false;
      note.textContent = error.message;
    }
  };
  area.focus();
}

async function deleteTurn(turn) {
  if (!selectedTaskId || !chatState) return;
  const index = chatState.turns.findIndex(candidate => candidate.id === turn.id);
  const after = index >= 0 ? chatState.turns.length - index - 1 : 0;
  const question = after > 0
    ? `Удалить это сообщение и ещё ${after} после него? Восстановить нельзя.`
    : 'Удалить это сообщение? Восстановить нельзя.';
  if (!confirm(question)) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/turns/${encodeURIComponent(turn.id)}/delete`, { method: 'POST', body: '{}' });
    await refreshTask();
  } catch (error) {
    $('createError').textContent = error.message;
    $('createError').classList.add('error');
  }
}

function applyEvents(events) {
  let approvalsChanged = false;
  let queueChanged = false;
  for (const event of events) {
    chatState.apply(event);
    // A delivered message leaves the queue at the very moment it enters the
    // conversation. The badge is drawn from task.pendingPrompts, which only the
    // next poll refreshes — so without this the message sat in the queue and in
    // the chat at the same time for up to two seconds.
    if (event.type === 'USER_MESSAGE') queueChanged = dropDeliveredFromQueue(event) || queueChanged;
    if (event.type === 'APPROVAL_REQUIRED' && event.data?.approvalId) {
      pendingApprovals.set(event.data.approvalId, { ...event.data, status: 'PENDING' });
      approvalsChanged = true;
    }
    if (event.type === 'APPROVAL_RESOLVED' && event.data?.approvalId) {
      const record = pendingApprovals.get(event.data.approvalId);
      if (record) record.status = event.data.decision === 'DENY' ? 'DENIED' : 'APPROVED';
      approvalsChanged = true;
    }
  }
  renderChat();
  if (queueChanged) renderQueuedPrompt();
  if (approvalsChanged) renderApprovals();
}

// Removes the delivered message from the local view of the queue. A queued entry
// carries the text plus the "additional files" note, so the event text is a
// prefix of it.
function dropDeliveredFromQueue(event) {
  const queued = currentTask?.pendingPrompts || [];
  if (!queued.length) return false;
  // The server names the queue entry it delivered; matching by text is only the
  // fallback for events written before pendingId existed (two identical queued
  // lines used to drop the wrong one).
  const pendingId = event.data?.pendingId;
  if (pendingId) {
    const before = queued.length;
    currentTask.pendingPrompts = queued.filter(entry => entry?.id !== pendingId);
    return currentTask.pendingPrompts.length !== before;
  }
  const text = String(event.data?.text ?? event.message ?? '');
  if (!text) return false;
  const index = queued.findIndex(entry => String(entry?.text || '') === text || String(entry?.text || '').startsWith(text));
  if (index < 0) return false;
  currentTask.pendingPrompts = queued.filter((_, i) => i !== index);
  return true;
}

function renderApprovals() {
  const banner = $('approvalBanner');
  const pending = [...pendingApprovals.values()].filter(approval => approval.status === 'PENDING');
  banner.textContent = '';
  banner.classList.toggle('hidden', pending.length === 0);
  for (const approval of pending) {
    const card = document.createElement('div');
    card.className = 'approvalCard';
    const title = document.createElement('b');
    title.textContent = `Требуется подтверждение: ${approval.toolName || 'инструмент'} (${approval.risk || 'риск не определён'})`;
    card.append(title);
    const detail = document.createElement('code');
    detail.textContent = String(approval.detail || JSON.stringify(approval.args || {})).slice(0, 400);
    card.append(detail);
    const actions = document.createElement('div');
    actions.className = 'approvalActions';
    for (const [label, decision] of [['Разрешить один раз', 'ALLOW_ONCE'], ['Запретить', 'DENY']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = decision === 'DENY' ? 'small danger' : 'small';
      button.textContent = label;
      button.onclick = () => resolveApproval(approval.approvalId, decision, button);
      actions.append(button);
    }
    card.append(actions);
    banner.append(card);
  }
}

async function resolveApproval(approvalId, decision, button) {
  if (!selectedTaskId) return;
  button.disabled = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/approvals/${encodeURIComponent(approvalId)}`, {
      method: 'POST', body: JSON.stringify({ decision })
    });
    const record = pendingApprovals.get(approvalId);
    if (record) record.status = decision === 'DENY' ? 'DENIED' : 'APPROVED';
    renderApprovals();
  } catch (error) {
    button.disabled = false;
    $('createError').textContent = `Не удалось ответить на запрос подтверждения: ${error.message}`;
  }
}

// Builds a complete, already-settled bot turn in one shot for history
// backfill (prependOlder). Deliberately does not touch liveTurn/liveText/etc
// — those track the live tail, which a backfill must never disturb — so this
// duplicates a little of renderChat()'s per-turn construction rather than
// reusing it through shared globals.
function renderSettledTurn(turn, before) {
  const wrap = document.createElement('div');
  wrap.className = 'turn';
  const body = document.createElement('div');
  body.className = 'body';
  const bubble = document.createElement('div');
  bubble.className = 'msg s-bot';
  const md = document.createElement('div');
  md.className = 'md';
  bubble.append(md);
  const meta = document.createElement('div');
  meta.className = 'meta';
  const copyBtn = copyButton('', 'Скопировать ответ');
  copyBtn._text = turn.text;
  const metaRow = document.createElement('div');
  metaRow.className = 'metaRow';
  metaRow.append(botBadge(), meta, copyBtn);
  body.append(bubble, metaRow);
  wrap.append(body);

  if (turn.thinking) body.insertBefore(reasoningEl(turn.thinking), body.firstChild);
  const text = (turn.text || '').trim();
  if (text) renderMarkdown(md, text);
  else if (turnCutOff(turn)) md.innerHTML = '<span class="muted">Запрос прерван</span>';
  else if (turn.thinking || turn.tools.length) md.innerHTML = '<span class="muted">Без текста</span>';
  else md.innerHTML = '<span class="muted">Ответ не был получен.</span>';
  if (turn.error) {
    const error = document.createElement('div');
    error.className = 'turnError';
    error.textContent = turn.error;
    md.append(error);
  }

  const tools = new Map();
  for (const tool of turn.tools) {
    const chip = document.createElement('details');
    const summary = document.createElement('summary');
    const toolBody = document.createElement('div');
    toolBody.className = 'tool-body';
    toolBody.textContent = tool.label;
    chip.append(summary, toolBody);
    chip.className = `tool ${tool.state}`;
    summary.textContent = `${tool.state === 'interrupted' ? '■' : toolIcon(tool.state)} ${tool.name}${tool.state === 'interrupted' ? ' · прервано' : ''}${tool.progress ? ` · ${tool.progress.replace(/\n/g, ' | ')}` : ''}`;
    chip._summary = summary;
    chip._state = tool.state;
    chip._progress = tool.progress;
    body.insertBefore(chip, bubble);
    tools.set(tool.id, chip);
    if (tool.state === 'done' && tool.imagePath && IMAGE_EXT_RE.test(tool.imagePath) && selectedTaskId) {
      const url = `/api/tasks/${selectedTaskId}/workspace-file?path=${encodeURIComponent(tool.imagePath)}`;
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.className = 'chatImage';
      link.title = tool.imagePath;
      const img = document.createElement('img');
      img.src = url;
      img.alt = tool.imagePath;
      img.loading = 'lazy';
      // Same reason as appendInlineImage: withdraw the preview rather than show
      // a broken picture when the server will not serve the file.
      img.onerror = () => link.remove();
      link.append(img);
      body.insertBefore(link, bubble);
      chip.dataset.imageShown = 'true';
    }
  }
  meta.textContent = turn.partial ? 'часть более раннего обмена' : (turn.status || '');
  // Historical turns carry their own times too (a reloaded session must show
  // when each answer started and finished).
  const settledNode = { timeEl: null };
  setTurnTime(settledNode, turn, metaRow);
  $('msgsInner').insertBefore(wrap, before);
  const node = { wrap, body, bubble, md, meta, metaRow, copyBtn, tools, timeEl: settledNode.timeEl, text: turn.text, active: turn.active, error: turn.error, thinking: turn.thinking, status: turn.status };
  // The node this is stored on, not a throwaway: renderChat walks the prepended
  // turns again on every pass, and a fold it cannot find there is built anew
  // each time — leaving the previous one behind, once per poll.
  layoutTools(node, turn);
  return node;
}

function renderPrependedTurns(turns) {
  // The "load older" button (if present) must stay the topmost element, so
  // newly-backfilled turns are inserted right after it, not above it.
  const loadOlderBtn = document.getElementById('loadOlderButton');
  const reference = loadOlderBtn ? loadOlderBtn.nextSibling : $('msgsInner').firstChild;
  for (const turn of turns) {
    if (turnNodes.has(turn.id)) continue;
    if (turn.role === 'user') {
      const userNode = { wrap: appendUserTurn(turn.text, turn.files, reference, turn.at), text: turn.text };
      turnNodes.set(turn.id, userNode);
      updateTurnActions(userNode, turn, false);
      continue;
    }
    if (turn.role === 'note') { turnNodes.set(turn.id, { wrap: appendSystemNote(turn.text, reference) }); continue; }
    const settled = renderSettledTurn(turn, reference);
    turnNodes.set(turn.id, settled);
    // A partial turn is not a turn the server knows by id: edit/fork/drop would
    // address a message that does not exist.
    if (!turn.partial) updateTurnActions(settled, turn, false);
  }
}

function renderLoadOlderIndicator() {
  const existing = document.getElementById('loadOlderButton');
  if (reachedHistoryStart) { existing?.remove(); return; }
  if (existing) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'loadOlderButton';
  btn.className = 'loadOlderButton';
  btn.textContent = 'Показать более раннюю историю';
  btn.onclick = loadOlderHistory;
  $('msgsInner').insertBefore(btn, $('msgsInner').firstChild);
}

async function loadOlderHistory() {
  if (loadingOlder || reachedHistoryStart || !selectedTaskId || !currentTask) return;
  const id = selectedTaskId;
  const version = selectionVersion;
  loadingOlder = true;
  const btn = document.getElementById('loadOlderButton');
  if (btn) { btn.disabled = true; btn.textContent = 'Загрузка…'; }
  try {
    // A page that the server had to cut by size can open mid-turn, with no
    // USER_MESSAGE of its own: it carries no renderable turn, so one click
    // showed nothing. Keep paging — the cursor advances with every response —
    // until a page brings turns or the history ends. The cap bounds a run of
    // giant turns: the next click continues from the cursor.
    const PAGE_ATTEMPTS = 12;
    let prepended = [];
    let reachedStart = false;
    for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
      const { events, reachedStart: pageReachedStart } = await api(`/api/tasks/${encodeURIComponent(id)}/events?tail=${HISTORY_PAGE_TURNS}&before=${oldestLoadedSeq}`);
      if (version !== selectionVersion) return;
      reachedStart = pageReachedStart;
      if (!events.length) break; // nothing below: history ends here
      prepended = chatState.prependOlder(currentTask, events, pageReachedStart);
      oldestLoadedSeq = events[0].seq;
      if (prepended.length || pageReachedStart) break;
    }
    if (version !== selectionVersion) return;
    const msgsEl = $('msgs');
    const prevScrollHeight = msgsEl.scrollHeight;
    const prevScrollTop = msgsEl.scrollTop;
    reachedHistoryStart = reachedStart;
    renderPrependedTurns(prepended);
    renderLoadOlderIndicator();
    // Keep whatever was on screen in place instead of jumping as content
    // grows above it.
    msgsEl.scrollTop = prevScrollTop + (msgsEl.scrollHeight - prevScrollHeight);
  } catch (error) {
    if (version === selectionVersion) { $('createError').textContent = `Не удалось загрузить историю: ${error.message}`; $('createError').classList.add('error'); }
  } finally {
    loadingOlder = false;
    if (version === selectionVersion) {
      const b = document.getElementById('loadOlderButton');
      if (b) { b.disabled = false; b.textContent = 'Показать более раннюю историю'; }
    }
  }
}

const lastNotifiedStatus = new Map();

// Only fires on a transition actually observed live (the map has no entry
// on first render of a task, e.g. one already finished when selected).
function maybeNotify(t) {
  const previous = lastNotifiedStatus.get(t.id);
  lastNotifiedStatus.set(t.id, t.status);
  if (!previous || previous === t.status || ACTIVE_STATUSES.has(t.status) || !notifyEnabled()) return;
  const title = t.status === 'SUCCEEDED' ? 'Готово' : t.status === 'FAILED' ? 'Ошибка' : 'Остановлено';
  try { new Notification(`TaskBridge: ${title}`, { body: (t.title || t.prompt || '').slice(0, 120), tag: t.id }); } catch {}
}

// One generation runs at a time, so "Стоп" must reach the session that actually
// works — not only the one that happens to be selected. Also considers active
// assistant streaming in the chat even if a stale terminal status landed earlier.
function stopTarget() {
  const isWorking = (task) => {
    if (!task) return false;
    if (task.status === 'CANCELLING') return false;
    if (ACTIVE_STATUSES.has(task.status)) return true;
    if (task.id === selectedTaskId && chatState?.current?.active) return true;
    return false;
  };
  const selected = lastTasks.find(task => task.id === selectedTaskId) || currentTask;
  if (isWorking(selected)) return selected;
  return lastTasks.find(task => task.status === 'RUNNING') || lastTasks.find(isWorking) || null;
}

// What the machine is doing, in one line: a running session must be obvious
// (the small "ждёт модель" badge in the list is not enough), with a live timer
// so a stuck run is visible too.
const ACTIVITY_LABELS = {
  QUEUED: 'В очереди', PREPARING: 'Подготовка', PREFLIGHT: 'Проверка',
  RUNNING: 'Pi работает', WAITING_USER: 'Ждёт подтверждения',
  VERIFYING: 'Собираю результат и проверки', CANCELLING: 'Останавливаю…'
};

// The details panel must not print a raw enum: the operator reads "Готово", not
// "SUCCEEDED", and "Ошибка", not "FAILED_RECOVERY". A status the server adds
// later falls back to its raw code on purpose, so it stays visible instead of
// disappearing — the "why" behind a failure is in the turn/error text anyway.
const TASK_STATUS_LABELS = {
  QUEUED: 'В очереди', PREPARING: 'Подготовка', PREFLIGHT: 'Проверка',
  RUNNING: 'Работает', WAITING_USER: 'Ждёт подтверждения',
  VERIFYING: 'Собираю результат и проверки', CANCELLING: 'Останавливаю…',
  SUCCEEDED: 'Готово', FAILED: 'Ошибка', CANCELLED: 'Остановлено'
};
function taskStatusLabel(status) { return TASK_STATUS_LABELS[status] || status || '—'; }
let activityTimer = null;

function renderActivity(task = currentTask) {
  const host = $('activity');
  const status = task?.status;
  const label = ACTIVITY_LABELS[status];
  if (!label) {
    if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }
    host.classList.add('hidden');
    host.textContent = '';
    return;
  }
  const since = Date.parse(task.statusChangedAt || task.updatedAt || task.createdAt || '') || null;
  const paint = () => {
    const seconds = since === null ? null : Math.max(0, Math.round((Date.now() - since) / 1000));
    const wait = status === 'QUEUED' ? (task.queueReason === 'MODEL_BUSY' ? ' — ждёт модель' : ' — ждёт очередь') : '';
    const elapsed = seconds === null ? '' : ` · ${seconds} с`;
    const model = task.model?.id ? ` · ${task.model.id}` : '';
    host.textContent = `${label}${wait}${elapsed}${model}`;
  };
  paint();
  // Elapsed time keeps ticking while a session works or waits.
  if (!activityTimer) activityTimer = setInterval(paint, 1000);
  host.classList.remove('hidden');
  host.classList.toggle('waiting', status !== 'RUNNING');
}

function updateStopButton() {
  const target = stopTarget();
  $('stopButton').disabled = !target;
  $('stopButton').title = target
    ? `Остановить сессию «${target.title || target.id}»`
    : 'Сейчас нечего останавливать';
}

function renderTaskDetails(t) {
  maybeNotify(t);
  currentTask = t;
  renderQueuedPrompt();
  updateRetryButton();
  $('taskTitle').textContent = t.title || t.prompt || t.id;
  $('taskStatus').textContent = taskStatusLabel(t.status);
  $('taskStatus').title = t.errorCode ? `${t.status} · ${t.errorCode}` : (t.status || '');
  $('taskModel').textContent = t.model ? modelFullLabel(t.model) : (t.requestedModel ? modelFullLabel(t.requestedModel) : '—');
  $('taskThinking').textContent = t.thinkingLevelActual || t.thinkingLevel || '—';
  updateModelChip();
  $('current').textContent = t.current || '—';
  $('workspace').textContent = t.workspacePath || '—';
  if ([...$('project').options].some(o => o.value === t.projectId)) $('project').value = t.projectId;
  renderContext(t);
  renderOutputFiles(t.outputFiles || []);
  const c = t.compaction || {};
  $('compaction').textContent = c.last ? `${c.count} · ${c.last.tokensBefore ?? '?'}→${c.last.estimatedTokensAfter ?? '?'}` : String(c.count || 0);
  updateStopButton();
  renderActivity(t);
  $('compact').disabled = ACTIVE_STATUSES.has(t.status) || t.sessionAvailable === false;
  const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(t.status);
  const isWorktree = Boolean(t.worktree);
  $('worktreeActions').classList.toggle('hidden', !isWorktree && !t.worktreeRemovedAt);
  $('applyChanges').disabled = !(isWorktree && t.sourcePath && terminal && (t.git?.changedFiles?.length || t.applied));
  $('cleanupWorktree').disabled = !(isWorktree && t.workspacePath && terminal);
  $('applyInfo').textContent = t.applied
    ? `Применено ${new Date(t.applied.at).toLocaleString('ru-RU')}${t.applied.forced ? ' (force)' : ''}: ${t.applied.files.length} файл(ов)`
    : t.worktreeRemovedAt ? `Worktree удалён ${new Date(t.worktreeRemovedAt).toLocaleString('ru-RU')}` : '';
}

/* ---------------- session URLs ---------------- */

// Every session has its own address: a reload, a bookmark, or a link opened on
// the phone must land on the same conversation (§ sessions with own URL).
function sessionPath(id) { return id ? `/session/${encodeURIComponent(id)}` : '/'; }

function sessionIdFromPath(pathname) {
  const match = /^\/session\/([^/]+)\/?$/.exec(pathname || '');
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function syncSessionUrl(id, { replace = false } = {}) {
  const target = sessionPath(id);
  if (location.pathname === target) return;
  try {
    if (replace) history.replaceState({ sessionId: id || null }, '', target);
    else history.pushState({ sessionId: id || null }, '', target);
  } catch { /* history can be unavailable in embedded contexts */ }
}

// Unknown ids fall back to the list instead of leaving a dead address behind.
async function openSessionFromLocation(tasks) {
  const id = sessionIdFromPath(location.pathname);
  if (!id) return false;
  if (!tasks.some(task => task.id === id)) { syncSessionUrl(null, { replace: true }); return false; }
  await selectTask(id);
  return true;
}

async function routeFromLocation() {
  const id = sessionIdFromPath(location.pathname);
  if (!id) return startNewTask({ replace: true });
  return selectTask(id);
}

// Switching a session clears the chat, so a spinner appears if the load is not
// instant — a blank area read as a hang. Delayed a moment so a quick switch does
// not flash it.
let sessionLoaderTimer = null;
function showSessionLoader() {
  hideSessionLoader();
  const el = $('sessionLoader');
  if (!el) return;
  sessionLoaderTimer = setTimeout(() => { sessionLoaderTimer = null; el.classList.remove('hidden'); }, 150);
}
function hideSessionLoader() {
  if (sessionLoaderTimer) { clearTimeout(sessionLoaderTimer); sessionLoaderTimer = null; }
  const el = $('sessionLoader');
  if (el) el.classList.add('hidden');
}

async function selectTask(id) {
  // Below 900px the session list is a drawer over the conversation, so picking
  // a session has to reveal what was behind it instead of staying on top.
  const spoiler = $('controlsSpoiler');
  if (spoiler && window.matchMedia(MOBILE_QUERY).matches) spoiler.open = false;
  const version = resetSelection(id);
  showSessionLoader();
  try {
    const initial = await api(`/api/tasks/${encodeURIComponent(id)}/events?tail=${HISTORY_PAGE_TURNS}`);
    const t = await api(`/api/tasks/${encodeURIComponent(id)}`);
    if (version !== selectionVersion) return;
    syncSessionUrl(id);
    currentTask = t;
    reachedHistoryStart = initial.reachedStart;
    oldestLoadedSeq = initial.events.length ? initial.events[0].seq : null;
    chatState = new ChatState(t, { seedInitial: initial.reachedStart });
    // A pending approval from before this page load must still be answerable.
    try {
      for (const approval of await api(`/api/tasks/${encodeURIComponent(id)}/approvals`)) {
        if (approval.status === 'PENDING') pendingApprovals.set(approval.approvalId, approval);
      }
      renderApprovals();
    } catch { /* approvals are optional */ }
    applyEvents(initial.events);
    renderLoadOlderIndicator();
    chatState.snapshot(t, true);
    renderChat();
    renderTaskDetails(t);
    // The session stream comes from whichever transport this page runs on: SSE on
    // the PC, protocol frames through the relay in the cloud (web/transport.mjs).
    source = transport.open(id, {
      after: chatState.cursor,
      onEvent: event => {
        if (version !== selectionVersion) return;
        if (chatState.apply(event)) {
          if (!textUpdateTimer) textUpdateTimer = setTimeout(() => { textUpdateTimer = null; if (version === selectionVersion) renderChat(); }, 80);
          if (event.type === 'STATUS' || event.type.startsWith('TASK_')) refreshTask();
        }
      },
      onStatus: value => { if (value === 'reconnecting' && version === selectionVersion) refreshTask(); }
    });
    refreshTimer = setInterval(refreshTask, 2000);
    await loadArtifacts();
    if (version === selectionVersion) hideSessionLoader();
  } catch (error) {
    if (version !== selectionVersion) return;
    hideSessionLoader();
    $('createError').textContent = `Не удалось загрузить сессию: ${error.message}`;
    $('createError').classList.add('error');
  }
}

async function refreshTask() {
  if (!selectedTaskId || !chatState || refreshingVersion === selectionVersion) return;
  const id = selectedTaskId;
  const version = selectionVersion;
  const initialCursor = chatState.cursor;
  refreshingVersion = version;
  try {
    // Every fetch here carries a hard timeout: a request that never answers
    // (a wedged server, a lost connection) used to leave refreshingVersion set
    // forever, and the chat stopped updating until a page reload. An aborted
    // request lands in the catch, the lock is released, and the next tick
    // carries on.
    const t = await api(`/api/tasks/${encodeURIComponent(id)}`, { timeoutMs: REFRESH_TIMEOUT_MS });
    const events = await api(`/api/tasks/${encodeURIComponent(id)}/events?limit=0&after=${chatState.cursor}`, { timeoutMs: REFRESH_TIMEOUT_MS });
    if (version !== selectionVersion) return;
    applyEvents(events);
    // A stale metadata response must not stop a newer streaming event.
    if (chatState.cursor === initialCursor) chatState.snapshot(t);
    renderChat();
    renderTaskDetails(t); // also refreshes the stop button and the activity strip
    await loadArtifacts(REFRESH_TIMEOUT_MS);
    await loadTasks(REFRESH_TIMEOUT_MS);
  } catch (error) {
    if (version === selectionVersion) $('createError').textContent = `Связь прервана: ${error.message}`;
  } finally {
    if (refreshingVersion === version) refreshingVersion = null;
  }
}

async function sendContinueMessage(taskId, text, opts = {}) {
  const version = selectionVersion;
  const result = await commandApi(`/api/tasks/${encodeURIComponent(taskId)}/message`,
    { text, mode: 'auto', files: opts.files || [], uploadToken: opts.uploadToken || null,
      now: opts.now === true, queue: opts.queue === true });
  if (version === selectionVersion) await refreshTask();
  return result;
}

let composerSendNow = false;

// The queued prompt is visible with its own actions: send it early, or drop it.
function renderQueuedPrompt() {
  const host = $('queuedPrompt');
  const queue = currentTask?.pendingPrompts || [];
  if (!queue.length) { host.classList.add('hidden'); host.innerHTML = ''; return; }
  host.classList.remove('hidden');
  host.innerHTML = '';
  // The machine runs one generation at a time. A session that does NOT hold it
  // cannot force its queued prompt to the front — that would mean two parallel
  // runs. Its prompt goes out by itself when the busy session finishes, so the
  // control is disabled and names the session in the way instead of failing with
  // «машина занята» afterwards.
  const busy = lastTasks.find(task => task.status === 'RUNNING' && task.id !== selectedTaskId) || null;
  for (const [index, pending] of queue.entries()) {
  const row = document.createElement('div');
  row.className = 'queuedRow';
  const text = document.createElement('div');
  text.className = 'queuedText';
  const first = String(pending.text || '').split('\n')[0];
  const head = queue.length > 1 ? `В очереди (${index + 1}/${queue.length}): ${first}` : `В очереди: ${first}`;
  text.textContent = busy ? `${head} — ждёт «${busy.title || busy.id}»` : head;
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'small';
  send.textContent = 'Отправить сейчас';
  send.title = busy
    ? `Сейчас нельзя: идёт сессия «${busy.title || busy.id}».`
    : 'Вклиниться в текущий ответ: команды не остановятся, агент ответит на это сообщение';
  // Kept pressable on purpose: a dead button explains nothing. Pressing it says
  // why it cannot happen now; the prompt stays queued meanwhile.
  send.onclick = () => {
    if (busy) { showNotice(`Сейчас нельзя: идёт сессия «${busy.title || busy.id}». Сообщение отправится само, когда она завершится.`); return; }
    actOnPending('send', pending.id);
  };
  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'small';
  drop.textContent = 'Убрать';
  drop.onclick = () => actOnPending('drop', pending.id);
  row.append(text, send, drop);
  host.append(row);
  }
}

async function actOnPending(action, pendingId = null) {
  if (!selectedTaskId) return;
  try {
    if (action === 'send') await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/pending/send`, { method: 'POST', body: JSON.stringify({ pendingId }) });
    else await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/pending${pendingId ? `?pendingId=${encodeURIComponent(pendingId)}` : ''}`, { method: 'DELETE' });
    await refreshTask();
  } catch (error) {
    // A refusal here is not a crash: the prompt stays queued. Show it in the app
    // (alerts can be suppressed on a phone) instead of a dead-looking button.
    showNotice(error.message);
  }
}

// Neutral notice (the error styling stays for real failures).
function showNotice(text) {
  $('createError').textContent = text;
  $('createError').classList.remove('error');
}

const QUEUED_NOTICE = 'Модель занята — сообщение в очереди и отправится автоматически, как только она освободится.';

/* ---------------- panel ---------------- */

let projects = [];

async function loadProjects() {
  projects = await api('/api/projects');
  const options = projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`);
  options.push(`<option value="__scratch__">Без проекта (временная папка)</option>`);
  $('project').innerHTML = options.join('');
  // A choice between one real project and "no project" isn't a choice worth
  // showing; the select still exists (and works) for its .value, just hidden.
  $('project').classList.toggle('hidden', projects.length <= 1);
}

function pillClass(status) {
  if (status === 'SUCCEEDED') return 'ok';
  if (status === 'RUNNING' || status === 'QUEUED' || status === 'PREPARING' || status === 'WORKSPACE_READY' || status === 'PREFLIGHT' || status === 'RUNTIME_READY') return 'run';
  if (status === 'FAILED' || status === 'CANCELLED') return 'err';
  return '';
}

async function deleteTask(id) {
  if (!confirm('Удалить сессию без возможности восстановления?')) return;
  try {
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    if (selectedTaskId === id) startNewTask();
    await loadTasks();
  } catch (err) {
    alert(err.message);
  }
}

function projectName(id) {
  if (id === '__scratch__') return 'Без проекта';
  return projects.find(p => p.id === id)?.name || id;
}

let lastTasks = [];
let taskFilterProjectId = 'all';
let taskSearchQuery = '';
let taskSort = 'recent';
const taskSortSelect = $('taskSort');

function renderTaskFilter() {
  const options = ['<option value="all">Все проекты</option>']
    .concat(projects.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`))
    .concat(['<option value="__scratch__">Без проекта</option>']);
  $('taskProjectFilter').innerHTML = options.join('');
  $('taskProjectFilter').value = taskFilterProjectId;
}

// Relative time keeps the sessions screen readable: an absolute timestamp for
// every row is noise when what matters is "started two minutes ago".
function relativeTime(value) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return '—';
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return 'только что';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} дн назад`;
  return new Date(at).toLocaleDateString();
}

// A session's history can be huge; a compact count is enough to spot the big
// ones in the list without a wide number.
function compactCount(value) {
  const n = Number(value) || 0;
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

function taskRow(t) {
  const model = t.model || t.requestedModel;
  const modelLabel = model ? modelFullLabel(model) : (t.engine?.profileId || null);
  return `
    <div class="taskRow ${t.id === selectedTaskId ? 'active' : ''}" data-id="${t.id}">
      <button class="t-delete" type="button" data-delete-id="${t.id}" title="Удалить сессию" aria-label="Удалить сессию">✕</button>
      <button class="t-link" type="button" data-link-id="${t.id}" title="Скопировать ссылку на сессию" aria-label="Скопировать ссылку на сессию">🔗</button>
      <div class="t-prompt">${escapeHtml(t.title || t.prompt)}</div>
      <div class="t-sub">
        <span class="pill ${pillClass(t.status)}">${escapeHtml(t.status)}</span>
        <span class="t-project">${escapeHtml(projectName(t.projectId))}</span>
        ${modelLabel ? `<span class="t-model">${escapeHtml(modelLabel)}</span>` : ''}
        ${t.queueReason ? '<span class="t-queue">ждёт модель</span>' : ''}
        ${Number.isFinite(t.events) ? `<span class="t-count" title="Событий в истории">${compactCount(t.events)}</span>` : ''}
        <span class="t-time">${escapeHtml(relativeTime(t.updatedAt || t.createdAt))}</span>
      </div>
    </div>`;
}

// Sessions screen: what is running now comes first, everything finished is
// recent history (§ TZ: Sessions with ACTIVE / RECENT).
function renderTaskList() {
  $('taskCount').textContent = lastTasks.length ? `(${lastTasks.length})` : '';
  let tasks = taskFilterProjectId === 'all' ? lastTasks : lastTasks.filter(t => t.projectId === taskFilterProjectId);
  if (taskSearchQuery) {
    // Search by the session title, its text and its project name alike.
    tasks = tasks.filter(t => `${t.title || t.prompt || ''} ${projectName(t.projectId)}`.toLowerCase().includes(taskSearchQuery));
  }
  if (!tasks.length) {
    $('tasks').innerHTML = `<div class="none">${lastTasks.length ? 'Ничего не найдено.' : 'Пока нет сессий.'}</div>`;
    return;
  }
  const active = tasks.filter(t => ACTIVE_STATUSES.has(t.status))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const recent = tasks.filter(t => !ACTIVE_STATUSES.has(t.status))
    .sort(taskSort === 'size'
      ? (a, b) => (Number(b.events) || 0) - (Number(a.events) || 0)
      : (a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
  const group = (title, items) => items.length
    ? `<div class="taskGroup">${title} · ${items.length}</div>${items.map(taskRow).join('')}`
    : '';
  $('tasks').innerHTML = group('Активные', active) + group('Недавние', recent);

  document.querySelectorAll('.taskRow').forEach((row) => {
    row.onclick = () => selectTask(row.dataset.id);
  });
  document.querySelectorAll('.t-delete').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteTask(btn.dataset.deleteId);
    };
  });
  document.querySelectorAll('.t-link').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      copySessionLink(btn.dataset.linkId);
    };
  });
}

// The address is the point of per-session URLs: hand it to the phone or another
// browser instead of describing which session to open.
async function copySessionLink(id) {
  const path = sessionPath(id);
  const url = location.href ? new URL(path, location.href).href : path;
  try { await navigator.clipboard.writeText(url); alert(`Ссылка скопирована:
${url}`); }
  catch { alert(`Ссылка на сессию:
${url}`); }
}

$('taskProjectFilter').addEventListener('change', () => {
  taskFilterProjectId = $('taskProjectFilter').value;
  renderTaskList();
});

$('taskSearch').addEventListener('input', () => {
  taskSearchQuery = $('taskSearch').value.trim().toLowerCase();
  renderTaskList();
});

if (taskSortSelect) taskSortSelect.addEventListener('change', () => {
  taskSort = taskSortSelect.value;
  renderTaskList();
});

// Destructive: erase every message of the current session (the session itself
// stays). Always asks first, in the in-app dialog.
const clearChatButton = $('clearChat');
if (clearChatButton) clearChatButton.onclick = async () => {
  if (!selectedTaskId) return;
  const confirmed = await confirmDialog('Все сообщения этой сессии будут удалены без возможности восстановления. Сессия, её имя и проект останутся.', { title: 'Очистить чат?', ok: 'Очистить' });
  if (!confirmed) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/clear`, { method: 'POST', body: { confirm: true } });
    await loadTasks();
    await selectTask(selectedTaskId);
  } catch (error) {
    showNotice(error.message);
  }
};

async function loadTasks(timeoutMs = null) {
  lastTasks = await api('/api/tasks', timeoutMs ? { timeoutMs } : {});
  renderTaskFilter();
  renderTaskList();
  // A session can be running while another one is selected: keep the stop
  // button pointed at whoever actually works.
  updateStopButton();
  return lastTasks;
}

async function loadArtifacts(timeoutMs = null) {
  if (!selectedTaskId) return;
  const id = selectedTaskId;
  const version = selectionVersion;
  try {
    const list = await api(`/api/tasks/${id}/artifacts`, timeoutMs ? { timeoutMs } : {});
    if (version !== selectionVersion) return;
    const artifacts = $('artifacts');
    artifacts.innerHTML = list.length
      ? list.map((name) => `<a target="_blank" rel="noopener" href="/api/tasks/${selectedTaskId}/artifacts/${encodeURIComponent(name)}">${escapeHtml(name)}</a>`).join('')
      : '—';
    // An artifact opens natively on the machine (or in the viewer elsewhere) on
    // a plain click, and in a new tab on a modifier click — same rule as the
    // file chips and model-authored links.
    for (const a of artifacts.querySelectorAll('a')) {
      const url = a.getAttribute('href');
      a.onclick = (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        openFileViewer({ url, name: a.textContent });
      };
    }
  } catch {}
}

/* ---------------- composer / actions ---------------- */

async function uploadSelectedFiles() {
  const files = Array.from($('files').files || []);
  if (!files.length) return { files: [], uploadToken: null };
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);
  // No content-type header: the browser sets the multipart boundary itself.
  // The custom header is a CSRF guard (see AccessControl.checkOrigin).
  // Uploads are multipart and stay on HTTP: a cloud page uploads through the
  // machine, which is a separate step (see docs/cloud-ui.md § files).
  const res = await fetch('/api/uploads', { method: 'POST', headers: { 'x-taskbridge-upload': '1' }, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.code === 'AUTH_REQUIRED') showAuthGate();
    throw new Error(`${body.code || res.status}: ${body.error || res.statusText}`);
  }
  return { files: (body.files || []).map((file) => ({ id: file.id })), uploadToken: body.token };
}

function renderFileList() {
  const files = Array.from($('files').files || []);
  $('fileList').innerHTML = files.map((f, i) => `
    <span class="fileChip">${escapeHtml(f.name)} (${Math.round(f.size / 1024)} KB)
      <button type="button" data-remove-file="${i}" aria-label="Убрать файл">✕</button>
    </span>`).join('');
  $('fileList').querySelectorAll('[data-remove-file]').forEach((btn) => {
    btn.onclick = () => removeFile(Number(btn.dataset.removeFile));
  });
  updateClearButton();
}

function removeFile(index) {
  const dt = new DataTransfer();
  Array.from($('files').files || []).forEach((f, i) => { if (i !== index) dt.items.add(f); });
  $('files').files = dt.files;
  renderFileList();
}

$('files').addEventListener('change', renderFileList);

// Add files to the composer's attachment input. A file input's `files` cannot be
// assigned directly; a DataTransfer is the supported way, and the same trick is
// already used to remove one.
function addFilesToComposer(files) {
  const input = $('files');
  const transfer = new DataTransfer();
  for (const existing of Array.from(input.files || [])) transfer.items.add(existing);
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  renderFileList();
}

const promptEl = $('prompt');

// A wall of text pasted into the message box belongs in a file, not in the
// prompt: the box is bounded, and the agent reads attachments just as well. Above
// this many characters the text becomes a `.txt` attachment instead.
const PASTE_FILE_THRESHOLD = 8000;

function attachPastedText(text) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  addFilesToComposer([new File([text], `pasted-${stamp}.txt`, { type: 'text/plain' })]);
}

// The pasted text lives in a different field per event kind.
function clipText(event) {
  return event.clipboardData?.getData?.('text') ?? event.dataTransfer?.getData?.('text') ?? event.data ?? '';
}

promptEl.addEventListener('paste', (event) => {
  // A screenshot on the clipboard becomes an attachment. Only a paste event
  // carries the image as a file, so this is the one place it can be done.
  const images = [...(event.clipboardData?.items || [])]
    .filter(item => item && typeof item.type === 'string' && item.type.startsWith('image/'))
    .map(item => item.getAsFile?.())
    .filter(Boolean);
  if (images.length) {
    event.preventDefault();
    addFilesToComposer(images);
    return;
  }
  const text = clipText(event);
  const limit = Number(promptEl.maxLength) || PASTE_FILE_THRESHOLD;
  const replaced = (promptEl.selectionEnd ?? 0) - (promptEl.selectionStart ?? 0);
  if (text.length <= PASTE_FILE_THRESHOLD && promptEl.value.length - replaced + text.length <= limit) return;
  event.preventDefault();
  attachPastedText(text);
});

// Android/iOS browsers do not always fire `paste` with the clipboard text — the
// OS paste UI can insert it straight into the field. `beforeinput` carries the
// same data on Chromium, so it is the second chance to catch a large paste.
promptEl.addEventListener('beforeinput', (event) => {
  if (event.inputType !== 'insertFromPaste') return;
  const text = clipText(event);
  if (text.length > PASTE_FILE_THRESHOLD) { event.preventDefault(); attachPastedText(text); }
});

function updateClearButton() {
  const hasText = Boolean(promptEl.value.trim());
  const hasFiles = ($('files').files || []).length > 0;
  $('clearPrompt').classList.toggle('hidden', !hasText && !hasFiles);
}

function clearComposerInput() {
  promptEl.value = '';
  promptEl.style.height = '';
  $('files').value = '';
  $('fileList').textContent = '';
  drafts.delete(selectedTaskId || '__new__');
  updateClearButton();
  promptEl.focus();
}

$('clearPrompt').onclick = clearComposerInput;

/* ---------------- interface settings ---------------- */

// Font scale and window width, applied as CSS variables and remembered between
// visits. Width preset is the container max-width and the message column width.
const UI_SETTINGS_KEY = 'taskbridge-ui';
const UI_WIDTHS = {
  normal: { app: '1100px', msgs: '780px' },
  wide: { app: '1500px', msgs: '1000px' },
  full: { app: '100%', msgs: '100%' }
};
let uiSettings = { scale: 1, width: 'normal' };

// Never-saved defaults follow the screen: a desktop has the room for larger text
// and a wider column, a phone does not. A saved choice always wins.
function isWideScreen() {
  if (typeof window === 'undefined') return false;
  if (Number.isFinite(window.innerWidth) && window.innerWidth >= 1100) return true;
  return Boolean(window.matchMedia && window.matchMedia('(min-width: 1100px)').matches);
}

function loadUiSettings() {
  let saved = {};
  try { saved = JSON.parse((typeof localStorage === 'undefined' ? null : localStorage.getItem(UI_SETTINGS_KEY)) || '{}') || {}; } catch { saved = {}; }
  const scale = Number(saved.scale);
  // Only a record written by the settings panel (`v: 2`) counts as a choice. An
  // older record is the implicit old default, not a decision, so it must not
  // pin a desktop to the small layout any more.
  const chosen = saved.v === 2;
  const knownScale = chosen && Number.isFinite(scale) && scale >= 0.8 && scale <= 2 ? scale : null;
  const knownWidth = chosen && UI_WIDTHS[saved.width] ? saved.width : null;
  if (knownScale !== null && knownWidth !== null) {
    uiSettings = { scale: knownScale, width: knownWidth };
    return uiSettings;
  }
  const wide = isWideScreen();
  uiSettings = {
    // Font stays at its normal size by default (the larger one was too much);
    // only the column is wider on a desktop screen.
    scale: knownScale ?? 1,
    width: knownWidth ?? (wide ? 'wide' : 'normal')
  };
  return uiSettings;
}

function applyUiSettings({ persist = false } = {}) {
  const style = document.documentElement.style;
  style.setProperty('--ui-scale', String(uiSettings.scale));
  const width = UI_WIDTHS[uiSettings.width] || UI_WIDTHS.normal;
  style.setProperty('--app-max', width.app);
  style.setProperty('--msgs-max', width.msgs);
  if ($('uiScaleSelect')) $('uiScaleSelect').value = String(uiSettings.scale);
  if ($('uiWidthSelect')) $('uiWidthSelect').value = uiSettings.width;
  // Only an explicit choice is remembered; the screen-based default must not
  // freeze itself into storage (a desktop would then stay small forever).
  if (persist) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({ ...uiSettings, v: 2 })); } catch { /* private mode */ }
  }
  return uiSettings;
}

// Guarded: a stale cached shell (old index.html) can arrive with this new app.js,
// and a bare `$('id').onclick = …` on a missing element would throw at load and
// leave the page blank. These new bindings check the element first (the older
// ones predate this hardening and still assume the shell is current).
const uiSettingsButton = $('uiSettingsButton');
if (uiSettingsButton) uiSettingsButton.onclick = () => $('uiSettingsOverlay').classList.remove('hidden');
const uiSettingsClose = $('uiSettingsClose');
if (uiSettingsClose) uiSettingsClose.onclick = () => $('uiSettingsOverlay').classList.add('hidden');
const uiSettingsReset = $('uiSettingsReset');
if (uiSettingsReset) uiSettingsReset.onclick = () => { uiSettings = { scale: 1, width: 'normal' }; applyUiSettings({ persist: true }); };
const uiScaleSelect = $('uiScaleSelect');
if (uiScaleSelect) uiScaleSelect.onchange = () => { uiSettings.scale = Number(uiScaleSelect.value) || 1; applyUiSettings({ persist: true }); };
const uiWidthSelect = $('uiWidthSelect');
if (uiWidthSelect) uiWidthSelect.onchange = () => { uiSettings.width = uiWidthSelect.value; applyUiSettings({ persist: true }); };

// Applied at load (not only in init) so the first paint already has them and the
// shell is not briefly shown at the default size.
loadUiSettings();
applyUiSettings();

// Grow-only auto-height, batched to one resize per frame and skipped while an
// IME composition is running. The old code reset the height to `auto` on every
// keystroke; on a phone that made the composer twitch up and down under the
// caret. It is cleared back to the default only when the box is emptied.
let promptResizeFrame = null;
function growPrompt() {
  if (promptResizeFrame) return;
  const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
  promptResizeFrame = schedule(() => {
    promptResizeFrame = null;
    const cap = 240;
    const needed = promptEl.scrollHeight + 2; // + top/bottom border (border-box)
    if (needed > promptEl.offsetHeight + 1 && promptEl.offsetHeight < cap) {
      promptEl.style.height = `${Math.min(needed, cap)}px`;
    }
  });
}

promptEl.addEventListener('input', (event) => {
  // Third chance, and the one that always fires: whatever route the text took
  // (a paste without data, an autofill, a keyboard), a wall of text in the box is
  // moved into a file the moment it lands. This is the phone-safe path.
  if (promptEl.value.length > PASTE_FILE_THRESHOLD) {
    const text = promptEl.value;
    promptEl.value = '';
    promptEl.style.height = '';
    attachPastedText(text);
    return;
  }
  if (!event.isComposing) growPrompt();
  // Saved on every keystroke: refreshing the same session must not wipe it.
  saveDraft(selectedTaskId || '__new__');
  updateClearButton();
});
promptEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    // Touch devices: Enter inserts a newline; sending is done via the button.
    if (isTouchDevice()) return;
    event.preventDefault();
    // Ctrl/Cmd+Enter hands the prompt over immediately; plain Enter accepts the
    // queue when the local model is busy with something else.
    composerSendNow = event.ctrlKey || event.metaKey;
    $('form').requestSubmit();
  }
});

// The composer is cleared as soon as a prompt is handed over, so a failed send
// (or a session that died on it) would cost the operator the text. The last
// prompt stays in memory of the page and one click sends it again.
let lastPrompt = null; // { id, text, failedSend }

function updateRetryButton() {
  const repeatable = Boolean(lastPrompt) && lastPrompt.id === (selectedTaskId || null)
    && (lastPrompt.failedSend || currentTask?.status === 'FAILED');
  $('retryPrompt').classList.toggle('hidden', !repeatable);
  if (repeatable) $('retryPrompt').title = lastPrompt.text.slice(0, 200);
}

$('retryPrompt').onclick = () => {
  if (!lastPrompt) return;
  promptEl.value = lastPrompt.text;
  promptEl.style.height = 'auto';
  updateClearButton();
  $('retryPrompt').classList.add('hidden');
  $('form').requestSubmit();
};

function setBusy(busy) {
  $('sendButton').disabled = busy;
  $('project').disabled = busy || Boolean(selectedTaskId);
}

function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches;
}

/* ---------------- header: the phone's "⋮" menu ---------------- */

// The header a phone got had the profile picker, MCP, restart, pairing, the
// system chip and five icon buttons on it — with the session list that left the
// conversation a third of the screen. Below 900px the secondary controls — the
// model chip included — move into the menu as the SAME nodes, so nothing is
// duplicated and every listener keeps working. What is left is the title, the
// status dot and this menu: one row at any phone width, while a model name of
// any length in the header was not (at 360px even "deepseek-flash · medium"
// wrapped the header onto a second line). On a wide screen every control goes
// back into the header in its original order.
// Nothing is hidden: without JS the header is exactly what index.html says.
const HEADER_CONTROLS = ['runtimeControl', 'modelButton', 'localModelsButton', 'mcpButton', 'serverRestartButton', 'pairButton', 'pcState', 'sessionDetailsButton', 'helpButton', 'uiSettingsButton'];
// Menu order, not header order: the model switcher is what a phone opens this
// menu for. The status dot stays in the header — 12px of a live indicator costs
// no row, and the model chip was what pushed the header onto a second line.
const HEADER_MENU_CONTROLS = ['modelButton', 'runtimeControl', 'localModelsButton', 'mcpButton', 'serverRestartButton', 'pairButton', 'sessionDetailsButton', 'helpButton', 'uiSettingsButton'];
// The one width the phone layout starts at, shared by the header menu, the
// session drawer and the CSS (see the media queries in web/app.css).
const MOBILE_QUERY = '(max-width: 900px)';

function applyHeaderLayout() {
  const menu = $('headerMenu');
  const menuBody = $('headerMenuBody');
  const actions = document.querySelector('.headerActions');
  if (!menu || !menuBody || !actions) return;
  const compact = window.matchMedia(MOBILE_QUERY).matches;
  if (compact) {
    for (const id of HEADER_MENU_CONTROLS) {
      const control = document.getElementById(id);
      if (control) menuBody.append(control);
    }
  } else {
    // Appending in the index.html order leaves the wide-screen header as it was.
    for (const id of HEADER_CONTROLS) {
      const control = document.getElementById(id);
      if (control) actions.insertBefore(control, menu);
    }
    // A menu left open while the window grew would come back as a stray popup.
    menu.open = false;
  }
  // The CSS shows the menu only with this flag: a page whose script failed has
  // the controls still in the header, and an empty "⋮" that does nothing is
  // worse than no button at all.
  menu.toggleAttribute('data-ready', compact);
}

const headerMenuQuery = window.matchMedia(MOBILE_QUERY);
if (headerMenuQuery && typeof headerMenuQuery.addEventListener === 'function') {
  headerMenuQuery.addEventListener('change', applyHeaderLayout);
} else if (headerMenuQuery && typeof headerMenuQuery.addListener === 'function') {
  // Older MediaQueryList: without this a page opened narrow and then widened
  // would keep its controls in the menu with no way to reach them.
  headerMenuQuery.addListener(applyHeaderLayout);
}
applyHeaderLayout();

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = promptEl.value.trim();
  const attached = Array.from($('files').files || []);
  const sendNow = composerSendNow;
  composerSendNow = false;
  // A file without text is a valid message; the server substitutes a title.
  if ((!prompt && !attached.length) || $('sendButton').disabled) return;
  $('createError').textContent = '';
  $('createError').classList.remove('error');
  setBusy(true);
  // A send can legitimately wait minutes for a model to load: after two seconds
  // the operator must see WHY the composer is quiet, not just a disabled button.
  let slowTimer = setTimeout(() => showNotice('Отправляю… ждём модель. Это может занять минуту-другую.'), 2000);
  if (isTouchDevice()) promptEl.blur();
  try {
    const taskId = selectedTaskId;
    const version = selectionVersion;
    const { files, uploadToken } = await uploadSelectedFiles();
    const draftKey = taskId || '__new__';
    const clearComposer = () => {
      drafts.delete(draftKey);
      try { localStorage.removeItem(`tbDraft:${draftKey}`); } catch { /* best effort */ }
      if (promptEl.value.trim() === prompt) {
        promptEl.value = '';
        promptEl.style.height = '';
        $('files').value = '';
        $('fileList').textContent = '';
      }
      updateClearButton();
    };
    if (taskId) {
      // Optimistic render: instantly add the user message into the chat (0ms feedback).
      // The assistant turn is marked active so it shows the typing indicator,
      // not «Ответ не был получен.» — nothing has failed yet, the model just
      // has not started (or the message is queued). Each optimistic turn carries
      // a unique id: several messages may sit queued at once, and the reducer
      // reconciles the OLDEST pending one when its event arrives.
      const pendingId = `pending-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const dropOptimistic = () => {
        if (!chatState) return;
        chatState.turns = chatState.turns.filter(t => !t.id.startsWith(`user-${pendingId}`) && !t.id.startsWith(`assistant-${pendingId}`));
        if (chatState.current && chatState.current.id.startsWith(`assistant-${pendingId}`)) {
          chatState.current = [...chatState.turns].reverse().find(t => t.role === 'assistant') || chatState.current;
        }
        renderChat();
      };
      if (chatState && prompt) {
        chatState.addUser(prompt, files, pendingId, null, true);
        chatState.current.active = true;
        renderChat();
        scrollBottom();
      }
      clearComposer();
      let sent;
      try {
        sent = await sendContinueMessage(taskId, prompt, { files, uploadToken, now: sendNow, queue: !sendNow });
      } catch (error) {
        // An unconfirmed send is NOT a failed one: the server may have accepted
        // the message, so the optimistic turn stays on screen and the operator
        // is told what to do instead of losing text.
        if (error.ambiguous) {
          showNotice(error.message);
          lastPrompt = { id: taskId, text: prompt, failedSend: false };
          return;
        }
        // Remove the optimistic turn if the send failed
        dropOptimistic();
        // The machine runs one generation at a time. If it refused only because
        // the model is busy, the text goes to the queue instead of being lost
        // (the wording check keeps genuine failures visible).
        if (!/занят/i.test(error.message)) throw error;
        sent = await sendContinueMessage(taskId, prompt, { files, uploadToken, now: false, queue: true });
      }
      // A parked message is NOT in the conversation yet: it waits in the queue
      // badge, with «Отправить сейчас» / «Убрать». Showing it in both places read
      // as the same message appearing twice. When the queue delivers it, the
      // USER_MESSAGE event draws its bubble as usual.
      const parked = (sent?.pendingPrompts || []).some(entry => String(entry?.text || '').startsWith(prompt));
      if (parked) dropOptimistic();
      lastPrompt = { id: taskId, text: prompt, failedSend: false };
      renderQueuedPrompt();
      if (sent?.queueReason) showNotice(sent.queueReason === 'MODEL_LOADING'
        ? 'Локальная модель ещё не загружена — сообщение в очереди и отправится, как только она будет готова.'
        : QUEUED_NOTICE);
    } else {
      const task = await commandApi('/api/tasks', { projectId: $('project').value, prompt, files, uploadToken, model: pendingModel, thinkingLevel: pendingThinking });
      // Clear before selectTask() runs resetSelection(), which would
      // otherwise capture this just-sent text as a stale "new task" draft.
      clearComposer();
      lastPrompt = { id: task.id, text: prompt, failedSend: false };
      if (task.queueReason) showNotice(QUEUED_NOTICE);
      if (version === selectionVersion) {
        await loadTasks();
        await selectTask(task.id);
      }
    }
  } catch (err) {
    $('createError').textContent = err.message;
    $('createError').classList.add('error');
    // The text may already be gone from the composer: keep it for one click.
    lastPrompt = { id: selectedTaskId, text: prompt, failedSend: true };
  } finally {
    setBusy(false);
    clearTimeout(slowTimer);
    // The "Отправляю…" notice is cleared once the send is over — unless an
    // error replaced it or a queued prompt notice took its place.
    if ($('createError').textContent.startsWith('Отправляю')) $('createError').textContent = '';
    updateRetryButton();
    if (!isTouchDevice()) promptEl.focus();
  }
});

$('newTaskButton').onclick = () => {
  $('controlsSpoiler').open = false;
  startNewTask();
};

$('stopButton').onclick = async () => {
  const target = stopTarget();
  if (!target) return;
  if (!confirm(`Остановить текущую работу Pi в сессии «${target.title || target.id}»?`)) return;
  $('stopButton').disabled = true;
  try {
    await commandApi(`/api/tasks/${encodeURIComponent(target.id)}/cancel`, {});
  } catch (e) { alert(e.message); }
  await loadTasks();
  if (target.id === selectedTaskId) await refreshTask();
};

$('refresh').onclick = () => loadTasks();

$('renameButton').onclick = async () => {
  if (!selectedTaskId) return;
  const current = $('taskTitle').textContent;
  const next = prompt('Название сессии (пусто — вернуть исходный текст задачи):', current === '—' ? '' : current);
  if (next === null) return;
  try {
    await api(`/api/tasks/${selectedTaskId}`, { method: 'PATCH', body: JSON.stringify({ title: next }) });
    await refreshTask();
  } catch (e) { alert(e.message); }
};

$('compact').onclick = async () => {
  if (!selectedTaskId) return;
  const instructions = prompt('Доп. инструкции для compaction (можно оставить пустым):', '') ?? null;
  if (instructions === null) return;
  try {
    const r = await api(`/api/tasks/${selectedTaskId}/compact`, { method: 'POST', body: JSON.stringify({ instructions }) });
    alert(`Compaction завершён. Before: ${r.result?.tokensBefore ?? '?'}; after: ${r.result?.estimatedTokensAfter ?? '?'}`);
  } catch (e) {
    if (/too small|nothing to compact/i.test(e.message)) alert('Пока нечего сжимать — контекст ещё маленький.');
    else alert(e.message);
  }
};

$('autoCompaction').onclick = async () => {
  if (!selectedTaskId) return;
  const next = $('autoCompaction').dataset.enabled !== 'true';
  $('autoCompaction').disabled = true;
  try {
    await api(`/api/tasks/${selectedTaskId}/auto-compaction`, { method: 'POST', body: JSON.stringify({ enabled: next }) });
    await refreshTask();
  } catch (e) {
    alert(e.message);
    $('autoCompaction').disabled = false;
  }
};

$('applyChanges').onclick = async () => {
  if (!selectedTaskId) return;
  if (!confirm('Применить изменения этой сессии к исходному проекту?')) return;
  $('applyChanges').disabled = true;
  try {
    await commandApi(`/api/tasks/${encodeURIComponent(selectedTaskId)}/apply`, {});
    await refreshTask();
  } catch (error) {
    alert(error.message);
    await refreshTask();
  }
};

$('cleanupWorktree').onclick = async () => {
  if (!selectedTaskId) return;
  if (!confirm('Удалить рабочую копию (worktree)? Незакоммиченные изменения в ней будут потеряны.')) return;
  $('cleanupWorktree').disabled = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/worktree`, { method: 'DELETE' });
    await refreshTask();
  } catch (error) {
    alert(error.message);
    await refreshTask();
  }
};

$('sendFollowup').onclick = async () => {
  const text = $('followup').value.trim();
  if (!selectedTaskId || !text) return;
  $('sendFollowup').disabled = true;
  try {
    await sendContinueMessage(selectedTaskId, text);
    $('followup').value = '';
  } catch (e) { alert(e.message); }
  finally { $('sendFollowup').disabled = false; }
};

$('stateDetails').addEventListener('toggle', async () => {
  if (!$('stateDetails').open || !selectedTaskId) return;
  $('stateJson').textContent = 'Загрузка…';
  try {
    const id = selectedTaskId;
    const r = await api(`/api/tasks/${id}/state`);
    if (id !== selectedTaskId) return;
    $('stateJson').textContent = JSON.stringify(r.state, null, 2);
  } catch (e) { $('stateJson').textContent = e.message; }
});

/* ---------------- markdown (regex, no deps) ---------------- */

function isExternalUrl(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//');
}

function workspaceFileUrl(relativePath, download) {
  if (!selectedTaskId) return null;
  return `/api/tasks/${encodeURIComponent(selectedTaskId)}/workspace-file?path=${encodeURIComponent(relativePath)}${download ? '&download=1' : ''}`;
}

// Bare relative paths in model-authored Markdown are meaningless to the
// browser (resolved against the page URL, not the workspace) and absolute
// same-origin paths could otherwise be pointed at internal API routes.
function rewriteMarkdownLinks(container) {
  for (const a of container.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) continue;
    if (isExternalUrl(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; continue; }
    if (href.startsWith('/')) { a.removeAttribute('href'); continue; }
    // A relative link to a picture is an image the model is showing, not a file
    // to save: render it inline (clicking still opens the full picture) instead
    // of handing the operator a download link.
    if (IMAGE_EXT_RE.test(href)) {
      const inline = workspaceFileUrl(href, false);
      if (!inline) { a.removeAttribute('href'); continue; }
      const label = a.textContent || href;
      a.textContent = '';
      const img = document.createElement('img');
      img.src = inline;
      img.alt = label;
      img.loading = 'lazy';
      a.append(img);
      a.href = inline;
      a.target = '_blank';
      a.rel = 'noopener';
      continue;
    }
    // A relative link to a file the model produced: open it, do not push a
    // download. `download=1` is the server's attachment switch, so the link
    // points at the inline URL, and a plain click opens the file natively on the
    // machine or in the built-in viewer elsewhere. A modifier click still opens
    // a new tab.
    const url = workspaceFileUrl(href, false);
    if (url) {
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.onclick = (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        openFileViewer({ url, name: a.textContent || href });
      };
    } else a.removeAttribute('href');
  }
  for (const img of container.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!src || isExternalUrl(src) || src.startsWith('/')) continue;
    const url = workspaceFileUrl(src, false);
    if (url) img.src = url;
    img.loading = 'lazy';
  }
}

// Languages whose blocks are commands, plus untagged blocks (a command is often
// pasted without a language tag) — only those get the "Выполнить" button.
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'powershell', 'ps', 'ps1', 'pwsh', 'cmd', 'bat', 'batch', 'cmd.exe', 'dos']);
function codeLanguage(code) {
  const match = String(code && code.className || '').match(/language-([\w.+-]+)/);
  return match ? match[1].toLowerCase() : '';
}

function addCodeCopyButtons(container) {
  for (const pre of container.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    // Read the code from <code>, never from the <pre>: the buttons live inside
    // the wrapper, so pre.textContent would copy their labels along with the code.
    const source = code ? code.textContent : pre.textContent;

    // The actions must not scroll with the code: the <pre> is the scroll
    // container, so a button inside it slid away on a horizontal scroll. They
    // live in a wrapper around the <pre> instead.
    const wrap = document.createElement('div');
    wrap.className = 'codeWrap';
    pre.replaceWith(wrap);
    wrap.append(pre);

    // One wrapper holds the actions in a row: two absolutely positioned buttons
    // at guessed offsets overlapped on a narrow phone. The row lays them out with
    // a gap instead, so their widths do not have to be predicted.
    const actions = document.createElement('div');
    actions.className = 'codeActions';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'codeCopyBtn';
    copy.textContent = 'Копировать';
    copy.onclick = async () => {
      // Read at click time, and honour an explicit source (`data-copy`): syntax
      // highlighting rewrites the inner HTML and a viewer's code fence adds a
      // trailing newline — neither should change what lands in the clipboard.
      const text = (code && code.getAttribute('data-copy')) ?? (code ? code.textContent : pre.textContent);
      const ok = await copyText(text);
      copy.textContent = ok ? 'Скопировано' : 'Ошибка';
      setTimeout(() => { copy.textContent = 'Копировать'; }, 1500);
    };
    actions.append(copy);

    const language = codeLanguage(code);
    if (language === '' || SHELL_LANGS.has(language)) {
      const run = document.createElement('button');
      run.type = 'button';
      run.className = 'codeRunBtn';
      run.textContent = 'Выполнить';
      run.title = 'Выполнить на компьютере';
      run.setAttribute('aria-label', 'Выполнить на компьютере');
      run.onclick = () => runShellCommand(source, run);
      actions.append(run);
    }
    wrap.append(actions);
  }
}

/* ---------------- light syntax highlighting ---------------- */

// A small, dependency-free highlighter: strings, comments, numbers and
// keywords. It is deliberately conservative — an unknown language is left
// plain — and it only rewrites the inner HTML with the *same* characters, so
// `code.textContent` (and therefore the copy button) is untouched.
const HL_KEYWORD_RE = /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|new|delete|typeof|instanceof|in|of|void|yield|class|extends|super|this|import|export|from|as|async|await|try|catch|finally|throw|static|get|set|public|private|protected|interface|implements|abstract|final|enum|package|def|elif|lambda|pass|raise|with|global|nonlocal|and|or|not|is|None|True|False|self|fn|mut|pub|impl|trait|struct|use|mod|crate|match|where|unsafe|dyn|ref|val|fun|object|when|override|open|data|sealed|suspend|companion|init|by|end|then|begin|local|nil|elsif|unless|module|require|true|false|null|undefined|SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|DELETE|CREATE|TABLE|JOIN|ON|GROUP|BY|ORDER|LIMIT|AND|OR|NOT|NULL)\b/;
const HL_RULES = {
  slash: [
    { cls: 'string', re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/ },
    { cls: 'comment', re: /\/\/[^\n]*|\/\*[\s\S]*?\*\// },
    { cls: 'number', re: /\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/ },
    { cls: 'keyword', re: HL_KEYWORD_RE }
  ],
  hash: [
    { cls: 'string', re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/ },
    { cls: 'comment', re: /#[^\n]*/ },
    { cls: 'number', re: /\b\d[\d_]*(?:\.\d+)?\b/ },
    { cls: 'keyword', re: HL_KEYWORD_RE }
  ],
  sql: [
    { cls: 'string', re: /'(?:''|[^'])*'/ },
    { cls: 'comment', re: /--[^\n]*|\/\*[\s\S]*?\*\// },
    { cls: 'number', re: /\b\d+(?:\.\d+)?\b/ },
    { cls: 'keyword', re: HL_KEYWORD_RE }
  ],
  markup: [
    { cls: 'comment', re: /<!--[\s\S]*?-->/ },
    { cls: 'string', re: /"[^"]*"|'[^']*'/ },
    { cls: 'keyword', re: /<\/?[a-zA-Z][\w:-]*|\/?>/ }
  ]
};
const HL_LANGS = {
  js: 'slash', mjs: 'slash', cjs: 'slash', jsx: 'slash', ts: 'slash', tsx: 'slash', java: 'slash', kt: 'slash', kts: 'slash',
  c: 'slash', h: 'slash', cc: 'slash', cpp: 'slash', cxx: 'slash', hpp: 'slash', cs: 'slash', go: 'slash', rs: 'slash',
  swift: 'slash', dart: 'slash', php: 'slash', scala: 'slash', groovy: 'slash', gradle: 'slash', css: 'slash', scss: 'slash', less: 'slash',
  py: 'hash', rb: 'hash', pl: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', yaml: 'hash', yml: 'hash', toml: 'hash',
  ini: 'hash', cfg: 'hash', conf: 'hash', properties: 'hash', env: 'hash', r: 'hash', ps1: 'hash', powershell: 'hash', pwsh: 'hash', dockerfile: 'hash', make: 'hash', mk: 'hash',
  sql: 'sql', html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup'
};

function highlightText(text, family) {
  const rules = HL_RULES[family];
  if (!rules) return escapeHtml(text);
  const master = new RegExp(rules.map(rule => `(${rule.re.source})`).join('|'), 'gm');
  let out = '';
  let last = 0;
  let match;
  while ((match = master.exec(text)) !== null) {
    if (match[0] === '') { master.lastIndex++; continue; }
    out += escapeHtml(text.slice(last, match.index));
    const group = match.slice(1).findIndex(value => value !== undefined);
    out += `<span class="tok-${rules[group]?.cls || ''}">${escapeHtml(match[0])}</span>`;
    last = match.index + match[0].length;
    if (master.lastIndex === match.index) master.lastIndex++;
  }
  return out + escapeHtml(text.slice(last));
}

function highlightCode(container) {
  for (const code of container.querySelectorAll('pre code')) {
    const family = HL_LANGS[codeLanguage(code)];
    if (!family) continue;
    code.innerHTML = highlightText(code.textContent, family);
  }
}

// A wide table (many columns, long cells) would otherwise stretch the message
// bubble and push the whole chat sideways on a phone. Wrap each one in a
// horizontally scrollable box so the table keeps its natural width and only its
// own area scrolls.
function wrapTables(container) {
  for (const table of container.querySelectorAll('table')) {
    if (table.parentElement && table.parentElement.classList.contains('tableWrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'tableWrap';
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

function renderMarkdown(container, text) {
  container.innerHTML = DOMPurify.sanitize(marked.parse(text));
  rewriteMarkdownLinks(container);
  highlightCode(container);
  addCodeCopyButtons(container);
  wrapTables(container);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

/* ---------------- auth ---------------- */

let authGateShown = false;
function showAuthGate() {
  if (authGateShown) return;
  authGateShown = true;
  $('authGate').classList.remove('hidden');
}
function hideAuthGate() {
  authGateShown = false;
  $('authGate').classList.add('hidden');
  $('authCode').value = '';
  $('authError').textContent = '';
}

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('authCode').value.trim();
  if (!code) return;
  $('authError').textContent = '';
  try {
    const res = await fetch('/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Неверный код');
    hideAuthGate();
    await loadAll();
  } catch (err) { $('authError').textContent = err.message; }
});

async function checkAuth() {
  const info = await api('/api/auth');
  $('pairButton').classList.toggle('hidden', !(info.enabled && info.local));
  // `info.machine` is the server's verdict that this request came from the
  // machine itself (its own address, whether the browser used localhost or the
  // LAN address). Opening files with desktop apps only makes sense there.
  serverIsLocal = Boolean(info.machine);
  // Running commands on the machine is also fine for an authenticated client
  // (a paired phone): the PC executes, the phone receives the output.
  canExecute = Boolean(info.machine || info.authenticated);
  document.body.classList.toggle('machine-local', serverIsLocal);
  document.body.classList.toggle('machine-exec', canExecute);
  if (info.enabled && !info.authenticated) { showAuthGate(); return false; }
  return true;
}

$('pairButton').onclick = async () => {
  try {
    const pairing = await api('/api/auth/pairing');
    $('pairingCode').textContent = pairing.code.replace(/(\d{4})(\d{4})/, '$1 $2');
    const update = () => {
      const left = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
      $('pairingExpiry').textContent = left ? `Действует ещё ${left} с.` : 'Код истёк, откройте заново.';
    };
    update();
    const timer = setInterval(update, 1000);
    $('pairingOverlay').classList.remove('hidden');
    $('pairingClose').onclick = () => { clearInterval(timer); $('pairingOverlay').classList.add('hidden'); };
  } catch (err) { alert(err.message); }
};

/* ---------------- notifications ---------------- */

// The operator's decision (2026-09-21): the 🔔 switch is gone from the header.
// Over the LAN's plain http:// it could not work anyway — Chrome refuses the
// Notification API, the service worker and Push outside a secure context and
// does not even show the permission prompt. The web-push machinery on the
// machine and in sw.js was left intact on purpose: bringing notifications back
// is returning the button (#notifyButton) and the handler that used to switch
// `subscribeToPush` / `unsubscribeFromPush` on — both are kept below, unused.
//
// The browser never lets a page revoke its own notification permission, so when
// the button comes back the on/off switch belongs to TaskBridge itself:
// permission may be granted, but we only fire notifications while this flag is
// not 'off'.
const NOTIFY_KEY = 'tb.notifyEnabled';

function notifyEnabled() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  return localStorage.getItem(NOTIFY_KEY) !== 'off';
}

// Web Push (§ notifications): a notification that arrives with the app closed —
// or with the phone somewhere else entirely. The machine pushes it directly and
// encrypts it for this browser, so the cloud only carries the wake-up.
function urlBase64ToUint8Array(value) {
  const padded = (value + '='.repeat((4 - value.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
}

async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const { publicKey } = await api('/api/push/key');
  if (!publicKey) return null;
  const registration = await navigator.serviceWorker.ready;
  // An existing subscription made with another key would never deliver: drop it.
  const current = await registration.pushManager.getSubscription();
  if (current) {
    const same = new Uint8Array(current.options?.applicationServerKey || []).toString() === urlBase64ToUint8Array(publicKey).toString();
    if (same) { await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: current.toJSON(), name: navigator.userAgent.slice(0, 60) }) }); return current; }
    await current.unsubscribe().catch(() => {});
  }
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });
  await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON(), name: navigator.userAgent.slice(0, 60) }) });
  return subscription;
}

async function unsubscribeFromPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}



/* ---------------- project browser ---------------- */

let browsedPath = null;

async function loadProjectBrowser(target) {
  $('projectBrowserSelect').disabled = true;
  $('projectBrowserUp').disabled = true;
  $('projectBrowserList').textContent = 'Загрузка…';
  try {
    const data = await api(`/api/project-browser${target ? `?path=${encodeURIComponent(target)}` : ''}`);
    browsedPath = data.path;
    $('projectBrowserPath').textContent = data.path || 'Выберите одну из разрешённых папок:';
    $('projectBrowserUp').disabled = !data.parent;
    $('projectBrowserUp').dataset.parent = data.parent || '';
    $('projectBrowserSelect').disabled = !data.path;
    $('projectBrowserList').innerHTML = '';
    if (!data.entries.length) { $('projectBrowserList').textContent = 'Подпапок нет.'; return; }
    for (const entry of data.entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sessionPickerItem';
      button.textContent = `📁 ${entry.name}`;
      button.onclick = () => loadProjectBrowser(entry.path);
      $('projectBrowserList').append(button);
    }
  } catch (err) { $('projectBrowserList').textContent = err.message; }
}

$('addProjectButton').onclick = () => {
  $('projectBrowserOverlay').classList.remove('hidden');
  loadProjectBrowser(null);
};
$('projectBrowserClose').onclick = () => $('projectBrowserOverlay').classList.add('hidden');
$('projectBrowserUp').onclick = () => loadProjectBrowser($('projectBrowserUp').dataset.parent || null);
$('projectBrowserSelect').onclick = async () => {
  if (!browsedPath) return;
  const defaultName = browsedPath.split(/[\\/]/).filter(Boolean).pop() || browsedPath;
  const name = prompt('Название проекта:', defaultName);
  if (name === null) return;
  try {
    const project = await api('/api/project-browser/register', { method: 'POST', body: JSON.stringify({ path: browsedPath, name }) });
    $('projectBrowserOverlay').classList.add('hidden');
    await loadProjects();
    $('project').value = project.id;
    if (!selectedTaskId) newTaskProjectId = project.id;
  } catch (err) { alert(err.message); }
};

/* ---------------- manage projects ---------------- */

function renderManageProjectsList() {
  $('manageProjectsList').innerHTML = '';
  if (!projects.length) { $('manageProjectsList').textContent = 'Проектов нет.'; return; }
  for (const p of projects) {
    const row = document.createElement('div');
    row.className = 'projectRow';
    const info = document.createElement('div');
    info.className = 'projectRowInfo';
    info.innerHTML = `<span class="name">${escapeHtml(p.name)}</span><span class="meta">${escapeHtml(p.path)}</span>`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'projectRowDelete';
    del.textContent = '✕';
    del.title = 'Удалить проект';
    del.setAttribute('aria-label', `Удалить проект ${p.name}`);
    del.onclick = async () => {
      if (!confirm(`Удалить проект «${p.name}» из TaskBridge? Папка на диске не удаляется, старые сессии продолжат работать.`)) return;
      try {
        await api(`/api/projects/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
        await loadProjects();
        renderManageProjectsList();
      } catch (err) { alert(err.message); }
    };
    row.append(info, del);
    $('manageProjectsList').append(row);
  }
}

$('manageProjectsButton').onclick = () => {
  $('manageProjectsOverlay').classList.remove('hidden');
  renderManageProjectsList();
};
$('manageProjectsClose').onclick = () => $('manageProjectsOverlay').classList.add('hidden');

/* ---------------- native Pi session importer ---------------- */

// Import once, continue everywhere: the terminal Pi session is copied into
// TaskBridge and the conversation continues here (PC browser → phone → PC).
// "Safe copy" is the default, so the terminal file is never touched; taking
// ownership of the original stays an explicitly confirmed advanced mode.

let importGroups = null;
let importQuery = '';
let importSelection = null;

const importModelLabel = model => model ? `${model.provider ? `${model.provider}/` : ''}${model.id || ''}` : '—';

function importSessionRow(group, session) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'sessionPickerItem';
  if (importSelection?.session.key === session.key) row.classList.add('active');
  const name = session.preview || session.name;
  const recent = group.suggestion?.key === session.key && !session.existingTaskId;
  const meta = [
    new Date(session.mtime).toLocaleString(),
    session.existingTaskId ? 'уже открыта в TaskBridge' : null,
    recent ? 'только что из терминала' : null
  ].filter(Boolean).join(' · ');
  row.innerHTML = `<span class="name">${escapeHtml(name)}</span><span class="meta">${escapeHtml(session.name)}</span><span class="meta">${escapeHtml(meta)}</span>`;
  row.onclick = () => selectImportSession(group, session);
  return row;
}

function renderImportList() {
  const list = $('importList');
  const groups = importGroups || [];
  const query = importQuery.trim().toLowerCase();
  list.innerHTML = '';
  let shown = 0;
  for (const group of groups) {
    const sessions = group.sessions.filter(session => !query
      || [session.name, session.preview, group.name, group.path].filter(Boolean).join(' ').toLowerCase().includes(query));
    if (!sessions.length) continue;
    const header = document.createElement('div');
    header.className = 'modelGroup';
    header.textContent = `${group.name} · ${group.path}`;
    list.append(header);
    for (const session of sessions) list.append(importSessionRow(group, session));
    shown += sessions.length;
  }
  if (!shown) {
    list.textContent = groups.length
      ? 'Ничего не найдено.'
      : 'Сессии Pi не найдены. Проверьте pi.sessionRoots в config.json или поработайте в терминальном Pi.';
  }
}

function renderImportPreview(preview) {
  const node = $('importPreview');
  node.classList.remove('hidden');
  node.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'importTitle';
  title.textContent = preview.name || preview.id;
  const details = document.createElement('div');
  details.className = 'importDetails';
  const rows = [
    ['Проект', preview.projectPath],
    ['Модель', importModelLabel(preview.model)],
    ['Thinking', preview.thinkingLevel || '—'],
    ['Сообщений', String(preview.messageCount)],
    ['Токенов', preview.tokens == null ? '—' : preview.tokens.toLocaleString()],
    ['Изменена', new Date(preview.mtime).toLocaleString()]
  ];
  details.innerHTML = rows.map(([label, value]) => `<div class="r"><span>${escapeHtml(label)}</span><b>${escapeHtml(String(value ?? '—'))}</b></div>`).join('');
  const last = (label, text) => {
    if (!text) return null;
    const box = document.createElement('div');
    box.className = 'importText';
    box.innerHTML = `<span class="meta">${escapeHtml(label)}</span><p>${escapeHtml(text)}</p>`;
    return box;
  };
  node.append(title, details);
  for (const box of [last('Последнее сообщение пользователя', preview.lastUser), last('Последний ответ', preview.lastAssistant)]) {
    if (box) node.append(box);
  }

  if (preview.existingTaskId) {
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Открыть сессию в TaskBridge';
    open.onclick = async () => { closeImport(); await selectTask(preview.existingTaskId); };
    node.append(open);
    return;
  }

  const mode = importMode();
  const note = document.createElement('p');
  note.className = 'muted small';
  note.textContent = mode === 'take-over'
    ? 'Сессию дальше ведёт TaskBridge, оригинальный файл не копируется. Не открывайте её одновременно в терминальном Pi.'
    : 'Будет создана копия. Оригинал останется на месте и его можно открыть в Pi как раньше.';
  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  confirmButton.className = 'primary';
  confirmButton.textContent = 'Продолжить в TaskBridge';
  confirmButton.onclick = () => confirmImport(preview);
  node.append(note, confirmButton);
}

async function selectImportSession(group, session) {
  importSelection = { group, session };
  document.querySelectorAll('#importList .sessionPickerItem').forEach(node => node.classList.remove('active'));
  renderImportList();
  const node = $('importPreview');
  node.classList.remove('hidden');
  node.textContent = 'Загрузка…';
  try {
    const preview = await api(`/api/native-sessions/preview?projectId=${encodeURIComponent(group.id)}&key=${encodeURIComponent(session.key)}`);
    if (importSelection?.session.key !== session.key) return; // a newer click won
    renderImportPreview(preview);
  } catch (error) { node.textContent = `Не удалось прочитать сессию: ${error.message}`; }
}

// Anything unexpected falls back to the safe copy: taking ownership of the
// terminal's file must only ever happen after an explicit choice.
function importMode() { return $('importMode').value === 'take-over' ? 'take-over' : 'clone'; }

async function confirmImport(preview) {
  const mode = importMode();
  if (mode === 'take-over' && !confirm('Сессия станет управляемой TaskBridge: дальше её ведёт только он. Убедитесь, что в терминале она закрыта — при одновременной записи файл может испортиться. Продолжить?')) return;
  try {
    const task = await api('/api/tasks/from-session', {
      method: 'POST',
      body: JSON.stringify({ projectId: preview.projectId, sessionKey: preview.key, mode, ...(mode === 'take-over' ? { confirmedClosed: true } : {}) })
    });
    closeImport();
    await loadTasks();
    await selectTask(task.id);
  } catch (error) { alert(error.message); }
}

async function openImport(preselect = null) {
  $('importOverlay').classList.remove('hidden');
  $('importPreview').classList.add('hidden');
  $('importList').textContent = 'Загрузка…';
  importQuery = $('importSearch').value = '';
  importSelection = null;
  try { importGroups = await api('/api/native-sessions'); }
  catch (error) { $('importList').textContent = error.message; return; }
  renderImportList();
  if (preselect) {
    const group = importGroups.find(item => item.id === preselect.projectId);
    const session = group?.sessions.find(item => item.key === preselect.key);
    if (group && session) selectImportSession(group, session);
  }
}

function closeImport() { $('importOverlay').classList.add('hidden'); }

$('resumeSessionButton').onclick = () => openImport();
$('importClose').onclick = closeImport;
$('importRefresh').onclick = () => openImport();
$('importMode').addEventListener('change', () => { if (importSelection) selectImportSession(importSelection.group, importSelection.session); });
$('importSearch').addEventListener('input', () => { importQuery = $('importSearch').value; renderImportList(); });

/* ---------------- help ---------------- */

$('helpButton').onclick = () => $('helpOverlay').classList.remove('hidden');
$('helpClose').onclick = () => $('helpOverlay').classList.add('hidden');

/* ---------------- server restart ---------------- */

// Restarts the whole TaskBridge process, not a model profile. The server answers
// 202 at once and relaunches itself in a detached helper (POST /api/server/restart).
// The page then loses its stream for a few seconds, so it shows progress, waits
// for the server to actually go away and come back, and reloads itself.
let restarting = false;

function fetchWithTimeout(url, ms) {
  let timer;
  return Promise.race([
    fetch(url, { cache: 'no-store' }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })
  ]).finally(() => clearTimeout(timer));
}

// The page's own origin is the proxy in LAN mode, so "health answers" means the
// whole pair is up again — not just the app.
async function serverIsUp() {
  try { return (await fetchWithTimeout('/api/health', 2500)).ok; }
  catch { return false; }
}

async function waitUntil(predicate, timeoutMs, stepMs = 700) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
}

function showRestart({ title, detail, retry, spinning = true }) {
  if (spinning) $('serverRestartButton').classList.add('restarting');
  else $('serverRestartButton').classList.remove('restarting');
  $('restartTitle').textContent = title;
  $('restartDetail').textContent = detail;
  $('restartRetry').classList.toggle('hidden', !retry);
  $('restartOverlay').classList.remove('hidden');
}

function stopRestartProgress() {
  restarting = false;
  $('serverRestartButton').classList.remove('restarting');
}

async function bootIdOfServer() {
  try {
    const info = await api('/api/info', { timeoutMs: 3000 });
    return info?.bootId ? String(info.bootId) : null;
  } catch {
    return null;
  }
}

async function reloadWhenServerIsBack(initialBootId = null) {
  // Positive proof: /api/info answering with a different bootId means a new
  // process has started and is serving requests. Waiting for a downtime gap
  // fails on fast restarts or through reverse proxies where health polls
  // never catch the process going down, leaving the progress animation stuck
  // even while the DOM behind it has already reconnected and rebuilt.
  const deadline = Date.now() + 120000;
  let sawDown = false;
  let up = false;

  while (Date.now() < deadline) {
    if (initialBootId) {
      const current = await bootIdOfServer();
      if (!current) {
        sawDown = true;
      } else if (current !== initialBootId || sawDown) {
        up = true;
        break;
      }
    } else {
      if (await serverIsUp()) {
        up = true;
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 700));
  }

  if (!up) {
    stopRestartProgress();
    showRestart({ title: 'Сервер не отвечает', detail: 'Проверь окно запуска TaskBridge и попробуй ещё раз.', retry: true, spinning: false });
    return;
  }
  $('restartTitle').textContent = 'Сервер вернулся';
  $('restartDetail').textContent = 'Обновляем страницу…';
  await new Promise(resolve => setTimeout(resolve, 500));
  location.reload();
}

$('serverRestartButton').onclick = async () => {
  if (restarting) return;
  if (!confirm('Перезагрузить сервер TaskBridge?\n\nАктивные сессии будут прерваны, страница переподключится автоматически через несколько секунд.')) return;
  restarting = true;
  $('serverRestartButton').classList.add('restarting');
  const initialBootId = await bootIdOfServer().catch(() => null);
  try {
    await api('/api/server/restart', { method: 'POST', body: { confirm: true } });
  } catch (error) {
    stopRestartProgress();
    $('createError').textContent = `Не удалось перезагрузить сервер: ${error.message}`;
    $('createError').classList.add('error');
    return;
  }
  showRestart({ title: 'Перезагрузка сервера…', detail: 'Сервер получил команду. Ждём остановки, затем — запуска.', retry: false, spinning: true });
  await reloadWhenServerIsBack(initialBootId);
};

$('restartRetry').onclick = async () => {
  $('restartRetry').classList.add('hidden');
  $('restartDetail').textContent = 'Ждём, пока сервер вернётся…';
  restarting = true;
  $('serverRestartButton').classList.add('restarting');
  await reloadWhenServerIsBack(null);
};

/* ---------------- MCP (pi-mcp-adapter) ---------------- */

let mcpStatus = null;

let lastMcpTools = new Set();

function renderMcp() {
  const mode = mcpStatus?.mode || 'inherit';
  $('mcpMode').value = mode;
  $('mcpHint').textContent = mode === 'inherit'
    ? 'Задачи используют MCP-конфиг Pi без изменений (список ниже — только просмотр). Переключите на managed и импортируйте, чтобы управлять отсюда.'
    : mode === 'off'
      ? 'MCP выключен для задач: Pi запускается с пустым конфигом.'
      : `Задачи используют конфиг TaskBridge: ${mcpStatus?.configPath || ''}`;
  const servers = mcpStatus?.servers || [];
  const list = $('mcpList');
  list.innerHTML = '';
  if (!servers.length) {
    list.textContent = mode === 'managed' ? 'Пусто. Нажмите «Импорт из Pi».' : 'Список пуст.';
    return;
  }
  for (const server of servers) {
    const box = document.createElement('div');
    box.className = 'mcpServer';

    const row = document.createElement('div');
    row.className = 'localModel';
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'id';
    name.textContent = server.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const badge = document.createElement('span');
    badge.className = `badge ${server.disabled ? '' : 'ok'}`.trim();
    badge.textContent = server.disabled ? 'выключен' : 'включён';
    meta.append(badge);
    const excluded = new Set(server.excludeTools || []);
    if (excluded.size) {
      const off = document.createElement('span');
      off.className = 'badge';
      off.textContent = `−${excluded.size} tool`;
      meta.append(off);
    }
    if (server.transport) {
      const transport = document.createElement('span');
      transport.className = 'muted small';
      transport.textContent = server.transport;
      meta.append(transport);
    }
    info.append(name, meta);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = server.disabled ? 'Включить' : 'Выключить';
    button.disabled = mode !== 'managed';
    button.onclick = async () => {
      try {
        mcpStatus = await api('/api/mcp/servers', { method: 'POST', body: JSON.stringify({ name: server.name, enabled: server.disabled === true }) });
        renderMcp();
      } catch (error) { alert(error.message); }
    };
    row.append(info, button);
    box.append(row);

    const tools = server.tools || [];
    if (tools.length) {
      const details = document.createElement('details');
      details.className = 'mcpTools';
      details.open = lastMcpTools.has(server.name);
      details.addEventListener('toggle', () => {
        if (details.open) lastMcpTools.add(server.name);
        else lastMcpTools.delete(server.name);
      });
      const summary = document.createElement('summary');
      const onCount = tools.length - tools.filter(t => excluded.has(t.name)).length;
      summary.textContent = `Инструменты: ${onCount}/${tools.length}`;
      details.append(summary);
      for (const tool of tools) {
        const line = document.createElement('label');
        line.className = 'toolLine';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = !excluded.has(tool.name);
        check.disabled = mode !== 'managed' || server.disabled;
        check.onchange = async () => {
          try {
            mcpStatus = await api('/api/mcp/tools', { method: 'POST', body: JSON.stringify({ server: server.name, tool: tool.name, enabled: check.checked }) });
            renderMcp();
          } catch (error) { alert(error.message); await refreshMcp(); }
        };
        const text = document.createElement('span');
        text.textContent = tool.name;
        if (tool.description) text.title = tool.description;
        line.append(check, text);
        details.append(line);
      }
      box.append(details);
    }
    list.append(box);
  }
}

async function refreshMcp() {
  try { mcpStatus = await api('/api/mcp'); } catch { mcpStatus = null; }
  renderMcp();
}

$('mcpButton').onclick = async () => {
  $('mcpOverlay').classList.remove('hidden');
  await refreshMcp();
};
$('mcpClose').onclick = () => $('mcpOverlay').classList.add('hidden');
$('mcpRefresh').onclick = () => refreshMcp();
$('mcpImport').onclick = async () => {
  try { mcpStatus = await api('/api/mcp/import', { method: 'POST', body: '{}' }); renderMcp(); }
  catch (error) { alert(error.message); }
};
$('mcpMode').addEventListener('change', async () => {
  try {
    mcpStatus = await api('/api/mcp/mode', { method: 'POST', body: JSON.stringify({ mode: $('mcpMode').value }) });
    renderMcp();
  } catch (error) { alert(error.message); await refreshMcp(); }
});

/* ---------------- model selection (Pi models) ---------------- */

// The model list comes straight from Pi (all providers), so TaskBridge shows the
// same set as Pi's /model. Until a session is selected, a pick is remembered as
// the model for the next new task.
let modelCatalog = null;
let pendingModel = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem('taskbridge.pendingModel') || 'null');
    return raw && raw.provider && raw.id ? raw : null;
  } catch { return null; }
})();
let pendingThinking = (() => {
  try { return localStorage.getItem('taskbridge.pendingThinking') || null; } catch { return null; }
})();

function savePendingModel() {
  try {
    if (pendingModel) localStorage.setItem('taskbridge.pendingModel', JSON.stringify(pendingModel));
    else localStorage.removeItem('taskbridge.pendingModel');
    if (pendingThinking) localStorage.setItem('taskbridge.pendingThinking', pendingThinking);
    else localStorage.removeItem('taskbridge.pendingThinking');
  } catch {}
}

function modelFullLabel(model) {
  if (!model) return '—';
  return model.provider ? `${model.provider}/${model.id}` : String(model.id || '—');
}

function modelShortLabel(model) {
  if (!model) return 'по умолчанию Pi';
  return model.name || model.id || modelFullLabel(model);
}

function currentModel() {
  if (selectedTaskId && currentTask) return currentTask.model || currentTask.requestedModel || null;
  return pendingModel;
}

function currentThinking() {
  if (selectedTaskId && currentTask) return currentTask.thinkingLevelActual || currentTask.thinkingLevel || null;
  return pendingThinking;
}

function updateModelChip() {
  const model = currentModel();
  const thinking = currentThinking();
  const chip = $('modelButton');
  const name = `${modelShortLabel(model)}${thinking ? ` · ${thinking}` : ''}`;
  // The label is its own element so the phone can drop it and keep the name
  // (web/app.css): writing the whole chip as one string would take the name with
  // it. The fallback is for a cached older shell without the spans.
  const nameEl = chip.querySelector('.modelChipName');
  if (nameEl) nameEl.textContent = name;
  else chip.textContent = `Модель: ${name}`;
  chip.title = `${model ? modelFullLabel(model) : 'модель Pi по умолчанию'}${thinking ? ` · thinking ${thinking}` : ''} — сменить`;
  renderModelPanelLine(model, thinking);
}

// The status panel leads with the model the session actually answers with. The
// chip in the header shows a short name only (and on a phone it sits in the
// menu), while "which model am I talking to, and is it this machine or the
// cloud" is the question the panel is opened for.
function renderModelPanelLine(model, thinking) {
  const line = $('pcStateModel');
  if (!line) return;
  const provider = model?.provider ? String(model.provider) : null;
  // "Local" is the machine's own router. Its provider id comes from the server
  // (localStatus); the fallback is only for a label, and matches the id Pi
  // actually serves (`llama.cpp/qwen-27b-q3`).
  const local = Boolean(provider) && (localEnabled && provider === localProviderId() || /llama/i.test(provider));
  const text = `Модель Pi: ${[
    model ? modelFullLabel(model) : 'по умолчанию',
    provider ? (local ? 'локальная' : 'облачная') : null,
    thinking ? `thinking ${thinking}` : null
  ].filter(Boolean).join(' · ')}`;
  if (line.textContent !== text) line.textContent = text;
  renderProviderStatus(lastProviderStatuses, model);
}

// Баланс/подписка относятся к аккаунту точного Pi provider, а не к семейству
// модели. Так wormsoft/deepseek/* показывает лимит WormSoft, а не чужой счёт
// DeepSeek. Неизвестный провайдер просто не имеет строки состояния.
function providerStatusForModel(statuses, model) {
  const provider = String(model?.provider || '').trim().toLowerCase();
  return provider ? statuses?.[provider] || null : null;
}

function renderProviderStatus(statuses, model) {
  const el = $('pcStateProvider');
  // A refresh in flight owns the line: the poll must not overwrite the loader.
  if (!el || el.dataset.refreshing === '1') return;
  const status = providerStatusForModel(statuses, model);
  let text = '';
  if (status?.available) text = providerStatusText(status);
  else if (status?.reason === 'not-fetched') text = 'Нажмите, чтобы обновить данные провайдера';
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('hidden', !text);
}

function providerStatusText(status) {
  if (status.kind === 'balance' && status.provider === 'deepseek') return deepseekStatusText(status);
  if (status.kind === 'subscription' && status.provider === 'wormsoft') return wormsoftStatusText(status);
  if (status.kind === 'credits' && status.credits != null) {
    return `${status.label || status.provider}: ${Number(status.credits).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} кредитов${status.stale ? ' · данные устарели' : ''}`;
  }
  return '';
}

function deepseekStatusText(ds) {
  const bal = [];
  if (ds.balance?.cny != null) bal.push(`¥${ds.balance.cny.toFixed(2)}`);
  if (ds.balance?.usd != null) bal.push(`$${ds.balance.usd.toFixed(2)}`);
  const lines = [];
  if (bal.length) {
    if (ds.rub?.total != null) bal.push(`(≈ ${Math.round(ds.rub.total).toLocaleString('ru-RU')} ₽)`);
    lines.push(`DeepSeek: ${bal.join(' · ')}${ds.stale ? ' · данные устарели' : ''}`);
  }
  const days = ds.runway?.historyDays;
  const pace = ds.pace?.historyPerDay;
  const paceRub = ds.pace?.historyPerDayRub;
  const paceParts = [];
  if (pace != null) paceParts.push(`¥${pace.toFixed(1)}`);
  if (paceRub != null) paceParts.push(`≈ ${Math.round(paceRub).toLocaleString('ru-RU')} ₽`);
  const paceLabel = paceParts.length ? ` (расход ~${paceParts.join('/день ')}/день)` : '';
  if (days === 0) lines.push(`Средства DeepSeek исчерпаны${paceLabel}`);
  else if (days != null) lines.push(`Хватит примерно на ${days} дн.${paceLabel}`);
  return lines.join('\n');
}

function wormsoftStatusText(status) {
  const sub = status.subscription || {};
  const number = value => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const lines = [];
  if (sub.remaining != null) {
    const total = sub.total != null ? ` из ${number(sub.total)}` : '';
    const percent = sub.remainingRatio != null && sub.remaining > 0 ? ` (${Math.round(sub.remainingRatio * 100)}%)` : '';
    lines.push(`WormSoft: осталось ${number(sub.remaining)}${total} кредитов${percent}${status.stale ? ' · данные устарели' : ''}`);
  } else if (status.stale) {
    lines.push('WormSoft: данные устарели');
  }
  const usage = status.usage;
  const clock = value => new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const minutesToReset = usage?.nextResetAt != null
    ? Math.round((new Date(usage.nextResetAt).getTime() - Date.now()) / 60_000)
    : null;
  if (minutesToReset > 0) {
    // The refresh moment is the point of the line: more credits arrive there,
    // so the verdict says whether the measured supply reaches it. A standalone
    // "запаса хватит на N ч" is redundant next to that verdict.
    const verdict = usage?.perDay != null && sub.remaining != null
      ? ((sub.remaining * 24 / usage.perDay) * 60 >= minutesToReset
        ? ' · запаса до сброса хватает'
        : ' · запаса до сброса не хватит')
      : '';
    lines.push(`сброс лимитов в ${clock(usage.nextResetAt)} (замер)${verdict}`);
  } else if (usage?.perDay != null && sub.remaining != null) {
    // No measured reset yet: the supply duration is the only honest figure,
    // and the note explains why the reset time is absent rather than guessed.
    // An exhausted counter (possibly negative after an overrun) has no supply
    // to speak of — negative hours would read as nonsense.
    if (sub.remaining <= 0) {
      lines.push('кредиты исчерпаны (сброс не измерен)');
    } else {
      const hoursOfSupply = (sub.remaining * 24) / usage.perDay;
      const supply = hoursOfSupply >= 48
        ? `~${number(Math.round(hoursOfSupply / 24))} дн.`
        : `~${number(Math.round(hoursOfSupply))} ч`;
      lines.push(`запаса хватит на ${supply} (сброс не измерен)`);
    }
  }
  return lines.join('\n');
}




// Clicking the provider line refreshes the balances explicitly: the /api/info
// poll no longer touches the providers (an always-on status endpoint must not
// get the account blocked), so this is the only operator-driven fetch. A tiny
// in-line loader says what is happening instead of a frozen line.
$('pcStateProvider').onclick = async () => {
  const el = $('pcStateProvider');
  if (!el || el.classList.contains('hidden') || el.dataset.refreshing === '1') return;
  const provider = currentModel()?.provider;
  if (!['wormsoft', 'deepseek', 'routerai'].includes(provider)) return;
  el.dataset.refreshing = '1';
  const previous = el.textContent;
  el.textContent = 'Обновляем данные провайдера…';
  try {
    const statuses = await api('/api/providers/refresh', { method: 'POST', body: JSON.stringify({ provider }) });
    lastProviderStatuses = { ...lastProviderStatuses, ...statuses };
    delete el.dataset.refreshing;
    renderProviderStatus(lastProviderStatuses, currentModel());
    if (el.classList.contains('hidden')) {
      el.textContent = previous;
      el.classList.remove('hidden');
    }
  } catch (error) {
    delete el.dataset.refreshing;
    renderProviderStatus(lastProviderStatuses, currentModel());
    showNotice(`Не удалось обновить: ${error.message}`);
  }
};

function renderThinkingOptions() {
  const select = $('modelThinking');
  const levels = modelCatalog?.thinkingLevels || [];
  const current = currentThinking();
  const values = [...new Set([current, ...levels].filter(Boolean))];
  const placeholder = selectedTaskId ? '' : '<option value="">(по умолчанию модели)</option>';
  select.innerHTML = placeholder + values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  select.value = current && values.includes(current) ? current : '';
}

// The Pi catalogue easily reaches ~1000 models (openrouter/routerai alone are
// ~900 of them), and building them all at once makes the picker slow to open
// and janky to scroll — so the list renders in batches and extends itself
// when the sentinel scrolls into view. The search input is debounced for the
// same reason: every keystroke would otherwise rebuild the whole list.
const MODEL_LIST_BATCH = 200;
const MODEL_LIST_SEARCH_DEBOUNCE_MS = 150;
let modelListWindow = { filtered: [], rendered: 0 };
let modelListSearchTimer = 0;
const modelListSentinel = document.createElement('button');
modelListSentinel.type = 'button';
modelListSentinel.className = 'modelItem modelMore';
const modelListSentinelObserver = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) renderModelListBatch();
    })
  : null; // DOM-stand (tests) and very old browsers: no auto-extend, list stays batched
if (modelListSentinelObserver) modelListSentinelObserver.observe(modelListSentinel);

function renderModelListBatch() {
  const list = $('modelList');
  const { filtered } = modelListWindow;
  if (modelListWindow.rendered >= filtered.length) return;
  const from = modelListWindow.rendered;
  const to = Math.min(filtered.length, from + MODEL_LIST_BATCH);
  // The provider header must consider the item rendered right before the
  // batch start, otherwise a boundary between two batches duplicates it.
  let provider = from > 0 ? filtered[from - 1].provider : null;
  for (let i = from; i < to; i++) {
    const m = filtered[i];
    if (m.provider !== provider) {
      provider = m.provider;
      const group = document.createElement('div');
      group.className = 'modelGroup';
      group.textContent = provider || '—';
      list.append(group);
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'modelItem';
    const active = currentModel();
    if (active && active.provider === m.provider && active.id === m.id) item.classList.add('active');
    const id = document.createElement('div');
    id.className = 'modelId';
    id.textContent = m.id;
    const meta = document.createElement('div');
    meta.className = 'modelMeta';
    meta.textContent = [
      m.name && m.name !== m.id ? m.name : null,
      m.contextWindow ? `ctx ${m.contextWindow}` : null,
      m.reasoning ? 'thinking' : null,
      m.images ? 'vision' : null
    ].filter(Boolean).join(' · ');
    item.append(id, meta);
    item.onclick = () => chooseModel(m);
    list.append(item);
  }
  modelListWindow.rendered = to;
  modelListSentinel.textContent = `Показать ещё (${to} из ${filtered.length})`;
  modelListSentinel.hidden = to >= filtered.length;
  list.append(modelListSentinel);
}

function renderModelList() {
  const list = $('modelList');
  const models = modelCatalog?.models || [];
  const query = $('modelSearch').value.trim().toLowerCase();
  const filtered = query
    ? models.filter(m => `${m.provider}/${m.id} ${m.name || ''}`.toLowerCase().includes(query))
    : models;
  modelListWindow = { filtered, rendered: 0 };
  list.innerHTML = '';
  if (!filtered.length) {
    list.textContent = models.length ? 'Ничего не найдено.' : 'Pi не вернул ни одной доступной модели.';
    return;
  }
  renderModelListBatch();
}

async function openModelPicker(refresh = false) {
  $('modelPickerOverlay').classList.remove('hidden');
  $('modelList').textContent = 'Загрузка…';
  try {
    modelCatalog = await api(`/api/models${refresh ? '?refresh=1' : ''}`);
    renderThinkingOptions();
    renderModelList();
  } catch (error) {
    $('modelList').textContent = `Не удалось получить список моделей: ${error.message}`;
  }
}

async function chooseModel(model) {
  const selection = { provider: model.provider, id: model.id };
  if (!selectedTaskId) {
    pendingModel = selection;
    savePendingModel();
    updateModelChip();
    $('modelPickerOverlay').classList.add('hidden');
    return;
  }
  const chip = $('modelButton');
  chip.disabled = true;
  try {
    const updated = await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/model`, { method: 'POST', body: JSON.stringify(selection) });
    currentTask = updated;
    renderTaskDetails(updated);
    updateModelChip();
    $('modelPickerOverlay').classList.add('hidden');
    if (localEnabled && model.provider === localProviderId()) {
      loadLocalModel(model.id).catch(() => {});
    }
  } catch (error) {
    alert(`Не удалось сменить модель: ${error.message}`);
  } finally {
    chip.disabled = false;
  }
}

$('modelButton').onclick = () => openModelPicker();
$('changeModelButton').onclick = () => openModelPicker();
$('modelRefresh').onclick = () => openModelPicker(true);
$('modelPickerClose').onclick = () => $('modelPickerOverlay').classList.add('hidden');
$('modelSearch').addEventListener('input', () => {
  clearTimeout(modelListSearchTimer);
  modelListSearchTimer = setTimeout(renderModelList, MODEL_LIST_SEARCH_DEBOUNCE_MS);
});
$('modelThinking').addEventListener('change', async () => {
  const level = $('modelThinking').value || null;
  if (!level) {
    if (!selectedTaskId) { pendingThinking = null; savePendingModel(); updateModelChip(); }
    return;
  }
  if (!selectedTaskId) {
    pendingThinking = level;
    savePendingModel();
    updateModelChip();
    return;
  }
  try {
    const updated = await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/thinking`, { method: 'POST', body: JSON.stringify({ level }) });
    currentTask = updated;
    renderTaskDetails(updated);
    updateModelChip();
  } catch (error) { alert(error.message); }
});

/* ---------------- local llama.cpp router ---------------- */

let localEnabled = false;
let localStatus = null;
let localEvents = null;

// The server reports the id Pi actually serves — do not guess here: proposing
// a provider Pi does not have is exactly how a local request starts failing
// with "Provider is not configured".
function localProviderId() { return localStatus?.provider || null; }

function localStatusBadge(status) {
  const map = {
    loaded: ['ok', 'загружена'],
    sleeping: ['ok', 'спит'],
    loading: ['run', 'грузится'],
    downloading: ['run', 'качается'],
    failed: ['err', 'ошибка'],
    unloaded: ['mutedBadge', 'не загружена'],
    unknown: ['ok', 'активна']
  };
  return map[status] || ['mutedBadge', status || '—'];
}

function renderLocalRouterState() {
  const el = $('localRouterState');
  if (!localStatus) { el.textContent = 'Загрузка…'; $('localStop').disabled = true; return; }
  const labels = {
    MANAGED_RUNNING: 'работает (управляется TaskBridge)',
    EXTERNAL_RUNNING: 'работает (запущен извне)',
    STARTING: 'запускается',
    STOPPED: 'остановлен'
  };
  const parts = [
    `Router: ${labels[localStatus.state] || localStatus.state || '—'}`,
    localStatus.baseUrl || ''
  ];
  if (localStatus.pid) parts.push(`pid ${localStatus.pid}`);
  if (localStatus.error) parts.push(localStatus.error);
  el.textContent = parts.filter(Boolean).join(' · ');
  $('localStop').disabled = localStatus.state !== 'MANAGED_RUNNING' || !localStatus.pid;
  $('localStart').disabled = ['MANAGED_RUNNING', 'EXTERNAL_RUNNING', 'STARTING'].includes(localStatus.state);
}

function localModelRow(m) {
  const row = document.createElement('div');
  row.className = 'localModel';
  const info = document.createElement('div');
  info.className = 'info';

  const titleRow = document.createElement('div');
  titleRow.className = 'titleRow';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = m.name || m.id;
  name.title = m.id;
  titleRow.append(name);

  if (m.id && m.name && m.id !== m.name) {
    const sub = document.createElement('div');
    sub.className = 'modelSubpath muted small';
    sub.textContent = m.id;
    sub.title = m.id;
    info.append(titleRow, sub);
  } else {
    info.append(titleRow);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';

  const [cls, label] = localStatusBadge(m.status);
  const badge = document.createElement('span');
  badge.className = `badge ${cls}`.trim();
  badge.textContent = label;
  meta.append(badge);

  if (m.quant && m.quant !== '—') {
    const qBadge = document.createElement('span');
    qBadge.className = 'badge quant';
    qBadge.textContent = m.quant;
    meta.append(qBadge);
  }

  if (m.vision) {
    const vision = document.createElement('span');
    vision.className = 'badge vision';
    vision.textContent = 'vision';
    meta.append(vision);
  }

  const ctx = document.createElement('span');
  ctx.className = 'ctxBadge';
  ctx.textContent = m.contextWindow ? `ctx ${Number(m.contextWindow).toLocaleString('ru-RU')}` : 'ctx ?';
  meta.append(ctx);
  info.append(meta);

  const actions = document.createElement('div');
  actions.className = 'rowActions';

  const activeId = currentTask?.model?.id || currentTask?.requestedModel?.id || pendingModel?.id;
  const isCurrent = Boolean(activeId && (
    m.id === activeId ||
    m.name === activeId ||
    (m.name && activeId.toLowerCase().includes(m.name.toLowerCase())) ||
    (m.quant && activeId.toLowerCase().includes(m.quant.toLowerCase()))
  ));

  if (isCurrent) {
    row.classList.add('selected');
    const selectedBadge = document.createElement('span');
    selectedBadge.className = 'badge selectedBadge';
    selectedBadge.textContent = '✓ Выбрана';
    meta.prepend(selectedBadge);
  }

  const choose = document.createElement('button');
  choose.type = 'button';
  choose.className = `chooseBtn ${isCurrent ? 'selected' : ''}`.trim();
  choose.textContent = isCurrent ? '✓ Выбрана' : 'Выбрать';
  choose.disabled = isCurrent;
  choose.title = isCurrent ? 'Эта модель уже выбрана' : 'Сделать моделью текущей сессии / следующей задачи';
  choose.onclick = async () => {
    choose.disabled = true;
    choose.textContent = '…';
    await selectLocalModel(m.id);
  };
  actions.append(choose);

  // External server models cannot be loaded/unloaded via router API
  const isExternal = localStatus?.state === 'EXTERNAL_RUNNING' && m.status === 'unknown';
  if (!isExternal) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'loadBtn';
    const loaded = m.status === 'loaded' || m.status === 'sleeping';
    button.textContent = loaded ? 'Выгрузить' : m.status === 'loading' ? 'Отменить' : 'Загрузить';
    button.onclick = () => (loaded || m.status === 'loading') ? unloadLocalModel(m.id) : loadLocalModel(m.id);
    actions.append(button);
  }

  row.append(info, actions);
  return row;
}

// Selecting a local preset from the dialog goes through the same path as the
// unified picker: live session → set_model (+preload), otherwise → next task.
async function selectLocalModel(id) {
  const provider = localProviderId();
  if (!provider) { alert('Список локальных моделей ещё не загружен — откройте окно заново.'); return; }
  try {
    await chooseModel({ provider, id });
    if (selectedTaskId) await refreshTask();
    renderLocalModels();
  } catch (error) {
    alert(`Не удалось выбрать модель: ${error.message}`);
    renderLocalModels();
  }
}

function renderLocalModels() {
  const list = $('localModelsList');
  const models = localStatus?.models || [];
  renderLocalRouterState();
  list.innerHTML = '';
  if (!models.length) {
    list.textContent = localStatus?.reachable
      ? 'Router не вернул ни одной модели (проверьте --models-preset/--models-dir).'
      : 'Router недоступен — запустите его или проверьте localRuntime.router.';
    return;
  }
  // Group by quantization, newest/larger context first inside a group, so the
  // list reads like a model zoo instead of a flat preset dump.
  const groups = new Map();
  for (const m of models) {
    const key = m.quant || '—';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const entries = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const singleNamelessGroup = entries.length === 1 && entries[0][0] === '—';
  for (const [quant, items] of entries) {
    if (!singleNamelessGroup) {
      const header = document.createElement('div');
      header.className = 'modelGroup';
      header.textContent = quant === '—' ? `Без группы · ${items.length}` : `${quant} · ${items.length}`;
      list.append(header);
    }
    items.sort((a, b) => (b.contextWindow || 0) - (a.contextWindow || 0) || a.id.localeCompare(b.id));
    for (const m of items) list.append(localModelRow(m));
  }
}

function setLocalProgress(p) {
  $('localProgress').classList.remove('hidden');
  $('localProgressText').textContent = `${p.message || 'Загрузка'}${p.model ? ` · ${p.model}` : ''}${p.ratio != null ? ` · ${Math.round(p.ratio * 100)}%` : ''}`;
  $('localProgressFill').style.width = p.ratio != null ? `${Math.round(p.ratio * 100)}%` : '15%';
}

function clearLocalProgress() {
  $('localProgress').classList.add('hidden');
  $('localProgressFill').style.width = '0%';
}

async function refreshLocalStatus() {
  try { localStatus = await api('/api/local'); }
  catch { localStatus = null; }
  renderLocalModels();
  if (localStatus) updateLocalVisibility(localStatus.enabled);
}

function updateLocalVisibility(enabled) {
  const next = Boolean(enabled);
  if (localEnabled === next) return;
  localEnabled = next;
  $('localModelsButton').classList.toggle('hidden', !next);
  $('runtimeControl').classList.toggle('hidden', next);
}

async function loadLocalModel(id) {
  const chip = $('localModelsButton');
  const previous = chip.textContent;
  chip.textContent = 'Локальные модели …';
  setLocalProgress({ model: id, message: `Загрузка ${id}`, ratio: null });
  try { await api('/api/local/load', { method: 'POST', body: JSON.stringify({ model: id }) }); }
  catch (error) { alert(error.message); }
  finally {
    chip.textContent = previous;
    clearLocalProgress();
    await refreshLocalStatus();
  }
}

async function unloadLocalModel(id) {
  try { await api('/api/local/unload', { method: 'POST', body: JSON.stringify({ model: id }) }); }
  catch (error) { alert(error.message); }
  await refreshLocalStatus();
}

function openLocalEvents() {
  if (localEvents) return;
  // Load progress comes from the local router, so this stays direct SSE: it is
  // simply not available to a page served from the cloud.
  if (transport.kind !== 'local') return;
  localEvents = new EventSource('/api/local/events');
  localEvents.onmessage = (e) => {
    let message;
    try { message = JSON.parse(e.data); } catch { return; }
    if (message.type === 'snapshot') { localStatus = message; renderLocalModels(); }
    else if (message.type === 'progress') setLocalProgress(message);
    else if (message.type === 'status') refreshLocalStatus();
  };
  localEvents.onerror = () => {};
}

function closeLocalEvents() { localEvents?.close(); localEvents = null; }

$('sessionDetailsButton').onclick = () => $('sessionDetailsOverlay').classList.remove('hidden');
const closeSessionDetails = () => $('sessionDetailsOverlay').classList.add('hidden');
$('sessionDetailsClose').onclick = closeSessionDetails;
$('sessionDetailsCloseBtn').onclick = closeSessionDetails;
$('sessionDetailsOverlay').onclick = (e) => { if (e.target === $('sessionDetailsOverlay')) closeSessionDetails(); };

$('localModelsButton').onclick = async () => {
  $('localModelsOverlay').classList.remove('hidden');
  openLocalEvents();
  await refreshLocalStatus();
};
$('localModelsClose').onclick = () => { $('localModelsOverlay').classList.add('hidden'); closeLocalEvents(); clearLocalProgress(); };
$('localRefresh').onclick = () => refreshLocalStatus();
$('localStart').onclick = async () => {
  $('localStart').disabled = true;
  try { localStatus = await api('/api/local/start', { method: 'POST', body: '{}' }); }
  catch (error) { alert(error.message); }
  renderLocalModels();
};
$('localStop').onclick = async () => {
  if (!confirm('Остановить router llama.cpp? Загруженные модели будут выгружены.')) return;
  try { await api('/api/local/stop', { method: 'POST', body: '{}' }); }
  catch (error) { alert(error.message); }
  await refreshLocalStatus();
};

/* ---------------- model runtime ---------------- */

let runtimeBusy = false;

function renderRuntimeStatus(status) {
  const select = $('runtimeProfile');
  const options = status.profiles || [];
  $('runtimeControl').classList.toggle('hidden', options.length === 0);
  if (!options.length) return;
  const nextIds = options.map(p => p.id).join(',');
  if ([...select.options].map(o => o.value).join(',') !== nextIds) {
    const previous = select.value;
    select.innerHTML = options.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
    if (options.some(p => p.id === previous)) select.value = previous;
  }
  if (status.profileId && options.some(p => p.id === status.profileId)) select.value = status.profileId;

  const button = $('runtimeStart');
  const starting = ['STARTING', 'RESTARTING'].includes(status.state);
  const running = ['MANAGED_RUNNING', 'EXTERNAL_RUNNING'].includes(status.state);
  const canRestart = !(running && status.canRestart === false);
  button.dataset.action = running && canRestart ? 'restart' : 'start';
  button.textContent = starting ? (status.state === 'RESTARTING' ? '⟳' : '…') : running ? '⟳' : '▶';
  button.disabled = runtimeBusy || starting || (running && status.canRestart === false);
  button.title = starting
    ? (status.state === 'RESTARTING' ? 'Перезапуск…' : 'Запуск…')
    : running
      ? (canRestart ? 'Перезапустить модель' : (status.externalRestartReason || 'Модель запущена извне — перезапуск недоступен'))
      : 'Запустить модель';
  button.setAttribute('aria-label', button.title);
  select.disabled = button.disabled && running;
}

async function loadRuntimeStatus() {
  // In router mode the legacy profile selector must stay hidden; otherwise
  // every /api/info poll shows it and the next line hides it again (header flicker).
  if (localEnabled) { $('runtimeControl').classList.add('hidden'); return; }
  try { renderRuntimeStatus(await api('/api/runtime')); }
  catch { $('runtimeControl').classList.add('hidden'); }
}

$('runtimeStart').onclick = async () => {
  const profileId = $('runtimeProfile').value;
  const restarting = $('runtimeStart').dataset.action === 'restart';
  runtimeBusy = true;
  $('runtimeStart').disabled = true;
  $('runtimeStart').textContent = restarting ? '⟳' : '…';
  try {
    await api(restarting ? '/api/runtime/restart' : '/api/runtime/start', { method: 'POST', body: JSON.stringify({ profileId }) });
  } catch (err) { alert(err.message); }
  finally { runtimeBusy = false; await loadRuntimeStatus(); }
};

/* ---------------- init ---------------- */

let lastWarnings = null;

function renderWarnings(warnings) {
  const text = (warnings || []).map(w => w.message).join('\n');
  if (text === lastWarnings) return;
  lastWarnings = text;
  const el = $('piWarning');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

function fmtMetric(value, digits = 1) {
  return value == null || !Number.isFinite(Number(value))
    ? '—'
    : Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits });
}

const mbToGb = mb => (mb == null ? null : mb / 1024);

// Live PC + model state: the answer to "is the machine the reason the model is
// slow?". Nothing is invented — a field without data says so (TZ v3 §13).
// The load goes into the status dot's panel (tap the dot in the header); the
// speeds go to the live line above the composer, because they change every
// couple of seconds and a block that rewrites itself that often made the header
// twitch (that is why the two are separate at all).
function renderMachineLoad(info) {
  const panel = $('pcStateSystem');
  const sys = info.system || null;
  const engine = info.engine || {};
  const metrics = engine.metrics;
  const lines = [];

  // "Локальная модель", not "Модель": the panel leads with the model Pi answers
  // with (a cloud one, usually) and this line is the machine's own llama.cpp —
  // two different models in one panel must not read as one.
  if (engine.configured) lines.push(`Локальная модель: ${engine.model || 'не загружена'}`);
  // Занятость контекста (KV) локальной модели. Перенесено из расширения
  // model-state, которое показывало это только в консольном виджете.
  if (metrics && metrics.available && metrics.kvRatio != null) {
    const ctxLabel = metrics.contextWindow ? ` из ${Math.round(metrics.contextWindow / 1024)}K` : '';
    lines.push(`Контекст (KV): ${Math.round(metrics.kvRatio * 100)}%${ctxLabel}`);
  }

  const ram = sys?.ram;
  if (ram) lines.push(`RAM: ${fmtMetric(mbToGb(ram.used))} / ${fmtMetric(mbToGb(ram.total))} GB (${Math.round(ram.ratio * 100)}%)`);
  const cpu = sys?.cpu;
  if (cpu) lines.push(`CPU: ${cpu.load == null ? '—' : `${Math.round(cpu.load * 100)}%`} (${cpu.cores} ядер)`);
  const gpus = sys?.gpu;
  if (Array.isArray(gpus) && gpus.length) {
    for (const gpu of gpus) {
      const mem = gpu.memoryUsedMb != null && gpu.memoryTotalMb != null
        ? `${fmtMetric(mbToGb(gpu.memoryUsedMb))} / ${fmtMetric(mbToGb(gpu.memoryTotalMb))} GB`
        : '—';
      const power = gpu.powerDrawW != null
        ? `${fmtMetric(gpu.powerDrawW, 0)} W${gpu.powerLimitW != null ? ` / ${fmtMetric(gpu.powerLimitW, 0)} W` : ''}`
        : '—';
      lines.push(`GPU${gpu.name ? ` (${gpu.name})` : ''}: ${mem} · ${gpu.utilization != null ? `${gpu.utilization}%` : '—'} · ${power}${gpu.temperatureC != null ? ` · ${gpu.temperatureC} °C` : ''}`);
    }
  } else {
    lines.push('GPU: нет данных (nvidia-smi недоступен)');
  }

  // Порт, который реально опрошен. Показываем, только если он найден автодетектом
  // (сконфигурированный молчал) — иначе это лишний шум.
  if (engine.autoDetected && engine.baseUrl) {
    lines.push(`Сервер (порт определён автоматически): ${engine.baseUrl}`);
  }

  // Live line right above the composer: speeds only.
  if (panel && panel.textContent !== lines.join('\n')) panel.textContent = lines.join('\n');
  const live = $('liveMetrics');
  if (live) {
    const parts = [];
    if (metrics && metrics.available) {
      if (metrics.pp != null) parts.push(`PP ${fmtMetric(metrics.pp)}`);
      if (metrics.tg != null) parts.push(`TG ${fmtMetric(metrics.tg)} tok/s`);
    }
    const liveText = parts.join(' · ');
    if (live.textContent !== liveText) live.textContent = liveText;
    live.classList.toggle('hidden', !liveText);
  }
}

// The machine was restarted behind this page: a phone tab has no restart flow of
// its own running, so without this it keeps the old shell until the operator
// reloads by hand — while the tab that pressed the button refreshes right away.
// bootId is the running process, not the code: same build restarted still means
// a fresh start for every page.
let seenBootId = null;

async function checkPcState() {
  // The dot is the <summary> of a details now: the colour lives on it, and a tap
  // opens what the tooltip used to say (unreachable on a touch screen).
  const el = $('pcState');
  const dot = el?.querySelector('summary');
  const panel = $('pcStateStatus');
  if (!el || !dot) return;
  const paint = (state, text) => {
    dot.classList.remove('err', 'ok', 'run');
    if (state) dot.classList.add(state);
    dot.title = text;
    dot.setAttribute('aria-label', text.split('\n')[0]);
    // Same text as the tooltip, written only when it changes: this runs every
    // 2 seconds and an unchanged write is what made the header twitch before.
    if (panel && panel.textContent !== text) panel.textContent = text;
  };
  loadRuntimeStatus();
  try {
    const info = await api('/api/info');
    if (info.bootId) {
      if (seenBootId && info.bootId !== seenBootId) {
        seenBootId = info.bootId;
        location.reload();
        return;
      }
      seenBootId = info.bootId;
    }
    // Visible on purpose (not only in the tooltip): the operator reports bugs
    // against a version, so the running build must be readable on screen.
    const shownCommit = String(info.build?.commit || '').slice(0, 7);
    $('buildInfo').textContent = info.build?.version ? `· v${info.build.version}${shownCommit ? ` · ${shownCommit}` : ''}` : '';
    const buildDetails = [
      info.build?.commit ? `коммит ${info.build.commit}` : null,
      info.build?.date ? `собрано ${new Date(info.build.date).toLocaleString('ru-RU')}` : null
    ].filter(Boolean).join(', ');
    $('buildInfo').title = buildDetails;
    modelBusy = info.modelBusy;
    let label;
    let state;
    if (info.modelReady === false) {
      label = 'Модель недоступна';
      state = 'err';
    } else if (modelBusy === true) {
      label = 'Модель занята';
      state = 'run';
    } else {
      label = 'Модель онлайн';
      state = 'ok';
    }
    const addresses = (info.addresses || []).map((x) => x.url).join('\n');
    const engine = info.engine || {};
    const engineLine = engine.reachable
      ? [engine.model, engine.contextWindow ? `ctx ${engine.contextWindow}` : null, engine.slots ? `slots ${engine.slots.busy}/${engine.slots.total}` : null].filter(Boolean).join(' · ')
      : null;
    paint(state, [label, engineLine, addresses].filter(Boolean).join('\n'));
    renderMachineLoad(info);
    lastProviderStatuses = info.providerStatuses || (info.deepseek ? { deepseek: { ...info.deepseek, provider: 'deepseek', kind: 'balance' } } : {});
    renderProviderStatus(lastProviderStatuses, currentModel());
    if (info.local) {
      localStatus = info.local;
      updateLocalVisibility(info.local.enabled);
      if (!$('localModelsOverlay').classList.contains('hidden')) renderLocalModels();
    }
    renderWarnings(info.warnings);
  } catch {
    modelBusy = null;
    paint('err', 'Нет связи с сервером');
  }
}

async function loadAll() {
  try {
    await loadProjects();
    const tasks = await loadTasks();
    if (await openSessionFromLocation(tasks)) return;
    if (tasks.length) await selectTask(tasks[0].id);
    else startNewTask({ replace: true });
  } catch (e) {
    $('createError').textContent = e.message;
    $('createError').classList.add('error');
  }
}

/* ---------------- cloud mode ---------------- */

// Served from the internet: the page talks to the machine through the relay, so
// it waits for the handshake, says what the machine is doing, and hides the
// controls that only exist on the PC itself.
const cloudMode = transport.kind === 'cloud';

function renderModeBanner(state, detail = '') {
  const node = $('modeBanner');
  const machine = globalThis.__TASKBRIDGE_CLOUD__?.machineId || 'ПК';
  const text = {
    connecting: `Облачный режим: подключаюсь к ${machine} через релей…`,
    online: `Облачный режим: ${machine} на связи. Команды выполняются на ПК.`,
    offline: `Облачный режим: ${machine} офлайн — сессии станут доступны, когда ПК включится.`,
    unauthorized: 'Облачный режим: релей отклонил это устройство — спарьте телефон заново.',
    error: `Облачный режим: не удалось подключиться к ${machine}.`
  }[state] || '';
  node.textContent = detail ? `${text} ${detail}` : text;
  node.classList.remove('online', 'offline', 'unauthorized', 'error');
  if (state !== 'connecting') node.classList.add(state);
  node.classList.toggle('hidden', !text);
}

function startCloudMode() {
  document.body.classList.add('cloud-mode');
  renderModeBanner('connecting');
  transport.on('machine', payload => renderModeBanner(payload?.online ? 'online' : 'offline'));
  transport.on('status', value => {
    if (['connecting', 'offline', 'unauthorized'].includes(value)) renderModeBanner(value);
  });
  // Nothing can be fetched before AUTH_OK: wait for it instead of showing errors.
  transport.ready()
    .then(() => loadAll())
    .catch(error => renderModeBanner(error.code === 'AUTH_FAILED' ? 'unauthorized' : 'error', error.message));
}

if (cloudMode) startCloudMode();

async function init() {
  // Push endpoints rotate (the browser may replace one at any time), so the
  // machine is told about the current one every time the app opens. This runs
  // only for a browser that already granted notifications (the bell that asked
  // for them was removed by the operator's decision — see below), so it keeps a
  // working subscription fresh instead of nagging for one.
  if (notifyEnabled()) subscribeToPush().catch(() => {});
  checkPcState();
  setInterval(checkPcState, 2000);

  const sync = () => {
    checkPcState();
    if (selectedTaskId) refreshTask();
    else loadTasks();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
  });
  window.addEventListener('online', sync);
  // In cloud mode the first load waits for the relay handshake instead (see
  // startCloudMode), and the pairing screen belongs to the PC.
  if (!cloudMode && await checkAuth()) await loadAll();
  window.addEventListener('popstate', () => { routeFromLocation(); });
  // Keep the button as an accessible/manual fallback, but normally fetch the
  // next page before the operator reaches the top of the real scroll viewport.
  $('msgs').addEventListener('scroll', () => {
    if ($('msgs').scrollTop <= 240) loadOlderHistory();
  });
}

init();
