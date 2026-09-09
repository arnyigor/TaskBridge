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

function botAvatar() {
  const av = document.createElement('div');
  av.className = 'av';
  av.setAttribute('aria-hidden', 'true');
  av.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 L14 9 L21 12 L14 15 L12 22 L10 15 L3 12 L10 9 Z"/></svg>';
  return av;
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

function appendUserTurn(text, files = []) {
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
  $('msgsInner').append(turn);
  scrollBottom();
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
  turn.append(botAvatar());
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
  metaRow.append(meta, copyBtn);
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

function appendSystemNote(text) {
  hideEmptyState();
  const note = document.createElement('div');
  note.className = 'systemNote';
  note.textContent = text;
  $('msgsInner').append(note);
  scrollBottom();
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
  promptEl.placeholder = continuing
    ? 'Сообщение продолжит текущую сессию. Enter — отправить, Shift+Enter — перенос строки.'
    : 'Сообщение для Pi. Enter — запустить, Shift+Enter — перенос строки.';
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
  turnNodes = new Map();
  liveTurn = null;
  liveThinking = liveText = '';
  nearBottom = true;
  $('stopButton').disabled = true;
  $('compact').disabled = true;
  $('autoCompaction').disabled = true;
  $('detail').classList.toggle('hidden', !id);
  $('msgsInner').innerHTML = '';
  for (const field of ['taskTitle', 'taskStatus', 'current', 'workspace', 'usage', 'compaction', 'artifacts', 'outputFiles', 'stateJson']) $(field).textContent = '—';
  $('contextBar').classList.add('hidden');
  $('createError').textContent = '';
  setComposerMode(id);
  restoreDraft(id || '__new__');
  return selectionVersion;
}

function startNewTask() {
  resetSelection(null);
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
        node.body.insertBefore(chip, node.metaRow);
        node.tools.set(tool.id, chip);
      }
      chip.className = `tool ${tool.state}`;
      chip.querySelector('summary').textContent = `${tool.state === 'interrupted' ? '■' : toolIcon(tool.state)} ${tool.name}${tool.state === 'interrupted' ? ' · прервано' : ''}`;
      if (tool.state === 'done' && tool.imagePath && IMAGE_EXT_RE.test(tool.imagePath) && !chip.dataset.imageShown) {
        appendInlineImage(tool.imagePath);
        chip.dataset.imageShown = 'true';
      }
    }
    node.meta.textContent = turn.status || '';
  }
  scrollBottom();
}

function applyEvents(events) {
  for (const event of events) chatState.apply(event);
  renderChat();
}

const lastNotifiedStatus = new Map();

// Only fires on a transition actually observed live (the map has no entry
// on first render of a task, e.g. one already finished when selected).
function maybeNotify(t) {
  const previous = lastNotifiedStatus.get(t.id);
  lastNotifiedStatus.set(t.id, t.status);
  if (!previous || previous === t.status || ACTIVE_STATUSES.has(t.status) || !('Notification' in window) || Notification.permission !== 'granted') return;
  const title = t.status === 'SUCCEEDED' ? 'Готово' : t.status === 'FAILED' ? 'Ошибка' : 'Остановлено';
  try { new Notification(`TaskBridge: ${title}`, { body: (t.title || t.prompt || '').slice(0, 120), tag: t.id }); } catch {}
}

function renderTaskDetails(t) {
  maybeNotify(t);
  $('taskTitle').textContent = t.title || t.prompt || t.id;
  $('taskStatus').textContent = t.status;
  $('current').textContent = t.current || '—';
  $('workspace').textContent = t.workspacePath || '—';
  if ([...$('project').options].some(o => o.value === t.projectId)) $('project').value = t.projectId;
  renderContext(t);
  renderOutputFiles(t.outputFiles || []);
  const c = t.compaction || {};
  $('compaction').textContent = c.last ? `${c.count} · ${c.last.tokensBefore ?? '?'}→${c.last.estimatedTokensAfter ?? '?'}` : String(c.count || 0);
  $('stopButton').disabled = !ACTIVE_STATUSES.has(t.status) || t.status === 'CANCELLING';
  $('compact').disabled = ACTIVE_STATUSES.has(t.status) || t.sessionAvailable === false;
}

async function selectTask(id) {
  const version = resetSelection(id);
  try {
    const events = await api(`/api/tasks/${encodeURIComponent(id)}/events?limit=0`);
    const t = await api(`/api/tasks/${encodeURIComponent(id)}`);
    if (version !== selectionVersion) return;
    chatState = new ChatState(t);
    applyEvents(events);
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
    method: 'POST', body: JSON.stringify({ text, mode: 'auto', files: opts.files || [] })
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

async function filesPayload() {
  const files = Array.from($('files').files || []);
  const result = [];
  for (const file of files) {
    const base64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(r.error);
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.readAsDataURL(file);
    });
    result.push({ name: file.name, size: file.size, base64 });
  }
  return result;
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
}

function removeFile(index) {
  const dt = new DataTransfer();
  Array.from($('files').files || []).forEach((f, i) => { if (i !== index) dt.items.add(f); });
  $('files').files = dt.files;
  renderFileList();
}

$('files').addEventListener('change', renderFileList);

