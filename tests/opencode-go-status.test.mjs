import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenCodeGoUsage, readOpenCodeGoStatus } from '../src/provider-status.mjs';

// Реальная структура ответа GET https://opencode.ai/zen/go/v1/usage
const payload = {
  usage: {
    rolling: { status: 'ok', percent: 0, resetsAt: '2026-11-18T20:00:00.000Z' },
    weekly: { status: 'ok', percent: 4, resetsAt: '2026-11-19T03:00:00.000Z' },
    monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-12-01T03:44:20.699Z' },
  },
};

test('parseOpenCodeGoUsage: проценты окон и даты сброса', () => {
  const limits = parseOpenCodeGoUsage(payload);
  assert.equal(limits.monthly.usedPercent, 100);
  assert.equal(limits.monthly.remainingPercent, 0);
  assert.equal(limits.rolling.resetAt, '2026-11-18T20:00:00.000Z');
  assert.equal(limits.weekly.remainingPercent, 96);
});

test('parseOpenCodeGoUsage: битый payload', () => {
  assert.equal(parseOpenCodeGoUsage({}), null);
  assert.equal(parseOpenCodeGoUsage(null), null);
  assert.deepEqual(parseOpenCodeGoUsage({ usage: { rolling: { percent: 'x', resetsAt: 'nope' } } }), null);
});

test('readOpenCodeGoStatus: без ключа и без сети в cacheOnly', async () => {
  assert.equal((await readOpenCodeGoStatus({}, { env: {} })).reason, 'no-key');
  let calls = 0;
  const fetch = async () => { calls++; return { ok: true, json: async () => payload }; };
  const env = { OPENCODE_API_KEY: 'sk-test' };
  assert.equal((await readOpenCodeGoStatus({}, { env, fetch, cacheOnly: true })).reason, 'not-fetched');
  assert.equal(calls, 0);
  const status = await readOpenCodeGoStatus({}, { env, fetch, noCache: true });
  assert.equal(status.available, true);
  assert.equal(status.limits.monthly.usedPercent, 100);
  assert.equal(calls, 1);
});
