#!/usr/bin/env node
// taskbridge — command-line front door for a running TaskBridge. This is
// intentionally a thin admin/client CLI: it talks to the server over its HTTP API
// and never spawns its own Pi.
//
// Default (`taskbridge start`) is the LAN mode: the app on loopback plus the proxy
// that owns the LAN face (scripts/start-lan.mjs,
// docs/agent-host-separation.md §12.1), so a restart of the LAN face does not kill
// the agent. `--monolith` keeps the old single-process daemon as an escape hatch.
// status / stop / open detect whichever mode is actually running.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function nowISO() { return new Date().toISOString(); }
function log(msg) { console.log(`[taskbridge ${nowISO()}] ${msg}`); }

// --- process / lock / LAN-mode helpers -------------------------------------

function dataRoot() {
  return process.env.TASKBRIDGE_DATA_DIR ? path.resolve(process.env.TASKBRIDGE_DATA_DIR) : path.join(ROOT_DIR, 'data');
}
function lockFile() { return path.join(dataRoot(), 'taskbridge.lock'); }
function lanFile() { return path.join(dataRoot(), 'lan.json'); }

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function readLock() {
  try {
    const holder = JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
    const pid = Number(holder?.pid);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, startedAt: holder.startedAt } : null;
  } catch { return null; }
}
function runningLock() {
  const b = readLock();
  return b && alive(b.pid) ? b : null;
}

function readLan() {
  try { return JSON.parse(fs.readFileSync(lanFile(), 'utf8')); } catch { return null; }
}
// LAN mode is two processes (app on loopback, proxy on the LAN) recorded in
// data/lan.json. Both must be alive for the mode to count as running.
function runningLan() {
  const s = readLan();
  if (!s || !Number.isSafeInteger(s.appPid) || !Number.isSafeInteger(s.proxyPid)) return null;
  if (!alive(s.appPid) || !alive(s.proxyPid)) return null;
  return s;
}
function wantsMonolith() { return process.argv.slice(2).includes('--monolith'); }

function effectiveUrl(config) {
  const lan = runningLan();
  const port = lan ? lan.publicPort : (config.server?.port ?? 8787);
  return `http://127.0.0.1:${port}`;
}

function openBrowser(url) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

async function portReady(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url + '/')).ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// --- subcommands ------------------------------------------------------------

async function cmdStatus(config) {
  const lan = runningLan();
  const lock = runningLock();
  if (lan) {
    console.log(`TaskBridge: running (LAN mode)`);
    console.log(`  app (agent):  PID ${lan.appPid}   127.0.0.1:${lan.internalPort} (loopback only)`);
    console.log(`  proxy (LAN):  PID ${lan.proxyPid}   0.0.0.0:${lan.publicPort}`);
    console.log(`  URL:          ${effectiveUrl(config)}`);
    console.log(`  data:         ${dataRoot()}`);
  } else if (lock) {
    const half = readLan();
    console.log(`TaskBridge: running (single process, PID ${lock.pid})`);
    if (half) console.log('  note:         data/lan.json exists but its proxy is gone — restart with "taskbridge start"');
    console.log(`  URL:       ${effectiveUrl(config)}`);
    console.log(`  startedAt: ${lock.startedAt ?? 'unknown'}`);
    console.log(`  data:      ${dataRoot()}`);
  } else {
    console.log('TaskBridge: not running');
  }
}

async function cmdDoctor(config) {
  const problems = [];
  const configPath = path.join(ROOT_DIR, 'config.json');
  if (!fs.existsSync(configPath)) problems.push('config.json missing (create it or run: node src/server.mjs to bootstrap)');
  if (!fs.existsSync(dataRoot())) {
    console.log(`  data dir:    ${dataRoot()} (will be created on first start)`);
  } else {
    const lock = runningLock();
    const lan = runningLan();
    console.log(`  data dir:    ${dataRoot()} (present${lock ? `, locked by PID ${lock.pid}` : ', not locked'}${lan ? ', LAN mode running' : ''})`);
  }
  console.log(`  root dir:    ${ROOT_DIR}`);
  console.log(`  config:      ${fs.existsSync(configPath) ? 'present' : 'MISSING'}`);
  console.log(`  server.port: ${config.server?.port ?? 8787}`);
  const holder = readLock();
  if (holder && !alive(holder.pid)) console.log(`  stale lock:  PID ${holder.pid} is gone; will be reused on next start`);
  if (problems.length) for (const p of problems) console.log(`  PROBLEM: ${p}`);
  console.log(problems.length ? 'doctor: issues found' : 'doctor: ok');
  return problems.length ? 1 : 0;
}

async function startLan(config, timeoutMs = 25000) {
  const running = runningLan();
  if (running) {
    log(`LAN mode already running (app ${running.appPid}, proxy ${running.proxyPid})`);
    return true;
  }
  log('starting LAN mode (app on loopback + proxy) …');
  const child = spawn(process.execPath, ['scripts/start-lan.mjs', 'start'], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) return false;
  return await portReady(effectiveUrl(config), timeoutMs);
}

