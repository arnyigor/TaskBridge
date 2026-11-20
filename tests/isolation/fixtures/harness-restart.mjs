#!/usr/bin/env node
// Рестарт минимальной пары ДЛЯ ЕЁ ЖЕ фикстуры (tests/isolation/lan-supervisor.test.mjs).
// Контракт владения (P0 изоляция, ревью 2026-11-20):
//  1. работает только в каталоге данных, переданном родителем (TASKBRIDGE_DATA_DIR
//     содержит маркер tb-sup-matrix — каталог фикстуры);
//  2. публичный порт обязан лежать в тестовом диапазоне 8790-8799 — боевой 8787
//     недостижим;
//  3. убиваются только процессы, зарегистрированные в lan.json ЭТОЙ фикстуры;
//  4. при любом несоответствии — отказ без убийств.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DATA = process.env.TASKBRIDGE_DATA_DIR || '';
const marker = 'tb-sup-matrix';
if (!DATA.includes(marker)) {
  console.error('[harness-restart] отказ: каталог данных не принадлежит фикстуре');
  process.exit(1);
}
const statePath = path.join(DATA, 'lan.json');
let state;
try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); }
catch (error) { console.error('[harness-restart] нет lan.json:', error.message); process.exit(1); }
if (!(state.publicPort >= 8790 && state.publicPort <= 8799)) {
  console.error(`[harness-restart] отказ: публичный порт ${state.publicPort} вне тестового диапазона`);
  process.exit(1);
}
// Убить старую пару — процессы, зарегистрированные этой фикстурой.
const oldPids = [state.appPid, state.proxyPid].filter(Boolean);
for (const pid of oldPids) {
  try { process.kill(pid); console.log(`[harness-restart] stopped old pid ${pid}`); }
  catch { /* уже мёртв */ }
}
await new Promise(resolve => setTimeout(resolve, 300));

// Поднять новую пару: mini-app + mini-proxy (вторая копия mini-app на другом порту).
function startMini(port, markerEnv) {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'tests/isolation/fixtures/mini-app.mjs')], {
    env: { ...process.env, PORT: String(port), MINI_ROLE: markerEnv },
    stdio: 'ignore', detached: false,
  });
  return child;
}
const internalPort = state.internalPort;
const app = startMini(internalPort, 'app');
const proxy = startMini(state.publicPort, 'proxy');

// Health обеих частей, иначе фиксировать отказ (фикстура проверит).
const health = port => new Promise(resolve => {
  const deadline = Date.now() + 10_000;
  const attempt = () => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => { if (Date.now() < deadline) setTimeout(attempt, 200); else resolve(false); });
  };
  attempt();
});
const okInternal = await health(internalPort);
const okPublic = await health(state.publicPort);
if (!okInternal || !okPublic) {
  console.error('[harness-restart] новая пара не отвечает — отказ');
  process.exit(1);
}
const next = { appPid: app.pid, proxyPid: proxy.pid, internalPort, publicPort: state.publicPort, startedAt: new Date().toISOString() };
fs.writeFileSync(statePath, JSON.stringify(next, null, 2));
console.log(`[harness-restart] pair restarted: app ${app.pid}, proxy ${proxy.pid}, ports ${internalPort}/${state.publicPort}`);
