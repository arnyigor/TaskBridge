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
import { isTaskBridgeProcess } from '../src/instance-lock.mjs';
import { freeTaskBridgePort, portProblemText } from '../src/lan-ports.mjs';

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

const serverAlive = pid => isTaskBridgeProcess(pid, 'server.mjs');
const proxyAlive = pid => isTaskBridgeProcess(pid, 'proxy.mjs');

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
}

const readJsonSafe = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

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

// A pair state file can be missing while its proxy still owns the public port
// (2026-11-18: the user's lan.json was gone, an elevated proxy answered 502 on
// 8787, and start/stop both lied about it). Reclaim the port by identity before
// launching anything, so the new proxy never races a leftover one.
async function reclaimPublicPort(port) {
  const result = await freeTaskBridgePort(port, { isOurs: (pid) => proxyAlive(pid) });
  if (result.status === 'free') return true;
  if (result.status === 'freed') {
    console.warn(`[lan] freed stale TaskBridge proxy PID ${result.ours.join(', ')} on port ${port}`);
    return true;
  }
  console.error(`[lan] ${portProblemText(port, result)}`);
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

// The lock is authoritative for the app process. lan.json is a recoverable
// description of the pair; an interrupted restart may leave it one generation
// behind, which must never hide the live lock holder.
function readLock() {
  try {
    const holder = JSON.parse(fs.readFileSync(path.join(DATA, 'taskbridge.lock'), 'utf8'));
    return Number.isSafeInteger(holder?.pid) && holder.pid > 0 ? holder : null;
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

async function launchProxy(internalPort, publicPort, lanHost, label = 'start-lan proxy') {
  const readyFile = path.join(DATA, `lan-proxy-ready-${randomUUID()}`);
  const proxyLog = path.join(DATA, 'lan-proxy.log');
  const proxyMarker = markLog(proxyLog, label);
  const proxy = spawnDetached({
    file: process.execPath,
    args: ['src/proxy.mjs'],
    log: proxyLog,
    env: { LAN_INTERNAL_PORT: String(internalPort), LAN_PORT: String(publicPort), LAN_READY_FILE: readyFile },
  });
  const proxyUp = await waitForProxy(proxy, readyFile, publicPort, lanHost);
  try { fs.unlinkSync(readyFile); } catch { /* proxy failed before binding */ }
  const config = await loadConfig(ROOT);
  const tailscale = config.server?.tailscale;
  const servePort = tailscale?.enabled === true && config.server?.auth?.enabled === true
    ? Number(tailscale.servePort ?? 8788) : null;
  if (proxyUp && proxy.exitCode === null) {
    if (servePort !== null) {
      const serveStarted = tailSince(proxyLog, proxyMarker).includes(`[proxy] Serve ingress http://127.0.0.1:${servePort} ->`);
      if (serveStarted) console.log(`[lan] private HTTPS: point Tailscale Serve at 127.0.0.1:${servePort} (never at ${publicPort})`);
      else console.warn('[lan] Serve ingress unavailable; LAN remains running. See lan-proxy.log.');
    }
    return proxy;
  }
  killTree(proxy.pid);
  console.error('[lan] the proxy did not come up. Its log says:');
  console.error(meaningfulTail(tailSince(proxyLog, proxyMarker)) || '  (empty)');
  return null;
}

/**
 * Reconcile the authoritative instance lock with the recoverable pair state.
 * Returns null when no TaskBridge process exists and a fresh launch may proceed.
 */
async function reconcileExisting() {
  const existing = readState();
  const lock = readLock();
  if (existing && serverAlive(existing.appPid) && proxyAlive(existing.proxyPid)
      && (!lock || lock.pid === existing.appPid)
      && await health(existing.internalPort) && await health(existing.publicPort)) {
    console.log(`[lan] already running: app ${existing.appPid}, proxy ${existing.proxyPid}`);
    console.log(`[lan] http://127.0.0.1:${existing.publicPort}`);
    ensureSupervisor();
    return 0;
  }

  if (lock && serverAlive(lock.pid)) {
    if (lock.mode !== 'lan' || !Number.isSafeInteger(lock.internalPort) || !Number.isSafeInteger(lock.publicPort)
        || !await health(lock.internalPort)) {
      console.error(`[lan] TaskBridge PID ${lock.pid} owns ${DATA}, but it has no recoverable LAN metadata. Stop it once, then start again.`);
      return 1;
    }
    if (existing?.proxyPid && proxyAlive(existing.proxyPid)) killTree(existing.proxyPid);
    if (!(await reclaimPublicPort(lock.publicPort))) return 1;
    const config = await loadConfig(ROOT);
    const lanHost = proxyHost(config);
    const proxy = await launchProxy(lock.internalPort, lock.publicPort, lanHost, 'start-lan proxy (recovery)');
    if (!proxy) return 1;
    fs.writeFileSync(STATE, JSON.stringify({
      appPid: lock.pid, proxyPid: proxy.pid, internalPort: lock.internalPort, publicPort: lock.publicPort,
      startedAt: lock.startedAt || new Date().toISOString(),
    }, null, 2));
    console.log(`[lan] recovered pair: app ${lock.pid}, proxy ${proxy.pid}`);
    console.log(`[lan] http://127.0.0.1:${lock.publicPort}`);
    ensureSupervisor();
    return 0;
  }

  // No lock holder exists. Only exact TaskBridge entrypoints may be cleaned:
  // stale/reused PIDs in lan.json are never touched.
  if (existing?.proxyPid && proxyAlive(existing.proxyPid)) killTree(existing.proxyPid);
  if (existing?.appPid && serverAlive(existing.appPid)) killTree(existing.appPid);
  try { fs.unlinkSync(STATE); } catch { /* absent */ }
  return null;
}


function ensureSupervisor() {
  // После reconcile (жилая пара/восстановление) супервизор тоже нужен:
  // без него молчаливая смерть app-сервера снова оставит телефон без связи.
  try {
    const supervisor = spawnDetached({
      file: process.execPath,
      args: ['scripts/lan-supervisor.mjs'],
      log: path.join(DATA, 'lan-supervisor.log'),
    });
    console.log(`[lan] supervisor ${supervisor.pid} (data/lan-supervisor.log)`);
    return supervisor;
  } catch (error) {
    console.warn(`[lan] supervisor not started: ${error?.message || error}`);
    return null;
  }
}

async function start() {
  const reconciled = await reconcileExisting();
  if (reconciled !== null) return reconciled;

  // Частично сломанная прежняя пара: reconcile не смог (например, app мёртв,
  // а proxy жив). Старт не вправе оставлять её процессы рядом с новыми —
  // именно так накапливались orphan-серверы (2026-11-19/20: 7 лишних
  // server.mjs и 2 proxy/supervisor после серии неудачных рестартов).
  // Убивается только ПРОВЕРЕННЫЙ наш процесс, не отвечающий health-ом.
  const stale = readState();
  if (stale) {
    if (stale.appPid && isTaskBridgeProcess(stale.appPid, 'server.mjs') && !(await health(stale.internalPort))) {
      killTree(stale.appPid);
      console.log(`[lan] остановлен сломанный app-сервер ${stale.appPid} из прежней пары`);
    }
    if (stale.proxyPid && isTaskBridgeProcess(stale.proxyPid, 'proxy.mjs') && !(await health(stale.publicPort))) {
      killTree(stale.proxyPid);
      console.log(`[lan] остановлен сломанный proxy ${stale.proxyPid} из прежней пары`);
    }
    try { fs.unlinkSync(STATE); } catch { /* gone */ }
  }

  // Единый владелец жизненного цикла: независимый параллельный старт
  // отклоняется, а дочерний старт самого рестарт-воркера — авторизован:
  // restart-lan-now держит замок весь цикл и сам вызывает start; отказ ребёнку
  // означал бы «stop выполнен, пара не поднята» (дедлок, ревью 2026-11-20).
  // Владение доказывается токеном: рестарт-воркер кладёт свой pid в env,
  // дети наследуют его, и замок подтверждается совпадением.
  const activeRestart = readJsonSafe(path.join(DATA, 'lan-restart.lock'));
  const ownerPid = Number(process.env.TASKBRIDGE_LIFECYCLE_OWNER || 0);
  const ownerAuthorized = ownerPid > 0 && activeRestart?.pid === ownerPid
    && isTaskBridgeProcess(activeRestart.pid, 'restart-lan-now.mjs');
  if (activeRestart?.pid && !ownerAuthorized) {
    console.error('[lan] restart already in progress — пропускаю старт, попробуйте позже.');
    return 1;
  }
  const lockFile = path.join(DATA, 'lan-restart.lock');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    return await startPair();
  } finally {
    try { fs.unlinkSync(lockFile); } catch { /* gone */ }
  }
}

async function startPair() {

  // P0 изоляция (инцидент 2026-11-20): тестовый экземпляр с собственным
  // каталогом данных не имеет права занимать боевой порт из config — укажите
  // LAN_PORT. Без этого проверка песочница молча забирала 8787.
  const dataDirOverride = process.env.TASKBRIDGE_DATA_DIR
    && path.resolve(process.env.TASKBRIDGE_DATA_DIR) !== path.join(ROOT, 'data');
  if (dataDirOverride && !process.env.LAN_PORT) {
    console.error('[lan] изолированный каталог данных (TASKBRIDGE_DATA_DIR) требует LAN_PORT: ' +
      'тестовый экземпляр не может занимать боевой порт.');
    return 1;
  }

  const config = await loadConfig(ROOT);
  // LAN_PORT is how a smoke run stands next to a live server instead of fighting
  // it for the configured port.
  const publicPort = Number(process.env.LAN_PORT || config.server?.port || 8787);
  const lanHost = proxyHost(config);
  const internalPort = await freePort();
  const appLog = path.join(DATA, 'lan-app.log');
  fs.mkdirSync(DATA, { recursive: true });
  if (!(await reclaimPublicPort(publicPort))) return 1;

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
      const lockPid = readLock()?.pid;
      console.error(lockPid
        ? `[lan] каталог данных ${DATA} занят другим экземпляром TaskBridge (PID ${lockPid}) — остановите его и повторите. ` +
          'Если этот процесс уже не работает, запустите ещё раз: блокировка от мёртвого процесса перехватывается.'
        : '[lan] is another TaskBridge already running on this data directory?');
    }
    return 1;
  }

  const proxy = await launchProxy(internalPort, publicPort, lanHost);
  if (!proxy) {
    killTree(app.pid);
    return 1;
  }

  fs.writeFileSync(STATE, JSON.stringify({
    appPid: app.pid, proxyPid: proxy.pid, internalPort, publicPort,
    startedAt: new Date().toISOString(),
  }, null, 2));

  console.log(`[lan] app   ${app.pid}  -> 127.0.0.1:${internalPort}  (the only door: loopback)`);
  console.log(`[lan] proxy ${proxy.pid} -> ${lanHost}:${publicPort}       (${lanHost === '127.0.0.1' ? 'LAN closed: server.auth.enabled is false' : 'this is what the phone opens'})`);
  console.log(`[lan] http://127.0.0.1:${publicPort}`);
  // Авария 2026-11-19: detached-пара жила без присмотра — молчаливая смерть
  // app-сервера оставляла прокси указывать на мёртвый upstream ~40 минут.
  // Супервизор рестартирует пару по стандартному жизненному циклу.
  ensureSupervisor();
  console.log(`[lan] pids in ${DATA}/lan.json, logs ${DATA}/lan-*.log`);
  return 0;
}

