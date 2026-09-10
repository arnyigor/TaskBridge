import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.mjs';
import { buildTurns } from './cloud-chat.mjs';

const $ = id => document.getElementById(id);
marked.setOptions({ gfm: true, breaks: true });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

const viewerId = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
const state = { tasks: new Map(), events: new Map(), selected: null, projects: [] };
let timer;

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}

const login = password => api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
const machineId = () => $('machineId').value.trim();

async function command(type, taskId, payload = {}) {
  return api('/api/tasks', { method: 'POST', body: JSON.stringify({ machineId: machineId(), type, taskId, payload }) });
}

async function ack(kind, receipts, taskId) {
  if (!receipts.length) return;
  await api('/api/events-ack', { method: 'POST', body: JSON.stringify({ kind, taskId, viewerId, receiptHandles: receipts }) });
}

function setConnection(label, kind = '') {
  $('status').textContent = label;
  $('statusDot').className = `statusDot ${kind}`.trim();
}

function applyIndex(event) {
  if (event.type === 'COMMAND_RESULT') {
    if (event.data?.ok === false) {
      setConnection(event.data.error || 'Ошибка команды', 'error');
      return;
    }
    const result = event.data?.result;
    if (event.data?.commandType === 'SYNC_STATE' && result) {
      state.projects = result.projects || [];
      for (const task of result.tasks || []) state.tasks.set(task.id, task);
      setConnection('ПК подключён', 'ok');
    } else if (result?.id) {
      state.tasks.set(result.id, { ...state.tasks.get(result.id), ...result });
    }
    return;
  }

  if (!event.taskId || event.taskId.startsWith('_machine_')) return;
  const task = state.tasks.get(event.taskId) || { id: event.taskId, prompt: event.message || event.taskId };
  if (event.type === 'STATUS') task.status = event.data?.status || task.status;
  else if (event.type.startsWith('TASK_')) task.status = event.type.slice(5);
  task.updatedAt = event.at;
  state.tasks.set(task.id, task);
}

function taskLabel(task) {
  return task.title || task.prompt || task.id;
}

