import { ChatState, ACTIVE_STATUSES } from './chat-state.mjs';
import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.mjs';
const $ = (id) => document.getElementById(id);

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
let modelBusy = null;  // true/false/null(unknown) — from /api/info, refreshed every 4s

// Interactive tool approvals (§52–§55). The Pi extension asks TaskBridge before
// a risky tool call; the request stays pending until an operator answers here
// or from the remote PWA.
let pendingApprovals = new Map();

const HISTORY_PAGE_TURNS = 20;
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

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.code === 'AUTH_REQUIRED') showAuthGate();
    throw new Error(`${body.code || res.status}: ${body.error || res.statusText}`);
  }
  return body;
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

function fileUrl(taskId, fileId, download) {
  return `/api/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}${download ? '?download=1' : ''}`;
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
  download.textContent = '⭳';
  download.title = 'Скачать';
  download.setAttribute('aria-label', `Скачать ${file.name}`);
  card.append(open, download);
  return card;
}

function renderOutputFiles(files) {
  const el = $('outputFiles');
  el.innerHTML = '';
  if (!files.length || !selectedTaskId) { el.textContent = '—'; return; }
  for (const f of files) el.append(fileCard(f, selectedTaskId));
}

function appendUserTurn(text, files = [], before = null) {
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
    for (const f of files) list.append(f.id ? fileCard(f, selectedTaskId) : Object.assign(document.createElement('span'), { className: 'fileChip', textContent: `📎 ${f.name}` }));
    body.append(list);
  }
  turn.append(body);
  $('msgsInner').insertBefore(turn, before);
  if (!before) scrollBottom();
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
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'copyBtn';
  copyBtn.textContent = '📋';
  copyBtn.title = 'Скопировать ответ';
  copyBtn.setAttribute('aria-label', 'Скопировать ответ');
  const metaRow = document.createElement('div');
  metaRow.className = 'metaRow';
  metaRow.append(botBadge(), meta, copyBtn);
  body.append(bubble, metaRow);
  turn.append(body);
  $('msgsInner').append(turn);
  liveTurn = { body, md, meta, metaRow, copyBtn, turn };
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

function updateText() {
  if (!liveTurn) return;
  const text = liveText.trim();
  if (text) renderMarkdown(liveTurn.md, text);
  else liveTurn.md.innerHTML = liveActive ? TYPING_HTML : '<span class="muted">Ответ не был получен.</span>';
  scrollBottom();
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

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
  liveTurn.body.insertBefore(link, liveTurn.metaRow);
  scrollBottom();
}

function appendSystemNote(text, before = null) {
  hideEmptyState();
  const note = document.createElement('div');
  note.className = 'systemNote';
  note.textContent = text;
  $('msgsInner').insertBefore(note, before);
  if (!before) scrollBottom();
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
    : 'Enter — отправить, Shift+Enter — перенос строки.';
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
  for (const turn of chatState.turns) {
    let node = turnNodes.get(turn.id);
    if (!node) {
      if (turn.role === 'user') {
        appendUserTurn(turn.text, turn.files);
        turnNodes.set(turn.id, {});
        continue;
      }
      if (turn.role === 'note') {
        appendSystemNote(turn.text);
        turnNodes.set(turn.id, {});
        continue;
      }
      liveText = liveThinking = '';
      liveActive = false;
      appendBotTurn();
      node = { ...liveTurn, tools: new Map() };
      turnNodes.set(turn.id, node);
    }
    if (turn.role !== 'assistant') continue;
    liveTurn = node;
    liveText = turn.text;
    liveThinking = turn.thinking;
    liveActive = turn.active;
    if (node.text !== turn.text || node.active !== turn.active || node.error !== turn.error) {
      updateText();
      node.copyBtn.onclick = () => copyText(turn.text);
      if (turn.error) {
        const error = document.createElement('div');
        error.className = 'turnError';
        error.textContent = turn.error;
        node.md.append(error);
      }
      node.text = turn.text;
      node.active = turn.active;
      node.error = turn.error;
    }
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
        node.body.insertBefore(chip, node.metaRow);
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
  }
  scrollBottom();
}

function applyEvents(events) {
  let approvalsChanged = false;
  for (const event of events) {
    chatState.apply(event);
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
  if (approvalsChanged) renderApprovals();
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
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'copyBtn';
  copyBtn.textContent = '📋';
  copyBtn.title = 'Скопировать ответ';
  copyBtn.setAttribute('aria-label', 'Скопировать ответ');
  copyBtn.onclick = () => copyText(turn.text);
  const metaRow = document.createElement('div');
  metaRow.className = 'metaRow';
  metaRow.append(botBadge(), meta, copyBtn);
  body.append(bubble, metaRow);
  wrap.append(body);

  if (turn.thinking) body.insertBefore(reasoningEl(turn.thinking), body.firstChild);
  const text = (turn.text || '').trim();
  if (text) renderMarkdown(md, text);
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
    body.insertBefore(chip, metaRow);
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
      body.insertBefore(link, metaRow);
      chip.dataset.imageShown = 'true';
    }
  }
  meta.textContent = turn.status || '';

  $('msgsInner').insertBefore(wrap, before);
  return { body, md, meta, metaRow, copyBtn, tools, text: turn.text, active: turn.active, error: turn.error, thinking: turn.thinking, status: turn.status };
}

