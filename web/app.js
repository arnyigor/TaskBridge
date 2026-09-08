const $ = (id) => document.getElementById(id);

let selectedTaskId = null;
let source = null;
let refreshTimer = null;
let liveTurn = null;        // { body, md, meta } of the current bot turn
let liveThinking = '';
let liveText = '';
let lastToolChip = null;
let nearBottom = true;
let textUpdateTimer = null;
let lastSentText = '';
let errorShownForTask = null;
let baselineAssistantLen = 0;  // cumulative-text offset where the current bot turn starts
let baselineThinkingLen = 0;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${body.code || res.status}: ${body.error || res.statusText}`);
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

function appendUserTurn(text) {
  hideEmptyState();
  const turn = document.createElement('div');
  turn.className = 'turn me';
  const body = document.createElement('div');
  body.className = 'body';
  const bubble = document.createElement('div');
  bubble.className = 'msg s-me';
  bubble.textContent = text;
  body.append(bubble);
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
  body.append(bubble, meta);
  turn.append(body);
  $('msgsInner').append(turn);
  liveTurn = { body, md, meta };
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
  liveTurn.md.innerHTML = text ? renderMarkdown(text) : TYPING_HTML;
  scrollBottom();
}

function scheduleTextUpdate() {
  if (textUpdateTimer) return;
  textUpdateTimer = setTimeout(() => { textUpdateTimer = null; updateText(); }, 120);
}

function appendToolChip(label, state) {
  if (!liveTurn) return;
  const chip = document.createElement('div');
  chip.className = `tool ${state}`;
  chip.textContent = label;
  liveTurn.body.insertBefore(chip, liveTurn.meta);
  if (state === 'run') lastToolChip = chip;
  scrollBottom();
}

function markToolDone(label) {
  if (lastToolChip) {
    lastToolChip.classList.remove('run');
    if (/error/i.test(label)) lastToolChip.classList.add('error');
    lastToolChip.textContent = label;
  } else {
    appendToolChip(label, /error/i.test(label) ? 'error' : 'done');
  }
  lastToolChip = null;
}

function appendSystemNote(text) {
  hideEmptyState();
  const note = document.createElement('div');
  note.className = 'systemNote';
  note.textContent = text;
  $('msgsInner').insertBefore(note, $('msgsInner').firstChild);
  scrollBottom();
}

function showTurnError(message, onRetry) {
  if (!liveTurn) return;
  liveTurn.md.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'turnError';
  const text = document.createElement('div');
  text.textContent = message || 'Модель не отвечает.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Повторить';
  retry.onclick = onRetry;
  box.append(text, retry);
  liveTurn.md.append(box);
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
  if (t.autoCompactionEnabled == null) {
    autoBtn.textContent = 'AUTO: —';
    autoBtn.disabled = true;
  } else {
    autoBtn.textContent = t.autoCompactionEnabled ? 'AUTO: ON' : 'AUTO: OFF';
    autoBtn.disabled = false;
    autoBtn.dataset.enabled = String(t.autoCompactionEnabled);
  }
}

function setMeta(t) {
  if (!liveTurn) return;
  const parts = [t.status];
  if (t.status === 'RUNNING' && t.current) parts.push(t.current);
  if (t.lastUsage?.totalTokens != null) parts.push(`${t.lastUsage.totalTokens} tok`);
  liveTurn.meta.textContent = parts.join(' · ');
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

function setComposerMode(taskId) {
  const continuing = Boolean(taskId);
  $('newTaskButton').classList.toggle('hidden', !continuing);
  const badge = $('continueBadge');
  badge.classList.toggle('hidden', !continuing);
  if (continuing) badge.textContent = `Продолжение сессии ${taskId}`;
  promptEl.placeholder = continuing
    ? 'Сообщение продолжит текущую сессию. Enter — отправить, Shift+Enter — перенос строки.'
    : 'Сообщение для Pi. Enter — запустить, Shift+Enter — перенос строки.';
}

function startNewTask() {
  selectedTaskId = null;
  if (source) source.close();
  source = null;
  if (refreshTimer) clearInterval(refreshTimer);
  liveTurn = null;
  lastToolChip = null;
  liveThinking = '';
  liveText = '';
  errorShownForTask = null;
  $('detail').classList.add('hidden');
  $('msgsInner').innerHTML = '<div class="empty" id="emptyState">Выбери сессию из списка или создай новую —<br>рассуждение, инструменты и ответ Pi появятся здесь вживую.</div>';
  document.querySelectorAll('.taskRow.active').forEach((row) => row.classList.remove('active'));
  setComposerMode(null);
  promptEl.focus();
}

async function sendContinueMessage(taskId, text, opts = {}) {
  const fresh = opts.fresh !== false;
  const files = opts.files || [];
  lastSentText = text;
  errorShownForTask = null;
  if (fresh) {
    baselineAssistantLen = liveText.length;
    baselineThinkingLen = liveThinking.length;
  }
  liveThinking = '';
  liveText = '';
  lastToolChip = null;
  appendBotTurn();
  try {
    await api(`/api/tasks/${taskId}/message`, {
      method: 'POST',
      body: JSON.stringify({ text, mode: 'auto', files })
    });
    await refreshTask();
  } catch (err) {
    if (/NOT_FOUND/.test(err.message)) {
      try {
        const original = await api(`/api/tasks/${taskId}`);
        const task = await api('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({ projectId: original.projectId, prompt: text, files: [] })
        });
        await loadTasks();
        await selectTask(task.id);
        appendSystemNote('Прежняя сессия Pi потеряна (сервер перезапускался) — начата новая с тем же сообщением.');
        return;
      } catch (err2) {
        showTurnError(err2.message, () => sendContinueMessage(taskId, text, { fresh: false }));
        return;
      }
    }
    errorShownForTask = taskId;
    showTurnError(err.message, () => sendContinueMessage(taskId, text, { fresh: false }));
  }
}

async function selectTask(id) {
  selectedTaskId = id;
  if (source) source.close();
  $('detail').classList.remove('hidden');
  $('msgsInner').innerHTML = '';
  liveTurn = null;
  lastToolChip = null;
  liveThinking = '';
  liveText = '';
  nearBottom = true;
  errorShownForTask = null;
  baselineAssistantLen = 0;
  baselineThinkingLen = 0;
  setComposerMode(id);

  try {
    const t = await api(`/api/tasks/${encodeURIComponent(id)}`);
    appendUserTurn(t.prompt);
    appendBotTurn();
    if (t.thinkingText) { liveThinking = t.thinkingText; updateThinking(); }
    if (t.assistantText) { liveText = t.assistantText; updateText(); }
    setMeta(t);

    // tool chips from history
    const events = await api(`/api/tasks/${encodeURIComponent(id)}/events?limit=500`);
    for (const e of events) {
      const pt = e.data?.pi?.type;
      if (pt === 'tool_execution_start') appendToolChip(e.message, 'run');
      else if (pt === 'tool_execution_end') markToolDone(e.message);
    }
  } catch {}

  source = new EventSource(`/api/tasks/${encodeURIComponent(id)}/stream`);
  source.onmessage = onStreamEvent;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshTask, 2000);
}

function onStreamEvent(e) {
  let ev;
  try { ev = JSON.parse(e.data); } catch { return; }
  const pt = ev.data?.pi?.type;
  if (pt === 'message_update') {
    const d = ev.data.pi.assistantMessageEvent;
    if (d?.type === 'thinking_delta') { liveThinking += d.delta || ''; updateThinking(); }
    else if (d?.type === 'text_delta') { liveText += d.delta || ''; scheduleTextUpdate(); }
    return;
  }
  if (pt === 'tool_execution_start') { appendToolChip(ev.message, 'run'); return; }
  if (pt === 'tool_execution_end') { markToolDone(ev.message); return; }
  if (ev.type === 'STATUS' || ev.type.startsWith('TASK_') || pt === 'compaction_end') refreshTask();
}

async function refreshTask() {
  if (!selectedTaskId) return;
  try {
    const t = await api(`/api/tasks/${encodeURIComponent(selectedTaskId)}`);
    // server fields are cumulative over the whole task — only the slice past
    // this turn's baseline belongs to the turn currently rendering
    const thinkingNow = (t.thinkingText || '').slice(baselineThinkingLen);
    const textNow = (t.assistantText || '').slice(baselineAssistantLen);
    if (thinkingNow !== liveThinking) { liveThinking = thinkingNow; updateThinking(); }
    if (textNow !== liveText) { liveText = textNow; updateText(); }
    setMeta(t);

    $('taskTitle').textContent = t.id;
    $('taskStatus').textContent = t.status;
    $('current').textContent = t.current || '—';
    $('workspace').textContent = t.workspacePath || '—';
    renderContext(t);
    const c = t.compaction || {};
    $('compaction').textContent = c.last
      ? `${c.count} · ${c.last.tokensBefore ?? '?'}→${c.last.estimatedTokensAfter ?? '?'}`
      : String(c.count || 0);
    $('stopButton').disabled = t.status !== 'RUNNING';
    if (['FAILED', 'CANCELLED'].includes(t.status) && !liveText.trim() && errorShownForTask !== selectedTaskId) {
      errorShownForTask = selectedTaskId;
      const taskId = selectedTaskId;
      showTurnError(t.error || 'Модель не отвечает.', () => sendContinueMessage(taskId, lastSentText || t.prompt, { fresh: false }));
    }
    await loadArtifacts();
    await loadTasks();
  } catch {}
}

/* ---------------- panel ---------------- */

async function loadProjects() {
  const projects = await api('/api/projects');
  $('project').innerHTML = projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
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

async function loadTasks() {
  const tasks = await api('/api/tasks');
  $('tasks').innerHTML = tasks.length ? tasks.map((t) => `
    <div class="taskRow ${t.id === selectedTaskId ? 'active' : ''}" data-id="${t.id}">
      <button class="t-delete" type="button" data-delete-id="${t.id}" title="Удалить сессию" aria-label="Удалить сессию">✕</button>
      <div class="t-prompt">${escapeHtml(t.prompt)}</div>
      <div class="t-sub">
        <span class="pill ${pillClass(t.status)}">${escapeHtml(t.status)}</span>
        <span class="t-time">${new Date(t.createdAt).toLocaleString()}</span>
      </div>
    </div>`).join('') : '<div class="none">Пока нет сессий.</div>';
  document.querySelectorAll('.taskRow').forEach((row) => {
    row.onclick = () => selectTask(row.dataset.id);
  });
  document.querySelectorAll('.t-delete').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteTask(btn.dataset.deleteId);
    };
  });
  return tasks;
}

async function loadArtifacts() {
  if (!selectedTaskId) return;
  try {
    const list = await api(`/api/tasks/${selectedTaskId}/artifacts`);
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
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 180)}px`;
});
promptEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('form').requestSubmit();
  }
});

