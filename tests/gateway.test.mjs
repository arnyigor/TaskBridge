import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHost } from '../src/agent-host.mjs';
import { createGateway } from '../src/gateway.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('gateway proxies HTTP to the host and streams its events over SSE', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-test-'));
  t.after(async () => { try { await fs.rm(dataRoot, { recursive: true, force: true }); } catch {} });

  // Host in-process.
  const host = new AgentHost({ config: { projects: [{ id: 'p', path: dataRoot, useWorktree: false }] }, dataRoot, rootDir: ROOT });
  await host.init();
  const { port: hostPort } = await host.startIpc();
  t.after(async () => { await host.close(); });

  // Gateway in-process over the same host + token.
  const gateway = await createGateway({ config: { projects: [], server: { port: 8787 } }, rootDir: ROOT, dataRoot, hostPort, port: 0, tokenFile: host.tokenFile });
  t.after(async () => { await gateway.close(); });

  // Seed a completed task directly (no queue/pump pipeline -> fast + stable).
  const task = { id: 'a', createdAt: new Date().toISOString(), status: 'SUCCEEDED', workspacePath: dataRoot, prompt: 'hello', files: [], assistantText: 'saved', thinkingText: '', compaction: { count: 0 } };
  await host.store.create(task);
  host.manager.tasks.set('a', task);

  const base = gateway.baseUrl;

  // Read paths go host -> IPC -> HTTP.
  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  assert.ok(Array.isArray(tasks));
  assert.ok(tasks.some((x) => x.id === 'a'), 'seeded task is listed via the gateway');

  const one = await (await fetch(`${base}/api/tasks/a`)).json();
  assert.equal(one.id, 'a');
  assert.equal(one.prompt, 'hello');

  const events = await (await fetch(`${base}/api/tasks/a/events?after=0`)).json();
  assert.ok(Array.isArray(events.events), 'event page is an array');

  // Static shell is served.
  const shell = await fetch(`${base}/`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-type'), /html/);

  // SSE: open a stream, then the host emits a live task-event which the gateway
  // must deliver over the open connection.
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const sseRes = await fetch(`${base}/api/tasks/a/stream?after=0`, { signal: ctrl.signal });
  assert.equal(sseRes.status, 200);
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  await sleep(60); // let the SSE connection register before emitting

  host.manager.emit('task-event', { seq: 777, taskId: 'a', type: 'STATUS', text: 'x' });

  const deadline = Date.now() + 3000;
  let buf = '';
  let got = false;
  while (Date.now() < deadline && !got) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    got = buf.includes('id: 777');
  }
  reader.releaseLock();
  assert.ok(got, `SSE stream received the live task-event; got: ${buf.slice(0, 200)}`);

  // Close the SSE connection now so gateway.close() (in teardown) is not
  // blocked waiting on an open stream.
  ctrl.abort();
  await sleep(80);
});
