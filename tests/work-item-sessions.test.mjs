import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { startFixture } from './server-fixture.mjs';

// MR-03: одна задача — несколько независимых сессий. Здесь проверяется и то, что
// связь работает, и то, чем она НЕ является: это не таблица `runs`. Прогоны
// принадлежат сессии (в сессии их много), а work item группирует сессии — на этом
// различии держится MR-04, и путать их нельзя.

test('a link is one row per pair, and it is not a run', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-links-'));
  const store = new TaskStore(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  {
    store.createWorkItem({
      id: 'wi-1', projectId: 'p', title: 'Задача', status: 'IN_PROGRESS',
      createdAt: '2026-10-11T10:00:00.000Z', updatedAt: '2026-10-11T10:00:00.000Z',
    });
    const first = store.linkWorkItemSession('wi-1', 'session-a', 'implementation');
    assert.equal(first.relation, 'implementation');
    assert.match(first.createdAt, /^\d{4}-/, 'связь датируется');

    // Linking the same pair again updates the relation instead of adding a row.
    store.linkWorkItemSession('wi-1', 'session-a', 'review');
    assert.equal(store.workItemSessions('wi-1').length, 1, 'одна строка на пару');
    assert.equal(store.workItemSessions('wi-1')[0].relation, 'review');

    store.linkWorkItemSession('wi-1', 'session-b', 'investigation');
    assert.deepEqual(store.workItemSessions('wi-1').map(l => l.sessionId).sort(), ['session-a', 'session-b']);
    assert.deepEqual(store.workItemsOfSession('session-b').map(l => l.workItemId), ['wi-1'], 'обратный взгляд');

    assert.equal(store.unlinkWorkItemSession('wi-1', 'session-a').sessionId, 'session-a');
    assert.equal(store.unlinkWorkItemSession('wi-1', 'session-a'), null, 'второй раз снимать нечего');
    assert.equal(store.removeSessionLinks('session-b'), 1, 'удаление сессии убирает её связи');
    assert.deepEqual(store.workItemSessions('wi-1'), []);
    assert.equal(store.removeWorkItemLinks('wi-1'), 0, 'у задачи уже нет связей');
  }
});

test('one work item gathers several sessions, and each keeps its own runs', { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const api = fixture.api;
  const [project] = await api('/api/projects');
  const headers = { 'content-type': 'application/json' };
  const post = async (route, body, expect = 201) => {
    const response = await fetch(fixture.base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    // One read: the body must not be consumed by the message of a failed assert.
    const text = await response.text();
    assert.equal(response.status, expect, `POST ${route} → ${response.status}: ${text}`);
    return JSON.parse(text);
  };

  const item = await post('/api/work-items', { projectId: project.id, title: 'Project Dashboard', goal: 'проектный интерфейс' });
  const sessionA = await api('/api/tasks', { projectId: project.id, prompt: 'backend часть' });
  const sessionB = await api('/api/tasks', { projectId: project.id, prompt: 'android часть' });

  await post(`/api/work-items/${item.id}/sessions`, { sessionId: sessionA.id, relation: 'implementation' });
  await post(`/api/work-items/${item.id}/sessions`, { sessionId: sessionB.id, relation: 'review' });

  // The item itself carries its sessions: one call is what the screen needs.
  const detail = await api(`/api/work-items/${item.id}`);
  assert.equal(detail.title, 'Project Dashboard');
  assert.equal(detail.goal, 'проектный интерфейс');
  assert.deepEqual(detail.sessions.map(s => s.sessionId).sort(), [sessionA.id, sessionB.id].sort());
  const review = detail.sessions.find(s => s.sessionId === sessionB.id);
  assert.equal(review.relation, 'review');
  assert.equal(review.available, true, 'сессия на месте');
  assert.ok(review.status, `у связи есть состояние сессии: ${JSON.stringify(review)}`);

  // Linking the same pair twice must not duplicate it, and the relation is updatable.
  await post(`/api/work-items/${item.id}/sessions`, { sessionId: sessionB.id, relation: 'verification' });
  const afterRelink = await api(`/api/work-items/${item.id}/sessions`);
  assert.equal(afterRelink.items.length, 2, 'повторная связка не создаёт вторую строку');
  assert.equal(afterRelink.items.find(s => s.sessionId === sessionB.id).relation, 'verification');

  // The reverse view: a session knows which work items it serves.
  const ofSession = await api(`/api/tasks/${sessionA.id}/work-items`);
  assert.deepEqual(ofSession.items.map(i => i.id), [item.id]);
  assert.equal(ofSession.items[0].relation, 'implementation');

  // MR-03's «очень важно»: this is not `runs`. Each session keeps its own runs.
  const runsA = await api(`/api/tasks/${sessionA.id}/runs`);
  const runsB = await api(`/api/tasks/${sessionB.id}/runs`);
  assert.ok(Array.isArray(runsA.runs) && Array.isArray(runsB.runs), 'прогоны остались у сессий');
  assert.ok(runsA.runs.every(run => run.taskId === sessionA.id), `прогоны не переехали в задачу: ${JSON.stringify(runsA.runs)}`);
  assert.ok(runsB.runs.every(run => run.taskId === sessionB.id));

  // Refusals: unknown work item, unknown session, unknown relation.
  await post(`/api/work-items/wi-nope/sessions`, { sessionId: sessionA.id }, 404);
  await post(`/api/work-items/${item.id}/sessions`, { sessionId: 'task-nope' }, 404);
  await post(`/api/work-items/${item.id}/sessions`, { sessionId: sessionA.id, relation: 'ревью' }, 400);
  await post(`/api/work-items/${item.id}/sessions`, {}, 400);

  // Unlinking does not touch the session, and unlinking twice is not an error.
  const unlinked = await api(`/api/work-items/${item.id}/sessions/${sessionB.id}`, {}, 'DELETE');
  assert.equal(unlinked.removed, true);
  assert.equal((await api(`/api/work-items/${item.id}/sessions/${sessionB.id}`, {}, 'DELETE')).removed, false);
  assert.ok((await api('/api/tasks')).some(task => task.id === sessionB.id), 'сессия осталась');
  assert.deepEqual((await api(`/api/work-items/${item.id}`)).sessions.map(s => s.sessionId), [sessionA.id]);

  // Links survive a restart, and a deleted session leaves no dangling link.
  await fixture.restart();
  assert.equal((await api(`/api/work-items/${item.id}`)).sessions.length, 1);
  await api(`/api/tasks/${sessionA.id}`, {}, 'DELETE');
  const afterDelete = await api(`/api/work-items/${item.id}`);
  assert.deepEqual(afterDelete.sessions, [], 'удаление сессии убрало связь, а не оставило висячую');
  assert.equal(afterDelete.title, 'Project Dashboard', 'сама задача осталась');

  // And deleting the work item removes its links without touching sessions.
  const sessionC = await api('/api/tasks', { projectId: project.id, prompt: 'третья сессия' });
  await post(`/api/work-items/${item.id}/sessions`, { sessionId: sessionC.id });
  await api(`/api/work-items/${item.id}`, {}, 'DELETE');
  assert.deepEqual((await api(`/api/tasks/${sessionC.id}/work-items`)).items, [], 'связи удалённой задачи ушли');
  assert.ok((await api('/api/tasks')).some(task => task.id === sessionC.id));
});