function setBusy(busy) {
  $('sendButton').disabled = busy;
  $('project').disabled = busy;
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
    if (selectedTaskId) {
      appendUserTurn(prompt);
      promptEl.value = '';
      promptEl.style.height = 'auto';
      const files = await filesPayload();
      $('files').value = '';
      $('fileList').textContent = '';
      await sendContinueMessage(selectedTaskId, prompt, { files });
    } else {
      const task = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          projectId: $('project').value,
          prompt,
          files: await filesPayload()
        })
      });
      promptEl.value = '';
      promptEl.style.height = 'auto';
      $('files').value = '';
      $('fileList').textContent = '';
      await loadTasks();
      await selectTask(task.id);
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

$('compact').onclick = async () => {
  if (!selectedTaskId) return;
  const instructions = prompt('Доп. инструкции для compaction (можно оставить пустым):', '') ?? null;
  if (instructions === null) return;
  try {
    const r = await api(`/api/tasks/${selectedTaskId}/compact`, { method: 'POST', body: JSON.stringify({ instructions }) });
    alert(`Compaction завершён. Before: ${r.result?.tokensBefore ?? '?'}; after: ${r.result?.estimatedTokensAfter ?? '?'}`);
  } catch (e) { alert(e.message); }
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

/* ---------------- markdown (regex, no deps) ---------------- */

function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
}

