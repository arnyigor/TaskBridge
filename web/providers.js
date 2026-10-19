(() => {
  'use strict';
  const el = id => document.getElementById(id);
  let revision = null;
  let profiles = [];
  let selected = null;
  let busy = false;

  const status = (message, kind = '') => {
    el('notice').textContent = message;
    el('notice').className = `notice ${kind}`;
  };
  const api = async (endpoint, options = {}) => {
    const response = await fetch(`/api/provider-profiles${endpoint}`, {
      credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };
  const renderList = () => {
    const root = el('providers');
    root.replaceChildren();
    if (profiles.length === 0) {
      const line = document.createElement('p');
      line.className = 'muted'; line.textContent = 'Пока нет подключений';
      root.append(line);
      return;
    }
    for (const item of profiles) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = `entry ${selected === item.id ? 'active' : ''}`;
      const title = document.createElement('strong'); title.textContent = item.id;
      const sub = document.createElement('small');
      sub.textContent = `${item.modelCount} мод. · ${item.auth} · ${item.managed ? 'можно настроить' : 'только просмотр'}`;
      button.append(title, sub);
      button.addEventListener('click', () => show(item));
      root.append(button);
    }
  };
  const show = item => {
    selected = item?.id || null;
    el('editor-title').textContent = item ? (item.managed ? 'Настройки подключения' : 'Существующее подключение') : 'Новое подключение';
    el('provider-id').value = item?.id || 'tb-';
    el('provider-id').disabled = !!item;
    el('base-url').value = item?.baseUrl || '';
    el('key-env').value = item?.keyEnv || '';
    el('models').value = item?.models?.map(m => m.id).join('\n') || '';
    el('preset').value = 'custom';
    const disabled = !!item && !item.managed;
    for (const id of ['base-url', 'key-env', 'models', 'preset', 'save']) el(id).disabled = disabled;
    el('test').disabled = !item?.managed;
    el('delete').disabled = !item?.managed;
    renderList();
  };
  const refresh = async ({ preserve = true } = {}) => {
    const result = await api('');
    revision = result.revision;
    profiles = result.providers;
    const found = preserve ? profiles.find(p => p.id === selected) : null;
    if (found) show(found);
    else if (preserve && selected) show(null);
    else if (!selected) renderList();
    return result;
  };
  el('refresh').addEventListener('click', async () => {
    try { await refresh(); status('Список обновлён.', 'success'); }
    catch (e) { status(e.message, 'error'); }
  });
  el('add').addEventListener('click', () => { show(null); status('Введите параметры нового подключения.'); });
  el('preset').addEventListener('change', () => {
    switch (el('preset').value) {
      case 'openrouter':
        el('provider-id').value = 'tb-openrouter';
        el('base-url').value = 'https://openrouter.ai/api/v1';
        el('key-env').value = 'OPENROUTER_API_KEY';
        break;
      case 'local':
        el('provider-id').value = 'tb-local';
        el('base-url').value = 'http://127.0.0.1:8080/v1';
        el('key-env').value = '';
        break;
      default: break;
    }
  });
  el('provider-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true; el('save').disabled = true;
    try {
      const id = el('provider-id').value.trim();
      const models = el('models').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const result = await api('', { method: 'PUT', body: JSON.stringify({
        revision, id, baseUrl: el('base-url').value.trim(), keyEnv: el('key-env').value.trim(), models,
      }) });
      revision = result.revision; profiles = result.providers;
      show(profiles.find(p => p.id === id));
      status('Сохранено. Обнови каталог моделей в TaskBridge. Для нового API-ключа перезапусти сервер.', 'success');
    } catch (e) { status(e.message, 'error'); }
    finally { busy = false; if (!selected || profiles.find(p => p.id === selected)?.managed) el('save').disabled = false; }
  });
  el('test').addEventListener('click', async () => {
    if (!selected || busy) return;
    busy = true; el('test').disabled = true;
    try {
      const result = await api(`/${encodeURIComponent(selected)}/check`, { method: 'POST', body: '{}' });
      status(`${result.ok ? 'Сервер ответил' : 'Соединение не подтверждено'}: ${result.status}${result.ms != null ? ` (${result.ms} мс)` : ''}. ${result.note || ''}`, result.ok ? 'success' : 'error');
    } catch (e) { status(e.message, 'error'); }
    finally { busy = false; el('test').disabled = false; }
  });
  el('delete').addEventListener('click', async () => {
    if (!selected || busy || !confirm(`Удалить провайдер ${selected}? Уже запущенные сессии не будут перенастроены.`)) return;
    busy = true;
    try {
      const result = await api(`/${encodeURIComponent(selected)}`, { method: 'DELETE', body: JSON.stringify({ revision }) });
      revision = result.revision; profiles = result.providers;
      show(null); status('Провайдер удалён. Оригинальный models.json сохранён в резервной копии.', 'success');
    } catch (e) { status(e.message, 'error'); }
    finally { busy = false; }
  });
  refresh({ preserve: false }).then(() => show(null)).catch(e => status(`Не удалось прочитать настройки: ${e.message}`, 'error'));
})();
