import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeOpenAiReset } from '../src/provider-status.mjs';

const config = { accessToken: 'test-secret', accountId: 'test-account' };
const id = n => n.toString(16).padStart(32, '0');
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const credits = { credits: [
  { id: 'later', status: 'available', expires_at: '2099-02-01T00:00:00Z' },
  { id: 'soon', status: 'available', expires_at: '2099-01-01T00:00:00Z' },
  { id: 'expired', status: 'available', expires_at: '2000-01-01T00:00:00Z' },
] };

test('reset spends nearest-expiry credit once; duplicate request is idempotent; refreshes usage', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/consume')) return response({});
    if (url.endsWith('/usage')) return response({ rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 0, limit_window_seconds: 604800 },
    } });
    return response(credits);
  };
  const options = { requestId: id(1), fetch };
  const first = consumeOpenAiReset(config, options);
  assert.equal(consumeOpenAiReset(config, options), first);
  await first;
  const post = calls.filter(c => c.options.method === 'POST');
  assert.equal(post.length, 1);
  assert.deepEqual(JSON.parse(post[0].options.body), { credit_id: 'soon', redeem_request_id: id(1) });
  assert.equal(post[0].options.headers['ChatGPT-Account-ID'], 'test-account');
  assert.equal(post[0].options.redirect, 'error');
  assert.ok(calls.some(c => c.url.endsWith('/usage')));
  await consumeOpenAiReset(config, options);
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
});

test('no credits, no auth and malformed requests never send consume', async () => {
  const calls = [];
  const fetch = async (url) => { calls.push(url); return response({ credits: [] }); };
  await assert.rejects(consumeOpenAiReset(config, { requestId: id(2), fetch }), /Нет доступного/);
  assert.ok(calls.every(url => !url.endsWith('/consume')));
  await assert.rejects(consumeOpenAiReset(config, { requestId: 'bad', fetch }), /ID запроса/);
  await assert.rejects(consumeOpenAiReset({ authPath: '.local/nonexistent-codex-auth.json' }, { requestId: id(3), fetch, env: {} }), /Вход Codex/);
});

test('concurrent spend refused; timeout is ambiguous, never retried for same request', async () => {
  let finish;
  let posts = 0;
  const fetch = async (url) => {
    if (url.endsWith('/consume')) { posts++; await new Promise(resolve => { finish = resolve; }); throw new Error('secret upstream text'); }
    return response(credits);
  };
  const options = { requestId: id(4), fetch };
  const pending = consumeOpenAiReset(config, options);
  await assert.rejects(consumeOpenAiReset(config, { requestId: id(5), fetch }), /уже выполняется/);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish();
  await assert.rejects(pending, /Результат сброса неизвестен/);
  await assert.rejects(consumeOpenAiReset(config, options), /Результат сброса неизвестен/);
  assert.equal(posts, 1);
});

test('upstream rejection returns safe error without upstream body', async () => {
  const fetch = async url => url.endsWith('/consume') ? response({ secret: 'hidden' }, 403) : response(credits);
  await assert.rejects(consumeOpenAiReset(config, { requestId: id(6), fetch }), e => e.code === 'CONFLICT' && /HTTP 403/.test(e.message) && !e.message.includes('hidden'));
});
