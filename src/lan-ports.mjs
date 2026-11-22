// Who holds the LAN port, and is it ours?
//
// data/lan.json is a convenience record, not a guarantee: an interrupted
// restart, a killed launcher, or a stop that could not read an elevated
// process' command line all leave a live proxy that no state file mentions.
// Then the next `start` dies with EADDRINUSE while `stop` says «not running»
// (observed 2026-11-18: proxy PID 2972 held port 8787 for seven minutes after
// its app was gone, lan.json had been removed, and every restart failed).
//
// The port itself is authoritative. A listener is ours when either its command
// line names our proxy entrypoint, or the port answers with the header every
// src/proxy.mjs response carries (`x-taskbridge-request-id`). The second test
// works even when the command line is unreadable because the process runs with
// higher rights — the case that caused the incident.

import { execFile } from 'node:child_process';

function run(file, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout));
    });
  });
}

/** PIDs listening on `port` from Windows `netstat -ano` output. */
export function parseListeningPids(output, port) {
  const pids = new Set();
  const needle = `:${Number(port)}`;
  for (const line of String(output || '').split(/\r?\n/u)) {
    const parts = line.trim().split(/\s+/u);
    // Proto  Local Address  Foreign Address  State  PID
    if (parts.length < 5 || parts[0] !== 'TCP' || parts[3] !== 'LISTENING') continue;
    if (!parts[1].endsWith(needle)) continue;
    const pid = Number(parts[4]);
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** PIDs listening on `port` from `lsof -ti` or `ss -lptn` output. */
export function parsePosixListeningPids(output, { lsof = false } = {}) {
  const pids = new Set();
  for (const line of String(output || '').split(/\r?\n/u)) {
    if (lsof) {
      const pid = Number(line.trim());
      if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
      continue;
    }
    const match = /pid=(\d+)/u.exec(line);
    if (match) pids.add(Number(match[1]));
  }
  return [...pids];
}

/** PIDs listening on `port`; [] when the platform tool is missing. */
export async function listeningPids(port) {
  if (process.platform === 'win32') {
    return parseListeningPids(await run('netstat.exe', ['-ano', '-p', 'TCP']), port);
  }
  const lsof = await run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
  if (lsof.trim()) return parsePosixListeningPids(lsof, { lsof: true });
  const ss = await run('ss', ['-lptn', `sport = :${port}`]);
  return parsePosixListeningPids(ss);
}

/** True when `pid` itself is one of the listeners on `port`. */
export async function pidOwnsPort(pid, port) {
  const wanted = Number(pid);
  const wantedPort = Number(port);
  if (!Number.isSafeInteger(wanted) || wanted <= 0) return false;
  if (!Number.isSafeInteger(wantedPort) || wantedPort <= 0) return false;
  return (await listeningPids(wantedPort)).includes(wanted);
}

/** True when the port answers as a TaskBridge proxy (any response carries the id). */
export async function taskBridgeProxyOn(port, timeoutMs = 1500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.headers.has('x-taskbridge-request-id');
  } catch {
    return false;
  }
}

async function killTree(pid) {
  if (process.platform === 'win32') {
    await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

/**
 * Free `port` from TaskBridge listeners. Foreign listeners are reported, never
 * killed: a stranger on our port is an operator problem, not ours to solve.
 *
 * Returns {status, pids, ours, foreign, failed}:
 *   status 'free'    — nothing listens
 *   status 'freed'   — every TaskBridge listener is gone
 *   status 'blocked' — a foreign process holds the port
 *   status 'failed'  — a TaskBridge listener survived (usually rights)
 */
export async function freeTaskBridgePort(port, { isOurs = () => false } = {}) {
  const wanted = Number(port);
  if (!Number.isSafeInteger(wanted) || wanted <= 0) return { status: 'free', pids: [], ours: [], foreign: [], failed: [] };
  const pids = (await listeningPids(wanted)).filter((pid) => pid !== process.pid);
  if (!pids.length) return { status: 'free', pids: [], ours: [], foreign: [], failed: [] };

  const answers = await taskBridgeProxyOn(wanted);
  const foreign = [];
  const ours = [];
  for (const pid of pids) {
    if (answers || isOurs(pid)) ours.push(pid);
    else foreign.push(pid);
  }
  for (const pid of ours) await killTree(pid);

  const deadline = Date.now() + 4000;
  let left = [];
  while (Date.now() < deadline) {
    left = (await listeningPids(wanted)).filter((pid) => pid !== process.pid);
    if (!left.length) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const leftSet = new Set(left);
  const failed = ours.filter((pid) => leftSet.has(pid));
  if (failed.length) return { status: 'failed', pids, ours, foreign, failed };
  if (foreign.length && left.length) return { status: 'blocked', pids, ours, foreign, failed: [] };
  return { status: ours.length ? 'freed' : 'blocked', pids, ours, foreign, failed: [] };
}

/** Operator-facing description of a blocked/failed port. */
export function portProblemText(port, result) {
  if (result.status === 'failed') {
    return `Порт ${port} всё ещё занят процессом TaskBridge (PID ${result.failed.join(', ')}), ` +
      'но остановить его не хватает прав: он запущен от администратора. ' +
      'Запустите задачу "TaskBridge" (schtasks /run /tn TaskBridge) или остановите процесс из консоли администратора.';
  }
  if (result.status === 'blocked') {
    return `Порт ${port} занят посторонним процессом (PID ${result.foreign.join(', ') || 'неизвестно'}). ` +
      'Освободите порт или измените server.port в config.json.';
  }
  return '';
}
