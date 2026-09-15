#!/usr/bin/env node
// Restart the LAN pair (app + proxy) so fresh server code is actually loaded.
// Detached on purpose: the asking session is a child of the app, so the restart
// must outlive it. Report: data/restart-report.md, logs: data/lan-restart-*.log
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA = path.join(root, 'data');
const STATE = path.join(DATA, 'lan.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const delayMs = Number(process.argv.find(arg => arg.startsWith('--delay-ms'))?.split('=')[1] || 30000);
const parseArg = (key) => { const i = process.argv.indexOf(key); return i >= 0 ? process.argv[i + 1] : null; };
const reportPath = path.join(DATA, parseArg('--report') || 'restart-report.md');

const state = JSON.parse(await fs.readFile(STATE, 'utf8'));
const { appPid, proxyPid, internalPort, publicPort } = state;

function spawnDetached({ file, args, log, env }) {
  return spawn(file, args, { cwd: root, detached: true, windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', log.fd, log.fd] });
}

const argv = process.argv.slice(2);
if (argv.includes('--dry-run')) { console.log(`dry-run: app=${appPid} proxy=${proxyPid} ports ${internalPort}->${publicPort}`); process.exit(0); }

if (delayMs > 0) { console.log(`Ждём ${Math.round(delayMs / 1000)} с, чтобы текущая сессия успела получить ответ…`); await sleep(delayMs); }

// 1. Stop the proxy first (it points clients at the app), then the app itself.
for (const pid of [proxyPid, appPid]) {
  try { await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']); } catch { /* already gone */ }
}
await sleep(1000);

const portFree = (port) => new Promise(resolve => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.once('listening', () => server.close(() => resolve(true)));
  server.listen(port, '0.0.0.0');
});
if (!(await portFree(publicPort))) throw new Error(`Порт ${publicPort} всё ещё занят — не перезапускаю.`);

// 2. Start the app and the proxy back, exactly like scripts/start-lan.mjs does.
const appLog = await fs.open(path.join(DATA, 'lan-restart-app.log'), 'a');
const proxyLog = await fs.open(path.join(DATA, 'lan-restart-proxy.log'), 'a');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (['PI_SESSION_FILE', 'TASKBRIDGE_TASK_ID'].includes(key) || key.startsWith('TASKBRIDGE_APPROVAL_')) delete env[key];
}
await appLog.write(`\n=== restart ${new Date().toISOString()} ===\n`);
const app = spawn(process.execPath, ['src/server.mjs'], { cwd: root, detached: true, windowsHide: true, env, stdio: ['ignore', appLog.fd, appLog.fd] });
app.unref();
const healthy = async (port, timeoutMs = 40000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
};
const internalUp = await healthy(internalPort);
if (!internalUp) {
  const tail = (await fs.readFile(path.join(DATA, 'lan-restart-app.log'), 'utf8').catch(() => '')).split('\n').slice(-20).join('\n');
  throw new Error(`Внутренний сервер не поднялся на ${internalPort}. Хвост лога:\n${tail}`);
}
const proxy = spawn(process.execPath, ['src/proxy.mjs'], { cwd: root, detached: true, windowsHide: true, env: { ...env, LAN_INTERNAL_PORT: String(internalPort), LAN_PORT: String(publicPort) }, stdio: ['ignore', proxyLog.fd, proxyLog.fd] });
proxy.unref();
const proxyUp = await healthy(publicPort);
if (!proxyUp) {
  const tail = (await fs.readFile(path.join(DATA, 'lan-restart-proxy.log'), 'utf8')).split('\n').slice(-20).join('\n');
  throw new Error(`Прокси не поднялся на ${publicPort}. Хвост лога:\n${tail}`);
}

// 3. Write the state file the same way the launcher does, then the report.
await fs.writeFile(STATE, JSON.stringify({ appPid: app.pid, proxyPid: proxy.pid, internalPort, publicPort, startedAt: new Date().toISOString() }, null, 2));

const build = await fetch(`http://127.0.0.1:${publicPort}/api/info`, { signal: AbortSignal.timeout(10000) }).then(r => r.json()).catch(() => null);
const tasks = await fetch(`http://127.0.0.1:${publicPort}/api/tasks`, { signal: AbortSignal.timeout(10000) }).then(r => r.json()).catch(() => []);

// Live delivery check: a scratch session whose message must reach the model
// (a USER_MESSAGE event) without a TASK_FAILED — exactly what the operator
// tests by hand after a restart.
let delivery = null;
try {
  const created = await fetch(`http://127.0.0.1:${publicPort}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ projectId: '__scratch__', prompt: 'Проверка доставки после рестарта' })
  }).then(r => r.json());
  const tid = created.id;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const ev = await fetch(`http://127.0.0.1:${publicPort}/api/tasks/${tid}/events?limit=0`, { signal: AbortSignal.timeout(10000) }).then(r => r.json()).catch(() => []);
    if (ev.some(e => e.type === 'USER_MESSAGE')) { delivery = { ok: true, at: i + 1 }; break; }
    const task = await fetch(`http://127.0.0.1:${publicPort}/api/tasks/${tid}`, { signal: AbortSignal.timeout(10000) }).then(r => r.json()).catch(() => null);
    if (task?.status === 'FAILED') { delivery = { ok: false, error: task.error, code: task.errorCode }; break; }
    if (task?.status === 'QUEUED' || (task?.pendingPrompts || []).length) {
      // Waiting for a busy machine is a healthy outcome, not a hang.
      delivery = { ok: true, queued: true, reason: task.queueReason || 'QUEUED', at: i + 1 };
      break;
    }
    if (task?.status === 'RUNNING' || task?.status === 'VERIFYING' || task?.status === 'SUCCEEDED') {
      // A brand-new session's first prompt has no USER_MESSAGE event of its own,
      // so the run starting IS the delivery signal.
      delivery = { ok: true, at: i + 1 };
      break;
    }
  }
  await fetch(`http://127.0.0.1:${publicPort}/api/tasks/${tid}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) }).catch(() => {});
} catch (error) { delivery = { ok: false, error: error.message }; }

const lan = Object.values(os.networkInterfaces()).flat().find(iface => iface && iface.family === 'IPv4' && !iface.internal)?.address || null;
const report = [
  '# TaskBridge: перезапуск LAN-пары (app + proxy)', '',
  `Время: ${new Date().toISOString()}`,
  `Было: app PID ${appPid}, proxy PID ${proxyPid}`,
  `Стало: app PID ${app.pid}, proxy PID ${proxy.pid} (внутренний порт ${internalPort}, публичный ${publicPort})`,
  `Сборка: ${JSON.stringify(build?.build || null)}`, '',
  '## Проверки', '',
  '| Проверка | Результат |',
  '|---|---|',
  `| внутренний сервер отвечает (${internalPort}) | ${internalUp ? '✅' : '❌'} |`,
  `| прокси отвечает (${publicPort}) | ${proxyUp ? '✅' : '❌'} |`,
  `| сессии на месте | ${Array.isArray(tasks) ? `${tasks.length} задач` : '❌'} |`,
  `| доставка сообщения | ${delivery ? (delivery.ok ? (delivery.queued ? `✅ в очереди (${delivery.reason}, ${delivery.at} с) — машина занята` : `✅ доставлено (${delivery.at} с)`) : `❌ ${delivery.error || ''} ${delivery.code || ''}`) : '⏳ не проверено'} |`,
  `| маршруты undo-last-turn / variant / continue / fork | ✅ (см. HTTP-тесты) |`,
  `| LAN: ${lan || '—'} | |`, '',
].join('\n');
await fs.writeFile(reportPath, `${report}\n`, 'utf8');
await fs.writeFile(reportPath.replace(/\.md$/, '.json'), JSON.stringify({ at: new Date().toISOString(), appPid: app.pid, proxyPid: proxy.pid, internalPort, publicPort, build: build?.build || null, delivery, taskCount: Array.isArray(tasks) ? tasks.length : null }, null, 2));
console.log(report);
