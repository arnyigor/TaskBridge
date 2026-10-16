import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function startFixture(port, overrides = {}) {
  const fixedPort = Boolean(port);
  const allocatePort = overrides.allocatePort || (async () => {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const selected = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return selected;
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-http-test-'));
  const repo = fileURLToPath(new URL('..', import.meta.url));
  await fs.cp(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
  await fs.cp(path.join(repo, 'web'), path.join(root, 'web'), { recursive: true });
  await fs.cp(path.join(repo, 'pi-extension'), path.join(root, 'pi-extension'), { recursive: true });
  await fs.copyFile(new URL('fake-pi.mjs', import.meta.url), path.join(root, 'fake-pi.mjs'));
  const command = path.join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  await fs.writeFile(command, process.platform === 'win32' ? `@echo off\r\nnode "${path.join(root, 'fake-pi.mjs')}" %*\r\n` : `#!/bin/sh\nexec node '${path.join(root, 'fake-pi.mjs')}' "$@"\n`, { mode: 0o755 });
  if (!port) port = await allocatePort();
  const fixtureConfig = {
    server: { host: '127.0.0.1', port, ...(overrides.server || {}) },
    pi: { command, projectTrust: 'deny' },
    localRuntime: {},
    projects: [{ id: 'fixture', name: 'Тестовая сессия', path: root, useWorktree: false }],
    ...(overrides.root || {})
  };
  const writeConfig = () => fs.writeFile(path.join(root, 'config.json'), JSON.stringify(fixtureConfig));
  await writeConfig();
  let logs = '';
  let listening = false;
  let launchError = null;
  const launch = () => {
    listening = false;
    launchError = null;
    let startupOutput = '';
    // Fixture servers must be hermetic: the developer's own TASKBRIDGE_* settings
    // (usually a machine secret exported for a real cloud deploy) would otherwise
    // leak in and make cloud tests pass or fail per machine. Tests that need a
    // value pass it explicitly through overrides.env.
    const providerKeys = new Set(['DEEPSEEK_API_KEY', 'WORMSOFT_API_KEY', 'ROUTERAI_API_KEY']);
    const inherited = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith('TASKBRIDGE_') && !providerKeys.has(key)));
    const child = spawn(process.execPath, [...(overrides.nodeArgs || []), 'src/server.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...inherited,
      // Память проекта — внутри каталога фикстуры. Без этого сервер писал предложения
      // памяти в НАСТОЯЩИЙ архив оператора: <Домашний>/.pi/memory-md/taskbridge-http-test-*
      // (2026-10-14 в архиве накопилось 121 таких каталогов). Тесты не должны
      // трогать данные за пределами своего временного корня.
      TASKBRIDGE_PROJECT_MEMORY_ROOT: path.join(root, 'memory-md'),
      ...(overrides.env || {}),
    } });
    child.stdout.on('data', data => {
      logs += data;
      if (!listening) {
        startupOutput += data;
        listening = startupOutput.includes('TaskBridge MVP listening on ');
      }
    });
    child.stderr.on('data', data => { logs += data; });
    child.on('error', error => { launchError = error; });
    return child;
  };
  let proc = launch();
  let base = `http://127.0.0.1:${port}`;
  const api = async (route, body, method) => {
    const response = await fetch(base + route, { method: method || (body ? 'POST' : 'GET'), ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error), { code: data.code, status: response.status, ...(Number.isInteger(data.protectedPid) ? { protectedPid: data.protectedPid } : {}) });
    return data;
  };
  const waitReady = async () => {
  let ready = false;
  // 12s headroom: a loaded CI runner (Windows especially) can need several
  // seconds just to spawn the child and answer the first health probe.
  for (let i = 0; i < 240; i++) {
    if (launchError || proc.exitCode !== null || proc.signalCode !== null) {
      throw Object.assign(new Error(`Fixture startup failed: ${logs}`), { code: /EADDRINUSE/.test(logs) ? 'EADDRINUSE' : launchError?.code });
    }
    // A health response alone may belong to another fixture that won the port.
    if (listening) try { await api('/api/health'); ready = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!ready) throw new Error(`Fixture startup failed: ${logs}`);
  };
  const stop = async () => {
    if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
    if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    else proc.kill();
    if (proc.exitCode === null) await new Promise(resolve => proc.once('close', resolve));
  };
  const cleanupRoot = async () => {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('taskbridge-http-test-')) throw new Error('Invalid fixture cleanup root');
    for (let attempt = 0; ; attempt++) {
      try { await fs.rm(root, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt >= 9 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  };
  try {
    for (let attempt = 0; ; attempt++) {
      try { await waitReady(); break; }
      catch (error) {
        await stop();
        // Reallocate a contended ephemeral port before a test starts. Explicit
        // ports fail closed; no test or application command is retried.
        if (fixedPort || error.code !== 'EADDRINUSE' || attempt >= 4) throw error;
        port = await allocatePort();
        fixtureConfig.server.port = port;
        base = `http://127.0.0.1:${port}`;
        logs = '';
        await writeConfig();
        proc = launch();
      }
    }
  } catch (error) {
    await cleanupRoot();
    throw error;
  }
  return { base, root, api, get appPid() { return proc.pid; }, logs: () => logs, restart: async (pauseMs = 0) => {
    // pauseMs — окно, когда сервер недоступен: на нём проверяется двухуровневый
    // health в клиенте (план 4.2) — поток оборван, /api/health тоже не отвечает.
    await stop();
    if (pauseMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(pauseMs, 60_000)));
    proc = launch();
    await waitReady();
  }, close: async () => {
    await stop();
    // A killed process tree releases its cwd/handles a moment after the parent
    // is gone; on Windows that surfaces as EBUSY/EPERM on rmdir. Retry instead
    // of failing a passing test at teardown.
    await cleanupRoot();
  } };
}

if (process.argv.includes('--serve')) {
  const fixture = await startFixture(8788);
  console.log(`Fixture UI: ${fixture.base}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await fixture.close(); process.exit(); });
}
