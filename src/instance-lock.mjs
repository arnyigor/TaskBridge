import fs from 'node:fs';
import path from 'node:path';

import { execFileSync } from 'node:child_process';

// process.kill(pid, 0) throws ESRCH when the process is gone and EPERM when it
// exists but belongs to another user (still alive for our purposes).
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code !== 'EPERM') return false;
    // EPERM only means the process belongs to another user — it can be a stale
    // lock whose PID was reused by an unrelated system process (e.g. PID reuse
    // after a crashed server). Verify the holder is actually a node process
    // before treating it as a live TaskBridge instance.
    return isNodeProcess(pid);
  }
}

// Returns true when the PID exists and its image name looks like a node/
// electron/bun runtime. On failure (missing tool, unknown platform) falls back
// to true so a legitimate running instance from another user is not killed off.
function isNodeProcess(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    }).trim();
    if (!out || out.includes('INFO:')) return false;
    const image = (out.split(',')[0] || '').replace(/"/g, '').toLowerCase();
    return /node|electron|bun|deno/.test(image);
  } catch {
    return true;
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
