import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startFixture } from './server-fixture.mjs';

// The processes panel needs three guarantees: the list is real (it contains the
// fixture server itself), a kill actually kills, and the guards refuse to fire
// at nothing (empty body), at a wrong name (reused pid) and at TaskBridge's own
// server tree.

test('GET /api/processes lists real processes with name and memory', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const { processes } = await fixture.api('/api/processes?fresh=1');
  assert.equal(Array.isArray(processes), true);
  const self = processes.find(p => p.pid === fixture.appPid);
  assert.ok(self, 'the fixture server process itself must be in the list');
  assert.equal(typeof self.commandLine, 'string');
  assert.ok(self.commandLine.includes('server.mjs'));
  if (process.platform === 'win32') {
    assert.equal(self.name, 'node.exe');
    assert.equal(typeof self.memoryBytes, 'number');
    assert.ok(self.memoryBytes > 0);
  }
});

test('POST /api/processes/kill kills a spawned dummy process', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', windowsHide: true,
  });
  t.after(() => { try { dummy.kill('SIGKILL'); } catch {} });
  // Wait until the dummy shows up in the list, so the kill is not a race.
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    const { processes } = await fixture.api('/api/processes?fresh=1').catch(() => ({ processes: [] }));
    seen = processes.some(p => p.pid === dummy.pid);
    if (!seen) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(seen, 'dummy process must appear in the list before the kill');

  const result = await fixture.api('/api/processes/kill', { pid: dummy.pid, name: 'node.exe' });
  assert.equal(result.killed, true);

  // The pid must leave the list (fresh query, no cache).
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    const { processes } = await fixture.api('/api/processes?fresh=1').catch(() => ({ processes: [] }));
    gone = !processes.some(p => p.pid === dummy.pid);
    if (!gone) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(gone, 'killed pid must disappear from a fresh list');
});

test('POST /api/processes/kill refuses empty body, name mismatch and TaskBridge processes', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  await assert.rejects(() => fixture.api('/api/processes/kill', {}), error => error.code === 'INPUT_INVALID');

  // A pid that exists but under a different name than claimed.
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { dummy.kill('SIGKILL'); } catch {} });
  await assert.rejects(
    () => fixture.api('/api/processes/kill', { pid: dummy.pid, name: 'definitely-not-node.exe' }),
    error => error.code === 'NAME_MISMATCH',
  );

  // The fixture server itself: it IS the calling server process (self-kill guard).
  await assert.rejects(
    () => fixture.api('/api/processes/kill', { pid: fixture.appPid, name: 'node.exe' }),
    error => error.code === 'PROTECTED',
  );

  // TaskBridge's own server tree is protected by command line, not only by self-pid:
  // a dummy whose command line mentions proxy.mjs must be refused the same way.
  const fakeTree = spawn(process.execPath, ['-e', '/* proxy.mjs */ setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { fakeTree.kill('SIGKILL'); } catch {} });
  await assert.rejects(
    () => fixture.api('/api/processes/kill', { pid: fakeTree.pid, name: 'node.exe' }),
    error => error.code === 'PROTECTED',
  );

  // A pid nobody has: NOT_FOUND, not a kill.
  await assert.rejects(
    () => fixture.api('/api/processes/kill', { pid: 4_000_000, name: 'node.exe' }),
    error => error.code === 'NOT_FOUND',
  );
});
