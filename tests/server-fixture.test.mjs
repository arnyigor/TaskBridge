import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFixture } from './server-fixture.mjs';

test('a fixture cannot accept another server health response on an explicit port', async t => {
  const first = await startFixture();
  t.after(() => first.close());
  const identity = (await first.api('/api/info')).storeId;
  let impostor;
  t.after(() => impostor?.close());
  await assert.rejects(async () => {
    impostor = await startFixture(Number(new URL(first.base).port));
  }, /Fixture startup failed:[\s\S]*EADDRINUSE/);
  assert.equal((await first.api('/api/info')).storeId, identity);
});

test('a contended ephemeral port is reallocated before exposing a fixture', async t => {
  const first = await startFixture();
  t.after(() => first.close());
  let allocations = 0;
  const second = await startFixture(undefined, { allocatePort: async () => {
    if (++allocations === 1) return Number(new URL(first.base).port);
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return port;
  } });
  t.after(() => second.close());
  assert.ok(allocations >= 2 && allocations <= 5);
  assert.notEqual(second.base, first.base);
  assert.notEqual((await second.api('/api/info')).storeId, (await first.api('/api/info')).storeId);
  const task = await second.api('/api/tasks', { projectId: 'fixture', prompt: 'own database' });
  const db = new DatabaseSync(path.join(second.root, 'data', 'taskbridge.db'), { readOnly: true });
  try { assert.ok(db.prepare('SELECT id FROM tasks WHERE id = ?').get(task.id)); }
  finally { db.close(); }
});
