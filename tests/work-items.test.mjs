import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { startFixture } from './server-fixture.mjs';

// MR-02: Work Items — семантическое состояние работы. Здесь проверяется то, за что
// эта сущность отвечает (цель, критерии, статус, приоритет, теги, completedAt), и
// то, чем она быть не должна: контейнером для prompt/диффа/истории. Плюс число
// «Active work» на дашборде — оно берётся отсюда.

async function tempDir(t, stores) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-workitems-'));
  t.after(async () => {
    for (const store of stores) store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('a work item survives reopening the database with its criteria and tags', async t => {
  const stores = [];
  const dir = await tempDir(t, stores);

  const store = new TaskStore(dir);
  const at = '2026-10-11T10:00:00.000Z';
  store.createWorkItem({
    id: 'wi-1', projectId: 'taskbridge', title: 'Project Dashboard', goal: 'Проектный интерфейс',
    status: 'IN_PROGRESS', priority: 1,
    acceptanceCriteria: ['список проектов', 'pinned/archive'], tags: ['ui', 'backend'],
    createdAt: at, updatedAt: at, completedAt: null,
  });
  store.close();

  const reopened = new TaskStore(dir);
  stores.push(reopened);
  const item = reopened.getWorkItem('wi-1');
  assert.equal(item.title, 'Project Dashboard');
  assert.equal(item.goal, 'Проектный интерфейс');
  assert.equal(item.status, 'IN_PROGRESS');
  assert.equal(item.priority, 1);
  assert.deepEqual(item.acceptanceCriteria, ['список проектов', 'pinned/archive'], 'критерии — список, а не строка');
  assert.deepEqual(item.tags, ['ui', 'backend']);
  assert.equal(item.completedAt, null);

  // Partial update: only what was given moves; DONE stamps the moment once.
  const done = reopened.updateWorkItem('wi-1', { status: 'DONE' });
  assert.equal(done.status, 'DONE');
  assert.match(done.completedAt, /^\d{4}-/, 'момент завершения проставлен');
  const again = reopened.updateWorkItem('wi-1', { goal: null });
  assert.equal(again.completedAt, done.completedAt, 'повторный PATCH не переписывает момент завершения');
  assert.equal(again.goal, null, 'null очищает поле');
  assert.deepEqual(again.acceptanceCriteria, ['список проектов', 'pinned/archive'], 'критерии не тронуты');

  const reopened2 = reopened.updateWorkItem('wi-1', { status: 'READY' });
  assert.equal(reopened2.completedAt, null, 'выход из DONE снимает completedAt');
  assert.deepEqual(reopened.listWorkItems('taskbridge').map(i => i.id), ['wi-1']);
  assert.deepEqual(reopened.listWorkItems('other'), [], 'список фильтруется проектом');
  assert.equal(reopened.workItemCounts().get('taskbridge').open, 1, 'READY — ещё открытая работа');
  assert.deepEqual(reopened.deleteWorkItem('wi-1'), reopened2, 'удаление возвращает то, что удалили');
  assert.equal(reopened.getWorkItem('wi-1'), null);
});

test('work items are created, filtered, updated and counted over HTTP', { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const api = fixture.api;
  const [project] = await api('/api/projects');
  const headers = { 'content-type': 'application/json' };
  const post = async (body, expect = 201) => {
    const response = await fetch(`${fixture.base}/api/work-items`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, expect, `POST ${JSON.stringify(body)} → ${response.status}`);
    return response.json();
  };

  const first = await post({
    projectId: project.id,
    title: 'Project Dashboard',
    goal: 'Перейти от списка сессий к проектам',
    acceptanceCriteria: ['обзор проектов', 'pinned/archive'],
    tags: ['ui'],
    priority: 2,
  });
  assert.match(first.id, /^wi-/, `id выделяется среди сессий: ${first.id}`);
  assert.equal(first.status, 'BACKLOG', 'статус по умолчанию');
  assert.equal(first.completedAt, null);
  assert.deepEqual(first.acceptanceCriteria, ['обзор проектов', 'pinned/archive']);
  const second = await post({ projectId: project.id, title: 'Work Items', status: 'IN_PROGRESS' });

  const listed = await api('/api/work-items');
  assert.deepEqual(listed.items.map(i => i.id).sort(), [first.id, second.id].sort(), 'обе задачи видны');
  assert.deepEqual((await api(`/api/work-items?projectId=${project.id}`)).items.length, 2);
  assert.deepEqual((await api('/api/work-items?projectId=nope')).items, [], 'чужой проект — пусто, а не ошибка');
  assert.deepEqual((await api('/api/work-items?status=IN_PROGRESS')).items.map(i => i.id), [second.id]);

  // The dashboard's «Active work» is exactly the open ones.
  const overview = await api('/api/projects/overview');
  const row = overview.projects.find(p => p.id === project.id);
  assert.equal(row.workItems, 2);
  assert.equal(row.activeWork, 2);
  assert.equal(overview.totals.activeWork, 2);
  assert.equal(overview.totals.workItems, 2);

  // Partial update over HTTP: an absent field keeps its value.
  const patched = await api(`/api/work-items/${first.id}`, { goal: 'уточнённая цель', status: 'DONE' }, 'PATCH');
  assert.equal(patched.status, 'DONE');
  assert.equal(patched.goal, 'уточнённая цель');
  assert.match(patched.completedAt, /^\d{4}-/, 'DONE проставляет момент завершения');
  assert.deepEqual(patched.acceptanceCriteria, ['обзор проектов', 'pinned/archive'], 'критерии уцелели');
  const afterDone = (await api('/api/projects/overview')).projects.find(p => p.id === project.id);
  assert.equal(afterDone.activeWork, 1, 'завершённая задача больше не «активная работа»');
  assert.equal(afterDone.workItems, 2, 'но из списка не исчезла');
  assert.deepEqual((await api('/api/work-items?includeClosed=0')).items.map(i => i.id), [second.id], 'фильтр открытых');
  assert.equal((await api(`/api/work-items/${first.id}`)).title, 'Project Dashboard');

  // Refusals: an unknown project, an empty title, an unknown status, a bad priority.
  await post({ projectId: 'nope', title: 'X' }, 404);
  await post({ projectId: project.id, title: '   ' }, 400);
  await post({ projectId: project.id, title: 'X', status: 'EPIC' }, 400);
  await post({ projectId: project.id, title: 'X', priority: 99 }, 400);
  const badPatch = await fetch(`${fixture.base}/api/work-items/${first.id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ status: 'почти готово' }),
  });
  assert.equal(badPatch.status, 400);
  assert.equal((await badPatch.json()).code, 'INPUT_INVALID');
  assert.equal((await fetch(`${fixture.base}/api/work-items/wi-nope`, { method: 'PATCH', headers, body: '{}' })).status, 404);

  // Deleting a work item does not touch the sessions it was about.
  const task = await api('/api/tasks', { projectId: project.id, prompt: 'работа по задаче' });
  const removed = await api(`/api/work-items/${second.id}`, {}, 'DELETE');
  assert.equal(removed.ok, true);
  assert.equal((await api('/api/work-items')).items.length, 1);
  assert.ok((await api('/api/tasks')).some(item => item.id === task.id), 'сессия осталась');

  // A restart keeps the work items: they are stored, not held in memory.
  await fixture.restart();
  const restored = (await api('/api/work-items')).items;
  assert.deepEqual(restored.map(i => i.id), [first.id], 'задачи пережили перезапуск');
  assert.equal(restored[0].status, 'DONE');
  assert.deepEqual(restored[0].acceptanceCriteria, ['обзор проектов', 'pinned/archive']);
  assert.equal((await api('/api/projects/overview')).totals.workItems, 1);
});
