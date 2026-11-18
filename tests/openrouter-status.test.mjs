import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenRouterKey, readOpenRouterStatus } from '../src/provider-status.mjs';

test('parseOpenRouterKey: остаток лимита ключа', () => {
  assert.deepEqual(parseOpenRouterKey({ data: { limit: 10, limit_remaining: 7.5 } }), { credits: 7.5 });
  assert.deepEqual(parseOpenRouterKey({ data: { limit: null, limit_remaining: null } }), { credits: null });
  assert.equal(parseOpenRouterKey({}), null);
});

test('readOpenRouterStatus: без ключа, с ключом, cacheOnly без сети', async () => {
  assert.equal((await readOpenRouterStatus({}, { env: {} })).reason, 'no-key');
  let calls = 0;
  const fetch = async () => { calls++; return { ok: true, json: async () => ({ data: { limit: 5, limit_remaining: 3 } }) }; };
  const env = { OPENROUTER_API_KEY: 'k-test' };
  assert.equal((await readOpenRouterStatus({}, { env, fetch, cacheOnly: true })).reason, 'not-fetched');
  assert.equal(calls, 0);
  const status = await readOpenRouterStatus({}, { env, fetch, noCache: true });
  assert.equal(status.credits, 3);
  assert.equal(calls, 1);
});
