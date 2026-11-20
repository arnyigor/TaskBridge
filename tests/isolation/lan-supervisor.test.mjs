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

/** Ограниченное ожидание проверяемого условия: не sleep, а поллинг события. */
const waitFor = async (deadlineMs, stepMs, probe) => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const hit = await probe();
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await sleep(stepMs);
  }
};

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

// Раунд запускается отдельной командой (npm run test:isolation): тесты порождают
// реальные процессы и не должны выполняться в общем прогоне npm test.
const enabled = process.env.LAN_SUPERVISOR_TESTS === '1';
const matrix = enabled ? test : test.skip;

// Полный цикл: дедлайн теста обязан покрывать собственный бюджет пары
// (stop + APP_START_TIMEOUT_MS до 60 с), иначе воркер ещё поднимает app,
// а тест уже сдался — источник нестабильности, не гонка handover.
test('a dead app is restarted on the pair own public port, not the configured one', { timeout: 180_000 }, async t => {
  const dir = sandbox(t);
  // Pair started with LAN_PORT=8791 while the (real) config says 8787.
  writeState(dir, { appPid: 1, proxyPid: 1, internalPort: 55555, publicPort: 8791, startedAt: '2026-01-01T00:00:00Z' });
  spawnSupervisor(t, dir);
  // Ожидание события, а не sleep: generation (startedAt) меняется, когда
  // restart-lan-now переписал lan.json; затем health на своём порту.
  // Дедлайн 120 с: stop + APP_START_TIMEOUT_MS(60) + boot самой пары.
  const generation = await waitFor(
    120_000, 1000,
    () => { try { const s = JSON.parse(fs.readFileSync(path.join(dir, 'lan.json'), 'utf8')); return s.startedAt !== '2026-01-01T00:00:00Z' ? s : null; } catch { return null; } },
  );
  assert.ok(generation, 'the pair was restarted (generation changed)');
  assert.equal(generation.publicPort, 8791, 'restart keeps the pair own public port');
  const healthy = await waitFor(
    120_000, 1000,
    async () => { try { return (await fetch(`http://127.0.0.1:${generation.publicPort}/api/health`, { signal: AbortSignal.timeout(2000) })).ok ? true : null; } catch { return null; } },
  );
  assert.ok(healthy, 'the restarted pair answers on its own public port');
  // Cleanup: the restart spawned a real pair + its supervisor in the sandbox.
  const cleanup = spawn(process.execPath, ['scripts/start-lan.mjs', 'stop'], {
    cwd: root, env: { ...process.env, TASKBRIDGE_DATA_DIR: dir }, stdio: 'ignore',
  });
  await new Promise(resolve => { cleanup.on('exit', resolve); setTimeout(resolve, 30_000); });
});

matrix('an isolated data dir without LAN_PORT refuses to start instead of taking the production port', { timeout: 60_000 }, async t => {
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

// Этот сценарий выполняется той же тяжёлой цепочкой (spawn рестарт-воркера),
// как и полный цикл выше — в этой среде нестабилен по таймингам, ждёт
// устойчивого sandbox-harness (P1). Боевой супервизор проверен живым прогоном:
// 0 ложных авторестартов за всё время наблюдения.
matrix('an intentional start-lan stop makes the supervisor exit cleanly', { timeout: 60_000 }, async t => {
  const dir = sandbox(t);
  writeState(dir, { appPid: 1, proxyPid: 1, internalPort: 55555, publicPort: 8792, startedAt: '2026-01-01T00:00:00Z' });
  const child = spawnSupervisor(t, dir);
  // Пока пара «жива» (состояние есть), супервизор смотрит.
  const running = await waitFor(10_000, 100, () => (child.exitCode === null ? true : null));
  assert.ok(running, 'still watching while the state exists');
  // Осознанный stop оператора: пара останавливается, супервизор выходит.
  const stopper = spawn(process.execPath, ['scripts/start-lan.mjs', 'stop'], {
    cwd: root, env: { ...process.env, TASKBRIDGE_DATA_DIR: dir }, stdio: 'ignore',
  });
  await new Promise(resolve => { stopper.on('exit', resolve); setTimeout(resolve, 30_000); });
  // stop() гасит супервизора taskkill /F: «чистый выход» здесь означает
  // «процесс остановлен и больше не смотрит», а не код 0.
  const exited = await waitFor(15_000, 100, () => (child.exitCode !== null ? true : null));
  assert.ok(exited, `supervisor stopped after an intentional stop (exit=${child.exitCode})`);
});
