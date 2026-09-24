import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiRpcSession } from '../src/pi-rpc.mjs';

// The RPC client against a Pi that misbehaves (backend plan B0/B1). The
// failure modes live in tests/fake-pi.mjs and are chosen by the prompt text.

const FAKE_PI = fileURLToPath(new URL('fake-pi.mjs', import.meta.url));

async function session(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-rpc-faults-'));
  const command = path.join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  await fs.writeFile(command, process.platform === 'win32'
    ? `@echo off\r\nnode "${FAKE_PI}" %*\r\n`
    : `#!/bin/sh\nexec node '${FAKE_PI}' "$@"\n`, { mode: 0o755 });
  const pi = new PiRpcSession({ command, cwd: root, persistSessions: false });
  const seen = { frames: [], protocolErrors: [], stderr: '', closed: null };
  pi.on('frame', frame => seen.frames.push(frame));
  pi.on('protocol_error', error => seen.protocolErrors.push(error));
  pi.on('stderr', text => { seen.stderr += text; });
  const closed = new Promise(resolve => pi.on('close', info => { seen.closed = info; resolve(info); }));
  t.after(async () => {
    await pi.killTree();
    await fs.rm(root, { recursive: true, force: true });
  });
  await pi.start();
  return { pi, seen, closed };
}

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('condition not met in time');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

test('Pi dying in the middle of a tool call closes the session with the exit code and stderr', { timeout: 20000 }, async t => {
  const { pi, seen, closed } = await session(t);
  await pi.prompt('fault-crash please');
  const info = await closed;
  assert.equal(info.code, 3);
  assert.equal(pi.closed, true);
  assert.match(seen.stderr, /simulated crash/);
  assert.ok(seen.frames.some(frame => frame.type === 'tool_execution_start'), 'the crash happened inside a tool call');
  await assert.rejects(pi.getState(), 'a request after the exit fails instead of hanging');
});

test('garbage and a torn JSON line are reported and the session keeps working', { timeout: 20000 }, async t => {
  const { pi, seen } = await session(t);
  await pi.prompt('fault-garbage');
  await until(() => seen.frames.some(frame => frame.type === 'agent_settled'));
  assert.equal(seen.protocolErrors.length, 2, JSON.stringify(seen.protocolErrors));
  assert.match(seen.protocolErrors[0].line, /not json/);
  const end = seen.frames.find(frame => frame.type === 'message_end' && frame.message?.role === 'assistant');
  assert.equal(end.message.content[0].text, 'после мусора');
  const state = await pi.getState();
  assert.equal(state.isStreaming, false);
});

test('Cyrillic split in the middle of a character arrives intact', { timeout: 20000 }, async t => {
  const { pi, seen } = await session(t);
  await pi.prompt('fault-utf8');
  await until(() => seen.frames.some(frame => frame.type === 'agent_settled'));
  assert.equal(seen.protocolErrors.length, 0, JSON.stringify(seen.protocolErrors));
  const end = seen.frames.find(frame => frame.type === 'message_end' && frame.message?.role === 'assistant');
  assert.equal(end.message.content[0].text, 'Привет, мир — ёжик');
});

test('a Pi that ignores abort is still stopped by killing its tree', { timeout: 20000 }, async t => {
  const { pi, closed } = await session(t);
  await pi.prompt('fault-deaf');
  await assert.rejects(pi.abort(300), 'abort is not acknowledged');
  assert.equal(pi.closed, false);
  await pi.killTree();
  await closed;
  assert.equal(pi.closed, true);
});

test('killing Pi also kills the processes it started (pytest, gradle)', { timeout: 20000, skip: process.platform === 'win32' && 'taskkill /T covers this on Windows' }, async t => {
  const { pi, seen, closed } = await session(t);
  await pi.prompt('fault-child');
  const pid = Number((await until(() => seen.stderr.match(/fake-pi child (\d+)/)))[1]);
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  assert.equal(alive(pid), true);
  await pi.killTree();
  await closed;
  await until(() => !alive(pid), 5000).catch(() => {});
  assert.equal(alive(pid), false, `child ${pid} outlived Pi`);
});
