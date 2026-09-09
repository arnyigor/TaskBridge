import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEngineError, parseRetryAfterMs } from '../src/engine.mjs';
import { chooseEngine, profileList } from '../src/dispatcher.mjs';

test('provider failures map to stable engine codes', () => {
  assert.equal(classifyEngineError('You exceeded your current quota, please check your plan').code, 'QUOTA_EXCEEDED');
  assert.equal(classifyEngineError('insufficient credits to run this request').retryable, false);
  assert.equal(classifyEngineError('Rate limit reached for gpt-x').code, 'RATE_LIMITED');
  assert.equal(classifyEngineError('HTTP 429 Too Many Requests').retryable, true);
  assert.equal(classifyEngineError('This model maximum context length is 8192 tokens').code, 'CONTEXT_OVERFLOW');
  assert.equal(classifyEngineError('invalid api key provided').code, 'ENGINE_AUTH');
  assert.equal(classifyEngineError('The model does not exist').code, 'MODEL_UNAVAILABLE');
  assert.equal(classifyEngineError('connect ECONNREFUSED 127.0.0.1:8080').code, 'ENGINE_UNREACHABLE');
  assert.equal(classifyEngineError('the engine is overloaded right now').code, 'ENGINE_OVERLOADED');
  assert.equal(classifyEngineError(new Error('some unrelated failure')), null);
  assert.equal(classifyEngineError(''), null);
});

test('retry-after hints are parsed and bounded', () => {
  assert.equal(parseRetryAfterMs('Rate limited. Retry after 30 seconds.'), 30000);
  assert.equal(parseRetryAfterMs('Retry-After: 1500 ms'), 1500);
  assert.equal(parseRetryAfterMs('retry after 2 minutes'), 120000);
  assert.equal(parseRetryAfterMs('retry after 99 hours'), 24 * 60 * 60 * 1000);
  assert.equal(parseRetryAfterMs('no hint here'), null);
  assert.equal(classifyEngineError('Rate limit hit, retry after 5s').retryAfterMs, 5000);
});

test('AUTO dispatcher picks the vision profile only when images are attached', () => {
  const localRuntime = {
    defaultProfile: 'text',
    auto: { enabled: true, visionProfile: 'vision', textProfile: 'text' },
    profiles: [
      { id: 'text', command: 'llama-server.exe', enabled: true },
      { id: 'vision', command: 'llama-server.exe', enabled: true }
    ]
  };
  assert.deepEqual(chooseEngine(localRuntime, { files: [] }), { profileId: 'text', auto: true, reason: 'text' });
  const image = { name: 'photo.png', mimeType: 'image/png' };
  assert.equal(chooseEngine(localRuntime, { files: [image] }).profileId, 'vision');
  assert.match(chooseEngine(localRuntime, { files: [image] }).reason, /vision/);
  // Without a configured vision profile, images still fall back to text and say so.
  const noVision = { ...localRuntime, auto: { enabled: true, textProfile: 'text' } };
  const fallback = chooseEngine(noVision, { files: [image] });
  assert.equal(fallback.profileId, 'text');
  assert.match(fallback.reason, /no vision profile/);
});

test('AUTO disabled keeps the configured default and never switches', () => {
  const localRuntime = {
    defaultProfile: 'vision',
    profiles: [{ id: 'vision', command: 'x', enabled: true }]
  };
  assert.deepEqual(chooseEngine(localRuntime, { files: [{ name: 'a.png' }] }), { profileId: 'vision', auto: false, reason: null });
  assert.equal(chooseEngine({}, {}).profileId, null);
});

test('profile list accepts the object form and drops disabled entries', () => {
  const list = profileList({ profiles: { a: { command: 'x' }, b: { command: 'y', enabled: false }, c: {} } });
  assert.deepEqual(list.map(p => p.id), ['a']);
});
