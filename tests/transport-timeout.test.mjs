import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalTransport } from '../web/transport.mjs';

test('a request that never answers is aborted by the timeout', async t => {
  // AbortSignal.timeout uses an unref'ed timer. Real fetch owns a socket;
  // this fake must keep the loop alive too, especially on Node 22 in CI.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  let aborted = false;
  const transport = createLocalTransport({
    fetchImpl: async (url, options = {}) => {
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
      });
    }
  });
  await assert.rejects(() => transport.request('GET', '/api/slow', undefined, 50), err => /aborted/i.test(err.message));
  assert.equal(aborted, true, 'the abort signal actually fired');
});

test('a request without a timeout is never aborted', async () => {
  const transport = createLocalTransport({
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: 1 }) })
  });
  const result = await transport.request('GET', '/api/fast');
  assert.deepEqual(result, { ok: 1 });
});
