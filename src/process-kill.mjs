// Killing an arbitrary process is a loaded gun, so the panel route funnels every
// request through here: the pid must be visible in the fresh process list AND
// carry the name the caller saw (a pid is reused by the OS within minutes), and
// a small denylist keeps the tempting footguns out of reach — the OS core, the
// antivirus and TaskBridge's own server tree (for that there is /api/server/restart).

import { execFile } from 'node:child_process';
import { listProcesses, descendantsOf } from './process-info.mjs';

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

/** Would killing this process hit something TaskBridge must never stop? Exported for tests. */
export function findProtection(target, selfPid = process.pid) {
  if (Number(target.pid) === selfPid) {
    return 'Сервер не может остановить сам себя через эту панель — используйте «Перезагрузить сервер».';
  }
  const firstToken = String(target.commandLine || '').trim().split(/\s+/)[0] || '';
  const actualName = baseName(target.name || firstToken.split(/[\/]/).pop());
  if (PROTECTED_NAMES.has(actualName)) {
    return `«${target.name}» — системный процесс, панель его не убивает.`;
  }
  const commandLine = String(target.commandLine || '');
  if (PROTECTED_COMMAND_PARTS.some(part => commandLine.includes(part))) {
    return 'Это процесс самого TaskBridge — для него есть «Перезагрузить сервер», а не kill.';
  }
  return null;
}

/**
 * Потомки, которые действительно принадлежат цели. Осиротевший процесс хранит
 * PPID давно мёртвого родителя, и этот номер ОС переиспользует для нового
 * процесса — тогда чужой долгоживущий процесс выглядит «потомком» и запрещает
 * законное убийство дерева (наблюдалось на прогоне тестов: TaskBridge.exe в
 * потомках тестового node). Ребёнок не может стартовать раньше родителя, поэтому
 * потомок с более ранним временем старта к дереву не относится. Неизвестное время
 * старта оставляет запись в дереве: отказ лучше выстрела вслепую.
 */
export function realDescendants(target, list) {
  const targetStartedAt = Number(target?.startedAt);
  return descendantsOf(target.pid, list).filter(item => {
    const startedAt = Number(item.startedAt);
    if (!Number.isFinite(targetStartedAt) || !Number.isFinite(startedAt)) return true;
    return startedAt >= targetStartedAt - 2000;
  });
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
  // taskkill /T kills the whole tree, so EVERY descendant is checked with the
  // same rules as the target (PROC-02): one protected child refuses the tree kill.
  const tree = [target, ...realDescendants(target, list)];
  for (const item of tree) {
    const reason = findProtection(item);
    if (reason) {
      const scope = item.pid === pidNum ? 'сам процесс' : `его потомок pid ${item.pid}`;
      throw Object.assign(new Error(`Отказался: ${scope} защищён — ${reason}`), { code: 'PROTECTED', protectedPid: item.pid });
    }
  }
  const firstToken = String(target.commandLine || '').trim().split(/\s+/)[0] || '';
  const actualName = baseName(target.name || firstToken.split(/[\/]/).pop());
  if (actualName !== baseName(name)) {
    throw Object.assign(new Error(`pid ${pidNum} теперь принадлежит «${target.name || '?'}», а не «${name}» — отказался убивать.`), { code: 'NAME_MISMATCH' });
  }
  if (process.platform === 'win32') {
    await promisifiedExec('taskkill.exe', ['/PID', String(pidNum), '/T', '/F']);
  } else {
    // Only signal the descendants inspected above. Killing just the parent
    // leaves its workers alive; killing the parent first also prevents it from
    // reaping exited children on hosts whose init does not reap promptly.
    const children = tree.slice(1).reverse();
    for (const child of children) {
      try { process.kill(child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const deadline = Date.now() + 1000;
    while (children.length && Date.now() < deadline) {
      const alive = children.some(child => {
        try { process.kill(child.pid, 0); return true; }
        catch (error) { return error.code !== 'ESRCH'; }
      });
      if (!alive) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    process.kill(pidNum, 'SIGKILL');
  }
  return { killed: true, pid: pidNum, name: target.name };
}

const RUNTIME_PROCESS_NAMES = {
  node: new Set(['node', 'nodejs']),
  python: new Set(['python', 'python3', 'py']),
  java: new Set(['java', 'javaw', 'javac', 'jshell']),
};

function matchesRuntime(target, runtime) {
  const executable = baseName(String(target.name || '').trim());
  const firstToken = String(target.commandLine || '').trim().split(/\s+/)[0] || '';
  const commandExecutable = baseName(firstToken.split(/[\\/]/).pop());
  const names = RUNTIME_PROCESS_NAMES[runtime];
  return Boolean(names) && (names.has(executable) || names.has(commandExecutable));
}

/**
 * Kill every process from a runtime family visible in one fresh snapshot.
 * Each candidate is passed through killProcess again, so PID reuse and all
 * protection rules still apply. The calling server is never included.
 */
export async function killProcessesByRuntime(runtime) {
  if (!RUNTIME_PROCESS_NAMES[runtime]) {
    throw Object.assign(new Error('Поддерживаются только группы node, python и java.'), { code: 'INPUT_INVALID' });
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
