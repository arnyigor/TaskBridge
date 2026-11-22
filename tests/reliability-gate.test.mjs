import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { processOwnership } from '../src/instance-lock.mjs';

// REL-SRE-01: TaskBridge must survive the loss of all its Node processes.
//
// The test owns every process it creates: its own data dir, its own public port,
// LAN_TLS=off (production owns 8443), and kills only the exact PIDs recorded in
// that data dir after proving `processOwnership() === 'ours'`. No image-name
// kill, no production stop. `taskbridge ensure` is the same entrypoint the
// Windows scheduled task runs.
const root = fileURLToPath(new URL('..', import.meta.url));
const productionData = path.join(root, 'data');
const enabled = process.platform === 'win32' && process.env.RELIABILITY_GATE === '1';
const gate = enabled ? test : test.skip;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function health(port, timeoutMs = 2000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch { return false; }
}

async function info(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

async function waitFor(deadlineMs, stepMs, probe) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const hit = await probe();
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await sleep(stepMs);
  }
}

const run = (args, env, timeout = 120_000) => spawnSync(process.execPath, args, {
  cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout, windowsHide: true,
});

function stopOwned(pid, entrypoint) {
  if (!pid) return;
  assert.equal(processOwnership(pid, entrypoint), 'ours', `refusing to kill PID ${pid}: ownership is not proven`);
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
}

async function stopStaging(dir, port) {
  const env = { TASKBRIDGE_DATA_DIR: dir, LAN_PORT: String(port), LAN_HOST: '127.0.0.1', LAN_TLS: 'off' };
  const result = run(['scripts/start-lan.mjs', 'stop'], env, 30_000);
  if (result.status === 0) return;
  // Cleanup must stay exact too: read the state this test owns, verify, kill.
  const state = readJson(path.join(dir, 'lan.json'));
  const supervisor = readJson(path.join(dir, 'lan-supervisor.json'));
  stopOwned(supervisor?.pid, 'lan-supervisor.mjs');
  stopOwned(state?.proxyPid, 'proxy.mjs');
  stopOwned(state?.appPid, 'server.mjs');
}

