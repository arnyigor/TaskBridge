// TaskBridge Remote UI.
//
// Correctness model (§41, §42, §59, §62, §77):
//   - rendering order is driven by `seq`, never by arrival order;
//   - the client persists lastReceivedSeq per task and re-fetches everything
//     after it on (re)connect, so a closed tab or a dropped stream loses nothing;
//   - polling is the baseline; SSE is only a latency optimization;
//   - delta/snapshot/coalescing semantics live in event-reducer.mjs and are
//     unit-tested there.

import { createViewState, applyEvent, applyEvents, cursorKey } from './event-reducer.mjs';

const TOKEN_KEY = 'taskbridge.token';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  machines: [],
  tasks: [],
  taskId: null,
  task: null,
  view: createViewState(),
  stream: null,
  pollTimer: null
};

const dom = {
  messages: new Map(), // message key → { node, meta, text }
  tools: new Map()     // toolCallId → { node, summary, pre }
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 4000);
}

function setConnection(key, value) {
  const dot = document.querySelector(`.dot[data-k="${key}"]`);
  if (!dot) return;
  dot.classList.remove('ok', 'warn', 'err');
  dot.classList.add(value === 'ok' ? 'ok' : value === 'warn' ? 'warn' : value === 'err' ? 'err' : '');
  dot.title = `${key}: ${value}`;
}

