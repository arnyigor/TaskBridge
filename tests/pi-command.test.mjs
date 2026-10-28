import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePiCommand, piRuntimeState, PI_STATES } from '../src/pi-command.mjs';

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
  const touch = async rel => {
    const file = path.join(root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'marker, not an executable');
  };
  return { root, touch };
}

test('a configured command keeps winning, as it always did', async t => {
  const { root, touch } = await sandbox(t, 'pi-command-config');
  await touch('TaskBridge/TaskBridge.exe');
  await touch('TaskBridge/app/placeholder');
  await touch('TaskBridge/server/runtime/pi/pi.cmd');
  const resolved = resolvePiCommand({ config: { pi: { command: 'C:/tools/pi.cmd' } }, env: { TASKBRIDGE_PI: 'ignored' }, serverRoot: path.join(root, 'TaskBridge/server') });
  assert.deepEqual(resolved, { command: 'C:/tools/pi.cmd', source: 'config' });
  const blank = resolvePiCommand({ config: { pi: { command: '   ' } }, env: {}, serverRoot: path.join(root, 'TaskBridge/server') });
  assert.equal(blank.source, 'bundled', 'a blank setting falls through to the bundled runtime');
});

test('TASKBRIDGE_PI is the override that needs no config edit', async t => {
  const { root, touch } = await sandbox(t, 'pi-command-env');
  await touch('Bundle/runtime/pi/pi.cmd');
  const resolved = resolvePiCommand({ config: {}, env: { TASKBRIDGE_PI: ' D:/pi/pi.cmd ' }, serverRoot: path.join(root, 'Bundle') });
  assert.deepEqual(resolved, { command: 'D:/pi/pi.cmd', source: 'environment' });
});

test('a bundled distribution runtime is preferred over PATH', async t => {
  const { root, touch } = await sandbox(t, 'pi-command-bundled');
  await touch('TaskBridge/TaskBridge.exe');
  await touch('TaskBridge/app/placeholder');
  await touch('TaskBridge/server/scripts/start-lan.mjs');
  await touch('TaskBridge/runtime/pi/pi.cmd');
  const serverRoot = path.join(root, 'TaskBridge/server');
  assert.deepEqual(resolvePiCommand({ config: {}, env: {}, serverRoot }), { command: path.join(root, 'TaskBridge/runtime/pi/pi.cmd'), source: 'bundled' });
  // A runtime inside the copied server tree itself takes precedence.
  await touch('TaskBridge/server/runtime/pi/pi.cmd');
  assert.deepEqual(resolvePiCommand({ config: {}, env: {}, serverRoot }), { command: path.join(serverRoot, 'runtime/pi/pi.cmd'), source: 'bundled' });
});

test('a bare checkout never claims a runtime from an unrelated neighbour', async t => {
  const { root, touch } = await sandbox(t, 'pi-command-checkout');
  await touch('runtime/pi/pi.cmd');
  const repository = path.join(root, 'repository');
  await touch('repository/scripts/start-lan.mjs');
  assert.deepEqual(resolvePiCommand({ config: {}, env: {}, serverRoot: repository }), { command: 'pi', source: 'path' });
});

test('an empty or blank override is ignored instead of naming an empty binary', async t => {
  const { root } = await sandbox(t, 'pi-command-blank');
  for (const value of ['', '   ', null, undefined]) {
    assert.equal(resolvePiCommand({ config: {}, env: { TASKBRIDGE_PI: value ?? '' }, serverRoot: root }).command, 'pi');
  }
});

test('the binary name follows the platform', async t => {
  const { root, touch } = await sandbox(t, 'pi-command-platform');
  await touch('server/runtime/pi/pi');
  const serverRoot = path.join(root, 'server');
  assert.equal(resolvePiCommand({ config: {}, env: {}, serverRoot, platform: 'linux' }).command, path.join(serverRoot, 'runtime', 'pi', 'pi'));
  assert.equal(resolvePiCommand({ config: {}, env: {}, serverRoot, platform: 'win32' }).command, 'pi');
});

test('diagnostics separate "no Pi" from "wrong Pi" from "ready"', () => {
  assert.deepEqual(piRuntimeState({ version: null, error: 'Pi не найден: pi' }), { state: PI_STATES.MISSING, reason: 'Pi не найден: pi' });
  assert.equal(piRuntimeState({ version: null }).state, PI_STATES.MISSING);
  const incompatible = piRuntimeState({ version: '2.0.0', supported: false, supportedRange: '>=0.85.0 <1.5.0' });
  assert.equal(incompatible.state, PI_STATES.INCOMPATIBLE);
  assert.match(incompatible.reason, /2\.0\.0/);
  assert.deepEqual(piRuntimeState({ version: '1.4.0', supported: true }), { state: PI_STATES.READY, reason: null });
});
