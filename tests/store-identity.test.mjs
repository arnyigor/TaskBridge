import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { startFixture } from './server-fixture.mjs';

// Stores close before the directory goes: Windows cannot unlink an open database.
async function tempDir(t, stores) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-store-id-'));
  t.after(async () => {
    for (const store of stores) store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('a database keeps its storeId across reopening', async t => {
  const stores = [];
  const dir = await tempDir(t, stores);
  const first = new TaskStore(dir);
  const id = first.storeId;
  first.close();
  const again = new TaskStore(dir);
  stores.push(again);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(again.storeId, id);
});

test('a restored backup has its own storeId, so clients drop their seq cache', async t => {
  const stores = [];
  const dir = await tempDir(t, stores);
  const store = new TaskStore(dir);
  stores.push(store);
  const file = await store.backup(path.join(dir, 'backups', 'copy.db'));
  const restoredDir = path.join(dir, 'restored');
  await fs.mkdir(restoredDir);
  await fs.copyFile(file, path.join(restoredDir, 'taskbridge.db'));
  const restored = new TaskStore(restoredDir);
  stores.push(restored);
  assert.ok(restored.storeId);
  assert.notEqual(restored.storeId, store.storeId);
});

test('/api/info reports the storeId and the Pi version', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  // The version probe runs in the background at startup.
  let info;
  for (let i = 0; i < 100; i++) {
    info = await fixture.api('/api/info');
    if (info.pi) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(info.storeId, /^[0-9a-f-]{36}$/);
  assert.equal(info.pi.version, '0.85.1');
  assert.equal(info.pi.supported, true);
  assert.equal(info.warnings.some(w => w.code === 'PI_VERSION_UNSUPPORTED'), false);
});

test('an unsupported Pi is a warning, not a failure', { timeout: 30000 }, async t => {
  const fixture = await startFixture(undefined, { env: { FAKE_PI_VERSION: '0.99.0' } });
  t.after(() => fixture.close());
  let info;
  for (let i = 0; i < 100; i++) {
    info = await fixture.api('/api/info');
    if (info.pi) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(info.pi.version, '0.99.0');
  assert.equal(info.pi.supported, false);
  assert.ok(info.warnings.some(w => w.code === 'PI_VERSION_UNSUPPORTED'), JSON.stringify(info.warnings));
});

test('a commandId reused with a different body is a 409 CONFLICT, and the sender is recorded', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'первое' });
  for (let i = 0; i < 200; i++) {
    const current = await api(`/api/tasks/${task.id}`);
    if (['SUCCEEDED', 'FAILED'].includes(current.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  await api(`/api/tasks/${task.id}/message`, { text: 'второе', commandId: 'cmd-origin-1', clientId: 'phone-1' });
  // The same command again is a replay, not a second prompt.
  await api(`/api/tasks/${task.id}/message`, { text: 'второе', commandId: 'cmd-origin-1', clientId: 'phone-1' });
  await assert.rejects(
    api(`/api/tasks/${task.id}/message`, { text: 'другое', commandId: 'cmd-origin-1', clientId: 'phone-1' }),
    error => error.status === 409 && error.code === 'CONFLICT');

  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  const users = events.filter(event => event.type === 'USER_MESSAGE');
  assert.equal(users.length, 1, 'the replay did not reach Pi twice');
  assert.equal(users[0].data.commandId, 'cmd-origin-1');
  assert.equal(users[0].data.clientId, 'phone-1');
});

test('a repeat of a command still in flight is a 409 ACCEPTED, not a server error', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'первое' });
  for (let i = 0; i < 200; i++) {
    const current = await api(`/api/tasks/${task.id}`);
    if (['SUCCEEDED', 'FAILED'].includes(current.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const body = { text: 'одновременно', commandId: 'cmd-inflight-1', clientId: 'phone-1' };
  const results = await Promise.allSettled([1, 2, 3].map(() => api(`/api/tasks/${task.id}/message`, body)));
  const refused = results.filter(r => r.status === 'rejected').map(r => r.reason);
  assert.ok(results.some(r => r.status === 'fulfilled'), 'one of them went through');
  for (const error of refused) assert.deepEqual([error.status, error.code], [409, 'ACCEPTED']);

  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  assert.equal(events.filter(event => event.type === 'USER_MESSAGE' && event.data.commandId === 'cmd-inflight-1').length, 1);
});

test('a history action on an answer that is not the newest is a 409 NOT_ALLOWED', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'первое' });
  for (let i = 0; i < 200; i++) {
    const current = await api(`/api/tasks/${task.id}`);
    if (['SUCCEEDED', 'FAILED'].includes(current.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await assert.rejects(api(`/api/tasks/${task.id}/regenerate`, { turnId: 'assistant-not-the-newest' }),
    error => error.status === 409 && error.code === 'NOT_ALLOWED');
});
