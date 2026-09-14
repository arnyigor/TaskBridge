#!/usr/bin/env node
// Process-level acceptance for step 5 in variant B: **restarting the LAN proxy
// must not disturb the agent.**
//
// The old split proved this with a host + gateway pair (scripts/split-acceptance
// — removed with that design). Variant B has to prove the same property for its
// own shape: the app owns the agent and binds loopback, the proxy owns the public
// face and owns nothing.
//
// Runs the real thing against a throwaway data root and real OS processes:
//   1. start the app on an internal port (loopback only),
//   2. start the proxy in front of it on a public port,
//   3. create a task through the *public* port and read it back,
//   4. kill the proxy,
//   5. assert the app is still alive and still answers on its internal port,
//   6. start a second proxy: the session is intact and a live stream still opens.
//
// Deliberately NOT part of `npm test` (process-spawning under the parallel suite
// is flaky). Run it explicitly:  npm run lan:acceptance
//
// Exit code 0 = PASS, non-zero = FAIL.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../tests/server-fixture.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function getJson(url, timeoutMs = 2500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function waitFor(label, url, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await getJson(url)).status === 200) { console.log(`✔ ${label}`); return; } }
    catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`${label}: no answer at ${url} within ${timeoutMs}ms`);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
}

// The proxy is started as a real process, not in-process: "the agent survives a
// proxy restart" is only meaningful if the proxy is something that can die.
function startProxy({ internalPort, publicPort, log }) {
  const out = fs.openSync(log, 'a');
  // Close our copy of the descriptor once the child holds one: leaving it open
  // trips a libuv assertion on the way out (Windows).
  try {
    const child = spawn(process.execPath, ['src/proxy.mjs'], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        LAN_INTERNAL_PORT: String(internalPort),
        LAN_PORT: String(publicPort),
        LAN_HOST: '127.0.0.1',
        LAN_TLS: 'off', // the repo config has https enabled; that port belongs to the operator
      },
      stdio: ['ignore', out, out],
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(out);
  }
}

let fixture = null;
let proxy = null;
const logFile = path.join(os.tmpdir(), 'taskbridge-lan-acceptance.log');

async function main() {
  fs.writeFileSync(logFile, `[lan-acceptance] ${new Date().toISOString()}\n`);
  const internalPort = await freePort();
  const publicPort = await freePort();

  // The app: a real TaskBridge in a throwaway root, told to behave like the
  // process behind the proxy (loopback only, TLS off, public port for its links).
  fixture = await startFixture(internalPort, {
    env: {
      TASKBRIDGE_BIND_HOST: '127.0.0.1',
      TASKBRIDGE_PUBLIC_PORT: String(publicPort),
      TASKBRIDGE_DISABLE_TLS: '1',
    },
  });
  console.log(`✔ app up on 127.0.0.1:${internalPort} (internal)`);

  proxy = startProxy({ internalPort, publicPort, log: logFile });
  const appPid = fixture.appPid;
  await waitFor('proxy up', `http://127.0.0.1:${publicPort}/api/health`);

  // Create the task through the *public* port, so the write path (POST body and
  // all) is exercised through the proxy, not only the read path.
  const created = await fetch(`http://127.0.0.1:${publicPort}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'fixture', prompt: 'survives a proxy restart' }),
    signal: AbortSignal.timeout(10000),
  });
  const task = await created.json().catch(() => null);
  if (!task?.id) throw new Error(`the proxy did not carry the create call: ${created.status} ${JSON.stringify(task)}`);
  const throughProxy = await getJson(`http://127.0.0.1:${publicPort}/api/tasks/${task.id}`);
  if (throughProxy.status !== 200 || throughProxy.body?.id !== task.id) {
    throw new Error(`the task is not readable through the proxy: ${throughProxy.status} ${JSON.stringify(throughProxy.body)}`);
  }
  console.log(`✔ task created and readable through the proxy: ${task.id}`);

  // --- the point of step 5 ---------------------------------------------------
  killTree(proxy.pid);
  await sleep(500);
  if (!alive(appPid)) throw new Error('the app died with the proxy — the agent did not survive');
  console.log('✔ the app outlived the proxy');
  const direct = await getJson(`http://127.0.0.1:${internalPort}/api/tasks/${task.id}`);
  if (direct.status !== 200 || direct.body?.id !== task.id) throw new Error('the agent lost the session when the proxy died');
  console.log('✔ the agent still holds the session on its internal port');

  proxy = startProxy({ internalPort, publicPort, log: logFile });
  await waitFor('proxy#2 up', `http://127.0.0.1:${publicPort}/api/health`);
  const afterRestart = await getJson(`http://127.0.0.1:${publicPort}/api/tasks/${task.id}`);
  if (afterRestart.status !== 200 || afterRestart.body?.id !== task.id) throw new Error('history is not intact after the proxy restart');

  const stream = await fetch(`http://127.0.0.1:${publicPort}/api/tasks/${task.id}/stream`, { signal: AbortSignal.timeout(8000) });
  if (stream.status !== 200) throw new Error(`the live stream did not reopen: ${stream.status}`);
  const reader = stream.body.getReader();
  const first = await reader.read();
  await reader.cancel().catch(() => {});
  if (first.done) throw new Error('the reopened stream closed without sending anything');
  console.log('✔ history intact and a live stream reopens through the new proxy');

  console.log('\nPASS: restarting the LAN proxy does not disturb the agent.');
  return 0;
}

try {
  const code = await main();
  killTree(proxy?.pid);
  await fixture?.close();
  process.exit(code);
} catch (error) {
  console.error(`\nFAIL: ${error.message}`);
  console.error(`proxy log: ${logFile}`);
  try { console.error(fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-8).join('\n')); } catch { /* no log */ }
  killTree(proxy?.pid);
  await fixture?.close().catch(() => {});
  process.exit(1);
}
