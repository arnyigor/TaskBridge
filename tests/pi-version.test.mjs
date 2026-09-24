import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePiVersion, isSupportedPiVersion, PiVersionProbe, SUPPORTED_PI } from '../src/pi-version.mjs';

test('the Pi version is found with or without a prefix', () => {
  assert.equal(parsePiVersion('0.85.1\n'), '0.85.1');
  assert.equal(parsePiVersion('pi 0.85.1'), '0.85.1');
  assert.equal(parsePiVersion('pi version v0.86.0-beta'), '0.86.0');
  assert.equal(parsePiVersion('command not found'), null);
  assert.equal(parsePiVersion(''), null);
});

test('only the recorded range is supported, compared as numbers', () => {
  assert.equal(isSupportedPiVersion(SUPPORTED_PI.min), true);
  assert.equal(isSupportedPiVersion('0.85.12'), true);
  assert.equal(isSupportedPiVersion(SUPPORTED_PI.below), false);
  assert.equal(isSupportedPiVersion('0.84.9'), false);
  assert.equal(isSupportedPiVersion('0.9.0'), false, '0.9 is older than 0.85, not newer');
  assert.equal(isSupportedPiVersion(null), false);
});

test('the probe reports a missing Pi as a status and caches the answer', async () => {
  let calls = 0;
  const probe = new PiVersionProbe({}, async () => { calls++; return { version: null, error: 'spawn pi ENOENT' }; });
  assert.equal(probe.current(), null, 'nothing known before the first probe finishes');
  const result = await probe.pending;
  assert.deepEqual(result, { version: null, supported: false, supportedRange: `>=${SUPPORTED_PI.min} <${SUPPORTED_PI.below}`, error: 'spawn pi ENOENT' });
  probe.current();
  probe.current();
  assert.equal(calls, 1, 'current() does not spawn Pi on every poll');
});

test('a real process that is not Pi is reported, not thrown', async () => {
  const probe = new PiVersionProbe({ command: 'definitely-not-a-pi-binary-xyz', timeoutMs: 5000 });
  const result = await probe.refresh();
  assert.equal(result.version, null);
  assert.equal(result.supported, false);
  assert.ok(result.error);
});
