import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configDir, loadConfig, saveConfig } from '../src/config.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

async function sandbox(t, name) {
  await fs.mkdir('.local', { recursive: true });
  const root = await fs.mkdtemp(path.resolve(`.local/taskbridge-${name}-`));
  t.after(async () => {
    // A killed child releases its cwd/handles a moment later on Windows.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rm(root, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt >= 9 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) return;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  });
  return root;
}

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('without the variable the settings stay beside the program, as before', async t => {
  const root = await sandbox(t, 'config-default');
  await fs.writeFile(path.join(root, 'config.example.json'), '{"pi":{"command":"example"}}');
  assert.equal(configDir(root, {}), path.resolve(root));
  assert.deepEqual(await loadConfig(root), { pi: { command: 'example' } });
  assert.equal(await fs.readFile(path.join(root, 'config.json'), 'utf8'), '{"pi":{"command":"example"}}');
  const config = await loadConfig(root);
  config.cloud = { enabled: true };
  await saveConfig(root, config);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')).cloud.enabled, true);
});

test('an explicit config directory wins and is created on first read', async t => {
  const root = await sandbox(t, 'config-explicit');
  const dir = path.join(root, 'данные пользователя', 'config');
  await fs.writeFile(path.join(root, 'config.example.json'), '{"pi":{"command":"example"}}');
  const env = { TASKBRIDGE_CONFIG_DIR: dir };
  assert.equal(configDir(root, env), path.resolve(dir));
  const config = await loadConfig(root, env);
  assert.equal(config.pi.command, 'example');
  assert.equal(await fs.readFile(path.join(dir, 'config.json'), 'utf8'), '{"pi":{"command":"example"}}');
  assert.equal(await fs.stat(path.join(root, 'config.json')).then(() => true, () => false), false, 'program directory stays clean');
  config.server = { port: 1234 };
  await saveConfig(root, config, env);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).server.port, 1234);
  assert.equal(await fs.stat(path.join(root, 'config.json')).then(() => true, () => false), false);
});

test('a blank variable is treated as unset, not as the current directory', async t => {
  const root = await sandbox(t, 'config-blank');
  await fs.writeFile(path.join(root, 'config.example.json'), '{}');
  assert.equal(configDir(root, { TASKBRIDGE_CONFIG_DIR: '   ' }), path.resolve(root));
  await loadConfig(root, { TASKBRIDGE_CONFIG_DIR: '   ' });
  assert.equal(await fs.stat(path.join(root, 'config.json')).then(() => true, () => false), true);
});

test('the server reads and writes settings outside its read-only program tree', { timeout: 40000 }, async t => {
  const root = await sandbox(t, 'config-server');
  const program = path.join(root, 'program');
  const configs = path.join(root, 'user', 'config');
  const data = path.join(root, 'user', 'data');
  const agent = path.join(root, 'user', 'pi-agent');
  for (const dir of ['src', 'web', 'pi-extension']) await fs.cp(path.join(repo, dir), path.join(program, dir), { recursive: true });
  for (const file of ['package.json', 'config.example.json']) await fs.copyFile(path.join(repo, file), path.join(program, file));
  await fs.copyFile(path.join(repo, 'tests', 'fake-pi.mjs'), path.join(program, 'fake-pi.mjs'));
  const pi = path.join(program, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  await fs.writeFile(pi, process.platform === 'win32'
    ? `@echo off\r\nnode "${path.join(program, 'fake-pi.mjs')}" %*\r\n`
    : `#!/bin/sh\nexec node '${path.join(program, 'fake-pi.mjs')}' "$@"\n`, { mode: 0o755 });
  await fs.mkdir(configs, { recursive: true });
  // This shell may run inside a live TaskBridge session (TASKBRIDGE_PORT and
  // friends point at the operator's server). Inheriting them made the child
  // bind that very port, so the fixture must start hermetic.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(TASKBRIDGE_|PI_AGENT_DIR|PI_CODING_AGENT_DIR)/.test(name)));
  const env = { ...inherited, TASKBRIDGE_CONFIG_DIR: configs, TASKBRIDGE_DATA_DIR: data, PI_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, TASKBRIDGE_PROJECT_MEMORY_ROOT: path.join(root, 'memory') };
  // A probed port can still be blocked by a lingering socket on Windows, so a
  // failed bind reallocates instead of failing the test.
  let child = null;
  let port = null;
  let log = '';
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise(resolve => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  };
  t.after(stop);
  for (let attempt = 0; attempt < 6; attempt++) {
    port = await freePort();
    const config = { server: { host: '127.0.0.1', port }, pi: { command: pi, projectTrust: 'deny' }, projects: [{ id: 'fixture', name: 'Fixture', path: program, useWorktree: false }] };
    await fs.writeFile(path.join(configs, 'config.json'), JSON.stringify(config));
    log = '';
    child = spawn(process.execPath, [path.join(program, 'src', 'server.mjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', x => { log += x; });
    child.stderr.on('data', x => { log += x; });
    // The child is only known to hold the port once it answers; a bind that
    // collides shows up as a fast exit and is retried on a fresh port.
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null || /EADDRINUSE/.test(log)) break;
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (child.exitCode === null && !/EADDRINUSE/.test(log)) break;
    await stop();
  }
  const api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${log}`);
    try { if ((await api('/api/health')).status === 200) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(ready, `server did not answer: ${log}`);
  const workspace = path.join(root, 'workspace-two');
  await fs.mkdir(workspace);
  const created = await api('/api/projects/local-register', { name: 'Added by test', path: workspace });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const saved = JSON.parse(await fs.readFile(path.join(configs, 'config.json'), 'utf8'));
  assert.deepEqual(saved.projects.map(project => project.id).sort(), ['fixture', created.body.id].sort());
  assert.equal(await fs.stat(path.join(program, 'config.json')).then(() => true, () => false), false, 'no settings written into the program directory');
  assert.equal(JSON.parse(await fs.readFile(path.join(configs, 'config.json'), 'utf8')).pi.command, pi, 'the original file was edited in place, not replaced by the example');
  assert.equal(await fs.stat(path.join(data, 'taskbridge.db')).then(() => true, () => false), true, 'session data lands in the configured store');
});
