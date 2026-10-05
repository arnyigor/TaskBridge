import fs from 'node:fs';
import path from 'node:path';

import { execFileSync } from 'node:child_process';

// process.kill(pid, 0) throws ESRCH when the process is gone and EPERM when it
// exists but belongs to another user (still alive for our purposes).
// A live PID is not proof that OUR server is alive: Windows reuses numbers, and this
// machine runs dozens of node processes (2026-10-05: «TaskBridge уже запущен (PID 13220)»
// about a PID that no longer belonged to TaskBridge, so the button could not start the
// server). Identity is the command line — the lock is taken only by src/server.mjs.
function alive(pid) {
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code !== 'EPERM') return false;
  }
  return isNodeProcess(pid) && isOurServer(pid);
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
// Windows hands that number to an unrelated process (this machine runs dozens of
// node processes), and the image check alone cannot tell them apart. The command
// line can: our server is started as `... server.mjs`.
function isOurServer(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue).CommandLine`], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    const command = out.trim();
    if (!command) return false; // процесс есть, но не наш (или расспросить не удалось)
    return /server\.mjs/.test(command);
  } catch {
    return true; // не смогли проверить — лучше отказать, чем поделить каталог данных
  }
}

// Prevents two TaskBridge servers from sharing one data directory: they would
// race on task state (event cursors are safe, task execution is not). A lock
// left by a killed process is detected as stale and taken over.
export function acquireInstanceLock(dataRoot) {
  const file = path.join(dataRoot, 'taskbridge.lock');
  fs.mkdirSync(dataRoot, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
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
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
      throw Object.assign(new Error(`TaskBridge уже запущен (PID ${pid}). Остановите его и повторите.`), { code: 'ALREADY_RUNNING' });
    }
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    try {
      create();
    } catch (retry) {
      if (retry.code === 'EEXIST') throw Object.assign(new Error('TaskBridge уже запускается другим процессом.'), { code: 'ALREADY_RUNNING' });
      throw retry;
    }
  }
  return { file, release: () => { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } } };
}
