import fs from 'node:fs';
import path from 'node:path';

// process.kill(pid, 0) throws ESRCH when the process is gone and EPERM when it
// exists but belongs to another user (still alive for our purposes).
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
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
