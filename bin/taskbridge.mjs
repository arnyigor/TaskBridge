#!/usr/bin/env node
// taskbridge — command-line front door for an already-running TaskBridge
// server (or for starting one). This is intentionally a thin admin/client
// CLI: it talks to the server over its HTTP API and never spawns its own Pi.
//
// The interesting agent logic stays in the server process. This file only
// knows how to find the server, report on it, open the right session in the
// browser, and start/stop the detached server process.
//
// Step 5a. The heavier AgentHost separation (5c) later moves the actual Pi
// ownership into a background process; this CLI keeps working unchanged.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';

// The repo root is the parent of this bin/ directory, wherever the CLI was
// invoked from (npm link, global install, or `node bin/taskbridge.mjs`).
const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function nowISO() { return new Date().toISOString(); }
function log(msg) { console.log(`[taskbridge ${nowISO()}] ${msg}`); }

// --- process / lock helpers ------------------------------------------------

function dataRoot() { return path.join(ROOT_DIR, 'data'); }
function lockFile() { return path.join(dataRoot(), 'taskbridge.lock'); }

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// Returns { pid, startedAt, path } or null when no live holder is recorded.
function readLock() {
  try {
    const holder = JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
    const pid = Number(holder?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    return { pid, startedAt: holder.startedAt, file: lockFile() };
  } catch { return null; }
}

function runningLock() {
  const holder = readLock();
  return holder && alive(holder.pid) ? holder : null;
}

function baseUrl(config) {
  const port = config.server?.port ?? 8787;
  // Browser-facing host is loopback even though the server may bind 0.0.0.0.
  return `http://127.0.0.1:${port}`;
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function portReady(config, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl(config) + '/');
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

// --- subcommands ------------------------------------------------------------

async function cmdStatus(config) {
  const holder = runningLock();
  if (holder) {
    console.log(`TaskBridge: running (PID ${holder.pid})`);
    console.log(`  URL:       ${baseUrl(config)}`);
    console.log(`  startedAt: ${holder.startedAt ?? 'unknown'}`);
    console.log(`  data:      ${dataRoot()}`);
  } else {
    console.log('TaskBridge: not running');
  }
}

async function cmdDoctor(config) {
  const problems = [];
  const configPath = path.join(ROOT_DIR, 'config.json');
  if (!fs.existsSync(configPath)) {
    problems.push(`config.json missing (create it or run: node src/server.mjs to bootstrap)`);
  }
  if (!fs.existsSync(dataRoot())) {
    // Not strictly an error: created on first start. Report as info.
    console.log(`  data dir:    ${dataRoot()} (will be created on first start)`);
  } else {
    const lock = runningLock();
    console.log(`  data dir:    ${dataRoot()} (present${lock ? `, locked by PID ${lock.pid}` : ', not locked'})`);
  }
  console.log(`  root dir:    ${ROOT_DIR}`);
  console.log(`  config:      ${fs.existsSync(configPath) ? 'present' : 'MISSING'}`);
  console.log(`  server.port: ${config.server?.port ?? 8787}`);
  const holder = readLock();
  if (holder && !alive(holder.pid)) {
    console.log(`  stale lock:  PID ${holder.pid} is gone; will be reused on next start`);
  }
  if (problems.length) {
    for (const p of problems) console.log(`  PROBLEM: ${p}`);
  }
  console.log(problems.length ? 'doctor: issues found' : 'doctor: ok');
  return problems.length ? 1 : 0;
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
    cwd: ROOT_DIR,
    detached: true,
    stdio: ['ignore', logHandle, logHandle],
  });
  child.unref();
  log(`starting server (PID ${child.pid}) … log: ${logPath}`);
  if (await portReady(config, timeoutMs)) {
    log('server is up');
    return true;
  }
  log('server did not become ready in time (see daemon log)');
  return false;
}

async function stopServer(timeoutMs = 9000) {
  const holder = runningLock();
  if (!holder) {
    log('no running server to stop');
    return;
  }
  log(`stopping server PID ${holder.pid}`);
  try { process.kill(holder.pid, 'SIGTERM'); } catch { /* gone */ }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(holder.pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (alive(holder.pid)) {
    try { process.kill(holder.pid, 'SIGKILL'); } catch { /* gone */ }
    log(`PID ${holder.pid} did not exit, forced (SIGKILL)`);
  } else {
    log(`PID ${holder.pid} stopped`);
  }
}

// Maps a working directory to the registered project whose path it sits in.
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

  if (!runningLock()) {
    log('server not running — starting it');
    const ok = await startServer(config);
    if (!ok) {
      console.error('TaskBridge could not be started. Check `taskbridge doctor`.');
      process.exit(1);
    }
  }

  // Find the latest session, preferring one belonging to the resolved project.
  let sessionPath = '/';
  try {
    const res = await fetch(baseUrl(config) + '/api/tasks');
    if (res.ok) {
      const tasks = await res.json();
      const list = Array.isArray(tasks) ? tasks : [];
      const scoped = project ? list.filter((t) => t.projectId === project.id) : list;
      const latest = (scoped.length ? scoped : list)[0];
      if (latest?.id) sessionPath = `/session/${encodeURIComponent(latest.id)}`;
    }
  } catch {
    // Server is up (we started/verified it) but the API hiccuped; fall back to '/'.
  }
  const url = baseUrl(config) + sessionPath;
  log(`opening ${url}`);
  openBrowser(url);
  console.log(url);
}

// --- argument parsing -------------------------------------------------------

const USAGE = `taskbridge — admin/client CLI for a running TaskBridge server

usage: taskbridge <command> [path]

commands:
  open [path]   open the latest session for the current directory (or path)
                in the browser; starts the server if it is not running
  status        is the server running? PID, URL, data dir
  doctor        check config, data dir and lock state
  start         start the server as a detached background process
  stop          stop the running server (by instance-lock PID)
  help          show this help
`;

const command = process.argv[2];
const arg = process.argv[3];

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
    const ok = await startServer(config);
    process.exit(ok ? 0 : 1);
    break;
  }
  case 'stop': await stopServer(); break;
  default:
    console.error(`unknown command: ${command}`);
    console.log(USAGE);
    process.exit(2);
}
