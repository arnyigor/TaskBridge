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
    throw new Error(`${error.code || 'HTTP_ERROR'}: ${error.message}`);
  }
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
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
  const open = document.createElement('a');
  open.href = fileUrl(taskId, file.id, false);
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = `📎 ${file.name}`;
  const download = document.createElement('a');
  download.href = fileUrl(taskId, file.id, true);
  download.className = 'downloadIcon';
  download.title = 'Скачать';
  download.setAttribute('aria-label', `Скачать ${file.name}`);
  // Inline SVG, not the glyph U+2B73: that rare codepoint is missing from many fonts and rendered as a tofu box instead of a download arrow.
  download.append(messageIcon('download'));
  card.append(open, download);
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
  const next = timeEl(turn.at, { range: turn.endedAt });
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
    for (const stale of [...node.body.querySelectorAll(':scope > .tool, :scope > .chatImage')]) stale.remove();
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
  return [
    ['Посмотреть', () => { if (window.open) window.open(absolute, '_blank', 'noopener'); }],
    ['Скачать', () => {
      const a = document.createElement('a');
      a.href = downloadUrl;
      if (alt) a.download = alt;
      document.body.append(a);
      a.click();
      a.remove();
    }],
    ['Копировать ссылку', () => { copyText(absolute); }]
  ];
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
    : 'Enter — отправить (если Pi занят — сообщение дождётся очереди), Ctrl+Enter — вклиниться сразу (прервёт текущий ответ, если инструмент не выполняется), Shift+Enter — перенос строки.';
  promptEl.placeholder = continuing
    ? `Сообщение продолжит текущую сессию. ${hint}`
    : `Сообщение для Pi. ${hint}`;
}

$('project').addEventListener('change', () => {
  if (!selectedTaskId) newTaskProjectId = $('project').value;
});

const drafts = new Map(); // taskId | '__new__' -> { text, files: File[] }

function saveDraft(key) {
  const text = promptEl.value;
  const files = Array.from($('files').files || []);
  if (!text && !files.length) drafts.delete(key);
  else drafts.set(key, { text, files });
}

function restoreDraft(key) {
  const draft = drafts.get(key);
  promptEl.value = draft?.text || '';
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 240)}px`;
  const dt = new DataTransfer();
  for (const file of draft?.files || []) dt.items.add(file);
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
      if (chip._state !== tool.state) {
        chip.className = `tool ${tool.state}`;
        chip._summary.textContent = `${tool.state === 'interrupted' ? '■' : toolIcon(tool.state)} ${tool.name}${tool.state === 'interrupted' ? ' · прервано' : ''}`;
        chip._state = tool.state;
      }
      if (tool.state === 'done' && tool.imagePath && IMAGE_EXT_RE.test(tool.imagePath) && !chip.dataset.imageShown) {
        appendInlineImage(tool.imagePath);
        chip.dataset.imageShown = 'true';
      }
    }
    if (node.status !== turn.status) {
      node.meta.textContent = turn.status || '';
      node.status = turn.status;
    }
    updateTurnActions(node, turn, turn === newest);
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
  download: [['polyline', { points: '21 15 21 19 21 19 3 19 3 15' }], ['line', { x1: '7', y1: '10', x2: '12', y2: '15' }], ['line', { x1: '17', y1: '10', x2: '12', y2: '15' }], ['line', { x1: '12', y1: '15', x2: '12', y2: '3' }]]
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
    summary.textContent = `${tool.state === 'interrupted' ? '■' : toolIcon(tool.state)} ${tool.name}${tool.state === 'interrupted' ? ' · прервано' : ''}`;
    chip._summary = summary;
    chip._state = tool.state;
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
      link.append(img);
      body.insertBefore(link, bubble);
      chip.dataset.imageShown = 'true';
    }
  }
  meta.textContent = turn.status || '';

  // Historical turns carry their own times too (a reloaded session must show
  // when each answer started and finished).
  const settledNode = { timeEl: null };
  setTurnTime(settledNode, turn, metaRow);
  $('msgsInner').insertBefore(wrap, before);
  return { wrap, body, bubble, md, meta, metaRow, copyBtn, tools, timeEl: settledNode.timeEl, text: turn.text, active: turn.active, error: turn.error, thinking: turn.thinking, status: turn.status };
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
    updateTurnActions(settled, turn, false);
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
    const { events, reachedStart } = await api(`/api/tasks/${encodeURIComponent(id)}/events?tail=${HISTORY_PAGE_TURNS}&before=${oldestLoadedSeq}`);
    if (version !== selectionVersion) return;
    const msgsEl = $('msgs');
    const prevScrollHeight = msgsEl.scrollHeight;
    const prevScrollTop = msgsEl.scrollTop;
    const prepended = chatState.prependOlder(currentTask, events, reachedStart);
    reachedHistoryStart = reachedStart;
    if (events.length) oldestLoadedSeq = events[0].seq;
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

async function selectTask(id) {
  const version = resetSelection(id);
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
  } catch (error) {
    if (version !== selectionVersion) return;
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
  const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/message`, {
    method: 'POST', body: JSON.stringify({ text, mode: 'auto', files: opts.files || [], uploadToken: opts.uploadToken || null,
      now: opts.now === true, queue: opts.queue === true })
  });
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
  const text = document.createElement('div');
  text.className = 'queuedText';
  const first = String(queue[0].text || '').split('\n')[0];
  text.textContent = queue.length > 1 ? `В очереди (${queue.length}): ${first}` : `В очереди: ${first}`;
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'small';
  send.textContent = 'Отправить сейчас';
  send.title = 'Прервать текущий ответ и отправить это сообщение сразу';
  send.onclick = () => actOnPending('send');
  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'small';
  drop.textContent = 'Убрать';
  drop.onclick = () => actOnPending('drop');
  host.append(text, send, drop);
}

