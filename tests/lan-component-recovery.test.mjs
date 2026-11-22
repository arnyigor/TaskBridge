import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { processOwnership } from '../src/instance-lock.mjs';

// S1: app and proxy recover independently. Every process is test-owned; kills
// are exact PIDs after ownership proof. The supervisor tick is stretched to
// 60 s so the recovery under test is the explicit `start-lan recover`, not a
// race with the supervisor.
const root = fileURLToPath(new URL('..', import.meta.url));
const enabled = process.platform === 'win32' && process.env.COMPONENT_RECOVERY === '1';
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
async function health(port, timeoutMs = 2500) {
  try { return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })).ok; }
  catch { return false; }
}
async function info(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(3000) })).json(); }
  catch { return null; }
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
function killOwned(pid, entrypoint) {
  assert.equal(processOwnership(pid, entrypoint), 'ours', `refusing to kill PID ${pid}: ownership not proven`);
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
}

gate('S1: proxy-only and app-only recovery keep the healthy half alive', { timeout: 300_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-components-'));
  const port = await freePort();
  const env = {
    TASKBRIDGE_DATA_DIR: dir,
    LAN_PORT: String(port),
    LAN_HOST: '127.0.0.1',
    LAN_TLS: 'off',
    LAN_SUPERVISOR_TICK_MS: '60000',
  };
  let wrongProxy = null;
  t.after(async () => {
    try { if (wrongProxy) wrongProxy.kill(); } catch { /* gone */ }
    run(['scripts/start-lan.mjs', 'stop'], env, 30_000);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const started = run(['scripts/start-lan.mjs', 'start'], env);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  assert.ok(await waitFor(30_000, 200, () => health(port)), 'pair did not start');
  const state = readJson(path.join(dir, 'lan.json'));
  const before = await info(port);
  assert.ok(state?.appPid && state?.proxyPid && state?.internalPort, 'incomplete lan.json');
  assert.ok(before?.storeId && before?.bootId, 'incomplete /api/info');

  // SSE probe through the real proxy.
  const sse = await fetch(`http://127.0.0.1:${port}/api/health/sse`, { signal: AbortSignal.timeout(5000) });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get('content-type') || '', /text\/event-stream/i);
  assert.match(await sse.text(), /event:\s*ready/u);

  // 1. Proxy dies; app stays.
  killOwned(state.proxyPid, 'proxy.mjs');
  assert.ok(await waitFor(15_000, 200, async () => !(await health(port))), 'proxy death did not close the public face');
  assert.equal(await health(state.internalPort), true, 'app should still be healthy after proxy death');
  const proxyRecovery = run(['scripts/start-lan.mjs', 'recover'], env);
  assert.equal(proxyRecovery.status, 0, proxyRecovery.stderr || proxyRecovery.stdout);
  const afterProxy = readJson(path.join(dir, 'lan.json'));
  assert.equal(afterProxy.appPid, state.appPid, 'app was restarted during proxy-only recovery');
  assert.notEqual(afterProxy.proxyPid, state.proxyPid, 'proxy PID was not replaced');
  assert.ok(await waitFor(20_000, 200, () => health(port)), 'public health did not return after proxy recovery');

  // 2. App dies; proxy stays, and the same proxy PID must survive.
  const proxyPid = afterProxy.proxyPid;
  killOwned(afterProxy.appPid, 'server.mjs');
  assert.ok(await waitFor(15_000, 200, async () => !(await health(afterProxy.internalPort))), 'app death did not stop internal health');
  const appRecovery = run(['scripts/start-lan.mjs', 'recover'], env);
  assert.equal(appRecovery.status, 0, appRecovery.stderr || appRecovery.stdout);
  const afterApp = readJson(path.join(dir, 'lan.json'));
  assert.equal(afterApp.proxyPid, proxyPid, 'proxy was restarted during app-only recovery');
  assert.notEqual(afterApp.appPid, afterProxy.appPid, 'app PID was not replaced');
  assert.equal(await health(afterApp.internalPort), true, 'app health missing after recovery');
  assert.ok(await waitFor(20_000, 200, () => health(port)), 'public health did not return after app recovery');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await health(port), true, `public face returned 502 after app recovery (attempt ${attempt + 1})`);
    await sleep(100);
  }
  const afterAppInfo = await info(port);
  assert.equal(afterAppInfo.storeId, before.storeId, 'storeId changed during component recovery');
  assert.notEqual(afterAppInfo.bootId, before.bootId, 'bootId did not change after app restart');

  // 3. Stale upstream: replace the proxy with one pointed at a wrong port while
  // the app is healthy, then prove recovery replaces only the proxy.
  const appPid = afterApp.appPid;
  const internalPort = afterApp.internalPort;
  killOwned(afterApp.proxyPid, 'proxy.mjs');
  assert.ok(await waitFor(15_000, 200, async () => !(await health(port))), 'proxy did not stop before stale-upstream fixture');
  const wrongUpstream = await freePort();
  wrongProxy = spawn(process.execPath, ['src/proxy.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      LAN_INTERNAL_PORT: String(wrongUpstream),
      LAN_PORT: String(port),
      LAN_HOST: '127.0.0.1',
      LAN_TLS: 'off',
    },
    stdio: 'ignore',
  });
  t.after(() => { try { wrongProxy?.kill(); } catch { /* gone */ } });
  assert.ok(await waitFor(15_000, 100, async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).status; }
    catch { return null; }
  }), 'stale proxy did not start');
  fs.writeFileSync(path.join(dir, 'lan.json'), JSON.stringify({ ...afterApp, proxyPid: wrongProxy.pid }, null, 2));
  const staleRecovery = run(['scripts/start-lan.mjs', 'recover'], env);
  assert.equal(staleRecovery.status, 0, staleRecovery.stderr || staleRecovery.stdout);
  const afterStale = readJson(path.join(dir, 'lan.json'));
  assert.equal(afterStale.appPid, appPid, 'app was restarted for a stale proxy');
  assert.notEqual(afterStale.proxyPid, wrongProxy.pid, 'stale proxy was not replaced');
  assert.equal(afterStale.internalPort, internalPort, 'internal port changed for a proxy-only issue');
  assert.ok(await waitFor(20_000, 200, () => health(port)), 'public health missing after stale-upstream recovery');

  // 4. Watchdog state records the deep SSE probe, not only HTTP liveness.
  const ensured = run(['bin/taskbridge.mjs', 'ensure'], env, 120_000);
  assert.equal(ensured.status, 0, ensured.stderr || ensured.stdout);
  const watchdog = readJson(path.join(dir, 'watchdog-state.json'));
  assert.equal(watchdog?.healthy, true);
  assert.equal(watchdog?.sseHealthy, true, 'watchdog did not record the SSE probe');
});

