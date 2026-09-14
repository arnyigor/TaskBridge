import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiRpcSession } from '../src/pi-rpc.mjs';

// A stand-in for `pi --mode rpc` that never acknowledges `prompt` (like a model
// that is still loading) and never answers `quiet` at all. It announces itself
// with a `ready` frame so a test can issue a request without racing Node's
// startup, and it answers `get_state` to prove the happy path still resolves.
const FAKE_PI = `
import readline from 'node:readline';
const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
send({ type: 'ready' });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    return send({ type: 'response', id: command.id, command: 'get_state', success: true, data: { isStreaming: false } });
  }
  if (command.type === 'prompt') {
    // Activity, but no acknowledgement: this is the "slow, still working" case.
    send({ type: 'agent_start' });
    return;
  }
  // 'quiet' and anything else: deliberately silent.
});
`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-rpc-timeout-'));
  await fs.writeFile(path.join(root, 'fake-pi.mjs'), FAKE_PI);
  const command = path.join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  await fs.writeFile(command, process.platform === 'win32'
    ? `@echo off\r\nnode "${path.join(root, 'fake-pi.mjs')}" %*\r\n`
    : `#!/bin/sh\nexec node '${path.join(root, 'fake-pi.mjs')}' "$@"\n`, { mode: 0o755 });
  const session = new PiRpcSession({ command, persistSessions: false });
  t.after(async () => {
    await session.killTree();
    for (let attempt = 0; ; attempt++) {
      try { await fs.rm(root, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt >= 9 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  });
  await session.start();
  await new Promise(resolve => session.once('frame', resolve));
  return session;
}

test('a silent but alive Pi is reported as hung, not as a generic timeout', async t => {
  const session = await fixture(t);
  const error = await session.request({ type: 'quiet' }, 300).then(() => null, e => e);
  assert.equal(error.code, 'PI_RPC_HUNG');
  assert.equal(error.retryable, false);
  assert.match(error.message, /Pi RPC timeout for quiet/);
  assert.match(error.message, /looks hung/);
});

test('a Pi that keeps streaming but has not acknowledged is reported as slow', async t => {
  const session = await fixture(t);
  const error = await session.request({ type: 'prompt', message: 'hi' }, 300).then(() => null, e => e);
  assert.equal(error.code, 'PI_RPC_SLOW');
  assert.equal(error.retryable, true);
  assert.doesNotMatch(error.message, /looks hung/);
});

test('a command that is acknowledged still resolves normally', async t => {
  const session = await fixture(t);
  assert.deepEqual(await session.getState(), { isStreaming: false });
});
