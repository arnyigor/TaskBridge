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
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lanAllowed } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';

// Where the proxy really listens (R1.1): without auth it stays on loopback.
const proxyHost = config => {
  const host = process.env.LAN_HOST || config.server?.host || '0.0.0.0';
  return lanAllowed(host, config.server?.auth) ? host : '127.0.0.1';
};

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

async function health(port, timeoutMs = 500, host = '127.0.0.1') {
  try {
    const address = host === '0.0.0.0' ? '127.0.0.1' : host;
    const response = await fetch(`http://${address.includes(':') ? `[${address}]` : address}:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch { return false; }
}

// Waits for the public face to answer. The app is polled on its internal port so
// a failure says which process is at fault, not just "nothing works".
async function waitForProxy(proxy, readyFile, port, host) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && proxy.exitCode === null) {
    try {
      if (fs.readFileSync(readyFile, 'utf8') === String(proxy.pid) && await health(port, 500, host)) return true;
    } catch { /* proxy has not bound yet */ }
    await sleep(250);
  }
  return false;
}

async function waitForHealth(port, { timeoutMs = 20000, onFail } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await health(port)) return true;
    if (onFail && onFail()) return false;
    await sleep(250);
  }
  return false;
}

// How long the app gets to answer /api/health. Measured 2026-10-05 on the real data
// directory: 22.4 s (a fresh empty one boots in a couple of seconds). The old 20 s
// budget killed a healthy server mid-boot, so the button reported «the app did not
// come up» while CTRL+C-free `run` (30 s) started the very same build.
const APP_START_TIMEOUT_MS = Number(process.env.LAN_APP_TIMEOUT_MS) || 60000;

// Both log files are opened for append, so a tail shows the history of every earlier
// run — on 2026-10-05 that produced a diagnosis about an instance lock that belonged
// to a run from an hour before. A marker before each launch makes the tail this run's.
function markLog(file, text) {
  const marker = `=== ${text} ${new Date().toISOString()} ===`;
  try { fs.appendFileSync(file, `\n${marker}\n`); } catch { /* the tail will just show history */ }
  return marker;
}

/** Tail of a log after its last marker — what this run's child actually wrote. */
function tailSince(file, marker, lines = 12) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const index = text.lastIndexOf(marker);
    return text.slice(index >= 0 ? index + marker.length : 0);
  } catch { return ''; }
}

// The child processes log Node warnings (DEP0190 from spawn with shell: true) that would
// fill the whole tail and hide the reason — e.g. an instance-lock refusal from
// src/server.mjs (2026-10-05: the operator saw three DeprecationWarnings and no cause).
const NODE_NOISE = /DeprecationWarning|--trace-deprecation|ExperimentalWarning/;
function meaningfulTail(text, lines = 12) {
  const kept = String(text || '').split('\n').filter(line => !NODE_NOISE.test(line) && line.trim() !== '');
  return kept.slice(-lines).join('\n');
}

// Who holds the data directory: the lock is written by src/server.mjs, and a live holder
// without lan.json is a leftover (an interrupted run) that the state file cannot show.
function readLockPid() {
  try {
    const holder = JSON.parse(fs.readFileSync(path.join(DATA, 'taskbridge.lock'), 'utf8'));
    return Number.isSafeInteger(holder?.pid) ? holder.pid : null;
  } catch { return null; }
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
  if (existing && alive(existing.appPid) && alive(existing.proxyPid)
      && await health(existing.internalPort) && await health(existing.publicPort)) {
    console.log(`[lan] already running: app ${existing.appPid}, proxy ${existing.proxyPid}`);
    console.log(`[lan] http://127.0.0.1:${existing.publicPort}`);
    return 0;
  }
  // A half-dead pair may still own the port or data lock. Do not kill PIDs from
  // stale state: the OS may have reused them for unrelated processes.
  if (existing && (alive(existing.appPid) || alive(existing.proxyPid))) {
    console.error(`[lan] incomplete pair in ${STATE} (app ${existing.appPid}, proxy ${existing.proxyPid}). Inspect the processes before restarting.`);
    return 1;
  }

  const config = await loadConfig(ROOT);
  // LAN_PORT is how a smoke run stands next to a live server instead of fighting
  // it for the configured port.
  const publicPort = Number(process.env.LAN_PORT || config.server?.port || 8787);
  const lanHost = proxyHost(config);
  const internalPort = await freePort();
  const appLog = path.join(DATA, 'lan-app.log');
  const proxyLog = path.join(DATA, 'lan-proxy.log');
  fs.mkdirSync(DATA, { recursive: true });

  // The app: full TaskBridge, loopback only, TLS left to the proxy, and told the
  // public port so the links it prints (and /api/info) point at the proxy.
  const appMarker = markLog(appLog, 'start-lan app');
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

  const appStartedAt = Date.now();
  const appUp = await waitForHealth(internalPort, { timeoutMs: APP_START_TIMEOUT_MS, onFail: () => app.exitCode !== null });
  if (!appUp) {
    killTree(app.pid);
    console.error(`[lan] the app did not come up in ${Math.round((Date.now() - appStartedAt) / 1000)} s. Its log says:`);
    console.error(meaningfulTail(tailSince(appLog, appMarker)) || '  (empty)');
    if (app.exitCode !== null) {
      const lockPid = readLockPid();
      console.error(lockPid
        ? `[lan] каталог данных ${DATA} занят другим экземпляром TaskBridge (PID ${lockPid}) — остановите его и повторите. ` +
          'Если этот процесс уже не работает, запустите ещё раз: блокировка от мёртвого процесса перехватывается.'
        : '[lan] is another TaskBridge already running on this data directory?');
    }
    return 1;
  }

  const readyFile = path.join(DATA, `lan-proxy-ready-${randomUUID()}`);
  const proxyMarker = markLog(proxyLog, 'start-lan proxy');
  const proxy = spawnDetached({
    file: process.execPath,
    args: ['src/proxy.mjs'],
    log: proxyLog,
    env: { LAN_INTERNAL_PORT: String(internalPort), LAN_PORT: String(publicPort), LAN_READY_FILE: readyFile },
  });

  const proxyUp = await waitForProxy(proxy, readyFile, publicPort, lanHost);
  try { fs.unlinkSync(readyFile); } catch { /* proxy failed before binding */ }
  if (!proxyUp || proxy.exitCode !== null) {
    killTree(proxy.pid);
    killTree(app.pid);
    console.error('[lan] the proxy did not come up. Its log says:');
    console.error(meaningfulTail(tailSince(proxyLog, proxyMarker)) || '  (empty)');
    return 1;
  }

  fs.writeFileSync(STATE, JSON.stringify({
    appPid: app.pid, proxyPid: proxy.pid, internalPort, publicPort,
    startedAt: new Date().toISOString(),
  }, null, 2));

  console.log(`[lan] app   ${app.pid}  -> 127.0.0.1:${internalPort}  (the only door: loopback)`);
  console.log(`[lan] proxy ${proxy.pid} -> ${lanHost}:${publicPort}       (${lanHost === '127.0.0.1' ? 'LAN closed: server.auth.enabled is false' : 'this is what the phone opens'})`);
  console.log(`[lan] http://127.0.0.1:${publicPort}`);
  console.log(`[lan] pids in ${DATA}/lan.json, logs ${DATA}/lan-*.log`);
  return 0;
}

// Foreground mode: when no pair is running, the app's log stays on this
// terminal. Ctrl+C reaches both (same console); the proxy goes first.
// When a healthy pair already exists, report it instead of starting a rival.
async function runForeground() {
  const existing = readState();
  if (existing && alive(existing.appPid) && alive(existing.proxyPid)
      && await health(existing.internalPort) && await health(existing.publicPort)) {
    console.log(`[lan] already running: app ${existing.appPid}, proxy ${existing.proxyPid}`);
    console.log(`[lan] http://127.0.0.1:${existing.publicPort}`);
    return 0;
  }
  if (existing && (alive(existing.appPid) || alive(existing.proxyPid))) {
    console.error(`[lan] incomplete pair in ${STATE} (app ${existing.appPid}, proxy ${existing.proxyPid}). Inspect the processes before restarting.`);
    return 1;
  }
  const config = await loadConfig(ROOT);
  const publicPort = Number(process.env.LAN_PORT || config.server?.port || 8787);
  const lanHost = proxyHost(config);
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

  const appUp = await waitForHealth(internalPort, { timeoutMs: APP_START_TIMEOUT_MS, onFail: () => app.exitCode !== null });
  if (!appUp) {
    killTree(app.pid);
    console.error('[lan] the app did not come up — see its output above.');
    return 1;
  }

  const readyFile = path.join(DATA, `lan-proxy-ready-${randomUUID()}`);
  const proxyMarker = markLog(path.join(DATA, 'lan-proxy.log'), 'start-lan proxy (foreground)');
  const proxy = spawnDetached({
    file: process.execPath,
    args: ['src/proxy.mjs'],
    log: path.join(DATA, 'lan-proxy.log'),
    env: { LAN_INTERNAL_PORT: String(internalPort), LAN_PORT: String(publicPort), LAN_READY_FILE: readyFile },
  });
  const proxyUp = await waitForProxy(proxy, readyFile, publicPort, lanHost);
  try { fs.unlinkSync(readyFile); } catch { /* proxy failed before binding */ }
  if (!proxyUp || proxy.exitCode !== null) {
    killTree(proxy.pid);
    killTree(app.pid);
    console.error('[lan] the proxy did not come up. Its log says:');
    console.error(meaningfulTail(tailSince(path.join(DATA, 'lan-proxy.log'), proxyMarker)) || '  (empty)');
    return 1;
  }

  fs.writeFileSync(STATE, JSON.stringify({
    appPid: app.pid, proxyPid: proxy.pid, internalPort, publicPort,
    startedAt: new Date().toISOString(),
  }, null, 2));

  console.log(`[lan] app ${app.pid} on 127.0.0.1:${internalPort} (loopback only)`);
  console.log(`[lan] proxy ${proxy.pid} on ${lanHost}:${publicPort} — ${lanHost === '127.0.0.1' ? 'LAN closed: server.auth.enabled is false' : 'this is what the phone opens'}`);
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
  console.log(`[lan] proxy ${state.proxyPid} ${proxyUp ? 'up' : 'DOWN'} (port ${state.publicPort})`);
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
