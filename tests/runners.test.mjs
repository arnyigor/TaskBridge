import test from 'node:test';
import assert from 'node:assert/strict';
import { PiRunner, registerRunner, getRunner, hasRunner, listRunners, piRunnerFor, PI_CAPABILITIES } from '../src/runners/pi-runner.mjs';

function fakeSession() {
  const calls = [];
  const session = {
    closed: false,
    getState: async () => ({ isStreaming: false }),
    prompt: async (m) => { calls.push(['prompt', m]); },
    sendFollowUp: async (m, mode) => { calls.push(['followUp', m, mode]); },
    compact: async (i) => { calls.push(['compact', i]); },
    setModel: async (p, id) => { calls.push(['setModel', p, id]); },
    cycleModel: async (d) => { calls.push(['cycle', d]); },
    getAvailableModels: async () => ['qwen-27b'],
    setThinkingLevel: async (l) => { calls.push(['level', l]); },
    getAvailableThinkingLevels: async () => ['low', 'medium', 'high'],
    setAutoCompaction: async (e) => { calls.push(['auto', e]); },
    abort: async (t) => { calls.push(['abort', t]); },
    killTree: async () => { calls.push(['killTree']); },
    closeStdin: () => { calls.push(['closeStdin']); },
  };
  return { session, calls };
}

test('PiRunner wraps a session and delegating preserves all calls', async t => {
  const { session, calls } = fakeSession();
  const runner = new PiRunner(session);

  // Capabilities advertise what Pi supports.
  assert.equal(runner.can('steer'), true);
  assert.equal(runner.can('compact'), true);
  assert.equal(runner.can('model'), true);
  assert.ok(runner.capabilitySet().length >= 6);
  assert.deepEqual(Object.keys(PI_CAPABILITIES).sort().slice(0, 3).length, 3);

  await runner.getState();
  await runner.prompt('hi');
  await runner.sendFollowUp('steer this', 'steer');
  await runner.compact('summarize');
  await runner.setModel('provider', 'm');
  await runner.cycleModel('backward');
  await runner.setThinkingLevel('high');
  await runner.setAutoCompaction(true);
  await runner.abort(5000);
  await runner.killTree();
  runner.closeStdin();

  assert.ok(calls.some((c) => c[0] === 'prompt' && c[1] === 'hi'));
  assert.ok(calls.some((c) => c[0] === 'followUp' && c[1] === 'steer this' && c[2] === 'steer'));
  assert.ok(calls.some((c) => c[0] === 'compact' && c[1] === 'summarize'));
  assert.ok(calls.some((c) => c[0] === 'abort' && c[1] === 5000));
  assert.ok(calls.some((c) => c[0] === 'killTree'));
  assert.ok(calls.some((c) => c[0] === 'closeStdin'));
  assert.equal(runner.closed, false);

  // Closed state is read from the session.
  session.closed = true;
  assert.equal(runner.closed, true);
});

test('PiRunner tolerates a sub-capability stub', async t => {
  // A stub that only supports prompt/getState; the rest are not advertised.
  const session = { closed: false, getState: async () => ({}), prompt: async () => {} };
  const runner = new PiRunner(session, { capabilities: { steer: false, model: false } });
  assert.equal(runner.can('steer'), false);
  assert.equal(runner.can('model'), false);
  assert.equal(runner.can('compact'), true, 'default remains when not overridden');
});

test('RunnerRegistry stores and resolves runners by id', () => {
  registerRunner('pi', piRunnerFor);
  assert.equal(hasRunner('pi'), true);
  assert.equal(typeof getRunner('pi'), 'function');
  assert.ok(listRunners().includes('pi'));
  // resolve the factory into a runner around a fake session
  const { session } = fakeSession();
  const runner = getRunner('pi')(session);
  assert.ok(runner instanceof PiRunner);
});