function renderTasks() {
  const previousProject = $('project').value;
  $('project').innerHTML = state.projects.map(project => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('') || '<option value="">нет данных</option>';
  if (state.projects.some(project => project.id === previousProject)) $('project').value = previousProject;

  const tasks = [...state.tasks.values()].sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  $('taskCount').textContent = String(tasks.length);
  $('tasks').innerHTML = tasks.length ? tasks.map(task => {
    const status = String(task.status || '—');
    const statusClass = status.toLowerCase();
    const project = state.projects.find(item => item.id === task.projectId)?.name || task.projectId || 'без проекта';
    return `<button class="task ${task.id === state.selected ? 'active' : ''}" data-id="${escapeHtml(task.id)}"><span class="taskTitle">${escapeHtml(taskLabel(task))}</span><span class="taskMeta"><span class="taskProject">${escapeHtml(project)}</span><span class="taskStatus ${escapeHtml(statusClass)}">${escapeHtml(status)}</span></span></button>`;
  }).join('') : '<div class="tasksEmpty">Сессий пока нет</div>';

  for (const button of $('tasks').querySelectorAll('.task')) button.onclick = () => selectTask(button.dataset.id);
  if (state.selected) updateDetails();
}

function renderMarkdown(container, text) {
  container.innerHTML = DOMPurify.sanitize(marked.parse(text));
  for (const link of container.querySelectorAll('a[href]')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
}

function reasoningNode(text) {
  const details = document.createElement('details');
  details.className = 'reasoning';
  const summary = document.createElement('summary');
  summary.textContent = `Рассуждение · ${text.length} симв.`;
  const body = document.createElement('pre');
  body.className = 'reasoningText';
  body.textContent = text;
  details.append(summary, body);
  return details;
}

function toolsNode(tools) {
  const list = document.createElement('div');
  list.className = 'tools';
  for (const tool of tools) {
    const details = document.createElement('details');
    details.className = `tool ${tool.status || ''}`.trim();
    const summary = document.createElement('summary');
    const icon = tool.status === 'error' ? '✕' : tool.status === 'running' ? '…' : '✓';
    summary.textContent = `${icon} ${tool.name}`;
    const body = document.createElement('pre');
    body.className = 'toolBody';
    body.textContent = tool.args == null ? 'Нет параметров' : JSON.stringify(tool.args, null, 2);
    details.append(summary, body);
    list.append(details);
  }
  return list;
}

function renderEvents() {
  const events = [...(state.events.get(state.selected)?.values() || [])].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const task = state.tasks.get(state.selected);
  const turns = buildTurns(task, events);
  const container = $('events');
  container.innerHTML = '';

  for (const turn of turns) {
    const root = document.createElement('article');
    root.className = `turn ${turn.kind}`;
    const body = document.createElement('div');
    body.className = 'turnBody';

    if (turn.kind === 'user') {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = turn.text;
      body.append(bubble);
    } else {
      if (turn.thinking) body.append(reasoningNode(turn.thinking));
      if (turn.tools?.length) body.append(toolsNode(turn.tools));
      if (turn.text) {
        const bubble = document.createElement('div');
        bubble.className = 'bubble md';
        renderMarkdown(bubble, turn.text);
        body.append(bubble);
      }
      const meta = document.createElement('div');
      meta.className = 'assistantMeta';
      meta.innerHTML = '<span class="assistantBadge">✦</span><span>Pi</span>';
      body.append(meta);
    }
    root.append(body);
    container.append(root);
  }

  if (!turns.length) container.innerHTML = '<div class="emptyState"><strong>История загружается</strong><span>События появятся после синхронизации с ПК.</span></div>';
  container.scrollTop = container.scrollHeight;
}

async function pollIndex() {
  const data = await api(`/api/tasks?viewerId=${encodeURIComponent(viewerId)}`);
  for (const item of data.messages) applyIndex(item.event);
  renderTasks();
  await ack('index', data.messages.map(item => item.receiptHandle));
  return data.messages.length;
}

async function pollTask() {
  if (!state.selected) return 0;
  const taskId = state.selected;
  const data = await api(`/api/task-events?taskId=${encodeURIComponent(taskId)}&viewerId=${encodeURIComponent(viewerId)}`);
  const events = state.events.get(taskId) || new Map();
  for (const item of data.messages) events.set(item.event.seq, item.event);
  state.events.set(taskId, events);
  if (state.selected === taskId) renderEvents();
  await ack('task', data.messages.map(item => item.receiptHandle), taskId);
  return data.messages.length;
}

async function poll() {
  let busy = false;
  try {
    const indexCount = await pollIndex();
    const taskCount = await pollTask();
    busy = indexCount >= 10 || taskCount >= 10;
  } catch (error) {
    if (error.status === 401) {
      $('app').classList.add('hidden');
      $('login').classList.remove('hidden');
      return;
    }
    setConnection(error.message, 'error');
  }
  clearTimeout(timer);
  timer = setTimeout(poll, busy ? 50 : 1200);
}

async function selectTask(id) {
  state.selected = id;
  $('chatHead').classList.remove('hidden');
  $('detail').classList.remove('hidden');
  $('controlsSpoiler').open = false;
  $('message').placeholder = 'Сообщение продолжит текущую сессию. Enter — отправить, Shift+Enter — перенос строки.';
  updateDetails();
  renderTasks();
  renderEvents();
  await pollTask();
}

function updateDetails() {
  const task = state.tasks.get(state.selected);
  if (!task) return;
  const project = state.projects.find(item => item.id === task.projectId)?.name || task.projectId || 'без проекта';
  const title = taskLabel(task);
  $('taskTitle').textContent = title;
  $('detailTitle').textContent = title;
  $('taskStatus').textContent = task.status || '—';
  $('taskProject').textContent = project;
  $('taskCurrent').textContent = task.current || '—';
  $('stop').disabled = !['QUEUED', 'STARTING', 'RUNNING', 'COMPACTING'].includes(task.status);
}

function beginNewSession() {
  state.selected = null;
  $('chatHead').classList.add('hidden');
  $('detail').classList.add('hidden');
  $('message').value = '';
  $('message').placeholder = 'Новая задача для Pi. Enter — запустить, Shift+Enter — перенос строки.';
  autoGrow($('message'));
  $('events').innerHTML = '<div id="empty" class="emptyState"><div class="emptyIcon">✦</div><strong>Новая сессия</strong><span>Выберите проект, напишите задачу ниже и нажмите отправить.</span></div>';
  renderTasks();
  $('controlsSpoiler').open = true;
  $('message').focus();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
}

$('loginForm').onsubmit = async event => {
  event.preventDefault();
  $('loginError').textContent = '';
  try {
    await login($('password').value);
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    setConnection('синхронизация…', 'wait');
    await command('SYNC_STATE');
    poll();
  } catch (error) {
    $('loginError').textContent = error.message;
  }
};

$('machineId').value = localStorage.taskbridgeMachineId || 'home-pc';
$('machineId').onchange = () => { localStorage.taskbridgeMachineId = machineId(); };
$('sync').onclick = async () => {
  try { setConnection('синхронизация…', 'wait'); await command('SYNC_STATE'); }
  catch (error) { setConnection(error.message, 'error'); }
};

$('stop').onclick = () => state.selected && command('ABORT_TASK', state.selected).catch(error => alert(error.message));
$('compact').onclick = () => state.selected && command('COMPACT', state.selected, {}).catch(error => alert(error.message));
$('newSession').onclick = beginNewSession;
$('followup').onsubmit = async event => {
  event.preventDefault();
  const text = $('message').value.trim();
  if (!text) return;
  try {
    if (state.selected) {
      await command('FOLLOW_UP', state.selected, { text });
    } else {
      if (!$('project').value) throw new Error('Сначала выберите проект.');
      const created = await command('START_TASK', null, { projectId: $('project').value, prompt: text });
      state.tasks.set(created.taskId, { id: created.taskId, projectId: $('project').value, prompt: text, status: 'QUEUED', createdAt: new Date().toISOString() });
      await selectTask(created.taskId);
    }
    $('message').value = '';
    autoGrow($('message'));
    renderTasks();
  } catch (error) { alert(error.message); }
};

for (const [textarea, form] of [[$('message'), $('followup')]]) {
  textarea.addEventListener('input', () => autoGrow(textarea));
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
}

$('app').classList.remove('hidden');
$('login').classList.add('hidden');
command('SYNC_STATE').then(() => { setConnection('синхронизация…', 'wait'); poll(); }).catch(error => {
  if (error.status === 401) {
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  } else {
    setConnection(error.message, 'error');
    poll();
  }
});
