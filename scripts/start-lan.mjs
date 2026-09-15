#!/usr/bin/env node
// Variant B, wired up (docs/agent-host-separation.md §12): the LAN proxy in
// front of the app, both as separate OS processes.
//
//   start  — app on loopback + proxy on the LAN (default `npm start` is untouched,
//            so this mode is opt-in and a failed experiment costs one command)
//   status — what is up, and whether the public face really answers
//   stop   — stop both, proxy first
//
// Why the app is bound to loopback: the proxy must be the only door into the
// machine. Two doors would mean the split bought nothing — and would expose the
// agent on a port the operator never looks at. `TASKBRIDGE_BIND_HOST` is what
// keeps it shut without editing config.json.
//
// State: data/lan.json (pids + ports), logs: data/lan-app.log, data/lan-proxy.log.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// State: <dataDir>/lan.json, logs: <dataDir>/lan-app.log, lan-proxy.log.
// Honors TASKBRIDGE_DATA_DIR so the launcher, the app, and the acceptance
// script all agree on where state lives (a smoke run next to a live server
// keeps the live one untouched).
const DATA = process.env.TASKBRIDGE_DATA_DIR ? path.resolve(process.env.TASKBRIDGE_DATA_DIR) : path.join(ROOT, 'data');
const STATE = path.join(DATA, 'lan.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
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

async function health(port, timeoutMs = 500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch { return false; }
}

// Waits for the public face to answer. The app is polled on its internal port so
// a failure says which process is at fault, not just "nothing works".
async function waitForHealth(port, { timeoutMs = 20000, onFail } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await health(port)) return true;
    if (onFail && onFail()) return false;
    await sleep(250);
  }
  return false;
}

function tail(file, lines = 8) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n'); }
  catch { return ''; }
}

