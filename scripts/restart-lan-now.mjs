#!/usr/bin/env node
// Restart the LAN pair through the single lifecycle implementation in start-lan.mjs.
// The worker is orphaned before it runs because Windows taskkill /T follows the
// server's process tree. A per-data-directory lock makes repeated HTTP requests
// one restart, not multiple workers racing to replace lan.json.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isTaskBridgeProcess } from '../src/instance-lock.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA = process.env.TASKBRIDGE_DATA_DIR ? path.resolve(process.env.TASKBRIDGE_DATA_DIR) : path.join(root, 'data');
const STATE = path.join(DATA, 'lan.json');
const RESTART_LOCK = path.join(DATA, 'lan-restart.lock');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const delayMs = Number(process.argv.find(arg => arg.startsWith('--delay-ms'))?.split('=')[1] || 30000);
const parseArg = key => { const index = process.argv.indexOf(key); return index >= 0 ? process.argv[index + 1] : null; };
const reportPath = path.join(DATA, parseArg('--report') || 'restart-report.md');

if (!process.env.TASKBRIDGE_RESTART_ORPHAN && !process.argv.includes('--dry-run')) {
  const launcher = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, TASKBRIDGE_RESTART_ORPHAN: '1' },
  });
  launcher.unref();
  process.exit(0);
}

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function acquireRestartLock() {
  await fs.mkdir(DATA, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(RESTART_LOCK, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = await readJson(RESTART_LOCK).catch(() => null);
      if (isTaskBridgeProcess(Number(holder?.pid), 'restart-lan-now.mjs')) return false;
      await fs.rm(RESTART_LOCK, { force: true });
    }
  }
  throw new Error('Не удалось захватить блокировку перезапуска LAN-пары.');
}

async function runLifecycle(command) {
  const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/start-lan.mjs', command], {
    cwd: root,
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

async function healthy(port, timeoutMs = 5000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch { return false; }
}

async function writeFailure(error) {
  const message = `# TaskBridge: перезапуск LAN-пары не удался\n\n${new Date().toISOString()}\n\n\`\`\`\n${error?.stack || error?.message || String(error)}\n\`\`\`\n`;
  await fs.writeFile(reportPath, message, 'utf8').catch(() => {});
}

const acquired = await acquireRestartLock();
if (!acquired) process.exit(0); // another accepted request already owns the restart

try {
  const before = await readJson(STATE).catch(() => null);
  if (process.argv.includes('--dry-run')) {
    console.log(`dry-run: app=${before?.appPid ?? 'none'} proxy=${before?.proxyPid ?? 'none'} ports ${before?.internalPort ?? '?'}->${before?.publicPort ?? '?'}`);
  } else {
    if (delayMs > 0) await sleep(delayMs);
    const stopOutput = await runLifecycle('stop');
    const startOutput = await runLifecycle('start');
    const after = await readJson(STATE);
    const [internalUp, proxyUp] = await Promise.all([healthy(after.internalPort), healthy(after.publicPort)]);
    if (!internalUp || !proxyUp) throw new Error(`Перезапущенная LAN-пара не отвечает: internal=${internalUp}, proxy=${proxyUp}`);

    const build = await fetch(`http://127.0.0.1:${after.publicPort}/api/info`, { signal: AbortSignal.timeout(10000) })
      .then(response => response.json()).catch(() => null);
    const tasks = await fetch(`http://127.0.0.1:${after.publicPort}/api/tasks`, { signal: AbortSignal.timeout(10000) })
      .then(response => response.json()).catch(() => []);
    const lan = Object.values(os.networkInterfaces()).flat().find(iface => iface && iface.family === 'IPv4' && !iface.internal)?.address || null;
    const report = [
      '# TaskBridge: перезапуск LAN-пары (app + proxy)', '',
      `Время: ${new Date().toISOString()}`,
      `Было: app PID ${before?.appPid ?? '—'}, proxy PID ${before?.proxyPid ?? '—'}`,
      `Стало: app PID ${after.appPid}, proxy PID ${after.proxyPid} (внутренний порт ${after.internalPort}, публичный ${after.publicPort})`,
      `Сборка: ${JSON.stringify(build?.build || null)}`, '',
      '## Проверки', '',
      '| Проверка | Результат |',
      '|---|---|',
      `| внутренний сервер отвечает (${after.internalPort}) | ✅ |`,
      `| прокси отвечает (${after.publicPort}) | ✅ |`,
      `| сессии на месте | ${Array.isArray(tasks) ? `${tasks.length} задач` : '❌'} |`,
      `| LAN: ${lan || '—'} | |`, '',
      '## Lifecycle output', '', '```', stopOutput, startOutput, '```', '',
    ].join('\n');
    await fs.writeFile(reportPath, report, 'utf8');
    await fs.writeFile(reportPath.replace(/\.md$/, '.json'), JSON.stringify({
      at: new Date().toISOString(), appPid: after.appPid, proxyPid: after.proxyPid,
      internalPort: after.internalPort, publicPort: after.publicPort,
      build: build?.build || null, taskCount: Array.isArray(tasks) ? tasks.length : null,
    }, null, 2));
  }
} catch (error) {
  await writeFailure(error);
  process.exitCode = 1;
} finally {
  await fs.rm(RESTART_LOCK, { force: true }).catch(() => {});
}
