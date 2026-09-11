#!/usr/bin/env node
// taskbridge — command-line front door for a running TaskBridge (monolith or
// the split host+gateway). This is intentionally a thin admin/client CLI: it
// talks to the server over its HTTP API and never spawns its own Pi.
//
// Default (`taskbridge start`) runs the legacy monolith (src/server.mjs).
// `taskbridge start --split` runs host + gateway as separate background
// processes (scripts/start-split.mjs) and keeps the agent in the host, so a
// gateway restart does not kill it. status / stop / open detect whichever
// mode is actually running.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function nowISO() { return new Date().toISOString(); }
function log(msg) { console.log(`[taskbridge ${nowISO()}] ${msg}`); }

// --- process / lock / split helpers ----------------------------------------

function dataRoot() {
  return process.env.TASKBRIDGE_DATA_DIR ? path.resolve(process.env.TASKBRIDGE_DATA_DIR) : path.join(ROOT_DIR, 'data');
}
function lockFile() { return path.join(dataRoot(), 'taskbridge.lock'); }
function splitFile() { return path.join(dataRoot(), 'split.json'); }

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

function runningSplit() {
  try {
    const s = JSON.parse(fs.readFileSync(splitFile(), 'utf8'));
    if (!s || !Number.isSafeInteger(s.hostPid) || !Number.isSafeInteger(s.gatewayPid)) return null;
    if (!alive(s.hostPid) || !alive(s.gatewayPid)) return null;
    return s;
  } catch { return null; }
}
function wantsSplit() { return process.argv.slice(2).includes('--split'); }

function effectiveUrl(config) {
  const split = runningSplit();
  const port = split ? split.gatewayPort : (config.server?.port ?? 8787);
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
  const split = runningSplit();
  const lock = runningLock();
  if (split && lock) {
    console.log(`TaskBridge: running in split mode`);
    console.log(`  host (agent):   PID ${split.hostPid}`);
    console.log(`  gateway (UI):   PID ${split.gatewayPid}`);
    console.log(`  URL:            ${effectiveUrl(config)}`);
    console.log(`  IPC:            127.0.0.1:${split.hostPort}`);
    console.log(`  data:           ${dataRoot()}`);
  } else if (lock) {
    console.log(`TaskBridge: running (monolith, PID ${lock.pid})`);
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
    const split = runningSplit();
    console.log(`  data dir:    ${dataRoot()} (present${lock ? `, locked by PID ${lock.pid}` : ', not locked'}${split ? ', split running' : ''})`);
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

async function startSplit(timeoutMs = 20000) {
  if (runningSplit()) {
    log(`split already running (host ${runningSplit().hostPid}, gateway ${runningSplit().gatewayPid})`);
    return true;
  }
  const child = spawn(process.execPath, ['scripts/start-split.mjs'], {
    cwd: ROOT_DIR,
    env: { ...process.env, TASKBRIDGE_DATA_DIR: dataRoot() },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  log('starting split (host + gateway) …');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runningSplit()) { return await portReady(effectiveUrl(await loadConfig(ROOT_DIR))); }
    await new Promise((r) => setTimeout(r, 300));
  }
  log('split did not become ready in time');
  return false;
}

async function startServer(config, timeoutMs = 15000) {
  if (runningLock() && !runningSplit()) {
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
  const split = runningSplit();
  if (split) {
    log(`stopping split: host PID ${split.hostPid}, gateway PID ${split.gatewayPid}`);
    for (const pid of [split.gatewayPid, split.hostPid]) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && (alive(split.hostPid) || alive(split.gatewayPid))) {
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const pid of [split.gatewayPid, split.hostPid]) {
      if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} log(`PID ${pid} forced (SIGKILL)`); }
    }
    try { fs.rmSync(splitFile(), { force: true }); } catch {}
    log('split stopped');
    return;
  }
  const holder = runningLock();
  if (!holder) { log('no running server to stop'); return; }
  log(`stopping server PID ${holder.pid}`);
  try { process.kill(holder.pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive(holder.pid)) await new Promise((r) => setTimeout(r, 200));
  if (alive(holder.pid)) { try { process.kill(holder.pid, 'SIGKILL'); } catch {} log('forced (SIGKILL)'); }
  else log('stopped');
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

  if (!runningSplit() && !runningLock()) {
    log('server not running — starting it');
    const ok = wantsSplit() ? await startSplit() : await startServer(config);
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

usage: taskbridge <command> [--split] [path]

commands:
  open [path]   open the latest session for the current dir (or path) in the
                browser; starts a server if none is running
  status        is it running? (monolith or split host+gateway)
  doctor        check config, data dir and lock state
  start [--split] start the server (split = host + gateway background procs)
  stop          stop whatever is running (split or monolith)
  help          show this help
`;

const command = process.argv[2];
const arg = process.argv.find((a) => a !== '--split' && !a.startsWith('-') && a !== command);

if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

const config = await loadConfig(ROOT_DIR);

switch (command) {
  case 'open': await cmdOpen(config, arg); break;
  case 'status': await cmdStatus(config); break;
  case 'doctor': process.exit(await cmdDoctor(config)); break;
  case 'start': {
    const ok = wantsSplit() ? await startSplit() : await startServer(config);
    process.exit(ok ? 0 : 1);
    break;
  }
  case 'stop': await stopServer(); break;
  default:
    console.error(`unknown command: ${command}`);
    console.log(USAGE);
    process.exit(2);
}