gate('S1: the supervisor recovers the failed half, not the whole pair', { timeout: 300_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-components-sup-'));
  const port = await freePort();
  const env = {
    TASKBRIDGE_DATA_DIR: dir,
    LAN_PORT: String(port),
    LAN_HOST: '127.0.0.1',
    LAN_TLS: 'off',
    LAN_SUPERVISOR_TICK_MS: '300',
    LAN_SUPERVISOR_DEAD_TICKS: '2',
    LAN_SUPERVISOR_BACKOFF_MS: '3000',
  };
  t.after(() => {
    run(['scripts/start-lan.mjs', 'stop'], env, 30_000);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const started = run(['scripts/start-lan.mjs', 'start'], env);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  assert.ok(await waitFor(30_000, 200, () => health(port)), 'pair did not start');
  const initial = readJson(path.join(dir, 'lan.json'));

  // Proxy dies; the supervisor must call `start-lan recover`, which replaces
  // only the proxy. A full restart would change appPid too.
  killOwned(initial.proxyPid, 'proxy.mjs');
  const afterProxy = await waitFor(30_000, 250, () => {
    const state = readJson(path.join(dir, 'lan.json'));
    return state && state.proxyPid !== initial.proxyPid ? state : null;
  });
  assert.ok(afterProxy, 'supervisor did not recover the dead proxy');
  assert.equal(afterProxy.appPid, initial.appPid, 'supervisor restarted the healthy app for a proxy failure');
  assert.ok(await waitFor(20_000, 250, () => health(port)), 'public health missing after supervisor proxy recovery');

  // App dies; the supervisor must keep the proxy PID and replace only the app.
  killOwned(afterProxy.appPid, 'server.mjs');
  const afterApp = await waitFor(30_000, 250, () => {
    const state = readJson(path.join(dir, 'lan.json'));
    return state && state.appPid !== afterProxy.appPid ? state : null;
  });
  assert.ok(afterApp, 'supervisor did not recover the dead app');
  assert.equal(afterApp.proxyPid, afterProxy.proxyPid, 'supervisor restarted the healthy proxy for an app failure');
  assert.ok(await waitFor(20_000, 250, () => health(port)), 'public health missing after supervisor app recovery');
});