async function actOnPending(action) {
  if (!selectedTaskId) return;
  try {
    if (action === 'send') await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/pending/send`, { method: 'POST', body: '{}' });
    else await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/pending`, { method: 'DELETE' });
    await refreshTask();
  } catch (error) { alert(error.message); }
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
        <span class="t-time">${escapeHtml(relativeTime(t.updatedAt || t.createdAt))}</span>
      </div>
    </div>`;
}

// Sessions screen: what is running now comes first, everything finished is
// recent history (§ TZ: Sessions with ACTIVE / RECENT).
function renderTaskList() {
  $('taskCount').textContent = lastTasks.length ? `(${lastTasks.length})` : '';
  let tasks = taskFilterProjectId === 'all' ? lastTasks : lastTasks.filter(t => t.projectId === taskFilterProjectId);
  if (taskSearchQuery) tasks = tasks.filter(t => (t.title || t.prompt || '').toLowerCase().includes(taskSearchQuery));
  if (!tasks.length) {
    $('tasks').innerHTML = `<div class="none">${lastTasks.length ? 'Ничего не найдено.' : 'Пока нет сессий.'}</div>`;
    return;
  }
  const active = tasks.filter(t => ACTIVE_STATUSES.has(t.status))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const recent = tasks.filter(t => !ACTIVE_STATUSES.has(t.status))
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
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
    $('artifacts').innerHTML = list.length
      ? list.map((name) => `<a target="_blank" href="/api/tasks/${selectedTaskId}/artifacts/${encodeURIComponent(name)}">${escapeHtml(name)}</a>`).join('')
      : '—';
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

const promptEl = $('prompt');

function updateClearButton() {
  const hasText = Boolean(promptEl.value.trim());
  const hasFiles = ($('files').files || []).length > 0;
  $('clearPrompt').classList.toggle('hidden', !hasText && !hasFiles);
}

function clearComposerInput() {
  promptEl.value = '';
  promptEl.style.height = 'auto';
  $('files').value = '';
  $('fileList').textContent = '';
  drafts.delete(selectedTaskId || '__new__');
  updateClearButton();
  promptEl.focus();
}

$('clearPrompt').onclick = clearComposerInput;

promptEl.addEventListener('input', () => {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 240)}px`;
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
      if (promptEl.value.trim() === prompt) {
        promptEl.value = '';
        promptEl.style.height = 'auto';
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
        chatState.addUser(prompt, files, pendingId);
        chatState.current.active = true;
        renderChat();
        scrollBottom();
      }
      clearComposer();
      let sent;
      try {
        sent = await sendContinueMessage(taskId, prompt, { files, uploadToken, now: sendNow, queue: !sendNow });
      } catch (error) {
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
      const task = await api('/api/tasks', {
        method: 'POST', body: JSON.stringify({ projectId: $('project').value, prompt, files, uploadToken, model: pendingModel, thinkingLevel: pendingThinking })
      });
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
    await api(`/api/tasks/${encodeURIComponent(target.id)}/cancel`, { method: 'POST', body: '{}' });
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
    await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/apply`, { method: 'POST', body: JSON.stringify({}) });
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
    const url = workspaceFileUrl(href, true);
    if (url) { a.href = url; a.target = '_blank'; a.rel = 'noopener'; } else a.removeAttribute('href');
  }
  for (const img of container.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!src || isExternalUrl(src) || src.startsWith('/')) continue;
    const url = workspaceFileUrl(src, false);
    if (url) img.src = url;
    img.loading = 'lazy';
  }
}

function addCodeCopyButtons(container) {
  for (const pre of container.querySelectorAll('pre')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'codeCopyBtn';
    btn.textContent = 'Копировать';
    btn.onclick = async () => {
      const ok = await copyText(pre.textContent);
      btn.textContent = ok ? 'Скопировано' : 'Ошибка';
      setTimeout(() => { btn.textContent = 'Копировать'; }, 1500);
    };
    pre.append(btn);
  }
}

function renderMarkdown(container, text) {
  container.innerHTML = DOMPurify.sanitize(marked.parse(text));
  rewriteMarkdownLinks(container);
  addCodeCopyButtons(container);
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

// The browser never lets a page revoke its own notification permission, so the
// on/off switch lives in TaskBridge itself: permission may be granted, but we
// only fire notifications while this flag is not 'off'.
const NOTIFY_KEY = 'tb.notifyEnabled';

function notifyEnabled() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  return localStorage.getItem(NOTIFY_KEY) !== 'off';
}

function updateNotifyButton() {
  const button = $('notifyButton');
  if (!('Notification' in window)) { button.classList.add('hidden'); return; }
  button.classList.remove('hidden');
  const enabled = notifyEnabled();
  button.textContent = '🔔';
  button.classList.toggle('granted', enabled);
  const title = enabled
    ? 'Уведомления включены — нажмите, чтобы выключить'
    : Notification.permission === 'granted'
      ? 'Уведомления выключены — нажмите, чтобы включить'
      : 'Включить уведомления';
  button.title = title;
  button.setAttribute('aria-label', title);
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

$('notifyButton').onclick = async () => {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    const turningOff = notifyEnabled();
    localStorage.setItem(NOTIFY_KEY, turningOff ? 'off' : 'on');
    updateNotifyButton();
    // Turning notifications off must also stop the ones that arrive while the
    // app is closed — otherwise the switch is a half-truth.
    if (turningOff) unsubscribeFromPush().catch(() => {});
    else subscribeToPush().catch(error => console.warn('push subscribe failed', error));
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    localStorage.setItem(NOTIFY_KEY, 'on');
    subscribeToPush().catch(error => console.warn('push subscribe failed', error));
  }
  updateNotifyButton();
  // Chrome blocks the Notification API entirely on plain HTTP origins other
  // than localhost, so a phone opening TaskBridge over LAN IP may never see
  // the permission prompt at all — requestPermission then just resolves to
  // 'denied' without the browser ever asking.
  if (permission !== 'granted') alert('Не получилось включить уведомления.\n\nПричина: браузер разрешает уведомления только для сайтов с https:// или для localhost. TaskBridge сейчас открыт по обычному http://, поэтому браузер даже не показал запрос на разрешение — это ограничение браузера, а не TaskBridge.\n\nЧтобы уведомления заработали, нужно включить HTTPS для TaskBridge.');
};

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
  chip.textContent = `Модель: ${modelShortLabel(model)}${thinking ? ` · ${thinking}` : ''}`;
  chip.title = `${model ? modelFullLabel(model) : 'модель Pi по умолчанию'}${thinking ? ` · thinking ${thinking}` : ''} — сменить`;
}

function renderThinkingOptions() {
  const select = $('modelThinking');
  const levels = modelCatalog?.thinkingLevels || [];
  const current = currentThinking();
  const values = [...new Set([current, ...levels].filter(Boolean))];
  const placeholder = selectedTaskId ? '' : '<option value="">(по умолчанию модели)</option>';
  select.innerHTML = placeholder + values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  select.value = current && values.includes(current) ? current : '';
}

function renderModelList() {
  const list = $('modelList');
  const models = modelCatalog?.models || [];
  const query = $('modelSearch').value.trim().toLowerCase();
  const active = currentModel();
  const filtered = query
    ? models.filter(m => `${m.provider}/${m.id} ${m.name || ''}`.toLowerCase().includes(query))
    : models;
  list.innerHTML = '';
  if (!filtered.length) {
    list.textContent = models.length ? 'Ничего не найдено.' : 'Pi не вернул ни одной доступной модели.';
    return;
  }
  let provider = null;
  for (const m of filtered) {
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
    if (localEnabled && model.provider === localProviderId()) loadLocalModel(model.id);
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
$('modelSearch').addEventListener('input', renderModelList);
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

  const choose = document.createElement('button');
  choose.type = 'button';
  choose.className = 'chooseBtn';
  choose.textContent = 'Выбрать';
  choose.title = 'Сделать моделью текущей сессии / следующей задачи';
  choose.onclick = () => selectLocalModel(m.id);
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
  await chooseModel({ provider, id });
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
function renderSysState(info) {
  const el = $('sysState');
  const body = $('sysStateBody');
  if (!el || !body) return;
  const sys = info.system || null;
  const engine = info.engine || {};
  const metrics = engine.metrics;
  const lines = [];

  if (engine.configured) lines.push(`Модель: ${engine.model || 'не загружена'}`);

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

  const compact = [];
  if (Array.isArray(gpus) && gpus.length && gpus[0].utilization != null) compact.push(`GPU ${gpus[0].utilization}%`);
  if (cpu?.load != null) compact.push(`CPU ${Math.round(cpu.load * 100)}%`);
  if (ram) compact.push(`RAM ${Math.round(ram.ratio * 100)}%`);

  el.classList.toggle('hidden', !sys);
  el.querySelector('summary').textContent = compact.length ? compact.join(' · ') : 'Система —';
  body.textContent = lines.join('\n');

  // Live line right above the composer: speeds only.
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

async function checkPcState() {
  const el = $('pcState');
  loadRuntimeStatus();
  try {
    const info = await api('/api/info');
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
    el.classList.remove('err', 'ok', 'run');
    let label;
    if (info.modelReady === false) {
      label = 'Модель недоступна';
      el.classList.add('err');
    } else if (modelBusy === true) {
      label = 'Модель занята';
      el.classList.add('run');
    } else {
      label = 'Модель онлайн';
      el.classList.add('ok');
    }
    const addresses = (info.addresses || []).map((x) => x.url).join('\n');
    const engine = info.engine || {};
    const engineLine = engine.reachable
      ? [engine.model, engine.contextWindow ? `ctx ${engine.contextWindow}` : null, engine.slots ? `slots ${engine.slots.busy}/${engine.slots.total}` : null].filter(Boolean).join(' · ')
      : null;
    el.title = [label, engineLine, addresses].filter(Boolean).join('\n');
    el.setAttribute('aria-label', label);
    renderSysState(info);
    if (info.local) {
      localStatus = info.local;
      updateLocalVisibility(info.local.enabled);
      if (!$('localModelsOverlay').classList.contains('hidden')) renderLocalModels();
    }
    renderWarnings(info.warnings);
  } catch {
    modelBusy = null;
    el.classList.remove('ok', 'run');
    el.classList.add('err');
    el.title = 'Нет связи с сервером';
    el.setAttribute('aria-label', 'Нет связи с сервером');
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
  updateNotifyButton();
  // Push endpoints rotate (the browser may replace one at any time), so the
  // machine is told about the current one every time the app opens.
  if (notifyEnabled()) subscribeToPush().catch(() => {});
  checkPcState();
  setInterval(checkPcState, 2000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkPcState();
  });
  // In cloud mode the first load waits for the relay handshake instead (see
  // startCloudMode), and the pairing screen belongs to the PC.
  if (!cloudMode && await checkAuth()) await loadAll();
  window.addEventListener('popstate', () => { routeFromLocation(); });
}

init();
