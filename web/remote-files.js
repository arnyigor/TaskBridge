// No localStorage, IndexedDB, filesystem mounts, or content cache.
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const taskId = params.get('taskId');
let projectId = params.get('projectId');
let rootId = params.get('rootId');
let relative = params.get('path') || '';
let settings = { revision: 0, roots: [], requests: [] };
let entries = [];
let cursor = null;
let epoch = 0;
let controller = null;
let pollTimer = null;
let prepared = null;
let reviewed = null;
let commandKey = null;
let commandId = null;
const permissions = new Map([
  ['browse', 'Просматривать список файлов'], ['preview', 'Предпросмотр пользователем'],
  ['attach-file', 'Создавать вложения-снимки'], ['agent-read', 'Разрешить агенту читать папку'],
  ['model-transfer', 'Разрешить передачу файлов и имён выбранной модели (в том числе облачной)'],
]);
const ready = () => navigator.onLine && !document.hidden;
const notice = (text, error = false) => { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; };
const element = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
const button = (text, action, enabled = true) => {
  const node = element('button', text); node.type = 'button'; node.disabled = !enabled || !ready();
  node.addEventListener('click', action); return node;
};
const projectPath = suffix => `/api/projects/${encodeURIComponent(projectId)}/${suffix}`;
const selectedRoot = () => settings.roots.find(root => root.id === rootId);
function command(key) {
  if (commandKey !== key) {
    commandKey = key;
    commandId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return commandId;
}
async function api(url, body, signal) {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (ready() && settings.requests.some(request => request.status === 'PENDING')) pollTimer = setTimeout(() => load(), 5000);
}
function clearContent() {
  $('previewBody').replaceChildren(); $('preview').close(); $('attachment').close(); $('decision').close();
  prepared = null; reviewed = null; $('attachmentText').value = '';
}
async function perform(action) {
  if (!ready() || !projectId) { notice('Нет соединения: операции отключены.', true); return; }
  controller?.abort(); clearTimeout(pollTimer);
  controller = new AbortController(); const signal = controller.signal; const version = ++epoch;
  document.querySelectorAll('button, input, select, textarea').forEach(node => { node.disabled = true; });
  try { await action(signal, version); }
  catch (error) { if (version === epoch && error.name !== 'AbortError') notice(error.message || 'Операция не выполнена', true); }
  finally {
    if (version === epoch) {
      document.querySelectorAll('button, input, select, textarea').forEach(node => { node.disabled = !ready(); });
      $('project').disabled = Boolean(taskId) || !ready();
      render(); schedulePoll();
    }
  }
}
function locationState() {
  const next = new URL(location.href);
  next.searchParams.set('projectId', projectId);
  if (rootId) next.searchParams.set('rootId', rootId); else next.searchParams.delete('rootId');
  if (relative) next.searchParams.set('path', relative); else next.searchParams.delete('path');
  history.replaceState(null, '', next);
}
function render() {
  $('roots').replaceChildren(); $('entries').replaceChildren(); $('requests').replaceChildren();
  for (const root of settings.roots) {
    const node = element('div', ''); node.className = 'entry';
    node.append(element('strong', root.name), element('p', root.revoked ? 'Разрешение отозвано локально' : !root.available ? 'Сохранена, но недоступна на сервере' : root.enabled ? 'Доступ включён' : 'Доступ временно отключён'),
      element('p', `Просмотр: ${root.canBrowse ? 'да' : 'нет'} · Агент: ${root.agentCanRead ? 'да' : 'нет'} · Передача модели: ${root.allowModelTransfer ? 'да' : 'нет'}`),
      button('Открыть', () => navigate(root.id, ''), root.canBrowse && root.available),
      button(root.enabled ? 'Отключить временно' : 'Включить', () => mutate(`toggle:${root.id}:${!root.enabled}:${settings.revision}`, id => api(projectPath(`external-read/roots/${encodeURIComponent(root.id)}/toggle`), { enabled: !root.enabled, expectedRevision: settings.revision, commandId: id })), !root.revoked));
    if (settings.localOperator && !root.revoked) node.append(button('Отозвать разрешение', () => {
      if (confirm(`Отозвать доступ к ${root.name} навсегда? Телефон не сможет включить его обратно. Неотправленные снимки тоже станут недоступны.`)) mutate(`revoke:${root.id}:${settings.revision}`, commandId => api(projectPath(`external-read/roots/${encodeURIComponent(root.id)}/revoke`), { expectedRevision: settings.revision, commandId }));
    }));
    $('roots').append(node);
  }
  const root = selectedRoot();
  $('browser').hidden = !rootId;
  $('location').textContent = `${root?.name || rootId || ''} / ${relative}`;
  $('up').disabled = !relative || !ready();
  $('more').hidden = !cursor;
  for (const entry of entries) {
    const node = element('div', ''); node.className = 'entry'; node.append(element('strong', entry.name), element('p', entry.size == null ? 'Папка' : `${entry.size} Б`));
    if (entry.type === 'directory') node.append(button('Открыть папку', () => navigate(rootId, entry.path), root?.canBrowse));
    else {
      node.append(button('Предпросмотр', () => preview(entry), entry.previewAvailable && root?.canPreview));
      if (taskId) node.append(button('Прикрепить снимок', () => prepare(entry), root?.canAttach && root?.allowModelTransfer && entry.size <= 2097152));
    }
    $('entries').append(node);
  }
  for (const request of settings.requests) {
    const node = element('div', ''); node.className = 'entry'; node.append(element('strong', `Запрос ${request.id.slice(0, 8)} · ${request.status}`));
    if (request.requestedPath) node.append(element('p', request.requestedPath));
    node.append(element('p', request.requestedPermissions.map(permission => permissions.get(permission)).join('; ')));
    if (settings.localOperator && request.status === 'PENDING') node.append(button('Проверить локально', () => {
      reviewed = request; $('operatorPath').value = request.requestedPath || '';
      $('decisionPermissions').textContent = request.requestedPermissions.map(permission => permissions.get(permission)).join('; ');
      $('decision').showModal();
    }));
    $('requests').append(node);
  }
}
async function load() {
  await perform(async (signal, version) => {
    const next = await api(projectPath('external-read'), null, signal);
    if (version !== epoch) return;
    settings = next;
    if (rootId && selectedRoot()?.canBrowse && selectedRoot()?.available) {
      const listing = await api(projectPath(`remote-files/browse?${new URLSearchParams({ rootId, path: relative })}`), null, signal);
      if (version !== epoch) return;
      entries = listing.entries; cursor = listing.nextCursor;
      $('scope').textContent = listing.truncated ? 'Список ограничен первыми 5000 записями.' : '';
    } else { entries = []; cursor = null; }
    notice('Данные загружены с компьютера.');
  });
}
function navigate(root, path) { clearContent(); rootId = root; relative = path; entries = []; cursor = null; $('scope').textContent = ''; locationState(); load(); }
async function mutate(key, action) {
  await perform(async () => { await action(command(key)); commandKey = null; clearContent(); notice('Операция выполнена.'); });
  if (ready()) {
    const message = $('notice').textContent;
    const failed = $('notice').classList.contains('error');
    await load();
    if (failed) notice(message, true);
  }
}
async function preview(entry) {
  await perform(async (signal, version) => {
    const result = await api(projectPath(`remote-files/preview?${new URLSearchParams({ rootId, path: entry.path })}`), null, signal);
    if (version !== epoch) return;
    $('previewName').textContent = result.name; $('previewBody').replaceChildren();
    if (result.image) {
      const img = document.createElement('img'); img.alt = result.name;
      img.src = `data:${result.mimeType};base64,${result.base64}`; $('previewBody').append(img);
    } else $('previewBody').append(element('pre', result.text));
    $('preview').showModal();
  });
}
async function prepare(entry) {
  await perform(async (signal, version) => {
    const key = `prepare:${taskId}:${rootId}:${entry.path}:${settings.revision}`;
    const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/remote-files/prepare-attachment`, { rootId, path: entry.path, expectedRevision: settings.revision, commandId: command(key) }, signal);
    if (version !== epoch) return;
    prepared = result; commandKey = null; $('attachmentName').textContent = result.files.map(file => file.name).join(', '); $('attachment').showModal();
  });
}
$('request').onsubmit = event => {
  event.preventDefault();
  const requestedPermissions = [...$('permissions').querySelectorAll('input:checked')].map(node => node.value);
  const path = $('requestedPath').value;
  if (!requestedPermissions.length) return notice('Выберите хотя бы одно полномочие.', true);
  mutate(`request:${path}:${requestedPermissions}:${settings.revision}`, id => api(projectPath('external-read/requests'), { path, permissions: requestedPermissions, expectedRevision: settings.revision, commandId: id }));
};
for (const [value, label] of permissions) {
  const node = element('label', ''); const input = document.createElement('input'); input.type = 'checkbox'; input.value = value; input.checked = ['browse', 'preview'].includes(value); node.append(input, document.createTextNode(label)); $('permissions').append(node);
}
for (const [id, approved] of [['approve', true], ['deny', false]]) $(id).onclick = () => {
  if (!reviewed || !settings.localOperator || (approved && !$('operatorPath').value)) return;
  const requestId = reviewed.id; const path = $('operatorPath').value;
  mutate(`decision:${requestId}:${approved}:${path}:${settings.revision}`, commandId => api(projectPath(`external-read/requests/${encodeURIComponent(requestId)}/decision`), { path, decision: approved ? 'APPROVED' : 'DENIED', expectedRevision: settings.revision, commandId }));
};
$('sendAttachment').onclick = async () => {
  if (!prepared) return;
  const snapshot = prepared; const text = $('attachmentText').value;
  await mutate(`send:${snapshot.token}:${text}`, commandId => api(`/api/tasks/${encodeURIComponent(taskId)}/message`, { text, uploadToken: snapshot.token, files: snapshot.files.map(file => ({ id: file.id })), queue: true, commandId }));
};
$('more').onclick = () => perform(async (signal, version) => {
  const listing = await api(projectPath(`remote-files/browse?${new URLSearchParams({ rootId, path: relative, cursor })}`), null, signal);
  if (version === epoch) { entries = [...entries, ...listing.entries].filter((entry, index, all) => all.findIndex(other => other.path === entry.path) === index); cursor = listing.nextCursor; }
});
$('search').onsubmit = event => {
  event.preventDefault(); if (!rootId) return;
  perform(async (signal, version) => {
    const result = await api(projectPath(`remote-files/search?${new URLSearchParams({ rootId, q: $('query').value })}`), null, signal);
    if (version !== epoch) return;
    entries = result.entries; cursor = null; $('scope').textContent = `Проверено папок: ${result.checkedDirectories}${result.truncated ? '. Поиск ограничен.' : '.'}`;
  });
};
$('up').onclick = () => navigate(rootId, relative.split('/').slice(0, -1).join('/'));
$('refresh').onclick = () => { clearContent(); load(); };
$('closePreview').onclick = () => { $('preview').close(); $('previewBody').replaceChildren(); };
$('closeDecision').onclick = () => { reviewed = null; $('decision').close(); };
$('cancelAttachment').onclick = () => { prepared = null; $('attachment').close(); $('attachmentText').value = ''; };
$('project').onchange = () => { projectId = $('project').value; navigate(null, ''); };
function visibility() {
  if (!ready()) { epoch++; controller?.abort(); clearTimeout(pollTimer); clearContent(); entries = []; render(); notice('Нет соединения или экран в фоне. Содержимое очищено.'); }
  else load();
}
document.addEventListener('visibilitychange', visibility);
window.addEventListener('offline', visibility); window.addEventListener('online', visibility);
if (taskId) $('back').href = `/session/${encodeURIComponent(taskId)}`;
try {
  const projects = await api('/api/projects');
  if (taskId) {
    const task = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    projectId = task.projectId; // Never trust a URL's project for an attachment.
  }
  for (const project of projects) { const option = element('option', project.name || project.id); option.value = project.id; $('project').append(option); }
  projectId ||= projects[0]?.id;
  if (projectId) { $('project').value = projectId; $('project').disabled = Boolean(taskId); await load(); }
  else notice('Нет зарегистрированных проектов.', true);
} catch (error) { notice(error.message, true); }
