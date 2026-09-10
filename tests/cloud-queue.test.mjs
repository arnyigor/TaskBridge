import test from 'node:test';
import assert from 'node:assert/strict';
import { send, receive, acknowledge } from '../cloud/lib/queue.mjs';

test('Vercel Queue adapter uses 7-day TTL, decodes leased NDJSON and treats repeated ACK as success', async () => {
  const previousFetch = globalThis.fetch;
  const previousRegion = process.env.QUEUE_REGION;
  const calls = [];
  process.env.QUEUE_REGION = 'fra1';
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'DELETE') return new Response('already acknowledged', { status: 404 });
    if (options.headers.accept) {
      const body = Buffer.from(JSON.stringify({ id: 'cmd', type: 'SYNC_STATE' })).toString('base64');
      return new Response(`${JSON.stringify({ messageId: 'm', receiptHandle: 'lease', deliveryCount: 2, body })}\n`);
    }
    return new Response('{}', { status: 201 });
  };
  try {
    const req = { headers: { 'x-vercel-oidc-token': 'oidc' } };
    await send(req, 'topic', { hello: 'world' }, 'event_task_1');
    const messages = await receive(req, 'topic', 'consumer', 1, 1);
    await acknowledge(req, 'topic', 'consumer', 'lease');
    assert.equal(calls[0].options.headers['vqs-retention-seconds'], '604800');
    assert.equal(calls[0].options.headers['vqs-idempotency-key'], 'event_task_1');
    assert.equal(calls[1].options.headers['vqs-max-concurrency'], '1');
    assert.deepEqual(messages[0].value, { id: 'cmd', type: 'SYNC_STATE' });
    assert.match(calls[2].url, /\/lease\/lease$/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRegion === undefined) delete process.env.QUEUE_REGION;
    else process.env.QUEUE_REGION = previousRegion;
  }
});
