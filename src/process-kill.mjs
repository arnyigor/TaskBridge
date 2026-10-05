// Killing an arbitrary process is a loaded gun, so the panel route funnels every
// request through here: the pid must be visible in the fresh process list AND
// carry the name the caller saw (a pid is reused by the OS within minutes), and
// a small denylist keeps the tempting footguns out of reach — the OS core, the
// antivirus and TaskBridge's own server tree (for that there is /api/server/restart).

import { execFile } from 'node:child_process';
import { listProcesses } from './process-info.mjs';

const PROTECTED_NAMES = new Set([
  'system', 'registry', 'secure system', 'memcompression', 'idle',
  'wininit', 'winlogon', 'csrss', 'smss', 'services', 'lsass', 'dwm',
  'svchost', 'explorer', 'fontdrvhost', 'audiodg', 'msmpeng', 'dllhost',
  // The desktop client that hosts the tray and opens this very panel.
  'taskbridge',
]);

// Parts of a command line that belong to TaskBridge's own server tree: killing
// them from inside the server would cut the branch we sit on. A proper restart
// exists as POST /api/server/restart.
const PROTECTED_COMMAND_PARTS = ['server.mjs', 'proxy.mjs', 'start-lan.mjs', 'restart-and-verify.mjs', 'restart-lan-now.mjs'];

function baseName(name) {
  return String(name || '').toLowerCase().replace(/\.exe$/, '');
}

function promisifiedExec(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { detail: String(stderr || stdout || '') }));
      else resolve(stdout);
    });
  });
}

/**
 * Kill one process by pid. `name` must match the name the caller saw in
 * /api/processes — it is the seatbelt against killing a reused pid.
 * Returns { killed, pid, name } or throws with code:
 *   INPUT_INVALID (no pid/name), NOT_FOUND, NAME_MISMATCH, PROTECTED, KILL_FAILED.
 */
export async function killProcess({ pid, name } = {}) {
  const pidNum = Number(pid);
  if (!Number.isInteger(pidNum) || pidNum <= 0) {
    throw Object.assign(new Error('Нужен числовой pid процесса.'), { code: 'INPUT_INVALID' });
  }
  if (typeof name !== 'string' || !name.trim()) {
    throw Object.assign(new Error('Нужно имя процесса (как в /api/processes) — оно защищает от выстрела в переиспользованный pid.'), { code: 'INPUT_INVALID' });
  }
  if (pidNum === process.pid) {
    throw Object.assign(new Error('Сервер не может остановить сам себя через эту панель — используйте «Перезагрузить сервер».'), { code: 'PROTECTED' });
  }
  const list = await listProcesses({ fresh: true });
  if (!list) {
    throw Object.assign(new Error('Не удалось получить список процессов, отказался стрелять вслепую.'), { code: 'KILL_FAILED' });
  }
  const target = list.find(item => item.pid === pidNum);
  if (!target) {
    throw Object.assign(new Error(`Процесс ${pidNum} уже не существует (или недоступен списку).`), { code: 'NOT_FOUND' });
  }
  const firstToken = String(target.commandLine || '').trim().split(/\s+/)[0] || '';
  const actualName = baseName(target.name || firstToken.split(/[\/]/).pop());
  if (actualName !== baseName(name)) {
    throw Object.assign(new Error(`pid ${pidNum} теперь принадлежит «${target.name || '?'}», а не «${name}» — отказался убивать.`), { code: 'NAME_MISMATCH' });
  }
  if (PROTECTED_NAMES.has(actualName)) {
    throw Object.assign(new Error(`«${target.name}» — системный процесс, панель его не убивает.`), { code: 'PROTECTED' });
  }
  const commandLine = String(target.commandLine || '');
  if (PROTECTED_COMMAND_PARTS.some(part => commandLine.includes(part))) {
    throw Object.assign(new Error('Это процесс самого TaskBridge — для него есть «Перезагрузить сервер», а не kill.'), { code: 'PROTECTED' });
  }
  if (process.platform === 'win32') {
    await promisifiedExec('taskkill.exe', ['/PID', String(pidNum), '/T', '/F']);
  } else {
    // POSIX: no tree kill without a supervisor; the single pid is what the panel showed.
    process.kill(pidNum, 'SIGKILL');
  }
  return { killed: true, pid: pidNum, name: target.name };
}

function matchesRuntime(target, runtime) {
  const executable = baseName(String(target.name || '').trim());
  const firstToken = String(target.commandLine || '').trim().split(/\s+/)[0] || '';
  const commandExecutable = baseName(firstToken.split(/[\\/]/).pop());
  const names = runtime === 'node'
    ? new Set(['node', 'nodejs', 'node.exe'])
    : new Set(['python', 'python3', 'py', 'python.exe', 'python3.exe', 'py.exe']);
  return names.has(executable) || names.has(commandExecutable);
}

/**
 * Kill every process from a runtime family visible in one fresh snapshot.
 * Each candidate is passed through killProcess again, so PID reuse and all
 * protection rules still apply. The calling server is never included.
 */
export async function killProcessesByRuntime(runtime) {
  if (runtime !== 'node' && runtime !== 'python') {
    throw Object.assign(new Error('Поддерживаются только группы node и python.'), { code: 'INPUT_INVALID' });
  }
  const list = await listProcesses({ fresh: true });
  if (!list) throw Object.assign(new Error('Не удалось получить список процессов.'), { code: 'KILL_FAILED' });
  const candidates = list.filter(item => item.pid !== process.pid && matchesRuntime(item, runtime));
  const killed = [];
  const failed = [];
  for (const candidate of candidates) {
    try {
      killed.push(await killProcess({ pid: candidate.pid, name: candidate.name || '' }));
    } catch (error) {
      failed.push({ pid: candidate.pid, name: candidate.name, code: error.code || 'KILL_FAILED', error: error.message });
    }
  }
  return { runtime, matched: candidates.length, killed, failed };
}
