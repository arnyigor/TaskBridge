import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentHost } from '../src/agent-host.mjs';
import { GatewayClient } from '../src/ipc.mjs';

const FS_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function makeHost(t, dataRoot) {
  const config = { projects: [{ id: 'p', path: dataRoot, useWorktree: false }] };
  const host = new AgentHost({ config, dataRoot, rootDir: dataRoot });
  t.after(async () => { try { await host.close(); } catch {} });
  await host.init();
  return host;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('AgentHost serves core commands and live events over IPC', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-test-'));
  t.after(async () => { try { await fs.rm(dataRoot, { recursive: true, force: true }); } catch {} });
  const host = await makeHost(t, dataRoot);
  const { port, token } = await host.startIpc();

  const client = new GatewayClient({ host: '127.0.0.1', port, token, reconnect: false });
  t.after(() => client.close());
  const events = [];
  client.on('event', (type, data) => events.push({ type, data }));
  await client.connect();
  client.subscribe();
  await sleep(30); // let SUBSCRIBE land before we emit

  // Read side.
  const projects = await client.request('listProjects');
  assert.deepEqual(projects.map((p) => ({ id: p.id, path: p.path, useWorktree: p.useWorktree })), [{ id: 'p', path: dataRoot, useWorktree: false }]);

  // Seed a completed task directly (no queue/pump pipeline, so the test stays
  // fast and stable under a parallel full-suite run) and read it back.
  const seeded = { id: 'a', createdAt: new Date().toISOString(), status: 'SUCCEEDED', workspacePath: dataRoot, prompt: 'hello', files: [], assistantText: 'saved', thinkingText: '', compaction: { count: 0 } };
  await host.store.create(seeded);
  host.manager.tasks.set('a', seeded);

  const fetched = await client.request('getTask', { id: 'a' });
  assert.equal(fetched.id, 'a');
  assert.ok(Array.isArray(await client.request('events', { id: 'a', count: 10, after: 0 })));

  // A write command round-trips through the dispatcher without a pipeline.
  const renamed = await client.request('renameTask', { id: 'a', title: 'renamed' });
  assert.equal(renamed.title, 'renamed');

  // The host forwards the manager's live event stream to the gateway.
  host.manager.emit('task-event', { seq: 999, taskId: 'a' });
  await sleep(50);
  assert.ok(events.some((e) => e.data?.seq === 999 && e.data.taskId === 'a'), 'the forwarded event reached the gateway');

  // Unknown command is reported, not silently swallowed.
  const unknown = await client.request('nope').then(() => null, (e) => e);
  assert.ok(unknown && unknown.code === 'NOT_IMPLEMENTED');
});

test('AgentHost holds the instance lock and releases it on close', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-lock-'));
  t.after(async () => { try { await fs.rm(dataRoot, { recursive: true, force: true }); } catch {} });
  const host = await makeHost(t, dataRoot);
  const { port } = await host.startIpc();

  const instanceLockPath = path.join(FS_ROOT, 'src', 'instance-lock.mjs');
  const lockProbe = `const { pathToFileURL } = await import('node:url'); const { acquireInstanceLock } = await import(pathToFileURL(${JSON.stringify(instanceLockPath)}).href); try { acquireInstanceLock(${JSON.stringify(dataRoot)}); console.log('LOCKED'); } catch (e) { console.log('REFUSED:' + (e.code || '')); }`;
  const runChild = (timeoutMs = 8000) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', lockProbe], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });

  // While the host holds the lock, a separate process must be refused.
  const held = await runChild();
  assert.match(held.out, /REFUSED:ALREADY_RUNNING/, 'foreign process refused while host holds the lock');

  // After close the lock is free and the IPC port is released.
  await host.close();
  await assert.rejects(
    new GatewayClient({ host: '127.0.0.1', port, token: '', reconnect: false }).request('listProjects'),
    /refused|closed|error/i,
  );
  const freed = await runChild();
  assert.match(freed.out, /LOCKED/, 'lock re-acquirable after close');
});
