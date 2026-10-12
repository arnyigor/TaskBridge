// Дашборд проектов в веб-клиенте (MR-01): раскладка по разделам, строка чисел и
// то, что закрепление/архив уходят на сервер одним флагом.
//
// Тест выполняет НАСТОЯЩИЕ функции из web/app.js (projectDashboardSections,
// projectCountsLine, projectRowElement, renderManageProjectsList), а не повторяет
// их логику: иначе он проверял бы сам себя. Стенд — linkedom, как в
// tests/machine-load-panel.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

/**
 * Вырезает исходник функции по имени: от `function name(` до парной `}`.
 * `async` перед объявлением сохраняется — без него вырезанное тело с `await`
 * не собирается («await is only valid in async functions»).
 */
function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `в app.js нет функции ${name}`);
  if (/async\s+$/.test(source.slice(0, start))) start = source.lastIndexOf('async', start);
  let depth = 0;
  let i = source.indexOf('{', start);
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`не найдена закрывающая скобка для ${name}`);
}

/**
 * Стенд: реальные функции дашборда + минимальные зависимости. Переменные модуля
 * (`projectOverview`, `projects`, `projectsQuery`, `showArchivedProjects`) объявлены
 * здесь теми же `let`, а `render()` их выставляет — иначе вырезанный код не собрался бы.
 */
function makeDashboard() {
  const { document } = parseHTML(`<!doctype html><html><body>
    <div id="manageProjectsList"></div>
    <div id="manageProjectsSummary"></div>
    <div id="manageProjectsUnassigned" class="hidden"></div>
    <input id="manageProjectsSearch">
  </body></html>`);
  const $ = id => document.getElementById(id);
  const captured = { patches: [] };
  const lines = [
      'let projectOverview = null;',
      'let showArchivedProjects = false;',
      'let projectsQuery = "";',
      'let projects = [];',
      extractFunction(appSource, 'projectDisplayName'),
      extractFunction(appSource, 'projectDashboardSections'),
      extractFunction(appSource, 'projectCountsLine'),
      // Строка проекта зовёт setProjectPreferences, а тот — loadProjectOverview: оба
      // берутся из app.js, иначе проверялся бы не тот код, что работает на телефоне.
      extractFunction(appSource, 'loadProjectOverview'),
      extractFunction(appSource, 'setProjectPreferences'),
      extractFunction(appSource, 'projectRowElement'),
      extractFunction(appSource, 'renderManageProjectsList'),
      'function render(overview, registry = [], query = "", archivedOpen = false) {',
      '  projectOverview = overview; projects = registry; projectsQuery = query; showArchivedProjects = archivedOpen;',
      '  renderManageProjectsList();',
      '}',
      'return { projectDisplayName, projectDashboardSections, projectCountsLine, projectRowElement, renderManageProjectsList, render };',
  ].join('\n');
  let factory;
  try {
    factory = new Function('document', '$', 'relativeTime', 'escapeHtml', 'api', 'alert', 'captured', lines);
  } catch (error) {
    // Стенд собирается из исходника: без самого текста непонятно, что именно не собралось.
    fs.writeFileSync(path.join(root, '.local', 'stand-assembly.js'), lines);
    throw new Error(`${error.message}\nсобранный стенд: .local/stand-assembly.js`);
  }
  const helpers = factory(
    document, $,
    value => `когда-то (${String(value).slice(0, 10)})`,
    value => String(value ?? '').replace(/[<>&]/g, ''),
    async (url, options) => {
      captured.patches.push({ url, body: JSON.parse(options?.body ?? '{}'), method: options?.method });
      return { pinned: true, archived: false };
    },
    message => captured.patches.push({ alert: message }),
    captured,
  );
  return { document, $, captured, ...helpers };
}

const overview = {
  projects: [
    { id: 'blog', name: 'Блог', path: 'G:/sites/blog', sessions: 3, working: 0, needsAttention: 0, pinned: false, archived: false, activeWork: 0, lastActivityAt: '2026-10-11T07:00:00.000Z' },
    { id: 'taskbridge', name: 'TaskBridge', path: 'G:/work/taskbridge', sessions: 41, working: 2, needsAttention: 1, pinned: true, archived: false, lastActivityAt: '2026-10-11T07:20:00.000Z', activeWork: 3 },
    { id: 'old', name: 'Старый', path: 'G:/old', sessions: 5, working: 0, needsAttention: 0, pinned: false, archived: true, lastActivityAt: null },
    { id: 'both', name: 'И то и то', path: 'G:/both', sessions: 1, working: 0, needsAttention: 0, pinned: true, archived: true, lastActivityAt: null },
  ],
  unassignedSessions: 2,
  totals: { projects: 4, pinned: 2, archived: 2, sessions: 50, working: 2, needsAttention: 1, workItems: 5, activeWork: 3 },
};

