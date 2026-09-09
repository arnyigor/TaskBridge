import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireInstanceLock } from '../src/instance-lock.mjs';

test('a live holder blocks a second instance, a stale lock is taken over', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-lock-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(async () => {
    child.kill();
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise(resolve => child.once('spawn', resolve));
  await fs.writeFile(path.join(root, 'taskbridge.lock'), JSON.stringify({ pid: child.pid }));
  assert.throws(() => acquireInstanceLock(root), { code: 'ALREADY_RUNNING' });

  child.kill();
  await new Promise(resolve => child.once('close', resolve));
  const lock = acquireInstanceLock(root);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'taskbridge.lock'), 'utf8')).pid, process.pid);
  lock.release();
  await assert.rejects(fs.access(path.join(root, 'taskbridge.lock')));
});
