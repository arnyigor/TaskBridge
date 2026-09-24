#!/usr/bin/env node
// Restart TaskBridge and check that the new build is actually healthy.
//
// Why a script: the running server is the parent of the Pi session that asked for
// the restart, so the restart must happen in a process of its own — with a delay,
// so the asking session can still deliver its answer — and the result has to be
// written down somewhere (the session that asked will be marked interrupted).
//
// Usage:
//   node scripts/restart-and-verify.mjs --dry-run          # checks only, no restart
//   node scripts/restart-and-verify.mjs --delay-ms 25000   # restart after the delay
//
// Report: data/restart-report.md (+ .json), server log: data/restart-server.log

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataRoot = path.join(root, 'data');

// Variables the server sets for a *task's* Pi process must never leak into the
// new server: they name this session, its approval endpoint and its task id.
const TASK_ONLY_ENV = ['PI_SESSION_FILE', 'TASKBRIDGE_TASK_ID'];
const TASK_ONLY_ENV_PREFIXES = ['TASKBRIDGE_APPROVAL_'];

function parseArgs(argv) {
  const args = { delayMs: 25_000, port: 8787, httpsPort: 8443, dryRun: false, report: path.join(dataRoot, 'restart-report.md') };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=');
    const next = inline ?? argv[i + 1];
    if (key === '--delay-ms') args.delayMs = Number(next);
    else if (key === '--port') args.port = Number(next);
    else if (key === '--https-port') args.httpsPort = Number(next);
    else if (key === '--report') args.report = path.resolve(next);
    else if (key === '--dry-run') args.dryRun = true;
  }
  return args;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function listeningPid(port) {
  if (process.platform !== 'win32') {
    const { stdout } = await execFileAsync('sh', ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN || true`]).catch(() => ({ stdout: '' }));
    const pid = Number(stdout.trim().split('\n')[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  }
  const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP']).catch(() => ({ stdout: '' }));
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
    if (match && Number(match[1]) === port) return Number(match[2]);
  }
  return null;
}

async function processInfo(pid) {
  if (process.platform !== 'win32') {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm=,args=']).catch(() => ({ stdout: '' }));
    return { name: stdout.split(' ')[0]?.trim() || '', command: stdout.trim() };
  }
  const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -Property Name,CommandLine | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]).catch(() => ({ stdout: '{}' }));
  const info = JSON.parse(stdout || '{}');
  return { name: info.Name || '', command: info.CommandLine || '' };
}

async function portFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs || 15_000), ...options });
  const body = await response.json().catch(() => null);
  return { status: response.status, contentType: response.headers.get('content-type') || '', body };
}

// The local HTTPS listener uses a self-signed certificate, which fetch() refuses;
// a plain https request with verification off is the honest way to check it.
function fetchSelfSigned(port, timeoutMs = 10_000) {
  return new Promise(resolve => {
    const request = https.request({ host: '127.0.0.1', port, path: '/', method: 'GET', rejectUnauthorized: false, timeout: timeoutMs }, response => {
      response.resume();
      resolve({ status: response.statusCode || 0 });
    });
    request.on('timeout', () => { request.destroy(); resolve({ status: 0, error: 'timeout' }); });
    request.on('error', error => resolve({ status: 0, error: error.message }));
    request.end();
  });
}

async function waitForServer(port, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 2_000 });
      if (health.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

function pickLanAddress() {
  return Object.values(os.networkInterfaces()).flat()
    .find(iface => iface && iface.family === 'IPv4' && !iface.internal)?.address || null;
}

// A build is identified by version AND commit: the version is bumped by hand
// per release, the commit pinpoints the code. Comparing only the commit made a
// correct restart look broken whenever the working tree was not committed yet.
const buildId = (build) => (build ? `${build.version || '?'}@${build.commit || '?'}` : null);

async function runChecks({ port, httpsPort, previousBuild, previousPid, dryRun = false }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  const health = await fetchJson(`http://127.0.0.1:${port}/api/health`).catch(error => ({ status: 0, error: error.message }));
  add('сервер отвечает (/api/health)', health.status === 200, `HTTP ${health.status}${health.error ? `: ${health.error}` : ''}`);

  const info = await fetchJson(`http://127.0.0.1:${port}/api/info`).catch(() => ({ body: null }));
  const build = info.body?.build || null;
  add('новый код запущен (сборка изменилась)', dryRun || Boolean(build && previousBuild && buildId(build) !== previousBuild), `было ${previousBuild || '—'}, стало ${buildId(build) || '—'}`);
  add('облако выключено', !info.body?.cloud, info.body?.cloud ? JSON.stringify(info.body.cloud) : 'поля cloud нет');
  const lan = pickLanAddress();
  add('LAN-адрес объявлен', Boolean(lan && (info.body?.addresses || []).some(a => a.url.includes(lan))), `${lan || 'нет интерфейса'} → ${JSON.stringify(info.body?.addresses || [])}`);

  // The cloud transport is optional: local-only is the default, scenario C runs
  // it on purpose. So the state is reported instead of being required to be off,
  // and an enabled transport is only green when it actually connected.
  const debugCloud = await fetchJson(`http://127.0.0.1:${port}/debug/cloud`).catch(() => ({ body: null }));
  const cloudOn = debugCloud.body?.enabled === true;
  add(cloudOn ? 'облако включено и подключено' : 'облако выключено (local-only)',
    cloudOn ? debugCloud.body?.connected === true : debugCloud.body?.enabled === false,
    JSON.stringify(debugCloud.body));

  const tasks = await fetchJson(`http://127.0.0.1:${port}/api/tasks`).catch(() => ({ body: [] }));
  const list = Array.isArray(tasks.body) ? tasks.body : [];
  add('сессии на месте', list.length > 0, `${list.length} задач`);

  const sample = list.find(task => task.id === previousPid) || list[0];
  if (sample) {
    const page = await fetch(`http://127.0.0.1:${port}/session/${encodeURIComponent(sample.id)}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const text = page ? await page.text().catch(() => '') : '';
    add('адрес сессии отдаёт интерфейс', page?.status === 200 && /<title>/i.test(text), `/session/${sample.id} → HTTP ${page?.status || 0}`);
  }

  const missing = await fetchJson(`http://127.0.0.1:${port}/api/this-route-does-not-exist`).catch(() => ({ status: 0, contentType: '' }));
  add('неизвестный API-путь остаётся JSON-404', missing.status === 404 && missing.contentType.includes('json'), `HTTP ${missing.status} ${missing.contentType}`);

  if (sample) {
    // A fake pendingId is a deliberate no-op per the pendingId contract
    // (stale button retry): it proves the endpoint exists without the risk of
    // delivering a real queued prompt during a mere check.
    const pending = await fetchJson(`http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(sample.id)}/pending/send`, { method: 'POST', body: JSON.stringify({ pendingId: 'restart-verify-noop' }), headers: { 'content-type': 'application/json' } }).catch(() => ({ status: 0, body: null }));
    add('эндпоинт очереди существует', pending.status === 200 && Boolean(pending.body?.id), `HTTP ${pending.status} ${JSON.stringify(pending.body)}`);
  }

  const local = await fetchJson(`http://127.0.0.1:${port}/api/local`, { timeoutMs: 120_000 }).catch(() => ({ body: null }));
  const models = local.body?.models || [];
  add('локальные модели видны роутеру', models.length > 0, `provider=${local.body?.provider ?? '—'}, моделей ${models.length}: ${models.map(m => m.id).join(', ')}`);
  add('провайдер — тот, что отдаёт Pi', local.body?.provider === 'llama.cpp' || local.body?.provider === 'llamacpp', `provider=${local.body?.provider ?? '—'}`);

  if (lan) {
    const page = await fetch(`http://${lan}:${port}/`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    add('доступ по LAN', page?.status === 200, `http://${lan}:${port}/ → HTTP ${page?.status || 0}`);
  }

  const https = await fetchSelfSigned(httpsPort);
  add('HTTPS-порт отвечает', https.status === 200, `https://127.0.0.1:${httpsPort}/ → HTTP ${https.status}${https.error ? ` (${https.error})` : ''}`);

  // Model pins of the newest sessions: a stale preset answers 400 from the router.
  const pins = list.slice(0, 8).map(task => ({ id: task.id, status: task.status, model: task.model ? `${task.model.provider || '?'}/${task.model.id}` : (task.requestedModel ? `${task.requestedModel.provider || '?'}/${task.requestedModel.id}` : null), queueReason: task.queueReason || null }));

  return { checks, build, models: models.map(m => m.id), provider: local.body?.provider ?? null, sessions: pins, taskCount: list.length, lan };
}

function renderReport({ args, startedAt, previousBuild, previousPid, stopped, restarted, checks, build, sessions, taskCount, lan }) {
  const ok = checks.filter(check => check.ok).length;
  const lines = [
    '# TaskBridge: перезапуск и проверка',
    '',
    `Время: ${new Date().toISOString()}`,
    `Действие: ${args.dryRun ? 'только проверки (dry-run, без перезапуска)' : 'перезапуск и проверки'}`,
    `Было: PID ${previousPid ?? '—'}, сборка ${previousBuild || '—'}`,
    `Стало: сборка ${buildId(build) || '—'}${stopped ? ', старый процесс остановлен' : ''}${restarted ? ', новый процесс запущен' : ''}`,
    '',
    `## Итог: ${ok}/${checks.length} проверок пройдено`,
    '',
    '| Проверка | Результат | Детали |',
    '|---|---|---|',
    ...checks.map(check => `| ${check.name} | ${check.ok ? '✅' : '❌'} | ${String(check.detail ?? '').replaceAll('|', '\\|')} |`),
    '',
    '## Сессии и их модели',
    '',
    '| Сессия | Статус | Модель | Очередь |',
    '|---|---|---|---|',
    ...(sessions || []).map(session => `| ${session.id} | ${session.status} | ${session.model || '—'} | ${session.queueReason || '—'} |`),
    '',
    `Всего сессий: ${taskCount ?? '—'}${lan ? `; LAN: ${lan}` : ''}`,
    ''
  ];
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(dataRoot, { recursive: true });

  const previousPid = await listeningPid(args.port);
  const info = await fetchJson(`http://127.0.0.1:${args.port}/api/info`).catch(() => ({ body: null }));
  const previousBuild = buildId(info.body?.build) || null;
  const previousTask = (await fetchJson(`http://127.0.0.1:${args.port}/api/tasks`).catch(() => ({ body: [] })))?.body?.find?.(task => task.status === 'RUNNING')?.id || null;

  let stopped = false;
  let restarted = false;

  if (!args.dryRun) {
    if (!previousPid) throw new Error(`Никто не слушает порт ${args.port}: нечего перезапускать.`);
    const process_ = await processInfo(previousPid);
    if (!/node/i.test(process_.name) || !/server\.mjs/.test(process_.command)) {
      throw new Error(`PID ${previousPid} не похож на TaskBridge (${process_.name}: ${process_.command.slice(0, 120)}). Остановка отменена.`);
    }
    if (args.delayMs > 0) {
      console.log(`Ждём ${Math.round(args.delayMs / 1000)} с, чтобы текущая сессия успела получить ответ…`);
      await sleep(args.delayMs);
    }
    console.log(`Останавливаю TaskBridge (PID ${previousPid})…`);
    process.kill(previousPid, 'SIGTERM');
    for (let i = 0; i < 40 && !(await portFree(args.port)); i++) {
      await sleep(250);
      if (i === 20) { try { process.kill(previousPid, 'SIGKILL'); } catch { /* already gone */ } }
    }
    if (!(await portFree(args.port))) throw new Error(`Порт ${args.port} всё ещё занят: новый сервер не запускаю, чтобы не было двух писателей.`);
    stopped = true;

    const logPath = path.join(dataRoot, 'restart-server.log');
    const logHandle = await fs.open(logPath, 'a');
    const env = { ...process.env };
    const scrubbed = [];
    for (const key of Object.keys(env)) {
      if (TASK_ONLY_ENV.includes(key) || TASK_ONLY_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) { delete env[key]; scrubbed.push(key); }
    }
    await logHandle.write(`\n=== restart ${new Date().toISOString()} (pid ${previousPid} stopped) ===\nscrubbed env: ${scrubbed.join(', ') || 'none'}\n`);
    const child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: root, detached: true, windowsHide: true, env,
      stdio: ['ignore', logHandle.fd, logHandle.fd]
    });
    child.unref();
    console.log(`Новый сервер запущен (PID ${child.pid}), лог: ${logPath}`);

    if (!(await waitForServer(args.port))) {
      const tail = (await fs.readFile(logPath, 'utf8').catch(() => '')).split('\n').slice(-25).join('\n');
      throw new Error(`Новый сервер не поднялся за 40 с. Хвост лога:\n${tail}`);
    }
    restarted = true;
  }

  const result = await runChecks({ port: args.port, httpsPort: args.httpsPort, previousBuild, previousPid: previousTask, dryRun: args.dryRun });
  const report = renderReport({ args, previousBuild, previousPid, stopped, restarted, ...result });
  await fs.writeFile(args.report, `${report}\n`, 'utf8');
  await fs.writeFile(args.report.replace(/\.md$/, '.json'), `${JSON.stringify({ at: new Date().toISOString(), previousBuild, previousPid, stopped, restarted, ...result }, null, 2)}\n`, 'utf8');
  console.log(report);
  const failed = result.checks.filter(check => !check.ok);
  console.log(`\nОтчёт: ${args.report}\nПровалено проверок: ${failed.length}`);
  process.exitCode = failed.length ? 2 : 0;
}

main().catch(async error => {
  const message = `# TaskBridge: перезапуск не удался\n\n${new Date().toISOString()}\n\n\`\`\`\n${error.stack || error.message}\n\`\`\`\n`;
  await fs.writeFile(path.join(dataRoot, 'restart-report.md'), message, 'utf8').catch(() => {});
  console.error(message);
  process.exitCode = 1;
});