function spawnDetached({ file, args, env, log }) {
  const out = fs.openSync(log, 'a');
  // The child gets its own copy of the descriptor; keeping ours open makes the
  // exit path trip a libuv assertion on Windows.
  try {
    const child = spawn(file, args, { cwd: ROOT, detached: true, windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', out, out] });
    child.unref();
    return child;
  } finally {
    fs.closeSync(out);
  }
}

async function start() {
  const existing = readState();
  if (existing && alive(existing.appPid) && alive(existing.proxyPid)) {
    console.log(`[lan] already running: app ${existing.appPid}, proxy ${existing.proxyPid}`);
    console.log(`[lan] http://127.0.0.1:${existing.publicPort}`);
    return 0;
  }

  const config = await loadConfig(ROOT);
  // LAN_PORT is how a smoke run stands next to a live server instead of fighting
  // it for the configured port.
  const publicPort = Number(process.env.LAN_PORT || config.server?.port || 8787);
  const internalPort = await freePort();
  const appLog = path.join(DATA, 'lan-app.log');
  const proxyLog = path.join(DATA, 'lan-proxy.log');
  fs.mkdirSync(DATA, { recursive: true });

  // The app: full TaskBridge, loopback only, TLS left to the proxy, and told the
  // public port so the links it prints (and /api/info) point at the proxy.
  const app = spawnDetached({
    file: process.execPath,
    args: ['src/server.mjs'],
    log: appLog,
    env: {
      TASKBRIDGE_BIND_HOST: '127.0.0.1',
      TASKBRIDGE_PORT: String(internalPort),
      TASKBRIDGE_PUBLIC_PORT: String(publicPort),
      TASKBRIDGE_DISABLE_TLS: '1',
    },
  });

  const appUp = await waitForHealth(internalPort, { onFail: () => app.exitCode !== null });
  if (!appUp) {
    killTree(app.pid);
    console.error('[lan] the app did not come up. Its log says:');
    console.error(tail(appLog, 12) || '  (empty)');
    if (app.exitCode !== null) console.error('[lan] is another TaskBridge already running on this data directory?');
    return 1;
  }

  const proxy = spawnDetached({
    file: process.execPath,
    args: ['src/proxy.mjs'],
    log: proxyLog,
    env: { LAN_INTERNAL_PORT: String(internalPort), LAN_PORT: String(publicPort) },
  });

  const proxyUp = await waitForHealth(publicPort, { onFail: () => proxy.exitCode !== null });
  if (!proxyUp) {
    killTree(proxy.pid);
    killTree(app.pid);
    console.error('[lan] the proxy did not come up. Its log says:');
    console.error(tail(proxyLog, 12) || '  (empty)');
    return 1;
  }

  fs.writeFileSync(STATE, JSON.stringify({
    appPid: app.pid, proxyPid: proxy.pid, internalPort, publicPort,
    startedAt: new Date().toISOString(),
  }, null, 2));

  console.log(`[lan] app   ${app.pid}  -> 127.0.0.1:${internalPort}  (the only door: loopback)`);
  console.log(`[lan] proxy ${proxy.pid} -> 0.0.0.0:${publicPort}       (this is what the phone opens)`);
  console.log(`[lan] http://127.0.0.1:${publicPort}`);
  console.log(`[lan] pids in ${DATA}/lan.json, logs ${DATA}/lan-*.log`);
  return 0;
}

// Foreground mode: what `npm start` and start.cmd have always felt like — the
// app's log stays on this terminal — with the proxy alongside it. Ctrl+C reaches
// both (same console), the proxy goes first, and the exit code is the app's.
async function runForeground() {
  const config = await loadConfig(ROOT);
  const publicPort = Number(process.env.LAN_PORT || config.server?.port || 8787);
  const internalPort = await freePort();
  fs.mkdirSync(DATA, { recursive: true });

  const app = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      TASKBRIDGE_BIND_HOST: '127.0.0.1',
      TASKBRIDGE_PORT: String(internalPort),
      TASKBRIDGE_PUBLIC_PORT: String(publicPort),
      TASKBRIDGE_DISABLE_TLS: '1',
    },
  });

  const appUp = await waitForHealth(internalPort, { timeoutMs: 30000, onFail: () => app.exitCode !== null });
  if (!appUp) {
    killTree(app.pid);
    console.error('[lan] the app did not come up — see its output above.');
    return 1;
  }

  const proxy = spawnDetached({
    file: process.execPath,
    args: ['src/proxy.mjs'],
    log: path.join(DATA, 'lan-proxy.log'),
    env: { LAN_INTERNAL_PORT: String(internalPort), LAN_PORT: String(publicPort) },
  });
  const proxyUp = await waitForHealth(publicPort, { onFail: () => proxy.exitCode !== null });
  if (!proxyUp) {
    killTree(proxy.pid);
    killTree(app.pid);
    console.error('[lan] the proxy did not come up. Its log says:');
    console.error(tail(path.join(DATA, 'lan-proxy.log'), 12) || '  (empty)');
    return 1;
  }

  fs.writeFileSync(STATE, JSON.stringify({
    appPid: app.pid, proxyPid: proxy.pid, internalPort, publicPort,
    startedAt: new Date().toISOString(),
  }, null, 2));

  console.log(`[lan] app ${app.pid} on 127.0.0.1:${internalPort} (loopback only)`);
  console.log(`[lan] proxy ${proxy.pid} on 0.0.0.0:${publicPort} — this is what the phone opens`);
  console.log(`[lan] http://127.0.0.1:${publicPort} · Ctrl+C stops both\n`);

  // The app owns the agent: when it is gone, the LAN face must not outlive it.
  const code = await new Promise((resolve) => app.on('close', (value) => resolve(value ?? 0)));
  killTree(proxy.pid);
  try { fs.unlinkSync(STATE); } catch { /* already gone */ }
  console.log('[lan] stopped');
  return code;
}

async function status() {
  const state = readState();
  if (!state) {
    console.log('[lan] not running (no lan.json)');
    return 1;
  }
  const appUp = alive(state.appPid);
  const proxyUp = alive(state.proxyPid);
  const answers = await health(state.publicPort);
  console.log(`[lan] app   ${state.appPid} ${appUp ? 'up' : 'DOWN'} (127.0.0.1:${state.internalPort})`);
  console.log(`[lan] proxy ${state.proxyPid} ${proxyUp ? 'up' : 'DOWN'} (0.0.0.0:${state.publicPort})`);
  console.log(`[lan] public face ${answers ? 'answers' : 'does NOT answer'}`);
  return appUp && proxyUp && answers ? 0 : 1;
}

function stop() {
  const state = readState();
  if (!state) {
    console.log('[lan] not running');
    return 0;
  }
  // Proxy first: while it still forwards, the app would answer a request that is
  // about to be cut off.
  killTree(state.proxyPid);
  killTree(state.appPid);
  try { fs.unlinkSync(STATE); } catch { /* already gone */ }
  console.log(`[lan] stopped (app ${state.appPid}, proxy ${state.proxyPid})`);
  return 0;
}

const command = (process.argv[2] || 'run').toLowerCase();
const handler = { run: runForeground, start, status, stop }[command];
if (!handler) {
  console.error(`[lan] unknown command: ${command} (run | start | status | stop)`);
  process.exit(2);
}
/* exitCode, not exit(): exiting while a detached child handle is still closing
   trips a libuv assertion on Windows (UV_HANDLE_CLOSING). */
process.exitCode = await handler();