async function startServer(config, timeoutMs = 15000) {
  if (runningLock()) {
    log(`server already running (PID ${runningLock().pid})`);
    return true;
  }
  const logPath = path.join(dataRoot(), 'taskbridge-daemon.log');
  fs.mkdirSync(dataRoot(), { recursive: true });
  const logHandle = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT_DIR, detached: true, stdio: ['ignore', logHandle, logHandle],
  });
  child.unref();
  log(`starting server (PID ${child.pid}) … log: ${logPath}`);
  if (await portReady(effectiveUrl(config), timeoutMs)) { log('server is up'); return true; }
  log('server did not become ready in time (see daemon log)');
  return false;
}

async function stopServer(timeoutMs = 9000) {
  const lan = runningLan();
  if (lan) {
    log(`stopping LAN mode: app PID ${lan.appPid}, proxy PID ${lan.proxyPid}`);
    // The proxy goes first: while it still forwards, the app would answer a
    // request that is about to be cut off.
    const child = spawn(process.execPath, ['scripts/start-lan.mjs', 'stop'], { cwd: ROOT_DIR, stdio: ['ignore', 'inherit', 'inherit'] });
    await new Promise((resolve) => child.on('close', resolve));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && (alive(lan.appPid) || alive(lan.proxyPid))) await new Promise((r) => setTimeout(r, 200));
    for (const pid of [lan.proxyPid, lan.appPid]) {
      if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} log(`PID ${pid} forced (SIGKILL)`); }
    }
    log('stopped');
    return;
  }
  const holder = runningLock();
  if (!holder) { log('no running server to stop'); return; }
  log(`stopping server PID ${holder.pid}`);
  if (process.platform === 'win32') {
    // Windows has no SIGTERM: process.kill() terminates the server outright, so
    // it never runs its shutdown and a busy Pi (plus the pytest/gradle it
    // started) outlives it. Kill the whole tree, as the LAN mode stop does.
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(holder.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('close', resolve);
      killer.on('error', resolve);
    });
  } else {
    try { process.kill(holder.pid, 'SIGTERM'); } catch {}
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive(holder.pid)) await new Promise((r) => setTimeout(r, 200));
  if (alive(holder.pid)) { try { process.kill(holder.pid, 'SIGKILL'); } catch {} log('forced (SIGKILL)'); }
  else log('stopped');
}

// --- local models -----------------------------------------------------------