const promptEl = $('prompt');
promptEl.addEventListener('input', () => {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 240)}px`;
});
promptEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
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
  if (!prompt || $('sendButton').disabled) return;
  $('createError').textContent = '';
  $('createError').classList.remove('error');
  setBusy(true);
  if (isTouchDevice()) promptEl.blur();
  try {
    const taskId = selectedTaskId;
    const version = selectionVersion;
    const files = await filesPayload();
    const draftKey = taskId || '__new__';
    const clearComposer = () => {
      drafts.delete(draftKey);
      if (promptEl.value.trim() === prompt) {
        promptEl.value = '';
        promptEl.style.height = 'auto';
        $('files').value = '';
        $('fileList').textContent = '';
      }
    };
    if (taskId) {
      await sendContinueMessage(taskId, prompt, { files });
      clearComposer();
    } else {
      const task = await api('/api/tasks', {
        method: 'POST', body: JSON.stringify({ projectId: $('project').value, prompt, files })
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

$('newTaskButton').onclick = startNewTask;

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

function updateNotifyButton() {
  if (!('Notification' in window)) { $('notifyButton').classList.add('hidden'); return; }
  $('notifyButton').classList.remove('hidden');
  $('notifyButton').textContent = Notification.permission === 'granted' ? '🔔 Уведомления вкл.' : '🔔 Уведомления';
}

$('notifyButton').onclick = async () => {
  if (!('Notification' in window)) return;
  const permission = await Notification.requestPermission();
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

/* ---------------- native Pi sessions ---------------- */

$('resumeSessionButton').onclick = async () => {
  const projectId = $('project').value;
  if (!projectId || projectId === '__scratch__') { alert('Выберите проект, у которого есть сессии Pi.'); return; }
  $('sessionPickerOverlay').classList.remove('hidden');
  $('sessionPickerPath').textContent = `Папка: ${projects.find(p => p.id === projectId)?.path || projectId}`;
  $('sessionPickerList').textContent = 'Загрузка…';
  try {
    const sessions = await api(`/api/projects/${encodeURIComponent(projectId)}/pi-sessions`);
    if (!sessions.length) { $('sessionPickerList').textContent = 'Сессии Pi для этого проекта не найдены.'; return; }
    $('sessionPickerList').innerHTML = '';
    for (const session of sessions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sessionPickerItem';
      const primary = session.preview || session.name;
      const secondary = session.preview && session.preview !== session.name ? session.name : null;
      button.innerHTML = `<span class="name">${escapeHtml(primary)}</span>${secondary ? `<span class="meta">${escapeHtml(secondary)}</span>` : ''}<span class="meta">${new Date(session.mtime).toLocaleString()}${session.existingTaskId ? ' · уже открыта в TaskBridge' : ''}</span>`;
      button.onclick = () => importSession(projectId, session);
      $('sessionPickerList').append(button);
    }
  } catch (err) { $('sessionPickerList').textContent = err.message; }
};

$('sessionPickerClose').onclick = () => $('sessionPickerOverlay').classList.add('hidden');

/* ---------------- help ---------------- */

$('helpButton').onclick = () => $('helpOverlay').classList.remove('hidden');
$('helpClose').onclick = () => $('helpOverlay').classList.add('hidden');

async function importSession(projectId, session) {
  if (!session.existingTaskId && !confirm('TaskBridge не может проверить, открыта ли эта сессия в терминале. Если процесс pi там ещё работает — закройте его сейчас: при одновременной записи с двух сторон файл сессии может испортиться. Сессия точно закрыта?')) return;
  try {
    const task = await api('/api/tasks/from-session', {
      method: 'POST', body: JSON.stringify({ projectId, sessionKey: session.key, confirmedClosed: true })
    });
    $('sessionPickerOverlay').classList.add('hidden');
    await loadTasks();
    await selectTask(task.id);
  } catch (err) { alert(err.message); }
}

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
  button.textContent = starting ? (status.state === 'RESTARTING' ? 'Перезапуск…' : 'Запуск…') : running ? 'Перезапустить' : 'Запустить';
  button.disabled = runtimeBusy || starting || (running && status.canRestart === false);
  button.title = running && status.canRestart === false ? (status.externalRestartReason || '') : '';
  select.disabled = button.disabled && running;
}

async function loadRuntimeStatus() {
  try { renderRuntimeStatus(await api('/api/runtime')); }
  catch { $('runtimeControl').classList.add('hidden'); }
}

$('runtimeStart').onclick = async () => {
  const profileId = $('runtimeProfile').value;
  const restarting = $('runtimeStart').textContent === 'Перезапустить';
  runtimeBusy = true;
  $('runtimeStart').disabled = true;
  $('runtimeStart').textContent = restarting ? 'Перезапуск…' : 'Запуск…';
  try {
    await api(restarting ? '/api/runtime/restart' : '/api/runtime/start', { method: 'POST', body: JSON.stringify({ profileId }) });
  } catch (err) { alert(err.message); }
  finally { runtimeBusy = false; await loadRuntimeStatus(); }
};

/* ---------------- init ---------------- */

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
    if (info.modelReady === false) {
      el.textContent = '● МОДЕЛЬ НЕДОСТУПНА';
      el.classList.add('err');
    } else if (modelBusy === true) {
      el.textContent = '● МОДЕЛЬ ЗАНЯТА';
      el.classList.add('run');
    } else {
      el.textContent = '● ONLINE';
      el.classList.add('ok');
    }
    el.title = (info.addresses || []).map((x) => x.url).join('\n');
  } catch {
    modelBusy = null;
    el.textContent = 'OFFLINE';
    el.classList.remove('ok', 'run');
    el.classList.add('err');
    el.title = '';
  }
}

async function loadAll() {
  try {
    await loadProjects();
    const tasks = await loadTasks();
    if (tasks.length) await selectTask(tasks[0].id);
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
}

init();