gate('REL-SRE-01: after all owned Node processes die, the external ensure restores one pair twice', { timeout: 300_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-rel-sre-'));
  const port = await freePort();
  const env = { TASKBRIDGE_DATA_DIR: dir, LAN_PORT: String(port), LAN_HOST: '127.0.0.1', LAN_TLS: 'off' };
  const productionBefore = readJson(path.join(productionData, 'lan.json'));
  const productionHealthBefore = await health(8787, 5000);
  t.after(async () => {
    await stopStaging(dir, port);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 1. Own isolated pair.
  const started = run(['scripts/start-lan.mjs', 'start'], env);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  assert.ok(await waitFor(30_000, 250, () => health(port)), 'staging public health did not come up');
  const first = readJson(path.join(dir, 'lan.json'));
  const firstInfo = await info(port);
  assert.ok(first?.appPid && first?.proxyPid && first?.internalPort, 'staging lan.json is incomplete');
  assert.ok(firstInfo?.storeId && firstInfo?.bootId, 'staging /api/info has no identity');
  assert.equal(await health(8787, 5000), productionHealthBefore, 'production health changed before the fault');

  for (const cycle of [1, 2]) {
    const previous = readJson(path.join(dir, 'lan.json'));
    const previousInfo = await info(port);
    const supervisor = readJson(path.join(dir, 'lan-supervisor.json'));

    // 2. Kill the supervisor first (otherwise it races the fault), then proxy and
    //    app. Every kill is by exact PID after ownership proof; /T is the test's
    //    own process tree, never an image-name kill.
    stopOwned(supervisor?.pid, 'lan-supervisor.mjs');
    stopOwned(previous?.proxyPid, 'proxy.mjs');
    stopOwned(previous?.appPid, 'server.mjs');
    const down = await waitFor(20_000, 200, async () => !(await health(port)));
    assert.ok(down, `cycle ${cycle}: staging pair is still answering after the kill`);

    // 3. The external mechanism: exactly what Task Scheduler runs.
    const ensured = run(['bin/taskbridge.mjs', 'ensure'], env, 180_000);
    assert.equal(ensured.status, 0, ensured.stderr || ensured.stdout);

    // 4. One correct pair, same store, new boot, recovery recorded.
    const restored = readJson(path.join(dir, 'lan.json'));
    assert.ok(restored?.appPid && restored?.proxyPid, `cycle ${cycle}: ensure did not write a pair`);
    assert.notEqual(restored.appPid, previous.appPid, `cycle ${cycle}: app PID was not replaced`);
    assert.notEqual(restored.proxyPid, previous.proxyPid, `cycle ${cycle}: proxy PID was not replaced`);
    assert.equal(restored.publicPort, port, `cycle ${cycle}: public port moved`);
    assert.ok(await waitFor(30_000, 250, () => health(port)), `cycle ${cycle}: restored public health missing`);
    const restoredInfo = await info(port);
    assert.equal(restoredInfo.storeId, previousInfo.storeId, `cycle ${cycle}: storeId changed`);
    assert.notEqual(restoredInfo.bootId, previousInfo.bootId, `cycle ${cycle}: bootId did not change`);
    assert.ok(restoredInfo.watchdog?.lastCheckAt, `cycle ${cycle}: /api/info has no watchdog state`);
    assert.equal(restoredInfo.watchdog.stale, false, `cycle ${cycle}: /api/info watchdog state is stale`);
    assert.equal(restoredInfo.watchdog.storeId, restoredInfo.storeId, `cycle ${cycle}: watchdog saw another store`);

    const watchdog = readJson(path.join(dir, 'watchdog-state.json'));
    assert.equal(watchdog?.healthy, true, `cycle ${cycle}: watchdog state is not healthy`);
    assert.ok(watchdog?.lastRecoveryAt, `cycle ${cycle}: lastRecoveryAt was not recorded`);
    assert.ok(watchdog?.bootId, `cycle ${cycle}: watchdog state has no bootId`);
    assert.ok(watchdog?.storeId, `cycle ${cycle}: watchdog state has no storeId`);

    // 5. Exactly one listener for app and proxy, owned by the restored PIDs.
    const listenPids = (await import('../src/lan-ports.mjs')).listeningPids;
    assert.deepEqual(await listenPids(port), [restored.proxyPid], `cycle ${cycle}: more than one public listener`);
    assert.deepEqual(await listenPids(restored.internalPort), [restored.appPid], `cycle ${cycle}: more than one app listener`);
  }

  // 6. Production was never touched.
  assert.equal(await waitFor(10_000, 500, () => health(8787, 3000)), true, 'production health changed during the gate');
  const productionAfter = readJson(path.join(productionData, 'lan.json'));
  assert.equal(productionAfter?.appPid, productionBefore?.appPid, 'production app PID changed during the gate');
  assert.equal(productionAfter?.proxyPid, productionBefore?.proxyPid, 'production proxy PID changed during the gate');
});

gate('a foreign listener makes ensure fail safely and exit nonzero', { timeout: 120_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-rel-foreign-'));
  const port = await freePort();
  const foreign = http.createServer((request, response) => {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not TaskBridge');
  });
  foreign.on('clientError', (error, socket) => { try { socket.destroy(); } catch { /* gone */ } });
  await new Promise(resolve => foreign.listen(port, '127.0.0.1', resolve));
  const productionHealthBefore = await health(8787, 5000);
  t.after(async () => {
    foreign.closeAllConnections();
    await new Promise(resolve => foreign.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ensured = run(['bin/taskbridge.mjs', 'ensure'], {
    TASKBRIDGE_DATA_DIR: dir, LAN_PORT: String(port), LAN_HOST: '127.0.0.1', LAN_TLS: 'off',
  }, 120_000);
  assert.equal(ensured.status, 1, 'a foreign port must not be reported as a successful recovery');

  const watchdog = readJson(path.join(dir, 'watchdog-state.json'));
  assert.equal(watchdog?.healthy, false, 'failed ensure must record unhealthy');
  assert.ok(watchdog?.lastError, 'failed ensure must record lastError');
  assert.equal(await waitFor(10_000, 500, () => health(8787, 3000)), true, 'production health changed during the foreign-port gate');
  assert.equal(foreign.listening, true, 'the foreign listener must not be killed');
});

gate('two concurrent ensures still produce exactly one pair', { timeout: 240_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-rel-race-'));
  const port = await freePort();
  const env = { ...process.env, TASKBRIDGE_DATA_DIR: dir, LAN_PORT: String(port), LAN_HOST: '127.0.0.1', LAN_TLS: 'off' };
  const productionBefore = readJson(path.join(productionData, 'lan.json'));
  t.after(async () => {
    await stopStaging(dir, port);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const started = run(['scripts/start-lan.mjs', 'start'], env);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  assert.ok(await waitFor(30_000, 250, () => health(port)), 'staging pair did not start');
  const before = await info(port);
  const supervisor = readJson(path.join(dir, 'lan-supervisor.json'));
  const state = readJson(path.join(dir, 'lan.json'));
  stopOwned(supervisor?.pid, 'lan-supervisor.mjs');
  stopOwned(state?.proxyPid, 'proxy.mjs');
  stopOwned(state?.appPid, 'server.mjs');
  assert.ok(await waitFor(20_000, 200, async () => !(await health(port))), 'staging pair still answers after the kill');

  const ensure = () => new Promise(resolve => {
    const child = spawn(process.execPath, ['bin/taskbridge.mjs', 'ensure'], { cwd: root, env, stdio: 'ignore' });
    child.on('close', code => resolve(code));
    child.on('error', () => resolve(-1));
  });
  const codes = await Promise.all([ensure(), ensure()]);
  assert.ok(codes.some(code => code === 0), `both concurrent ensures failed: ${codes.join(', ')}`);
  assert.ok(await waitFor(30_000, 250, () => health(port)), 'no pair after concurrent ensures');

  const restored = readJson(path.join(dir, 'lan.json'));
  assert.ok(restored?.appPid && restored?.proxyPid, 'concurrent ensures did not produce a pair');
  const restoredInfo = await info(port);
  assert.equal(restoredInfo.storeId, before.storeId, 'storeId changed across concurrent ensures');
  const listeningPids = (await import('../src/lan-ports.mjs')).listeningPids;
  assert.deepEqual(await listeningPids(port), [restored.proxyPid], 'more than one public listener after concurrent ensures');
  assert.deepEqual(await listeningPids(restored.internalPort), [restored.appPid], 'more than one app listener after concurrent ensures');
  assert.equal(await waitFor(10_000, 500, () => health(8787, 3000)), true, 'production health changed during the concurrency gate');
  assert.equal(readJson(path.join(productionData, 'lan.json'))?.appPid, productionBefore?.appPid, 'production app PID changed');
});