async function api(path, { method = 'GET', body = null, query = null, silent = false } = {}) {
  const search = query ? `?${new URLSearchParams(query)}` : '';
  const response = await fetch(`${path}${search}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  }).catch(error => {
    setConnection('cloud', 'err');
    throw error;
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    setConnection('cloud', 'err');
    if (response.status === 401) showLogin('Token rejected. Sign in again.');
    const error = new Error(payload?.error?.message || `HTTP ${response.status}`);
    error.code = payload?.error?.code || 'HTTP_ERROR';
    if (!silent) toast(`${error.code}: ${error.message}`);
    throw error;
  }
  setConnection('cloud', 'ok');
  return payload;
}

// ---------------------------------------------------------------- auth ------
function showLogin(message) {
  $('login').hidden = false;
  $('app').hidden = true;
  $('logout').hidden = true;
  if (message) {
    $('login-error').textContent = message;
    $('login-error').hidden = false;
  }
}

function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  $('logout').hidden = false;
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.token = $('token').value.trim();
  try {
    await loadAll();
    localStorage.setItem(TOKEN_KEY, state.token);
    showApp();
    $('login-error').hidden = true;
  } catch {
    showLogin('Could not sign in. Check the token and the cloud URL.');
  }
});

$('logout').addEventListener('click', () => {
  localStorage.removeItem(TOKEN_KEY);
  state.token = '';
  showLogin('Signed out.');
});

// ------------------------------------------------------------ rendering -----
function renderMachines() {
  const list = $('machines');
  const select = $('machine-select');
  list.textContent = '';
  select.textContent = '';
  for (const machine of state.machines) {
    const item = el('li');
    item.append(el('span', null, machine.displayName || machine.id));
    item.append(el('span', `badge ${machine.status}`, machine.status));
    list.append(item);

    const option = el('option', null, machine.displayName ? `${machine.displayName} (${machine.id})` : machine.id);
    option.value = machine.id;
    select.append(option);
  }
  if (!state.machines.length) list.append(el('li', 'muted', 'No machines registered yet.'));
}

function renderTasks() {
  const list = $('tasks');
  list.textContent = '';
  for (const task of state.tasks) {
    const item = el('li', task.id === state.taskId ? 'active' : '');
    item.append(el('span', null, task.prompt?.slice(0, 48) || task.id));
    item.append(el('span', `badge ${task.status}`, task.status));
    item.addEventListener('click', () => openTask(task.id));
    list.append(item);
  }
  if (!state.tasks.length) list.append(el('li', 'muted', 'No tasks yet.'));
}

function renderStatus() {
  const head = $('task-head');
  const body = $('task-body');
  if (!state.taskId) { head.hidden = true; body.hidden = true; return; }
  head.hidden = false;
  body.hidden = false;

  const task = state.task || { id: state.taskId };
  const status = state.view.status || task.status || 'UNKNOWN';
  $('task-title').textContent = task.prompt?.slice(0, 120) || task.id;
  const machine = state.machines.find(m => m.id === task.machineId);
  $('task-meta').textContent = [
    task.id,
    task.projectId ? `project: ${task.projectId}` : null,
    `machine: ${machine ? `${machine.displayName || machine.id} (${machine.status})` : task.machineId}`,
    task.createdAt ? `created: ${new Date(task.createdAt).toLocaleString()}` : null
  ].filter(Boolean).join(' · ');

  const line = el('div');
  line.append(el('span', `badge ${status}`, status));
  const detail = state.view.error || state.view.current || task.current || '';
  if (detail) line.append(document.createTextNode(`  ${detail}`));
  $('task-status').textContent = '';
  $('task-status').append(line);
  $('stop').disabled = ['COMPLETED', 'FAILED', 'ABORTED'].includes(status);
  // Capability negotiation (§95): disable controls the machine cannot honour.
  const caps = machine?.commandCapabilities || {};
  $('compact').disabled = caps.compact === false;
  $('follow-form').querySelector('button').disabled = caps.followUp === false;

  setConnection('machine', machine ? (['ONLINE', 'BUSY'].includes(machine.status) ? 'ok' : machine.status === 'ERROR' ? 'err' : 'warn') : 'warn');
  setConnection('task', ['RUNNING', 'STARTING', 'QUEUED', 'WAITING_MACHINE', 'WAITING_USER'].includes(status) ? 'warn'
    : status === 'COMPLETED' ? 'ok'
    : ['FAILED', 'ABORTED'].includes(status) ? 'err' : '');
}

function renderMessages() {
  const container = $('transcript');
  for (const key of state.view.order) {
    const record = state.view.messages.get(key);
    let node = dom.messages.get(key);
    if (!node) {
      const wrapper = el('div', 'msg');
      const meta = el('span', 'meta');
      const text = el('span', 'text');
      wrapper.append(meta, text);
      node = { wrapper, meta, text };
      dom.messages.set(key, node);
      container.append(wrapper);
    }
    // Re-append in seq order only when needed (order can change on replay).
    if (container.children[state.view.order.indexOf(key)] !== node.wrapper) container.append(node.wrapper);
    node.wrapper.className = `msg ${record.role}${record.thinking ? ' thinking' : ''}${record.status === 'STREAMING' ? ' streaming' : ''}`;
    node.meta.textContent = record.role === 'user' ? 'you' : record.thinking ? 'thinking' : `assistant${record.status === 'INTERRUPTED' ? ' · interrupted' : ''}`;
    node.text.textContent = record.thinking ? `💭 ${record.text}` : record.text;
  }
  container.scrollTop = container.scrollHeight;
}

function renderTools() {
  const container = $('tools');
  for (const toolCallId of state.view.toolOrder) {
    const record = state.view.tools.get(toolCallId);
    let node = dom.tools.get(toolCallId);
    if (!node) {
      const details = el('details', 'tool running');
      const summary = el('summary');
      const pre = el('pre');
      const actions = el('div', 'actions');
      const full = el('button', 'ghost', 'Load full output');
      full.addEventListener('click', (event) => { event.preventDefault(); loadFullOutput(toolCallId); });
      actions.append(full);
      details.append(summary, pre, actions);
      node = { details, summary, pre, actions, full };
      dom.tools.set(toolCallId, node);
      container.append(details);
    }
    node.details.className = `tool ${record.status}`;
    node.summary.textContent = '';
    node.summary.append(el('strong', null, record.toolName || toolCallId));
    if (record.args) node.summary.append(el('span', 'args', JSON.stringify(record.args).slice(0, 160)));
    if (record.durationMs != null) node.summary.append(el('span', 'badge', `${(record.durationMs / 1000).toFixed(1)} s`));
    if (record.status === 'running') node.summary.append(el('span', 'badge', 'running'));
    if (record.truncated || record.fullLogAvailable) node.summary.append(el('span', 'badge', 'truncated'));
    const extra = [
      record.output,
      record.summary ? `\n${record.summary}` : '',
      record.exitCode != null ? `\nexit ${record.exitCode}` : '',
      record.error ? `\n${record.error}` : '',
      record.fullOutput ? `\n--- full output${record.fullOutputTruncated ? ' (truncated)' : ''} ---\n${record.fullOutput}` : ''
    ].join('');
    node.pre.textContent = extra.trim();
    // "Load full output" is an explicit operation: the log stays local and only
    // a bounded slice is uploaded on request (§38).
    const canLoad = record.fullLogAvailable && !record.fullOutput;
    node.actions.hidden = !canLoad;
    node.full.disabled = !canLoad;
  }
}

async function loadFullOutput(toolCallId) {
  if (!state.taskId) return;
  await api(`/api/tasks/${state.taskId}/commands`, { method: 'POST', body: { type: 'FETCH_TOOL_OUTPUT', payload: { toolCallId } } });
  toast('Full output requested');
}

function renderActivity() {
  const container = $('activity');
  container.textContent = '';
  for (const line of state.view.activity.slice(-200)) container.append(el('div', null, line));
  container.scrollTop = container.scrollHeight;
}

function renderApprovals() {
  const container = $('approvals');
  container.textContent = '';
  for (const [approvalId, approval] of state.view.approvals) {
    const card = el('div', 'approval');
    card.append(el('div', null, `Approval required: ${approval.toolName || 'tool'} (${approval.risk || 'unknown risk'})`));
    card.append(el('pre', null, JSON.stringify(approval.args || {}, null, 2)));
    if (approval.status === 'PENDING') {
      const actions = el('div', 'actions');
      const allow = el('button', null, 'ALLOW ONCE');
      const deny = el('button', 'danger', 'DENY');
      allow.addEventListener('click', () => respondApproval(approvalId, 'ALLOW_ONCE'));
      deny.addEventListener('click', () => respondApproval(approvalId, 'DENY'));
      actions.append(allow, deny);
      card.append(actions);
    } else {
      card.append(el('div', 'muted', `${approval.status}${approval.decision ? ` — ${approval.decision}` : ''}`));
    }
    container.append(card);
  }
}

function renderAll() {
  renderMessages();
  renderTools();
  renderActivity();
  renderApprovals();
  renderStatus();
}

function resetView() {
  state.view = createViewState();
  dom.messages.clear();
  dom.tools.clear();
  $('transcript').textContent = '';
  $('tools').textContent = '';
  $('activity').textContent = '';
  $('approvals').textContent = '';
}

// ------------------------------------------------------------- loading ------
async function loadAll() {
  const [machines, tasks] = await Promise.all([api('/api/machines'), api('/api/tasks')]);
  state.machines = machines || [];
  state.tasks = tasks || [];
  renderMachines();
  renderTasks();
}

async function loadTasks() {
  state.tasks = await api('/api/tasks', { silent: true }) || [];
  renderTasks();
}

function applyIncoming(events) {
  if (!events?.length) return false;
  const changed = applyEvents(state.view, events);
  if (state.taskId) localStorage.setItem(cursorKey(state.taskId), String(state.view.lastSeq));
  if (changed) renderAll();
  if (events.some(event => ['task_finished', 'task_failed', 'task_aborted'].includes(event.type))) loadTasks().catch(() => {});
  return changed;
}

async function openTask(taskId) {
  state.taskId = taskId;
  state.task = state.tasks.find(task => task.id === taskId) || null;
  resetView();
  renderTasks();
  // Resume from the persisted cursor so a closed browser reconstructs output.
  state.view.lastSeq = Number(localStorage.getItem(cursorKey(taskId)) || 0);
  const payload = await api(`/api/tasks/${taskId}/events`, { query: { after: state.view.lastSeq, limit: 2000 }, silent: true }).catch(() => null);
  applyIncoming(payload?.events || []);
  state.task = await api(`/api/tasks/${taskId}`, { silent: true }).catch(() => state.task);
  renderAll();
  startPolling();
  startStream();
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

function startPolling() {
  stopPolling();
  const tick = async () => {
    if (!state.taskId) return;
    try {
      const payload = await api(`/api/tasks/${state.taskId}/events`, { query: { after: state.view.lastSeq, limit: 500 }, silent: true });
      applyIncoming(payload?.events || []);
      state.task = await api(`/api/tasks/${state.taskId}`, { silent: true });
      renderStatus();
    } catch { /* the connection indicator already reflects the failure */ }
    const status = state.view.status || state.task?.status;
    const running = status && !['COMPLETED', 'FAILED', 'ABORTED'].includes(status);
    state.pollTimer = setTimeout(tick, running ? 1500 : 5000);
  };
  state.pollTimer = setTimeout(tick, 1500);
}

// SSE fast path. If it is unavailable (e.g. a serverless deployment), polling
// keeps the UI correct and this silently stays off (§40, §41).
function startStream() {
  if (state.stream) state.stream.close();
  if (!state.token || typeof EventSource === 'undefined') { setConnection('realtime', 'off'); return; }
  const url = `/api/tasks/stream?taskId=${encodeURIComponent(state.taskId)}&after=${state.view.lastSeq}&token=${encodeURIComponent(state.token)}`;
  const source = new EventSource(url);
  state.stream = source;
  source.onopen = () => setConnection('realtime', 'ok');
  source.onerror = () => setConnection('realtime', 'warn');
  source.onmessage = (message) => {
    try { applyIncoming([JSON.parse(message.data)]); }
    catch { /* malformed frame: polling will resync */ }
  };
}

// ------------------------------------------------------------ commands ------
$('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    machineId: $('machine-select').value,
    projectId: $('project-id').value.trim(),
    prompt: $('prompt').value.trim(),
    options: { worktree: $('worktree').checked }
  };
  const created = await api('/api/tasks', { method: 'POST', body });
  $('prompt').value = '';
  await loadTasks();
  await openTask(created.taskId);
  toast(`Task queued (machine ${created.machineStatus || 'unknown'})`);
});

$('stop').addEventListener('click', async () => {
  if (!state.taskId) return;
  await api(`/api/tasks/${state.taskId}/commands`, { method: 'POST', body: { type: 'ABORT_TASK' } });
  toast('STOP queued');
});

$('compact').addEventListener('click', async () => {
  if (!state.taskId) return;
  await api(`/api/tasks/${state.taskId}/commands`, { method: 'POST', body: { type: 'COMPACT', payload: {} } });
  toast('Compact queued');
});

$('follow-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('follow').value.trim();
  if (!text || !state.taskId) return;
  await api(`/api/tasks/${state.taskId}/commands`, { method: 'POST', body: { type: 'FOLLOW_UP', payload: { text } } });
  $('follow').value = '';
  toast('Follow-up queued');
});

async function respondApproval(approvalId, decision) {
  await api(`/api/tasks/${state.taskId}/commands`, { method: 'POST', body: { type: 'APPROVAL_RESPONSE', payload: { approvalId, decision } } });
  toast(`${decision} queued`);
}

// ---------------------------------------------------------------- boot ------
(async function boot() {
  if (!state.token) { showLogin(); return; }
  try {
    await loadAll();
    showApp();
  } catch {
    showLogin();
  }
})();

document.addEventListener('visibilitychange', () => {
  // Returning to a backgrounded tab must re-fetch, not trust the stream.
  if (!document.hidden && state.taskId) {
    startPolling();
    startStream();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