// The router is a single process holding every preset from models.ini; loading
// is per model, and `--models-max 1` means loading one unloads the previous.
// These are thin wrappers over /api/local/*, i.e. the same calls the
// "Локальные модели" window makes.
async function apiCall(config, pathname, body, timeoutMs = 30 * 60 * 1000) {
  const res = await fetch(effectiveUrl(config) + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep the raw body below */ }
  if (!res.ok) throw new Error(json?.error?.message || json?.message || `${pathname} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

function modelLine(model) {
  const notes = [model.status, model.vision ? 'vision' : null, model.contextWindow ? `ctx ${model.contextWindow}` : null].filter(Boolean);
  return `  ${String(model.id).padEnd(30)} ${notes.join(', ')}`;
}

async function cmdModels(config, action, id) {
  const state = await apiCall(config, '/api/local', undefined, 60000);
  if (!action || action === 'list') {
    console.log(`router: ${state.state}${state.pid ? ` (PID ${state.pid})` : ''}  ${state.baseUrl}`);
    if (!state.models?.length) {
      console.log(state.state === 'STOPPED'
        ? '  роутер остановлен - taskbridge models start'
        : '  моделей нет: проверьте --models-preset в config.json');
      return;
    }
    for (const model of state.models) console.log(modelLine(model));
    if (state.loaded?.length) console.log(`загружено: ${state.loaded.join(', ')}`);
    return;
  }
  if (action === 'stop') {
    await apiCall(config, '/api/local/stop', {});
    console.log('роутер остановлен');
    return;
  }
  if (action === 'start') {
    // start() is a no-op when a router is already listening, so it must NOT be
    // advertised as "re-reads models.ini" — a running router keeps the presets
    // it was started with. reload is the one that actually re-reads the file.
    const next = await apiCall(config, '/api/local/start', {}, 180000);
    console.log(`роутер запущен (PID ${next.pid}), моделей: ${next.models?.length ?? 0}`);
    if (state.state !== 'STOPPED') console.log('роутер уже был поднят — models.ini не перечитан (для этого: taskbridge models reload)');
    return;
  }
  if (action === 'reload') {
    try {
      await apiCall(config, '/api/local/stop', {});
    } catch (error) {
      // The router outlives the TaskBridge process that spawned it, so a server
      // restart leaves it listening but unowned — and stop() refuses to kill a
      // router it did not start. Saying that plainly beats a raw HTTP 500.
      if (/запущен извне/u.test(error.message)) {
        throw new Error('роутер поднят не тем процессом TaskBridge, что отвечает на API (state EXTERNAL_RUNNING) — перезапустите TaskBridge: он прочитает models.ini при старте');
      }
      throw error;
    }
    const next = await apiCall(config, '/api/local/start', {}, 180000);
    // Every restart re-reads models.ini — this is how a new or edited preset
    // becomes visible; a running router keeps the presets it started with.
    console.log(`роутер перезапущен (PID ${next.pid}) — models.ini перечитан, моделей: ${next.models?.length ?? 0}`);
    return;
  }
  if (action === 'load' || action === 'unload') {
    if (!id) throw new Error(`укажите id: taskbridge models ${action} <id>`);
    if (!state.models?.some((model) => model.id === id)) {
      throw new Error(`нет пресета "${id}". Есть: ${(state.models || []).map((model) => model.id).join(', ')}`);
    }
    const started = Date.now();
    log(`${action === 'load' ? 'загружаю' : 'выгружаю'} ${id} (первый раз M64 грузится до ~90 c) …`);
    const result = await apiCall(config, `/api/local/${action}`, { model: id });
    console.log(`${action === 'load' ? 'загружено' : 'выгружено'}: ${result?.id ?? id} за ${((Date.now() - started) / 1000).toFixed(1)} c`);
    return;
  }
  throw new Error(`неизвестное действие "${action}" (list | load | unload | start | stop | reload)`);
}

function projectForPath(config, cwd) {
  const target = path.resolve(cwd);
  const candidates = (config.projects || []).slice().sort((a, b) => (b.path || '').length - (a.path || '').length);
  return candidates.find((p) => {
    const base = path.resolve(p.path || '');
    return target === base || target.startsWith(base + path.sep);
  }) || null;
}

async function cmdOpen(config, arg) {
  const cwd = arg ? path.resolve(arg) : process.cwd();
  const project = projectForPath(config, cwd);
  if (project) log(`project: ${project.name || project.id} (${project.path})`);
  else if (arg) log(`note: '${cwd}' is not under a registered project — opening the task list`);

  if (!runningLan() && !runningLock()) {
    log('server not running — starting it');
    const ok = wantsMonolith() ? await startServer(config) : await startLan(config);
    if (!ok) { console.error('TaskBridge could not be started. Check `taskbridge doctor`.'); process.exit(1); }
  }

  let sessionPath = '/';
  try {
    const res = await fetch(effectiveUrl(config) + '/api/tasks');
    if (res.ok) {
      const list = Array.isArray(await res.json()) ? await res.json() : [];
      const scoped = project ? list.filter((t) => t.projectId === project.id) : list;
      const latest = (scoped.length ? scoped : list)[0];
      if (latest?.id) sessionPath = `/session/${encodeURIComponent(latest.id)}`;
    }
  } catch { /* fall back to root */ }
  const url = effectiveUrl(config) + sessionPath;
  log(`opening ${url}`);
  openBrowser(url);
  console.log(url);
}

// --- argument parsing -------------------------------------------------------

const USAGE = `taskbridge — admin/client CLI for a running TaskBridge server

usage: taskbridge <command> [--monolith] [path]

commands:
  open [path]   open the latest session for the current dir (or path) in the
                browser; starts a server if none is running
  status        is it running? (LAN mode = app + proxy, or a single process)
  doctor        check config, data dir and lock state
  start [--monolith]  start the server (default: LAN mode — the app on loopback
                plus the LAN proxy; --monolith keeps the old daemon)
  stop          stop whatever is running (LAN mode or single process)
  models [list] list llama.cpp router presets (from models.ini) and their status
  models load <id>    load a preset (blocks until ready)
  models unload <id>  unload a preset
  models start  start the router if it is down (a running router is left alone,
                it keeps the presets it was started with)
  models reload stop + start — the way to pick up models.ini edits, since the
                file is read at startup and not re-read live
  models stop   stop the router
  help          show this help
`;

const command = process.argv[2];
const rest = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const arg = rest.find((a) => a !== command);
const subArg = rest.filter((a) => a !== command)[1] ?? null;

if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

const config = await loadConfig(ROOT_DIR);

try {
  switch (command) {
    case 'open': await cmdOpen(config, arg); break;
    case 'status': await cmdStatus(config); break;
    case 'doctor': process.exit(await cmdDoctor(config)); break;
    case 'start': {
      const ok = wantsMonolith() ? await startServer(config) : await startLan(config);
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'stop': await stopServer(); break;
    case 'models': await cmdModels(config, arg, subArg); break;
    default:
      console.error(`unknown command: ${command}`);
      console.log(USAGE);
      process.exit(2);
  }
} catch (error) {
  // A raw unhandled rejection prints a stack trace. And process.exit() with an
  // in-flight fetch handle trips a libuv assertion on Windows, so the code is
  // only recorded here and the loop is left to drain on its own.
  console.error(`taskbridge: ${error.message ?? error}`);
  process.exitCode = 2;
}
