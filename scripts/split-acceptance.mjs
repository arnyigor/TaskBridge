#!/usr/bin/env node
// Process-level acceptance for TZ step 5 (P-3 final): restarting the gateway
// must not kill the agent.
//
// Runs the real split as separate OS processes against a throwaway data root:
//   1. start the host (owns the agent + instance lock),
//   2. start a gateway pointing at it,
//   3. register a project + create a task and read it / open an SSE stream,
//   4. SIGTERM the gateway,
//   5. assert the host is still alive and still owns the data (lock pid), and
//   6. start a second gateway on the same endpoint: the task history is intact
//      and the SSE replay still streams — nothing was lost by the restart.
//
// Deliberately NOT part of `npm test` (process-spawning under the parallel
// suite is flaky). Run it explicitly:  npm run split:acceptance
//
// Exit code 0 = PASS, non-zero = FAIL.

import { spawn } from 'node:child_process';
import fs, { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getFreePort() {
  const net = (await import('node:net')).default;
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function pollHttp(url, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.ok) return true; } catch {}
    await sleep(150);
  }
  return false;
}

function startProc(name, file, env, onReady) {
  const child = spawn(process.execPath, [file], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} did not become ready`)), 15000);
    const check = () => {
      if (onReady(out)) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', (c) => { out += c; check(); });
    child.stderr.on('data', (c) => { out += c; check(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${name} exited (code ${code}):\n${out}`)); });
  });
  return { child, ready: () => ready, log: () => out };
}

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'tb-split-acc-'));
  let host, gw1, gw2;
  const hostPort = await getFreePort();
  const gwPort = await getFreePort();
  try {
    // 1. host
    host = startProc('host', 'src/host.mjs', { TASKBRIDGE_DATA_DIR: tmp, HOST_PORT: String(hostPort) }, (o) => /ready: 127\.0\.0\.1:\d+/.test(o));
    await host.ready();
    console.log('✔ host up (pid ' + host.child.pid + ')');

    // 2. gateway #1
    gw1 = startProc('gateway#1', 'src/gateway.mjs', { TASKBRIDGE_DATA_DIR: tmp, HOST_PORT: String(hostPort), GATEWAY_PORT: String(gwPort) }, (o) => /listening on http:\/\/127\.0\.0\.1:\d+/.test(o));
    gw1.ready().then(() => console.log('✔ gateway#1 up (pid ' + gw1.child.pid + ')'));
    await gw1.ready();
    if (!(await pollHttp(`http://127.0.0.1:${gwPort}/`))) throw new Error('gateway#1 did not answer HTTP');

    // 3. register a project through the host's IPC and create a task through
    //    the gateway (exercising both the IPC and HTTP paths).
    const { GatewayClient, readToken } = await import('../src/ipc.mjs');
    const ipc = new GatewayClient({ host: '127.0.0.1', port: hostPort, token: readToken(path.join(tmp, 'host-ipc.json')), reconnect: false });
    await ipc.connect();
    await ipc.request('registerProject', { project: { id: 'acc', name: 'acceptance', path: tmp, useWorktree: false } });
    ipc.close();

    const base = `http://127.0.0.1:${gwPort}`;
    const created = await (await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello acceptance', projectId: 'acc' }),
    })).json();
    const taskId = created.id;
    if (!taskId) throw new Error('could not create a task: ' + JSON.stringify(created));
    console.log('✔ task created: ' + taskId);

    // Open an SSE stream on gateway#1 and confirm it starts.
    const ctrl = new AbortController();
    const sse1 = await fetch(`${base}/api/tasks/${taskId}/stream?after=0`, { signal: ctrl.signal });
    const r1 = sse1.body.getReader();
    await r1.read(); ctrl.abort();
    console.log('✔ SSE stream on gateway#1 opened');

    // 4. restart the gateway only.
    const hostPid = host.child.pid;
    gw1.child.kill('SIGTERM');
    await sleep(400);

    // 5. host must still be alive and still hold the instance lock.
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    if (!alive(hostPid)) throw new Error('host died when the gateway was killed');
    const lock = JSON.parse(fs.readFileSync(path.join(tmp, 'taskbridge.lock'), 'utf8'));
    if (lock.pid !== hostPid) throw new Error(`host no longer owns the lock (lock pid ${lock.pid}, host ${hostPid})`);
    console.log('✔ host survived gateway restart and still owns the data (pid ' + hostPid + ')');

    // 6. gateway #2 on the same endpoint: same history, SSE replay works.
    gw2 = startProc('gateway#2', 'src/gateway.mjs', { TASKBRIDGE_DATA_DIR: tmp, HOST_PORT: String(hostPort), GATEWAY_PORT: String(gwPort) }, (o) => /listening on http:\/\/127\.0\.0\.1:\d+/.test(o));
    await gw2.ready();
    if (!(await pollHttp(`${base}/`))) throw new Error('gateway#2 did not answer HTTP');
    const tasks = await (await fetch(`${base}/api/tasks`)).json();
    if (!tasks.some((t) => t.id === taskId)) throw new Error('task history lost on restart');
    const sse2 = await fetch(`${base}/api/tasks/${taskId}/stream?after=99999999`, { signal: (new AbortController()).signal });
    if (sse2.status !== 200) throw new Error('SSE replay failed on gateway#2');
    (sse2.body.getReader().cancel()).catch(() => {});
    console.log('✔ gateway#2 reconnected: task history intact, SSE stream available');

    console.log('\nPASS: restarting the gateway does not kill the agent.');
    return 0;
  } finally {
    try { gw1?.child.kill('SIGKILL'); } catch {}
    try { gw2?.child.kill('SIGKILL'); } catch {}
    try { host?.child.kill('SIGKILL'); } catch {}
    await sleep(150);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

main().then(
  (code) => process.exit(code),
  (error) => { console.error('\nFAIL: ' + (error?.message || error)); process.exit(1); }
);