test('архив побеждает закрепление: проект не показывается дважды', () => {
  const dash = makeDashboard();
  const sections = dash.projectDashboardSections(overview, '');
  assert.deepEqual(sections.pinned.map(p => p.id), ['taskbridge'], 'закреплённый и архивный — только в архиве');
  assert.deepEqual(sections.active.map(p => p.id), ['blog']);
  assert.deepEqual(sections.archived.map(p => p.id).sort(), ['both', 'old']);
  assert.equal(2, sections.unassignedSessions, 'сессии вне реестра едут вместе с разделами');
});

test('поиск идёт по названию и пути, пробелы не мешают', () => {
  const dash = makeDashboard();
  assert.deepEqual(dash.projectDashboardSections(overview, ' blog ').active.map(p => p.id), ['blog'], 'по названию');
  assert.deepEqual(dash.projectDashboardSections(overview, 'work/taskbridge').pinned.map(p => p.id), ['taskbridge'], 'по пути');
  const none = dash.projectDashboardSections(overview, 'нет такого');
  assert.equal(none.pinned.length + none.active.length + none.archived.length, 0);
});

test('строка чисел показывает то, что нужно оператору, и не печатает нули', () => {
  const dash = makeDashboard();
  const [blog, taskbridge, old] = overview.projects;
  assert.equal(
    dash.projectCountsLine(taskbridge),
    'сессий: 41 · работа: 3 · работают: 2 · внимание: 1 · активность: когда-то (2026-10-11)',
  );
  assert.equal(dash.projectCountsLine(blog), 'сессий: 3 · активность: когда-то (2026-10-11)', 'нули работы и внимания отсутствуют');
  assert.equal(dash.projectCountsLine(old), 'сессий: 5', 'без активности строка короче');
});

test('окно рисует разделы, архив свёрнут, а закрепление уходит одним флагом', async () => {
  const dash = makeDashboard();
  dash.render(overview);

  const list = dash.$('manageProjectsList');
  assert.match(list.textContent, /Закреплённые/u);
  assert.match(list.textContent, /TaskBridge/u);
  assert.match(list.textContent, /Архив \(2\) — показать/u, 'архив свёрнут и его размер виден');
  assert.ok(!list.textContent.includes('Старый'), 'свёрнутый архив не показывает проекты');
  assert.match(dash.$('manageProjectsSummary').textContent, /проектов: 4 · сессий: 50 · работают: 2 · требуют внимания: 1 · работы: 3/u);
  assert.match(dash.$('manageProjectsUnassigned').textContent, /вне реестра: 2/u, 'сессии вне реестра названы');

  // Кнопка закрепления отправляет только изменяемый флаг: значение архива на
  // сервере остаётся тем, каким было.
  const rows = [...list.querySelectorAll('.projectRow')];
  const pinnedRow = rows.find(row => row.textContent.includes('TaskBridge'));
  const unpin = [...pinnedRow.querySelectorAll('.projectRowAction')].find(button => button.textContent === '☆');
  assert.ok(unpin, 'у закреплённого проекта кнопка снимает закрепление');
  await unpin.onclick();
  const patches = dash.captured.patches.filter(call => call.method === 'PATCH');
  assert.deepEqual(patches, [
    { url: '/api/projects/taskbridge/preferences', body: { pinned: false }, method: 'PATCH' },
  ], 'уходит только изменяемый флаг: архив на сервере остаётся тем, каким был');
  assert.ok(
    dash.captured.patches.some(call => call.url === '/api/projects/overview'),
    'а состояние перечитывается с сервера, а не досчитывается на месте',
  );
});

test('раскрытый архив показывает свои проекты', () => {
  const dash = makeDashboard();
  dash.render(overview, [], '', true);
  assert.match(dash.$('manageProjectsList').textContent, /Старый/u);
  assert.match(dash.$('manageProjectsList').textContent, /Архив \(2\) — свернуть/u);
});

test('без дашборда окно показывает реестр, а не пустоту', () => {
  const dash = makeDashboard();
  // /api/projects/overview не ответил: числа показать нечем, но реестр уже загружен.
  dash.render(null, [{ id: 'p', name: 'Проект', path: 'G:/p' }]);
  assert.match(dash.$('manageProjectsList').textContent, /Проект/u, 'реестр остаётся видимым');
  assert.equal(dash.$('manageProjectsSummary').textContent, '', 'и обещаний про числа нет');
  assert.ok(dash.$('manageProjectsUnassigned').classList.contains('hidden'), 'строка про вне-реестровые скрыта');
});
