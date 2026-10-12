import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { startFixture } from './server-fixture.mjs';

// MR-01: the project dashboard. The overview and the project-scoped session list
// are computed from the project registry and the sessions that already exist;
// only pinned/archived are stored, and they must survive a restart of the server
// (that is the acceptance criterion, so it is the first test here).
//
// Everything runs over HTTP on the fixture server (fake Pi): the manager-level
// paths are the same code, and a manager built by hand would spawn a real Pi.
// Both dashboard tests live in ONE fixture: every `startFixture` boots a whole
// server plus a fake Pi, and the suite runs test files in parallel — a spare one
// here is a flake somewhere else.

async function tempDir(t, stores) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-dashboard-'));
  t.after(async () => {
    for (const store of stores) store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('pinned and archived survive reopening the database', async t => {
  const stores = [];
  const dir = await tempDir(t, stores);

  const store = new TaskStore(dir);
  assert.equal(store.projectViewPreferences().get('taskbridge'), undefined, 'nothing stored yet');

  store.setProjectViewPreferences('taskbridge', { pinned: true });
  store.setProjectViewPreferences('other', { archived: true });
  // A patch of one flag must not clear the other.
  store.setProjectViewPreferences('taskbridge', { archived: true });
  store.close();

  const reopened = new TaskStore(dir);
  stores.push(reopened);
  const preferences = reopened.projectViewPreferences();
  assert.deepEqual(
    { pinned: preferences.get('taskbridge').pinned, archived: preferences.get('taskbridge').archived },
    { pinned: true, archived: true },
    'a later patch merges into the stored values',
  );
  assert.equal(preferences.get('other').archived, true);
  assert.equal(preferences.get('other').pinned, false);
  assert.match(preferences.get('other').updatedAt, /^\d{4}-/, 'the change is timestamped');
});

test('the dashboard counts projects, hides nothing and pages their sessions', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const api = fixture.api;
  const [home] = await api('/api/projects');

  /** Waits until no session is left running, so «working» has a defined value. */
  const settled = async () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const tasks = await api('/api/tasks');
      if (tasks.every(task => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status))) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('sessions did not settle');
  };

  // A second project on the machine: registering from localhost is what the
  // operator does, and it gives the dashboard something to group. It needs its own
  // folder — registering the same path twice returns the existing project.
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-dashboard-second-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const second = await api('/api/projects/local-register', { path: folder, name: 'Второй' });
  assert.notEqual(second.id, home.id);

  const first = await api('/api/tasks', { projectId: home.id, prompt: 'первый вопрос' });
  await api('/api/tasks', { projectId: home.id, prompt: 'второй вопрос' });
  await api('/api/tasks', { projectId: home.id, prompt: 'третий вопрос' });
  await api('/api/tasks', { projectId: second.id, prompt: 'чужая сессия' });
  await settled();

  const overview = await api('/api/projects/overview');
  const byId = new Map(overview.projects.map(project => [project.id, project]));
  assert.deepEqual([...byId.keys()].sort(), [home.id, second.id].sort(), 'every registered project is listed');
  assert.equal(byId.get(home.id).sessions, 3);
  assert.equal(byId.get(second.id).sessions, 1);
  assert.equal(byId.get(home.id).working, 0, 'a settled session is not working');
  assert.equal(byId.get(home.id).needsAttention, 0, 'and it is not «needs attention» either');
  assert.match(byId.get(home.id).lastActivityAt, /^\d{4}-/, 'the newest activity is reported');
  assert.equal(byId.get(home.id).pinned, false);
  assert.equal(byId.get(home.id).archived, false);
  assert.equal(overview.unassignedSessions, 0, 'every session belongs to a registered project');
  assert.equal(overview.totals.projects, 2);

  // `fault-crash` exits in the middle of a tool call: that is the session the
  // dashboard must point the operator at. It runs BEFORE the hanging one — a
  // hanging session occupies the machine, and a queued session is not «failed».
  await api('/api/tasks', { projectId: second.id, prompt: 'fault-crash' });
  let attention = null;
  for (let attempt = 0; attempt < 40 && attention === null; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const row = (await api('/api/projects/overview')).projects.find(entry => entry.id === second.id);
    if (row.needsAttention > 0) attention = row;
  }
  assert.ok(attention, 'a failed session is counted as needing attention');
  assert.equal(attention.sessions, 2, 'and the failed session is still listed');
  assert.equal((await api('/api/projects/overview')).totals.needsAttention, 1);

  // A session that never finishes: the «working» count has a subject of its own.
  await api('/api/tasks', { projectId: home.id, prompt: 'fault-hang' });
  const homeRow = (await api('/api/projects/overview')).projects.find(entry => entry.id === home.id);
  assert.ok(homeRow.working >= 1, `the hanging session counts as working: ${JSON.stringify(homeRow)}`);
  assert.equal(homeRow.needsAttention, 0, 'a hanging session is working, not «needs attention»');

  // Pinned first, the rest by activity.
  await api(`/api/projects/${second.id}/preferences`, { pinned: true }, 'PATCH');
  assert.equal((await api('/api/projects/overview')).projects[0].id, second.id, 'a pinned project comes first');
  assert.equal((await api('/api/projects/overview')).totals.pinned, 1);

  // Archiving is a view flag: it survives, and it changes nothing about the project.
  await api(`/api/projects/${home.id}/preferences`, { archived: true }, 'PATCH');
  const archived = (await api('/api/projects/overview')).projects.find(entry => entry.id === home.id);
  assert.equal(archived.archived, true);
  assert.equal(archived.sessions, 4, 'the sessions stay');
  const archivedNew = await api('/api/tasks', { projectId: home.id, prompt: 'сессия в архиве' });
  assert.equal(archivedNew.projectId, home.id, 'a new session can still be created in an archived project');

  // --- the session list of one project, filtered and paged server-side ---------
  const listed = await api(`/api/projects/${home.id}/sessions`);
  assert.equal(listed.registered, true);
  assert.equal(listed.offset, 0);
  assert.equal(listed.limit, 50);
  assert.equal(listed.endReached, true);
  const total = listed.total;
  assert.ok(total >= 4, `the archived project's sessions are listed: ${total}`);

  const page = await api(`/api/projects/${home.id}/sessions?limit=2&offset=0`);
  assert.equal(page.items.length, 2);
  assert.equal(page.total, total, 'the total is the whole list, not the page');
  assert.equal(page.endReached, false);
  assert.equal((await api(`/api/projects/${home.id}/sessions?limit=2&offset=2`)).items.length, 2);
  assert.equal((await api(`/api/projects/${home.id}/sessions?limit=2&offset=${total}`)).items.length, 0);

  assert.equal((await api(`/api/projects/${home.id}/sessions?q=${encodeURIComponent('второй вопрос')}`)).total, 1, 'search is server-side');
  assert.equal((await api(`/api/projects/${home.id}/sessions?q=неттакого`)).total, 0);
  // The filter is applied rather than ignored: a status nothing is in returns nothing.
  assert.equal((await api(`/api/projects/${home.id}/sessions?status=CANCELLED`)).total, 0);
  assert.equal((await api(`/api/projects/${home.id}/sessions?status=SUCCEEDED&limit=1`)).items.length <= 1, true);
  // Sorting is the server's: «created» is newest-first, «title» is alphabetical.
  assert.equal((await api(`/api/projects/${home.id}/sessions?sort=created&limit=1`)).items[0].id, archivedNew.id);
  const byTitle = await api(`/api/projects/${home.id}/sessions?sort=title`);
  assert.ok(byTitle.items[0].prompt.startsWith('второй'), `sort=title is alphabetical: ${byTitle.items[0].prompt}`);

  // --- a registration that is gone, and bad input ------------------------------
  await fetch(`${fixture.base}/api/projects/${second.id}`, { method: 'DELETE' });
  const afterRemoval = await api('/api/projects/overview');
  assert.ok(!afterRemoval.projects.some(entry => entry.id === second.id), 'the registration is gone');
  assert.equal(afterRemoval.unassignedSessions, 2, 'its sessions are counted, not hidden');
  const orphan = await api(`/api/projects/${second.id}/sessions`);
  assert.equal(orphan.registered, false, 'an unregistered id answers with its sessions, not 404');
  assert.equal(orphan.total, 2);
  assert.ok((await api('/api/tasks')).length >= 6, 'the global list still has every session');

  for (const query of ['limit=0', 'limit=501', 'offset=-1']) {
    const response = await fetch(`${fixture.base}/api/projects/${home.id}/sessions?${query}`);
    assert.equal(response.status, 400, `${query} is refused`);
    assert.equal((await response.json()).code, 'INPUT_INVALID');
  }
  const badPatch = await fetch(`${fixture.base}/api/projects/${home.id}/preferences`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pinned: 'yes' }),
  });
  assert.equal(badPatch.status, 400);
  assert.equal((await badPatch.json()).code, 'INPUT_INVALID');
  const unknownProject = await fetch(`${fixture.base}/api/projects/nope/preferences`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pinned: true }),
  });
  assert.equal(unknownProject.status, 404);
  assert.equal((await unknownProject.json()).code, 'NOT_FOUND');

  // The old endpoints are untouched: the dashboard is additive.
  assert.equal((await api('/api/projects')).length, 1);

  // A restart keeps the view preferences: they are stored, not held in memory.
  await fixture.restart();
  const restored = (await api('/api/projects/overview')).projects.find(entry => entry.id === home.id);
  assert.equal(restored.archived, true, 'archived survived the restart');
  assert.equal(restored.pinned, false);
  assert.equal(restored.sessions, 5, 'and so did the sessions');
  assert.equal((await api(`/api/projects/${home.id}/sessions`)).total, 5);
});
