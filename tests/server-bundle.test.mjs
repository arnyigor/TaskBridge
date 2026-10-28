import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

async function sandbox(t, name) {
  await fs.mkdir('.local', { recursive: true });
  const root = await fs.mkdtemp(path.resolve(`.local/taskbridge-${name}-`));
  t.after(async () => {
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

test('the bundle is reproducible, self-describing and runs without a repository', { timeout: 60000 }, async t => {
  const root = await sandbox(t, 'bundle');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  for (const out of [first, second]) await promisify(execFile)(process.execPath, [path.join(repo, 'scripts', 'build-server-bundle.mjs'), '--out', out], { cwd: repo, timeout: 60000 });

  const manifest = JSON.parse(await fs.readFile(path.join(first, 'release-manifest.json'), 'utf8'));
  const repeat = JSON.parse(await fs.readFile(path.join(second, 'release-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files, repeat.files, 'two builds from the same tree hash identically');
  const version = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8')).version;
  assert.equal(manifest.product, 'TaskBridge');
  assert.equal(manifest.version, version);
  assert.match(manifest.node.required, />=22\.13/);
  assert.equal(manifest.runtimeDependencies.nodeModulesBundled, false);

  // Every declared file exists with exactly the recorded bytes, and nothing else
  // hides in the bundle (a stale config.json or a stray log would ship the
  // operator's state to the next machine).
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const bytes = await fs.readFile(path.join(first, rel));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), hash, rel);
  }
  for (const forbidden of ['node_modules', 'data', 'config.json', '.git']) {
    assert.equal(await fs.stat(path.join(first, forbidden)).then(() => true, () => false), false, `${forbidden} must not be bundled`);
  }
  const logs = Object.keys(manifest.files).filter(rel => rel.endsWith('.log'));
  assert.deepEqual(logs, []);

  // The point of the bundle: the settings and the state live outside it.
  const configs = path.join(root, 'settings');
  const data = path.join(root, 'state');
  const agent = path.join(root, 'agent');
  await fs.mkdir(configs, { recursive: true });
  const pi = path.join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  await fs.writeFile(pi, process.platform === 'win32'
    ? `@echo off\r\nexit /b 1\r\n`
    : `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(TASKBRIDGE_|PI_AGENT_DIR|PI_CODING_AGENT_DIR)/.test(name)));
  const env = { ...inherited, TASKBRIDGE_CONFIG_DIR: configs, TASKBRIDGE_DATA_DIR: data, PI_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, PATH: '' };

  let child = null;
  let port = null;
  let log = '';
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise(resolve => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  };
  t.after(stop);
  let healthy = false;
  for (let attempt = 0; attempt < 6 && !healthy; attempt++) {
    port = await freePort();
    await fs.writeFile(path.join(configs, 'config.json'), JSON.stringify({ server: { host: '127.0.0.1', port }, pi: { command: pi, projectTrust: 'deny' }, projects: [] }));
    log = '';
    child = spawn(process.execPath, [path.join(first, 'src', 'server.mjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', x => { log += x; });
    child.stderr.on('data', x => { log += x; });
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null || /EADDRINUSE/.test(log)) break;
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { healthy = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!healthy) await stop();
  }
  assert(healthy, `bundle did not start: ${log}`);
  const tasks = await fetch(`http://127.0.0.1:${port}/api/tasks`);
  assert.equal(tasks.status, 200);
  assert.deepEqual(await tasks.json(), []);
  for (const asset of manifest.runtimeDependencies.browserVendored) {
    const response = await fetch(`http://127.0.0.1:${port}/${asset.slice('web/'.length)}`);
    assert.equal(response.status, 200, asset);
  }
  assert.equal(await fs.stat(path.join(data, 'taskbridge.db')).then(() => true, () => false), true, 'state stayed outside the bundle');
  assert.equal(await fs.stat(path.join(first, 'config.json')).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(first, 'data')).then(() => true, () => false), false);
});