function renderPrependedTurns(turns) {
  // The "load older" button (if present) must stay the topmost element, so
  // newly-backfilled turns are inserted right after it, not above it.
  const loadOlderBtn = document.getElementById('loadOlderButton');
  const reference = loadOlderBtn ? loadOlderBtn.nextSibling : $('msgsInner').firstChild;
  for (const turn of turns) {
    if (turnNodes.has(turn.id)) continue;
    if (turn.role === 'user') { appendUserTurn(turn.text, turn.files, reference); turnNodes.set(turn.id, {}); continue; }
    if (turn.role === 'note') { appendSystemNote(turn.text, reference); turnNodes.set(turn.id, {}); continue; }
    turnNodes.set(turn.id, renderSettledTurn(turn, reference));
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

function renderTaskDetails(t) {
  maybeNotify(t);
  currentTask = t;
  $('taskTitle').textContent = t.title || t.prompt || t.id;
  $('taskStatus').textContent = t.status;
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
  $('stopButton').disabled = !ACTIVE_STATUSES.has(t.status) || t.status === 'CANCELLING';
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
    source = new EventSource(`/api/tasks/${encodeURIComponent(id)}/stream?after=${chatState.cursor}`);
    source.onmessage = e => {
      if (version !== selectionVersion) return;
      let event;
      try { event = JSON.parse(e.data); } catch { return; }
      if (chatState.apply(event)) {
        if (!textUpdateTimer) textUpdateTimer = setTimeout(() => { textUpdateTimer = null; if (version === selectionVersion) renderChat(); }, 80);
        if (event.type === 'STATUS' || event.type.startsWith('TASK_')) refreshTask();
      }
    };
    source.onerror = () => { if (version === selectionVersion) refreshTask(); };
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
    // Fetch metadata first, then all events that may have arrived while it loaded.
    const t = await api(`/api/tasks/${encodeURIComponent(id)}`);
    const events = await api(`/api/tasks/${encodeURIComponent(id)}/events?limit=0&after=${chatState.cursor}`);
    if (version !== selectionVersion) return;
    applyEvents(events);
    // A stale metadata response must not stop a newer streaming event.
    if (chatState.cursor === initialCursor) chatState.snapshot(t);
    renderChat();
    renderTaskDetails(t);
    await loadArtifacts();
    await loadTasks();
  } catch (error) {
    if (version === selectionVersion) $('createError').textContent = `Связь прервана: ${error.message}`;
  } finally {
    if (refreshingVersion === version) refreshingVersion = null;
  }
}

async function sendContinueMessage(taskId, text, opts = {}) {
  const version = selectionVersion;
  await api(`/api/tasks/${encodeURIComponent(taskId)}/message`, {
    method: 'POST', body: JSON.stringify({ text, mode: 'auto', files: opts.files || [], uploadToken: opts.uploadToken || null })
  });
  if (version === selectionVersion) await refreshTask();
}

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

function renderTaskList() {
  $('taskCount').textContent = lastTasks.length ? `(${lastTasks.length})` : '';
  let tasks = taskFilterProjectId === 'all' ? lastTasks : lastTasks.filter(t => t.projectId === taskFilterProjectId);
  if (taskSearchQuery) tasks = tasks.filter(t => (t.title || t.prompt || '').toLowerCase().includes(taskSearchQuery));
  $('tasks').innerHTML = tasks.length ? tasks.map((t) => `
    <div class="taskRow ${t.id === selectedTaskId ? 'active' : ''}" data-id="${t.id}">
      <button class="t-delete" type="button" data-delete-id="${t.id}" title="Удалить сессию" aria-label="Удалить сессию">✕</button>
      <div class="t-prompt">${escapeHtml(t.title || t.prompt)}</div>
      <div class="t-sub">
        <span class="pill ${pillClass(t.status)}">${escapeHtml(t.status)}</span>
        <span class="t-project">${escapeHtml(projectName(t.projectId))}</span>
        <span class="t-time">${new Date(t.createdAt).toLocaleString()}</span>
      </div>
    </div>`).join('') : `<div class="none">${lastTasks.length ? 'Ничего не найдено.' : 'Пока нет сессий.'}</div>`;
  document.querySelectorAll('.taskRow').forEach((row) => {
    row.onclick = () => selectTask(row.dataset.id);
  });
  document.querySelectorAll('.t-delete').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteTask(btn.dataset.deleteId);
    };
  });
}

