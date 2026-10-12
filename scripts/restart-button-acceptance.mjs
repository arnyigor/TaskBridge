#!/usr/bin/env node
// Process-level acceptance for the «Перезапустить сервер» button.
//
// The button (web/app.js, KMP SessionList.restartServer) POSTs /api/server/restart to a
// LIVE server; the server answers 202 and hands the restart to a detached helper
// (scripts/restart-lan-now.mjs), which stops and starts the pair through
// scripts/start-lan.mjs. This script runs that whole chain for real — the button cannot
// be verified without a live server to ask (and that is exactly how it failed on
// 2026-10-12: the server had been killed, so there was nobody to accept the request).
//
// The operator's live pair is never touched: the check has its own data root
// (TASKBRIDGE_DATA_DIR) and its own public port (LAN_PORT), and `start-lan.mjs stop`
// kills only PIDs from ITS lan.json, after an identity check.
//
// Deliberately NOT part of `npm test` (it spawns processes, like lan-acceptance.mjs).
// Run explicitly:  npm run restart:button
//
// Exit code 0 = PASS, non-zero = FAIL. Output: ✅/❌ per step.

import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve('.');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
});
const lifecycle = (command, dataDir, port) => run(process.execPath, ['scripts/start-lan.mjs', command], {
  cwd: ROOT, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, TASKBRIDGE_DATA_DIR: dataDir, LAN_PORT: String(port) },
});
const health = async url => {
  try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
};
const bootId = async url => {
  try { return (await (await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(5000) })).json()).bootId; } catch { return null; }
};

let failed = false;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
};

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-restart-check-'));
const publicPort = await freePort();
console.log(`данные: ${dataDir}\nпубличный порт проверки: ${publicPort}\n`);

try {
  const started = await lifecycle('start', dataDir, publicPort);
  const before = JSON.parse(await fs.readFile(path.join(dataDir, 'lan.json'), 'utf8'));
  console.log(started.stdout.trim().split('\n').slice(-4).join('\n'), '\n');
  check('одноразовая пара поднялась', await health(`http://127.0.0.1:${publicPort}`),
    `app ${before.appPid}, proxy ${before.proxyPid}, внутренний порт ${before.internalPort}`);
  const first = await bootId(`http://127.0.0.1:${publicPort}`);
  check('bootId читается до перезапуска', Boolean(first), first || 'нет');

  // Тот же запрос, что шлёт кнопка.
  const response = await fetch(`http://127.0.0.1:${before.internalPort}/api/server/restart`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
  });
  const body = await response.json().catch(() => null);
  check('сервер ответил 202', response.status === 202, JSON.stringify(body));
  check('режим lan, helper запущен', body?.mode === 'lan' && Number.isFinite(body?.pid), JSON.stringify(body));

  // 202 значит только «helper запланирован»: успех — новый bootId.
  let second = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    second = await bootId(`http://127.0.0.1:${publicPort}`);
    if (second && second !== first) break;
  }
  check('после перезапуска новый bootId', Boolean(second) && second !== first, `${first} -> ${second}`);

  const after = JSON.parse(await fs.readFile(path.join(dataDir, 'lan.json'), 'utf8'));
  check('в lan.json новые PID', after.appPid !== before.appPid && after.proxyPid !== before.proxyPid,
    `app ${before.appPid}->${after.appPid}, proxy ${before.proxyPid}->${after.proxyPid}`);
  check('внутренний сервер отвечает', await health(`http://127.0.0.1:${after.internalPort}`), String(after.internalPort));
  check('прокси отвечает', await health(`http://127.0.0.1:${publicPort}`), String(publicPort));
  const report = await fs.readFile(path.join(dataDir, 'restart-report.md'), 'utf8').catch(() => null);
  check('отчёт перезапуска записан', Boolean(report) && report.includes('перезапуск LAN-пары'),
    (report || 'файла нет').split('\n')[0]);
} catch (error) {
  check('проверка дошла до конца', false, error?.message || String(error));
} finally {
  await lifecycle('stop', dataDir, publicPort).catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  console.log(`\nИТОГ: ${failed ? 'есть провалы' : 'всё сошлось'}`);
  process.exitCode = failed ? 1 : 0;
}
