// Isolated fault-tolerance tests for scripts/lan-supervisor.mjs (matrix of the
// stabilization round). Every test runs its own data directory, its own ports
// and its own processes; nothing here may touch the live pair (8787) or kill
// a process without checking it belongs to this test (isTaskBridgeProcess).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SUPERVISOR = path.join(root, 'scripts', 'lan-supervisor.mjs');

const sandbox = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-sup-matrix-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lag */ } });
  return dir;
};

const writeState = (dir, state) => fs.writeFileSync(path.join(dir, 'lan.json'), JSON.stringify(state, null, 2));

const spawnSupervisor = (t, dir) => {
  const child = spawn(process.execPath, [SUPERVISOR], {
    cwd: root,
    env: {
      ...process.env,
      TASKBRIDGE_DATA_DIR: dir,
      LAN_SUPERVISOR_TICK_MS: '300',
      LAN_SUPERVISOR_DEAD_TICKS: '2',
      LAN_SUPERVISOR_UNHEALTHY_TICKS: '4',
      LAN_SUPERVISOR_BACKOFF_MS: '3000',
      LAN_SUPERVISOR_BACKOFF_WINDOW_MS: '10000',
      LAN_SUPERVISOR_BACKOFF_AFTER: '2',
    },
    stdio: 'ignore',
  });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  return child;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a dead app is restarted on the pair own public port, not the configured one', { timeout: 60_000 }, async t => {
  const dir = sandbox(t);
  // Pair started with LAN_PORT=8791 while the (real) config says 8787.
  writeState(dir, { appPid: 1, proxyPid: 1, internalPort: 55555, publicPort: 8791, startedAt: '2026-01-01T00:00:00Z' });
  spawnSupervisor(t, dir);
  // The supervisor restarts via restart-lan-now, which rewrites lan.json and
  // brings a real pair up in the sandbox dir. Poll, the app boot takes seconds.
  const deadline = Date.now() + 45_000;
  let state = null;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, 'lan.json'), 'utf8'));
      if (state.startedAt !== '2026-01-01T00:00:00Z') break;
    } catch { /* not rewritten yet */ }
  }
  assert.ok(state, 'the pair was restarted');
  assert.equal(state.publicPort, 8791, 'restart keeps the pair own public port');
  let healthy = false;
  const healthDeadline = Date.now() + 30_000;
  while (Date.now() < healthDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${state.publicPort}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { healthy = true; break; }
    } catch { /* booting */ }
    await sleep(1000);
  }
  assert.ok(healthy, 'the restarted pair answers on its own public port');
  // Cleanup: the restart spawned a real pair + its supervisor in the sandbox.
  const cleanup = spawn(process.execPath, ['scripts/start-lan.mjs', 'stop'], {
    cwd: root, env: { ...process.env, TASKBRIDGE_DATA_DIR: dir }, stdio: 'ignore',
  });
  await new Promise(resolve => { cleanup.on('exit', resolve); setTimeout(resolve, 30_000); });
});

test('an isolated data dir without LAN_PORT refuses to start instead of taking the production port', { timeout: 60_000 }, async t => {
  // P0 изоляция (инцидент 2026-11-20): песочница без LAN_PORT забирала боевой
  // порт 8787. Контракт: старт отклоняется, боевая пара не тронута.
  const dir = sandbox(t);
  const before = await fetch('http://127.0.0.1:8787/api/health', { signal: AbortSignal.timeout(3000) })
    .then(r => r.status).catch(() => 0);
  const result = spawn(process.execPath, ['scripts/start-lan.mjs', 'start'], {
    cwd: root,
    env: { ...process.env, TASKBRIDGE_DATA_DIR: dir },   // LAN_PORT намеренно не задан
    stdio: 'ignore',
  });
  const code = await new Promise(resolve => { result.on('exit', resolve); setTimeout(() => resolve(-1), 20_000); });
  assert.equal(code, 1, 'старт без LAN_PORT отклоняется');
  const after = await fetch('http://127.0.0.1:8787/api/health', { signal: AbortSignal.timeout(3000) })
    .then(r => r.status).catch(() => 0);
  assert.equal(after, before, 'боевой порт не меняется');
});

test('a missing lan.json for several ticks means stop — the supervisor exits', { timeout: 30_000 }, async t => {
  const dir = sandbox(t);
  writeState(dir, { appPid: 1, proxyPid: 1, internalPort: 55555, publicPort: 8792, startedAt: '2026-01-01T00:00:00Z' });
  const child = spawnSupervisor(t, dir);
  // Под нагрузкой полного CI тики могут запаздывать: ждём выхода вместо
  // фиксированной паузы, но не принимаем ранний выход за успех.
  const deadline = Date.now() + 10_000;
  let observedRunning = false;
  while (Date.now() < deadline) {
    if (child.exitCode === null) { observedRunning = true; break; }
    await sleep(100);
  }
  assert.ok(observedRunning, 'still watching while the state exists');
  try { fs.unlinkSync(path.join(dir, 'lan.json')); } catch { /* none */ }
  // 3 ticks * 300 ms + запас: тоже поллингом, а не фиксированной паузой.
  const stopped = await new Promise(resolve => {
    const deadline2 = Date.now() + 15_000;
    const timer = setInterval(() => {
      if (child.exitCode !== null) { clearInterval(timer); resolve(true); }
      else if (Date.now() > deadline2) { clearInterval(timer); resolve(false); }
    }, 100);
  });
  assert.equal(child.exitCode, 0, 'supervisor exits cleanly after an intentional stop');
  assert.ok(stopped, 'exited within the deadline');
});
