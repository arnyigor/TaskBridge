import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { PiRpcSession } from '../src/pi-rpc.mjs';

// The "Pi RPC session is not writable" family. Pi exiting leaves stdin closed
// while the close event may still be unprocessed, and a runtime reused in that
// window answers every command with that error instead of the session being
// started again. These check the two halves of the fix: the session reports the
// dead pipe, and the manager replaces such a runtime.

const FAKE_PI = fileURLToPath(new URL('fake-pi.mjs', import.meta.url));

// A Pi that takes its time to answer the first get_state, like a cold boot (the
// extensions and the MCP adapter load first) or a turn boundary. `slowStateMs`
// is how long it stays quiet.
const SLOW_PI = `
import readline from 'node:readline';
const delay = Number(process.env.SLOW_STATE_MS || 2500);
const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
let first = true;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  const answer = () => send({ type: 'response', id: command.id, command: command.type, success: true, data: command.type === 'get_state' ? { isStreaming: false } : {} });
  if (command.type === 'get_state' && first) { first = false; setTimeout(answer, delay); return; }
  answer();
});
`;

async function slowFixture(t, slowStateMs) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-rpc-probe-'));
  await fs.writeFile(path.join(root, 'slow-pi.mjs'), SLOW_PI);
  const command = path.join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  await fs.writeFile(command, process.platform === 'win32'
    ? `@echo off\r\nset SLOW_STATE_MS=${slowStateMs}\r\nnode "${path.join(root, 'slow-pi.mjs')}" %*\r\n`
    : `#!/bin/sh\nSLOW_STATE_MS=${slowStateMs} exec node '${path.join(root, 'slow-pi.mjs')}' "$@"\n`, { mode: 0o755 });
  const session = new PiRpcSession({ command, persistSessions: false });
  t.after(async () => {
    await session.killTree();
    await fs.rm(root, { recursive: true, force: true });
  });
  await session.start();
  return session;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-rpc-pipe-'));
  const command = path.join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  await fs.writeFile(command, process.platform === 'win32'
    ? `@echo off\r\nnode "${FAKE_PI}" %*\r\n`
    : `#!/bin/sh\nexec node '${FAKE_PI}' "$@"\n`, { mode: 0o755 });
  const store = new TaskStore(root);
  const manager = new TaskManager(
    { projects: [{ id: 'p', path: root, useWorktree: false }], pi: { command, projectTrust: 'deny' } },
    root,
    store
  );
  manager.queuePollMs = 100000;
  t.after(async () => {
    manager.closing = true;
    if (manager.pumpTimer) clearTimeout(manager.pumpTimer);
    await manager.close().catch(() => {});
    store.close();
    for (let attempt = 0; ; attempt++) {
      try { await fs.rm(root, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt >= 9 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) return;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  });
  const task = { id: 'a', createdAt: new Date().toISOString(), status: 'SUCCEEDED', workspacePath: root, prompt: 'original', files: [], compaction: { count: 0 } };
  await store.create(task);
  manager.tasks.set('a', task);
  return { manager, store, task, command, root };
}

test('a session that never started reports a dead pipe with a classified, retryable error', async () => {
  const session = new PiRpcSession({ command: 'pi', persistSessions: false });
  assert.equal(session.canSend(), false, 'nothing was spawned yet');
  const error = await session.getState().then(() => null, thrown => thrown);
  assert.equal(error?.code, 'PI_RPC_NOT_WRITABLE');
  assert.equal(error?.retryable, true);
});

test('a session whose Pi exited reports a dead pipe as soon as the pipe closes', { timeout: 30000 }, async t => {
  const { command } = await fixture(t);
  const session = new PiRpcSession({ command, persistSessions: false });
  t.after(() => session.killTree());
  await session.start();
  assert.equal(session.canSend(), true, 'a live Pi takes commands');
  await session.prompt('fault-crash please');
  await new Promise(resolve => session.once('close', resolve));
  assert.equal(session.canSend(), false, 'a Pi that exited cannot take commands');
  const error = await session.getState().then(() => null, thrown => thrown);
  assert.equal(error?.code, 'PI_RPC_NOT_WRITABLE', 'a dead pipe is classified, not an opaque 500');
});

test('a runtime whose Pi pipe is already gone is replaced instead of failing every command', { timeout: 40000 }, async t => {
  const { manager, store, command } = await fixture(t);
  manager.runtimeManager.isReady = async () => true;
  manager.runtimeManager.getBusyStatus = async () => ({ busy: false });
  // The session of the previous turn: its Pi is down (the pipe is closed), but
  // the close event has not been processed yet, so `closed` still reads false —
  // the exact state the reuse check used to trust.
  const dead = new PiRpcSession({ command, persistSessions: false });
  t.after(() => dead.killTree());
  await dead.start();
  await dead.killTree();
  dead.closed = false;
  const runtime = { pi: dead, eventChain: Promise.resolve(), settleResolvers: [], cancelRequested: false };
  manager.runtimes.set('a', runtime);

  const task = await manager.message('a', 'после падения Pi', 'auto', [], null, { now: true, queue: false });
  assert.equal(task.status, 'RUNNING');
  assert.notEqual(manager.runtimes.get('a')?.pi, dead, 'the dead runtime does not own the session any more');
  assert.equal(runtime.retired, true, 'its handlers are retired so they cannot fail the new turn');
  const users = (await store.readEvents('a', 0)).filter(event => event.type === 'USER_MESSAGE');
  assert.deepEqual(users.map(event => event.data.text), ['после падения Pi']);
});

test('a slow state read is not reported as hung, and an explicit short budget still fails fast', { timeout: 30000 }, async t => {
  // 60 s is the probe budget the send path uses; measured cold-boot reads took
  // 9.0 s and 13.2 s and a turn-boundary read 7.5 s with a real Pi, so the 15 s
  // default used to turn a merely slow Pi into "it looks hung".
  assert.equal(PiRpcSession.PROBE_TIMEOUT_MS, 60000);
  const session = await slowFixture(t, 2500);
  const impatient = await session.getState(1000).then(() => null, error => error);
  assert.equal(impatient?.code, 'PI_RPC_HUNG', 'a budget the Pi cannot meet in time still reports the hang');
  const state = await session.getState();
  assert.equal(state?.isStreaming, false, 'the probe budget tolerates a Pi that answers late');
});

test('state() answers "no live runtime" for a session whose pipe is gone', async t => {
  const { manager } = await fixture(t);
  const pi = { closed: false, canSend: () => false, getState: async () => ({ isStreaming: false }), killTree: async () => {} };
  manager.runtimes.set('a', { pi, eventChain: Promise.resolve(), settleResolvers: [], cancelRequested: false });
  assert.equal(await manager.state('a'), null, 'the polled endpoint stops failing with the pipe error');
  pi.canSend = () => true;
  assert.deepEqual(await manager.state('a'), { isStreaming: false });
});