function extractListTail(lines, itemPattern) {
  let i = lines.length;
  while (i > 0 && itemPattern.test(lines[i - 1].trim())) i--;
  if (i === lines.length) return null;
  return {
    tag: itemPattern.source.startsWith('^\\d') ? 'ol' : 'ul',
    intro: lines.slice(0, i),
    items: lines.slice(i).map((line) => line.trim().replace(itemPattern, '')),
  };
}

function renderMarkdown(text) {
  const codeBlocks = [];
  const withPlaceholders = text.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_match, code) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${codeBlocks.length - 1}\u0000`;
  });

  return withPlaceholders
    .split(/\n{2,}/)
    .map((block) => {
      const placeholder = block.trim().match(/^\u0000(\d+)\u0000$/);
      if (placeholder) return codeBlocks[Number(placeholder[1])];

      let lines = block.split('\n').filter((line) => line.length > 0);
      let heading = '';
      const headingMatch = lines[0] && lines[0].match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const level = Math.min(headingMatch[1].length + 2, 6);
        heading = `<h${level}>${renderInline(headingMatch[2])}</h${level}>`;
        lines = lines.slice(1);
      }
      if (!lines.length) return heading;

      const list = extractListTail(lines, /^[-*]\s+/) || extractListTail(lines, /^\d+\.\s+/);
      if (list) {
        const intro = list.intro.length ? `<p>${list.intro.map(renderInline).join('<br>')}</p>` : '';
        const items = list.items.map((line) => `<li>${renderInline(line)}</li>`).join('');
        return `${heading}${intro}<${list.tag}>${items}</${list.tag}>`;
      }
      return `${heading}<p>${lines.map(renderInline).join('<br>')}</p>`;
    })
    .join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

/* ---------------- init ---------------- */

async function checkPcState() {
  const el = $('pcState');
  try {
    const info = await api('/api/info');
    el.textContent = '● ONLINE';
    el.classList.remove('err');
    el.classList.add('ok');
    el.title = (info.addresses || []).map((x) => x.url).join('\n');
  } catch {
    el.textContent = 'OFFLINE';
    el.classList.remove('ok');
    el.classList.add('err');
    el.title = '';
  }
}

async function init() {
  await checkPcState();
  setInterval(checkPcState, 8000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkPcState();
  });
  try {
    await loadProjects();
    const tasks = await loadTasks();
    if (tasks.length) await selectTask(tasks[0].id);
  } catch (e) {
    $('createError').textContent = e.message;
    $('createError').classList.add('error');
  }
}

init();
