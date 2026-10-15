import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';

test('startup keeps a foreign recorded Pi alive and clears only the copied PID record', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-startup-recovery-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await once(child, 'spawn');
  const store = new TaskStore(root);
  const manager = new TaskManager({ projects: [], memory: { projectMemoryRoot: path.join(root, 'memory') } }, root, store);
  manager.mcp.ensureReady = async () => {};
  manager.nativeSessions.allRoots = () => [];
  t.after(async () => {
    await manager.close();
    store.close();
    const closed = once(child, 'close');
    child.kill();
    await closed;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  await store.create({ id: 'copied', prompt: 'copied database', status: 'SUCCEEDED',
    createdAt: new Date().toISOString(), assistantText: '', thinkingText: '',
    piPid: child.pid, piStartedAt: new Date().toISOString(),
    piSessionFile: path.join(root + '-foreign', 'pi-sessions', 'copied.jsonl') });
  await manager.init();
  assert.equal(child.exitCode, null);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  const restored = manager.getTask('copied');
  assert.equal(restored.status, 'SUCCEEDED');
  assert.equal(restored.piPid, null);
  assert.equal(restored.piStartedAt, null);
});