$('taskProjectFilter').addEventListener('change', () => {
  taskFilterProjectId = $('taskProjectFilter').value;
  renderTaskList();
});

$('taskSearch').addEventListener('input', () => {
  taskSearchQuery = $('taskSearch').value.trim().toLowerCase();
  renderTaskList();
});

async function loadTasks() {
  lastTasks = await api('/api/tasks');
  renderTaskFilter();
  renderTaskList();
  return lastTasks;
}

async function loadArtifacts() {
  if (!selectedTaskId) return;
  const id = selectedTaskId;
  const version = selectionVersion;
  try {
    const list = await api(`/api/tasks/${id}/artifacts`);
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
  updateClearButton();
});
promptEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    // Touch devices: Enter inserts a newline; sending is done via the button.
    if (isTouchDevice()) return;
    event.preventDefault();
    $('form').requestSubmit();
  }
});

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
  // A file without text is a valid message; the server substitutes a title.
  if ((!prompt && !attached.length) || $('sendButton').disabled) return;
  $('createError').textContent = '';
  $('createError').classList.remove('error');
  setBusy(true);
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
      await sendContinueMessage(taskId, prompt, { files, uploadToken });
      clearComposer();
    } else {
      const task = await api('/api/tasks', {
        method: 'POST', body: JSON.stringify({ projectId: $('project').value, prompt, files, uploadToken, model: pendingModel, thinkingLevel: pendingThinking })
      });
      // Clear before selectTask() runs resetSelection(), which would
      // otherwise capture this just-sent text as a stale "new task" draft.
      clearComposer();
      if (version === selectionVersion) {
        await loadTasks();
        await selectTask(task.id);
      }
    }
  } catch (err) {
    $('createError').textContent = err.message;
    $('createError').classList.add('error');
  } finally {
    setBusy(false);
    if (!isTouchDevice()) promptEl.focus();
  }
});

$('newTaskButton').onclick = () => {
  $('controlsSpoiler').open = false;
  startNewTask();
};

