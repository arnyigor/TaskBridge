import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Ownership is deliberately three-valued. `isTaskBridgeProcess()` answers the
// strict question ("is this provably our entrypoint?") and is the only answer a
// kill decision may use. A non-elevated caller cannot read the command line of
// an elevated TaskBridge process, so that case is `unknown`, never `ours` and
// never `foreign`: killing it could hit an unrelated process, while deleting its
// data-directory lock could start a second server on the same SQLite file.
//
// Liveness for status uses stronger, independent evidence: the PID must own the
// expected listening port and the endpoint must answer. That corroboration lives
// in scripts/start-lan.mjs (ports) and src/lan-ports.mjs, not here.
export const OWNERSHIP = Object.freeze({
  OURS: 'ours',
  FOREIGN: 'foreign',
  UNKNOWN: 'unknown',
  DEAD: 'dead',
});

/** Classify a readable command line; an empty one is unknown, not proof. */
export function classifyCommandLine(commandLine, entrypoint) {
  const command = String(commandLine ?? '').trim();
  if (!command) return OWNERSHIP.UNKNOWN;
  return command.replaceAll('\\', '/').includes(entrypoint.replaceAll('\\', '/'))
    ? OWNERSHIP.OURS
    : OWNERSHIP.FOREIGN;
}

/** Strict: true only when the command line proves this is our entrypoint. */
export function entrypointMatches(commandLine, entrypoint) {
  return classifyCommandLine(commandLine, entrypoint) === OWNERSHIP.OURS;
}

// process.kill(pid, 0) throws ESRCH when the process is gone and EPERM when it
// exists but belongs to another user (still alive for our purposes).
export function processOwnership(pid, entrypoint = 'server.mjs') {
  if (!Number.isSafeInteger(pid) || pid <= 0) return OWNERSHIP.DEAD;
  try { process.kill(pid, 0); }
  catch (error) { if (error.code !== 'EPERM') return OWNERSHIP.DEAD; }

  const node = isNodeProcess(pid);
  if (!node) return OWNERSHIP.FOREIGN;
  const command = readCommandLine(pid);
  if (command === null || command === '') return OWNERSHIP.UNKNOWN;
  return classifyCommandLine(command, entrypoint);
}

/** True only for a proven TaskBridge process; unknown and foreign are false. */
export function isTaskBridgeProcess(pid, entrypoint = 'server.mjs') {
  return processOwnership(pid, entrypoint) === OWNERSHIP.OURS;
}

// Returns true when the PID exists and its image name looks like a node/
// electron/bun runtime. On failure (missing tool, unknown platform) falls back
// to true so a legitimate running instance from another user is not killed off.
// The image name is taken from CSV and must look like an executable: on a
// Russian Windows a missing PID prints «ИНФОРМАЦИЯ: нет задач…» instead of
// «INFO:», and the old check for the literal 'INFO:' parsed that text as an image
// name — one more way to answer the wrong thing about a reused PID.
function isNodeProcess(pid) {
  try {
    if (process.platform !== 'win32') {
      const image = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
        encoding: 'utf8', timeout: 5000,
      }).trim().split('/').pop();
      return /^(node(js)?|electron|bun|deno)$/.test(image);
    }
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    }).trim();
    const image = imageNameOf(out);
    if (!image) return false;
    return /node|electron|bun|deno/.test(image);
  } catch {
    return true;
  }
}

/** Image name from `tasklist /FO CSV /NH` output; null when there is no process row. */
export function imageNameOf(csvOutput) {
  const first = (csvOutput || '').trim().split('\n')[0]?.split(',')[0]?.replace(/"/g, '').trim().toLowerCase();
  return first && first.endsWith('.exe') ? first : null;
}

// A reused PID is the reason a dead server can look alive: the lock stores a PID,
// Windows hands that number to an unrelated process, and the image check alone
// cannot tell them apart. The command line can. `null` means the query failed;
// `''` means the process exists but exposes no command line (elevation). Both are
// unknown and must not be used as evidence of ownership or of staleness.
function readCommandLine(pid) {
  try {
    if (process.platform !== 'win32') {
      return execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
        encoding: 'utf8', timeout: 5000,
      }).trim();
    }
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue).CommandLine`], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    return out.trim();
  } catch {
    return null;
  }
}

// Prevents two TaskBridge servers from sharing one data directory: they would
// race on task state (event cursors are safe, task execution is not). The lock
// also carries enough LAN metadata to reconstruct lan.json after an interrupted
// launcher. Its random owner token makes release compare-and-delete: an older
// process can never remove a replacement process's lock while exiting.
export function acquireInstanceLock(dataRoot, details = {}) {
  const file = path.join(dataRoot, 'taskbridge.lock');
  fs.mkdirSync(dataRoot, { recursive: true });
  const owner = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, owner, startedAt: new Date().toISOString(), ...details });
  const create = () => {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, payload);
    fs.closeSync(fd);
  };
  try {
    create();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable lock: treat as stale */ }
    const pid = Number(holder?.pid);
    const ownership = processOwnership(pid);
    // Unknown is not stale. Removing this lock would let a second server open the
    // same SQLite file next to a live instance whose command line we merely could
    // not read. Refuse and name the PID instead.
    if (pid !== process.pid && (ownership === OWNERSHIP.OURS || ownership === OWNERSHIP.UNKNOWN)) {
      const message = ownership === OWNERSHIP.UNKNOWN
        ? `TaskBridge PID ${pid} держит каталог данных, но его командная строка недоступна. ` +
          'Владение не подтверждено, lock не удаляю. Проверьте процесс вручную.'
        : `TaskBridge уже запущен (PID ${pid}). Остановите его и повторите.`;
      throw Object.assign(new Error(message), { code: 'ALREADY_RUNNING' });
    }
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    try {
      create();
    } catch (retry) {
      if (retry.code === 'EEXIST') throw Object.assign(new Error('TaskBridge уже запускается другим процессом.'), { code: 'ALREADY_RUNNING' });
      throw retry;
    }
  }
  return {
    file,
    release: () => {
      try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (current?.owner === owner) fs.rmSync(file, { force: true });
      } catch { /* already gone or replaced */ }
    },
  };
}
