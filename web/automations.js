// Экран «Автоматизации» (AUTO-02).
//
// Работает на уже существующих API и не создаёт новых таблиц: автоматизация — это
// рецепт (`/api/recipes`) плюс расписание (`/api/schedules`), а история — инвокации
// (`/api/invocations?scheduleId=…`). Всё, что можно проверить без DOM, живёт в
// `automations-view.mjs`.
import {
  invocationText, recipePayload, schedulePayload, scheduleStateText, scheduleText, summaryText,
} from './automations-view.mjs';

const el = id => document.getElementById(id);
let projects = [];
let recipes = [];
let schedules = [];
let selected = null; // { recipeId, scheduleId }
let busy = false;

const status = (message, kind = '') => {
  el('notice').textContent = message;
  el('notice').className = `notice ${kind}`;
};

async function api(endpoint, options = {}) {
  const response = await fetch(`/api${endpoint}`, {
    credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { code: body.code });
  return body;
}

const currentProject = () => el('project').value || projects[0]?.id || null;
const recipeOf = id => recipes.find(item => item.id === id) || null;
const schedulesOf = recipeId => schedules.filter(item => item.recipeId === recipeId);
const selectedSchedule = () => (selected?.scheduleId ? schedules.find(item => item.id === selected.scheduleId) : null);

function renderItems() {
  const root = el('items');
  root.replaceChildren();
  if (!recipes.length) {
    const line = document.createElement('p');
    line.className = 'muted';
    line.textContent = 'Пока нет автоматизаций';
    root.append(line);
    return;
  }
  for (const recipe of recipes) {
    const schedule = schedulesOf(recipe.id)[0] || null;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `entry ${selected?.recipeId === recipe.id ? 'active' : ''}`;
    const title = document.createElement('strong');
    title.textContent = recipe.name;
    const sub = document.createElement('small');
    sub.textContent = schedule
      ? `${scheduleText(schedule)} · ${scheduleStateText(schedule)}`
      : 'нет расписания — только ручной запуск';
    button.append(title, sub);
    button.addEventListener('click', () => show(recipe.id, schedule?.id ?? null));
    root.append(button);
  }
}

function show(recipeId, scheduleId) {
  selected = recipeId ? { recipeId, scheduleId } : null;
  const recipe = recipeId ? recipeOf(recipeId) : null;
  const schedule = scheduleId ? schedules.find(item => item.id === scheduleId) : null;
  el('editor-title').textContent = recipe ? 'Автоматизация' : 'Новая автоматизация';
  el('name').value = recipe?.name || '';
  el('prompt').value = recipe?.promptTemplate || '';
  el('model').value = recipe?.runtime?.model || '';
  el('kind').value = schedule?.spec?.kind || 'daily';
  el('at').value = schedule?.spec?.at || '09:00';
  el('weekday').value = schedule?.spec?.weekday || 'mon';
  el('everyMinutes').value = schedule?.spec?.everyMinutes || 60;
  el('misfirePolicy').value = schedule?.misfirePolicy || 'RUN_ONCE';
  el('concurrencyPolicy').value = schedule?.concurrencyPolicy || 'SKIP_IF_RUNNING';
  el('notify').value = schedule?.notify || 'action-required';
  el('enabled').checked = schedule ? schedule.enabled !== false : true;
  el('run').disabled = !schedule;
  el('pause').disabled = !schedule;
  el('pause').textContent = schedule && schedule.enabled === false ? 'Включить' : 'Пауза';
  el('delete').disabled = !recipe;
  renderItems();
  renderHistory();
}

async function loadHistory() {
  const schedule = selectedSchedule();
  const root = el('history');
  root.replaceChildren();
  if (!schedule) {
    const line = document.createElement('p');
    line.className = 'muted';
    line.textContent = selected?.recipeId ? 'У автоматизации нет расписания — запусков по времени не было.' : 'Выберите автоматизацию.';
    root.append(line);
    return;
  }
  const result = await api(`/invocations?scheduleId=${encodeURIComponent(schedule.id)}&limit=20`).catch(error => ({ items: [], error }));
  if (result.error) {
    status(`История не загружена: ${result.error.message}`, 'error');
    return;
  }
  if (!result.items.length) {
    const line = document.createElement('p');
    line.className = 'muted';
    line.textContent = 'Запусков ещё не было';
    root.append(line);
    return;
  }
  for (const invocation of result.items) {
    const row = document.createElement('div');
    row.className = 'entry static';
    const title = document.createElement('strong');
    title.textContent = invocationText(invocation);
    const sub = document.createElement('small');
    const parts = [];
    if (invocation.sessionId) parts.push(`сессия ${invocation.sessionId}`);
    if (invocation.resultArtifact) parts.push(`результат: ${invocation.resultArtifact}`);
    if (invocation.finishedAt) parts.push('завершён');
    sub.textContent = parts.join(' · ') || 'ожидает завершения';

    // Сводка (длительность, модель, токены) грузится по нажатию: десятки запусков
    // не должны тянуть детали при каждом обновлении истории (AUTO-03B).
    const details = document.createElement('small');
    details.className = 'muted';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'subtle small';
    more.textContent = 'Подробнее';
    more.addEventListener('click', async () => {
      more.disabled = true;
      try {
        const summary = await api(`/invocations/${encodeURIComponent(invocation.id)}/summary`);
        details.textContent = summaryText(summary);
      } catch (error) {
        details.textContent = `Сводка недоступна: ${error.message}`;
      } finally {
        more.disabled = false;
      }
    });
    row.append(title, sub, more, details);
    root.append(row);
  }
}

const renderHistory = () => loadHistory().catch(error => status(error.message, 'error'));

async function refresh({ keepSelection = true } = {}) {
  const projectId = currentProject();
  const [projectList, recipeList, scheduleList] = await Promise.all([
    api('/projects'),
    projectId ? api(`/recipes?projectId=${encodeURIComponent(projectId)}`) : Promise.resolve({ items: [] }),
    api('/schedules'),
  ]);
  projects = projectList;
  if (!el('project').value) {
    el('project').replaceChildren();
    for (const project of projects) {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.name;
      el('project').append(option);
    }
  }
  recipes = recipeList.items || [];
  schedules = scheduleList.items || [];
  const keep = keepSelection && selected && recipes.some(item => item.id === selected.recipeId);
  if (keep) show(selected.recipeId, schedulesOf(selected.recipeId)[0]?.id ?? null);
  else show(recipes[0]?.id ?? null, schedulesOf(recipes[0]?.id)[0]?.id ?? null);
}

el('project').addEventListener('change', () => { selected = null; refresh({ keepSelection: false }).catch(error => status(error.message, 'error')); });

el('add').addEventListener('click', () => {
  selected = null;
  show(null, null);
  status('Заполните название, промпт и расписание.');
});

el('automation-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  el('save').disabled = true;
  try {
    const recipeBody = recipePayload({
      name: el('name').value,
      promptTemplate: el('prompt').value,
      projectId: currentProject(),
      model: el('model').value.trim(),
    });
    const recipeId = selected?.recipeId
      ? (await api(`/recipes/${encodeURIComponent(selected.recipeId)}`, { method: 'PATCH', body: JSON.stringify(recipeBody) })).id
      : (await api('/recipes', { method: 'POST', body: JSON.stringify(recipeBody) })).id;

    const scheduleBody = schedulePayload({
      recipeId,
      kind: el('kind').value,
      at: el('at').value,
      weekday: el('weekday').value,
      everyMinutes: el('everyMinutes').value,
      misfirePolicy: el('misfirePolicy').value,
      concurrencyPolicy: el('concurrencyPolicy').value,
      notify: el('notify').value,
      enabled: el('enabled').checked,
    });
    const existing = schedulesOf(recipeId)[0] || null;
    if (existing) await api(`/schedules/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body: JSON.stringify(scheduleBody) });
    else await api('/schedules', { method: 'POST', body: JSON.stringify(scheduleBody) });

    await refresh({ keepSelection: false });
    show(recipeId, schedulesOf(recipeId)[0]?.id ?? null);
    status('Сохранено. Расписание работает на этом компьютере, даже если телефон выключен.', 'success');
  } catch (error) {
    status(error.message, 'error');
  } finally {
    busy = false;
    el('save').disabled = false;
  }
});

el('run').addEventListener('click', async () => {
  const schedule = selectedSchedule();
  if (!schedule || busy) return;
  busy = true;
  try {
    const invocation = await api(`/schedules/${encodeURIComponent(schedule.id)}/run`, { method: 'POST', body: '{}' });
    status(`Запущено: ${invocation.id}${invocation.sessionId ? ` (сессия ${invocation.sessionId})` : ''}`, 'success');
    await refresh();
    await renderHistory();
  } catch (error) {
    status(error.message, 'error');
  } finally {
    busy = false;
  }
});

el('pause').addEventListener('click', async () => {
  const schedule = selectedSchedule();
  if (!schedule || busy) return;
  busy = true;
  try {
    const next = schedule.enabled === false;
    await api(`/schedules/${encodeURIComponent(schedule.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
    await refresh();
    status(next ? 'Расписание включено.' : 'Расписание на паузе: время не наступает, история сохраняется.', 'success');
  } catch (error) {
    status(error.message, 'error');
  } finally {
    busy = false;
  }
});

el('delete').addEventListener('click', async () => {
  const recipe = selected?.recipeId ? recipeOf(selected.recipeId) : null;
  if (!recipe || busy || !confirm(`Удалить автоматизацию «${recipe.name}»? Уже прошедшие сессии останутся.`)) return;
  busy = true;
  try {
    for (const schedule of schedulesOf(recipe.id)) {
      await api(`/schedules/${encodeURIComponent(schedule.id)}`, { method: 'DELETE' });
    }
    await api(`/recipes/${encodeURIComponent(recipe.id)}`, { method: 'DELETE' });
    selected = null;
    await refresh({ keepSelection: false });
    status('Удалено. Сессии, которые автоматизация уже запустила, остались.', 'success');
  } catch (error) {
    status(error.message, 'error');
  } finally {
    busy = false;
  }
});

el('refresh').addEventListener('click', () => refresh().catch(error => status(error.message, 'error')));
el('history-refresh').addEventListener('click', () => renderHistory());

refresh().catch(error => status(`Не удалось прочитать автоматизации: ${error.message}`, 'error'));