$('stopButton').onclick = async () => {
  if (!selectedTaskId) return;
  if (!confirm('Остановить текущую работу Pi?')) return;
  $('stopButton').disabled = true;
  try {
    await api(`/api/tasks/${selectedTaskId}/cancel`, { method: 'POST', body: '{}' });
  } catch (e) { alert(e.message); }
  await refreshTask();
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

$('notifyButton').onclick = async () => {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    localStorage.setItem(NOTIFY_KEY, notifyEnabled() ? 'off' : 'on');
    updateNotifyButton();
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission === 'granted') localStorage.setItem(NOTIFY_KEY, 'on');
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

/* ---------------- cloud settings (§91) ---------------- */

function setCloudStatus(text, isError = false) {
  const node = $('cloudStatus');
  node.textContent = text;
  node.classList.toggle('error', isError);
}

async function openCloudSettings() {
  $('cloudOverlay').classList.remove('hidden');
  setCloudStatus('Загрузка…');
  try {
    const config = await api('/api/cloud/config');
    $('cloudEnabled').checked = config.enabled;
    $('cloudUrl').value = config.saved.url || config.url || '';
    $('cloudMachineId').value = config.saved.machineId || config.machineId || '';
    $('cloudMachineName').value = config.saved.machineDisplayName || config.machineDisplayName || '';
    $('cloudRedact').checked = config.redactPaths !== false;
    $('cloudSecret').value = '';
    $('cloudSecret').placeholder = config.saved.hasSecret || config.hasSecret
      ? `сохранён (${config.secretFingerprint || '••••'}) — оставьте пустым, чтобы не менять`
      : 'секрет не задан';
    const notes = [];
    if (config.envLocked?.length) notes.push(`переменные окружения перекрывают: ${config.envLocked.join(', ')}`);
    if (!config.enabled) notes.push('облако выключено');
    setCloudStatus(notes.join(' · ') || 'Готово');
  } catch (error) {
    setCloudStatus(`Не удалось прочитать настройки: ${error.message}`, true);
  }
}

$('cloudButton').onclick = openCloudSettings;
$('cloudClose').onclick = () => $('cloudOverlay').classList.add('hidden');

$('cloudTest').onclick = async () => {
  setCloudStatus('Проверяю соединение…');
  try {
    const result = await api('/api/cloud/test', {
      method: 'POST',
      body: JSON.stringify({
        url: $('cloudUrl').value.trim(),
        machineId: $('cloudMachineId').value.trim(),
        machineSecret: $('cloudSecret').value
      })
    });
    if (result.ok) setCloudStatus(`Соединение работает: ${result.url} (${result.machineId})`);
    else setCloudStatus(`Не получилось: ${(result.problems || []).join('; ') || `${result.error?.code}: ${result.error?.message}`}`, true);
  } catch (error) {
    setCloudStatus(`Не получилось: ${error.message}`, true);
  }
};

$('cloudForm').onsubmit = async (event) => {
  event.preventDefault();
  setCloudStatus('Сохраняю…');
  try {
    const result = await api('/api/cloud/config', {
      method: 'POST',
      body: JSON.stringify({
        enabled: $('cloudEnabled').checked,
        url: $('cloudUrl').value.trim(),
        machineId: $('cloudMachineId').value.trim(),
        machineDisplayName: $('cloudMachineName').value.trim(),
        redactPaths: $('cloudRedact').checked,
        machineSecret: $('cloudSecret').value || undefined
      })
    });
    $('cloudSecret').value = '';
    setCloudStatus(result.enabled ? `Сохранено. Транспорт запущен: ${result.url}` : 'Сохранено. Облачный транспорт выключен.');
  } catch (error) {
    setCloudStatus(`Не сохранено: ${error.message}`, true);
  }
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

function localProviderId() { return localStatus?.provider || 'llama.cpp'; }

function localStatusBadge(status) {
  const map = {
    loaded: ['ok', 'загружена'],
    sleeping: ['ok', 'спит'],
    loading: ['run', 'грузится'],
    downloading: ['run', 'качается'],
    failed: ['err', 'ошибка'],
    unloaded: ['', 'не загружена']
  };
  return map[status] || ['', status || '—'];
}

function renderLocalRouterState() {
  const el = $('localRouterState');
  if (!localStatus) { el.textContent = 'Загрузка…'; $('localStop').disabled = true; return; }
  const labels = { MANAGED_RUNNING: 'работает (управляется TaskBridge)', EXTERNAL_RUNNING: 'работает (запущен извне)', STARTING: 'запускается', STOPPED: 'остановлен' };
  el.textContent = `Router: ${labels[localStatus.state] || localStatus.state || '—'} · ${localStatus.baseUrl || ''}${localStatus.pid ? ` · pid ${localStatus.pid}` : ''}${localStatus.error ? ` · ${localStatus.error}` : ''}`;
  $('localStop').disabled = localStatus.state !== 'MANAGED_RUNNING' || !localStatus.pid;
  $('localStart').disabled = ['MANAGED_RUNNING', 'EXTERNAL_RUNNING', 'STARTING'].includes(localStatus.state);
}

function localModelRow(m) {
  const row = document.createElement('div');
  row.className = 'localModel';
  const info = document.createElement('div');
  info.className = 'info';
  const id = document.createElement('div');
  id.className = 'id';
  id.textContent = m.id;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const [cls, label] = localStatusBadge(m.status);
  const badge = document.createElement('span');
  badge.className = `badge ${cls}`.trim();
  badge.textContent = label;
  meta.append(badge);
  if (m.vision) {
    const vision = document.createElement('span');
    vision.className = 'badge vision';
    vision.textContent = 'vision';
    meta.append(vision);
  }
  const ctx = document.createElement('span');
  ctx.className = 'muted small';
  ctx.textContent = m.contextWindow ? `ctx ${m.contextWindow}` : 'ctx ?';
  meta.append(ctx);
  info.append(id, meta);
  const button = document.createElement('button');
  button.type = 'button';
  const loaded = m.status === 'loaded' || m.status === 'sleeping';
  button.textContent = loaded ? 'Выгрузить' : m.status === 'loading' ? 'Отменить' : 'Загрузить';
  button.onclick = () => (loaded || m.status === 'loading') ? unloadLocalModel(m.id) : loadLocalModel(m.id);
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.textContent = 'Выбрать';
  choose.title = 'Сделать моделью текущей сессии / следующей задачи';
  choose.onclick = () => selectLocalModel(m.id);
  const actions = document.createElement('div');
  actions.className = 'rowActions';
  actions.append(choose, button);
  row.append(info, actions);
  return row;
}

// Selecting a local preset from the dialog goes through the same path as the
// unified picker: live session → set_model (+preload), otherwise → next task.
async function selectLocalModel(id) {
  await chooseModel({ provider: localProviderId(), id });
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
  for (const [quant, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const header = document.createElement('div');
    header.className = 'modelGroup';
    header.textContent = `${quant} · ${items.length}`;
    list.append(header);
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

async function checkPcState() {
  const el = $('pcState');
  loadRuntimeStatus();
  try {
    const info = await api('/api/info');
    $('buildInfo').textContent = info.build?.version ? `· v${info.build.version}` : '';
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

async function init() {
  updateNotifyButton();
  checkPcState();
  setInterval(checkPcState, 4000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkPcState();
  });
  if (await checkAuth()) await loadAll();
  window.addEventListener('popstate', () => { routeFromLocation(); });
}

init();