// Foreground mode: when no pair is running, the app's log stays on this
// terminal. Ctrl+C reaches both (same console); the proxy goes first.
// When a healthy pair already exists, report it instead of starting a rival.
async function runForeground() {
  const reconciled = await reconcileExisting();
  if (reconciled !== null) return reconciled;
  const config = await loadConfig(ROOT);
  const publicPort = Number(process.env.LAN_PORT || config.server?.port || 8787);
  const lanHost = proxyHost(config);
  const internalPort = await freePort();
  fs.mkdirSync(DATA, { recursive: true });
  if (!(await reclaimPublicPort(publicPort))) return 1;

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

  const proxy = await launchProxy(internalPort, publicPort, lanHost, 'start-lan proxy (foreground)');
  if (!proxy) {
    killTree(app.pid);
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
  const lock = readLock();
  if (!state) {
    if (lock && serverAlive(lock.pid)) {
      console.log(`[lan] app ${lock.pid} is up, pair state is missing`);
      return 1;
    }
    console.log('[lan] not running (no lan.json)');
    return 1;
  }
  const appUp = serverAlive(state.appPid);
  const proxyUp = proxyAlive(state.proxyPid);
  const answers = await health(state.publicPort);
  const authoritative = !lock || lock.pid === state.appPid;
  console.log(`[lan] app   ${state.appPid} ${appUp ? 'up' : 'DOWN'} (127.0.0.1:${state.internalPort})`);
  console.log(`[lan] proxy ${state.proxyPid} ${proxyUp ? 'up' : 'DOWN'} (port ${state.publicPort})`);
  console.log(`[lan] public face ${answers ? 'answers' : 'does NOT answer'}`);
  if (!authoritative) console.log(`[lan] state is stale: data lock belongs to app ${lock.pid}`);
  return appUp && proxyUp && answers && authoritative ? 0 : 1;
}

async function stop() {
  const state = readState();
  const lock = readLock();
  const stopped = [];
  // Супервизор не должен рестартить пару, которую остановили руками: убивается
  // первым, его pid-файл чистится, чтобы новый старт породил нового.
  const supervisor = readJsonSafe(path.join(DATA, 'lan-supervisor.json'));
  // Рестарт, инициированный супервизором, не убивает смотрящего: новая пара
  // порождает замену, старый уходит по «replaced by a newer supervisor».
  const ownRestart = Number(process.env.TASKBRIDGE_LIFECYCLE_SUPERVISOR || 0) > 0
    && supervisor?.pid === Number(process.env.TASKBRIDGE_LIFECYCLE_SUPERVISOR);
  if (supervisor?.pid && !ownRestart) {
    killTree(supervisor.pid);
    stopped.push(`supervisor ${supervisor.pid}`);
    try { fs.unlinkSync(path.join(DATA, 'lan-supervisor.json')); } catch { /* gone */ }
  } else if (ownRestart) {
    stopped.push(`supervisor ${supervisor?.pid} (handed over)`);
  }
  if (state?.proxyPid && proxyAlive(state.proxyPid)) { killTree(state.proxyPid); stopped.push(`proxy ${state.proxyPid}`); }
  if (lock?.pid && serverAlive(lock.pid)) { killTree(lock.pid); stopped.push(`app ${lock.pid}`); }
  if (state?.appPid && state.appPid !== lock?.pid && serverAlive(state.appPid)) {
    killTree(state.appPid);
    stopped.push(`stale app ${state.appPid}`);
  }

  // The state file is not proof the port is free: a proxy that outlived its app,
  // or one whose command line is unreadable (elevated), is not in `state` at all.
  // Removing lan.json in that situation is how a later start lost the port and
  // looped on EADDRINUSE. Keep the file unless the port is verified free.
  const config = await loadConfig(ROOT).catch(() => ({}));
  const port = Number(process.env.LAN_PORT || state?.publicPort || config.server?.port || 8787);
  const result = await freeTaskBridgePort(port, { isOurs: (pid) => proxyAlive(pid) });
  if (result.ours.length) stopped.push(`proxy ${result.ours.join(', ')}`);
  if (result.status === 'failed') {
    console.error(`[lan] ${portProblemText(port, result)}`);
    console.error('[lan] состояние пары сохранено — следующий запуск увидит тот же порт');
    return 1;
  }
  if (result.status === 'blocked') console.warn(`[lan] ${portProblemText(port, result)}`);

  try { fs.unlinkSync(STATE); } catch { /* already gone */ }
  console.log(stopped.length ? `[lan] stopped (${stopped.join(', ')})` : '[lan] not running');
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
