const $ = (id) => document.getElementById(id);
let selectedTaskId = null;
let source = null;
let refreshTimer = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${body.code || res.status}: ${body.error || res.statusText}`);
  return body;
}

function statusClass(status) {
  return ['FAILED'].includes(status) ? 'error' : '';
}

async function init() {
  try {
    const info = await api('/api/info');
    $('pcState').textContent = '● ONLINE';
    $('pcState').title = (info.addresses || []).map((x) => x.url).join('\n');
  } catch {
    $('pcState').textContent = 'OFFLINE';
  }
  await loadProjects();
  await loadTasks();
}

async function loadProjects() {
  const projects = await api('/api/projects');
  $('project').innerHTML = projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
}

async function loadTasks() {
  const tasks = await api('/api/tasks');
  $('tasks').innerHTML = tasks.length ? tasks.map((t) => `
    <div class="taskRow" data-id="${t.id}">
      <div>
        <strong>${escapeHtml(t.prompt)}</strong>
        <span class="muted small">${escapeHtml(t.projectId)} · ${new Date(t.createdAt).toLocaleString()}</span>
      </div>
      <span class="pill ${statusClass(t.status)}">${escapeHtml(t.status)}</span>
    </div>`).join('') : '<div class="muted">Пока нет задач.</div>';
  document.querySelectorAll('.taskRow').forEach((row) => row.onclick = () => selectTask(row.dataset.id));
}

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

$('files').addEventListener('change', () => {
  $('fileList').textContent = Array.from($('files').files || []).map((f) => `${f.name} (${Math.round(f.size / 1024)} KB)`).join(', ');
});

$('run').onclick = async () => {
  $('createError').textContent = '';
  $('run').disabled = true;
  try {
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        projectId: $('project').value,
        prompt: $('prompt').value,
        files: await filesPayload()
      })
    });
    $('prompt').value = '';
    $('files').value = '';
    $('fileList').textContent = '';
    await loadTasks();
    await selectTask(task.id);
  } catch (e) {
    $('createError').textContent = e.message;
  } finally {
    $('run').disabled = false;
  }
};

$('refresh').onclick = loadTasks;

async function selectTask(id) {
  selectedTaskId = id;
  $('detail').classList.remove('hidden');
  if (source) source.close();
  await refreshTask();
  await loadEventHistory();
  source = new EventSource(`/api/tasks/${encodeURIComponent(id)}/stream`);
  source.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      appendEvent(event);
      if (event.type === 'STATUS' || event.type.startsWith('TASK_') || event.data?.pi?.type === 'compaction_end') refreshTask();
    } catch {}
  };
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshTask, 2000);
}

async function refreshTask() {
  if (!selectedTaskId) return;
  try {
    const t = await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}`);
    $('taskTitle').textContent = `Task ${t.id}`;
    $('taskProject').textContent = t.projectId;
    $('taskStatus').textContent = t.status;
    $('current').textContent = t.current || '—';
    $('workspace').textContent = t.workspacePath || '—';
    $('assistant').textContent = t.assistantText || '—';
    $('usage').textContent = t.lastUsage?.totalTokens != null ? `${t.lastUsage.totalTokens} tokens (last update)` : '—';
    const c = t.compaction || {};
    $('compaction').textContent = c.last ? `${c.count} · ${c.last.tokensBefore ?? '?'} → ${c.last.estimatedTokensAfter ?? '?'}` : `${c.count || 0}`;
    $('stop').disabled = t.status !== 'RUNNING';
    await loadArtifacts();
    await loadTasks();
  } catch {}
}

async function loadEventHistory() {
  const events = await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}/events?limit=150`);
  $('events').innerHTML = '';
  for (const e of events) appendEvent(e);
}

function appendEvent(e) {
  const piType = e.data?.pi?.type;
  if (piType === 'message_update' || piType === 'tool_execution_update') return;
  const div = document.createElement('div');
  div.className = 'event';
  const time = new Date(e.at).toLocaleTimeString();
  div.innerHTML = `<span class="time">${escapeHtml(time)}</span>${escapeHtml(e.message || e.type)}`;
  $('events').append(div);
  while ($('events').children.length > 250) $('events').firstChild.remove();
  $('events').scrollTop = $('events').scrollHeight;
}

$('stop').onclick = async () => {
  if (!selectedTaskId || !confirm('Остановить текущую работу Pi?')) return;
  try { await api(`/api/tasks/${selectedTaskId}/cancel`, { method: 'POST', body: '{}' }); }
  catch (e) { alert(e.message); }
  await refreshTask();
};

$('compact').onclick = async () => {
  if (!selectedTaskId) return;
  const instructions = prompt('Доп. инструкции для compaction (можно оставить пустым):', '') ?? null;
  if (instructions === null) return;
  try {
    const r = await api(`/api/tasks/${selectedTaskId}/compact`, { method: 'POST', body: JSON.stringify({ instructions }) });
    alert(`Compaction завершён. Before: ${r.result?.tokensBefore ?? '?'}; after: ${r.result?.estimatedTokensAfter ?? '?'}`);
  } catch (e) { alert(e.message); }
};

$('sendFollowup').onclick = async () => {
  const text = $('followup').value.trim();
  if (!selectedTaskId || !text) return;
  $('sendFollowup').disabled = true;
  try {
    await api(`/api/tasks/${selectedTaskId}/message`, { method: 'POST', body: JSON.stringify({ text, mode: 'auto' }) });
    $('followup').value = '';
  } catch (e) { alert(e.message); }
  finally { $('sendFollowup').disabled = false; }
};

$('piState').onclick = async () => {
  if (!selectedTaskId) return;
  try {
    const r = await api(`/api/tasks/${selectedTaskId}/state`);
    $('stateJson').textContent = JSON.stringify(r.state, null, 2);
  } catch (e) { $('stateJson').textContent = e.message; }
};

async function loadArtifacts() {
  if (!selectedTaskId) return;
  try {
    const list = await api(`/api/tasks/${selectedTaskId}/artifacts`);
    $('artifacts').innerHTML = list.length
      ? list.map((name) => `<a target="_blank" href="/api/tasks/${selectedTaskId}/artifacts/${encodeURIComponent(name)}">${escapeHtml(name)}</a>`).join('')
      : '—';
  } catch {}
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

init();
