import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { renderWatchdogVbs, watchdogCommand } from '../scripts/watchdog-vbs.mjs';

// Incident 2026-11-22: after all TaskBridge node processes were killed, the
// external scheduled task ran every 3 minutes, reported LastTaskResult 0, and
// did nothing — data/watchdog.log did not even exist. The generated command was
// `cmd /c ""node.exe"" ...`; cmd stripped the outer quotes, split the program
// path at its space and never reached the redirection. The pair stayed down
// until a manual start. These tests execute the exact rendered VBS, so a broken
// template fails here instead of silently disabling recovery.

const windows = process.platform === 'win32';
const wscript = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');

test('watchdog command uses the cmd /d /s /c form that survives quoted paths', () => {
  const command = watchdogCommand({
    root: 'C:\\root with space',
    node: 'C:\\Program Files\\nodejs\\node.exe',
    log: 'C:\\root with space\\data\\watchdog.log',
  });
  assert.match(command, /^cmd \/d \/s \/c ""C:\\Program Files\\nodejs\\node\.exe" "/);
  assert.doesNotMatch(command, /^cmd \/c ""/);
});

test('rendered watchdog VBS really runs node and captures its output', { skip: !windows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-watchdog-vbs-'));
  try {
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    const marker = path.join(root, 'marker.txt');
    fs.writeFileSync(path.join(root, 'bin', 'taskbridge.mjs'),
      "import fs from 'node:fs';\n" +
      `fs.writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));\n` +
      "console.log('watchdog probe ok');\n");
    const log = path.join(root, 'watchdog.log');
    const vbs = path.join(root, 'watchdog.vbs');
    fs.writeFileSync(vbs, renderWatchdogVbs({ root, node: process.execPath, log }), 'ascii');

    spawnSync(wscript, ['//B', vbs], { timeout: 30000, windowsHide: true });

    assert.equal(fs.readFileSync(marker, 'utf8'), 'ensure', 'node did not run with the ensure argument');
    assert.match(fs.readFileSync(log, 'utf8'), /watchdog probe ok/, 'the command output was not redirected to watchdog.log');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rendered VBS propagates a failed health result to Task Scheduler', { skip: !windows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-watchdog-exit-'));
  try {
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'taskbridge.mjs'), 'process.exit(7);\n');
    const vbs = path.join(root, 'watchdog.vbs');
    fs.writeFileSync(vbs, renderWatchdogVbs({ root, node: process.execPath, log: path.join(root, 'watchdog.log') }), 'ascii');

    const result = spawnSync(wscript, ['//B', vbs], { timeout: 30000, windowsHide: true });
    assert.equal(result.status, 7, 'LastTaskResult must reflect the ensure/probe failure, not VBS startup');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setup script delegates to the tested renderer instead of an inline cmd line', () => {
  const setup = fs.readFileSync(fileURLToPath(new URL('../scripts/taskbridge-task-setup.ps1', import.meta.url)), 'utf8');
  assert.match(setup, /watchdog-vbs\.mjs/);
  assert.doesNotMatch(setup, /sh\.Run "cmd \/c "/);
});
