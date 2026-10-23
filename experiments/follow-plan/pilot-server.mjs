#!/usr/bin/env node
// FP-PILOT-01: a hermetic TaskBridge with Follow Plan enabled, running a small
// Node project (CSV warehouse importer) that carries one real, undocumented defect.
//
//   node experiments/follow-plan/pilot-server.mjs start
//   node experiments/follow-plan/pilot-server.mjs stop
//
// Its own root, dataRoot, workspace, Pi agent dir and port. The operator's
// TaskBridge, config.json, data and Pi sessions are never read or written; only
// provider keys survive from the environment (the model needs them).
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const out = path.join(repo, '.local', 'fp-07');
const stand = path.join(out, 'stand');
const stateFile = path.join(out, 'server.json');
// The project under test lives in the repository so the pilot is reproducible.
const fixture = path.join(here, 'pilot-fixture');
const command = process.argv[2] || 'start';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const stopSaved = async () => {
  const saved = await fs.readFile(stateFile, 'utf8').then(JSON.parse, () => null);
  if (!saved?.pid) return false;
  if (process.platform === 'win32') {
    await new Promise(resolve => spawn('taskkill', ['/PID', String(saved.pid), '/T', '/F'], { windowsHide: true }).on('exit', resolve));
  } else { try { process.kill(saved.pid, 'SIGTERM'); } catch { /* gone */ } }
  await fs.rm(stateFile, { force: true });
  return true;
};

if (command === 'stop') {
  console.log(await stopSaved() ? 'стенд остановлен' : 'стенд не запущен');
  process.exit(0);
}

const freePort = async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
};

await stopSaved();
const root = path.join(stand, 'app');
const dataDir = path.join(stand, 'data');
const workspace = path.join(stand, 'workspace');
const agentDir = path.join(stand, 'pi-agent');
await fs.rm(stand, { recursive: true, force: true }).catch(() => {});
for (const dir of [root, dataDir, workspace, agentDir]) await fs.mkdir(dir, { recursive: true });
await fs.cp(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
await fs.cp(path.join(repo, 'web'), path.join(root, 'web'), { recursive: true });
await fs.cp(path.join(repo, 'pi-extension'), path.join(root, 'pi-extension'), { recursive: true });
await fs.copyFile(path.join(repo, 'package.json'), path.join(root, 'package.json'));
// The project under test: its own git repository, so diffs and re-runs stay clean.
await fs.cp(fixture, workspace, { recursive: true });
await new Promise(resolve => spawn('git', ['init', '-q'], { cwd: workspace, windowsHide: true }).on('exit', resolve));
await new Promise(resolve => spawn('git', ['add', '-A'], { cwd: workspace, windowsHide: true }).on('exit', resolve));
await new Promise(resolve => spawn('git', ['-c', 'user.email=pilot@example.invalid', '-c', 'user.name=Pilot', 'commit', '-qm', 'initial'], { cwd: workspace, windowsHide: true }).on('exit', resolve));

const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || await freePort();
const config = {
  server: { host: '127.0.0.1', port, auth: { enabled: false } },
  pi: { command: 'pi', projectTrust: 'approve', persistSessions: true, turnInstructions: { mode: 'legacy' } },
  projects: [{ id: 'pilot', name: 'FP-PILOT-01', path: workspace, useWorktree: false }],
  followPlan: {
    enabled: true,
    // The pilot budget from the task: 15 cycles, 30 minutes, 2 idle cycles.
    limits: { maxCycles: 15, budgetMs: 30 * 60 * 1000, noProgressLimit: 2, auditTurnsPerCycle: 1 }
  }
};
await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config, null, 2));

const inherited = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.startsWith('PI_') && !key.startsWith('TASKBRIDGE_')));
const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: root, windowsHide: true, detached: true, stdio: 'ignore',
  env: { ...inherited, PI_CODING_AGENT_DIR: agentDir, TASKBRIDGE_DATA_DIR: dataDir }
});
child.unref();

const base = `http://127.0.0.1:${port}`;
let ready = false;
for (let i = 0; i < 300; i++) {
  try { await fetch(`${base}/api/health`); ready = true; break; } catch { await sleep(100); }
}
if (!ready) { console.error('сервер не поднялся — смотри', root); process.exit(1); }
await fs.writeFile(stateFile, JSON.stringify({ pid: child.pid, port, base, root, workspace, startedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ base, pid: child.pid, workspace, plan: 'PLAN.md' }));
