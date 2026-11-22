import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Verifies the Windows side that the repository test cannot see: the installed
// task must point at the repaired VBS, the VBS must propagate the health result,
// and one on-demand run must advance watchdog state with LastTaskResult 0.
// It never stops production; it only asks the healthy pair to be checked.
const root = fileURLToPath(new URL('..', import.meta.url));
const enabled = process.platform === 'win32' && process.env.WATCHDOG_TASK_GATE === '1';
const gate = enabled ? test : test.skip;

const run = (file, args, timeout = 30_000) => spawnSync(file, args, {
  encoding: 'utf8', timeout, windowsHide: true,
});
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

gate('the installed Task Scheduler action uses the repaired health-aware watchdog', { timeout: 90_000 }, async () => {
  const xml = run('schtasks.exe', ['/query', '/tn', 'TaskBridge', '/xml']).stdout || '';
  assert.match(xml, /<LogonTrigger>/, 'the task must still be registered for logon');
  assert.match(xml, /<TimeTrigger>/, 'the task must still run periodically');
  assert.match(xml, /taskbridge-watchdog\.vbs/, 'the task action does not point at the watchdog VBS');

  const vbs = fs.readFileSync(path.join(root, '.local', 'taskbridge-watchdog.vbs'), 'utf8');
  assert.match(vbs, /rc = sh\.Run\("cmd \/d \/s \/c /, 'installed VBS still uses the broken command form');
  assert.match(vbs, /WScript\.Quit rc/, 'installed VBS drops the real exit code');

  const stateFile = path.join(root, 'data', 'watchdog-state.json');
  const before = readJson(stateFile)?.lastCheckAt || null;
  const started = run('schtasks.exe', ['/run', '/tn', 'TaskBridge']);
  assert.equal(started.status, 0, started.stderr || started.stdout);

  let state = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    state = readJson(stateFile);
    if (state?.lastCheckAt && state.lastCheckAt !== before) break;
    await sleep(500);
  }
  assert.ok(state?.lastCheckAt && state.lastCheckAt !== before, 'the scheduled task did not advance watchdog-state.json');
  assert.equal(state.healthy, true, 'the scheduled task recorded an unhealthy production');
  assert.ok(state.bootId && state.storeId, 'the scheduled task did not verify server identity');

  const info = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-ScheduledTaskInfo -TaskName TaskBridge).LastTaskResult']).stdout.trim();
  assert.equal(Number(info), 0, `LastTaskResult is not 0: ${info}`);

  const health = await fetch('http://127.0.0.1:8787/api/health', { signal: AbortSignal.timeout(3000) })
    .then(response => response.status).catch(() => 0);
  assert.equal(health, 200, 'production health changed during the watchdog-task check');
});
