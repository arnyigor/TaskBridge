import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encryptPayload, vapidHeader, generateVapidKeys } from '../src/push/web-push.mjs';
import { PushCenter, notificationFor } from '../src/push/push-center.mjs';
import { startFixture } from './server-fixture.mjs';

// Web Push straight from the machine (RFC 8030/8291/8292). Nothing here talks to
// a real push service: the crypto is checked against the RFC's own example and
// the delivery loop against an injected fetch.

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-push-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const SUBSCRIPTION = {
  endpoint: 'https://push.example.com/send/abc',
  keys: {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg'
  }
};

test('the payload matches the RFC 8291 example byte for byte', () => {
  // If this ever drifts, phones would receive undecryptable noise — which is
  // exactly the failure that is impossible to debug from the phone side.
  const body = encryptPayload({
    payload: 'When I grow up, I want to be a watermelon',
    p256dh: SUBSCRIPTION.keys.p256dh,
    auth: SUBSCRIPTION.keys.auth,
    salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    serverKeys: { privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' }
  });
  assert.equal(
    body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
  );
});

test('a random send is still a well-formed aes128gcm record and refuses bad keys', () => {
  const body = encryptPayload({ payload: 'привет', p256dh: SUBSCRIPTION.keys.p256dh, auth: SUBSCRIPTION.keys.auth });
  assert.equal(body.readUInt32BE(16), 4096, 'the record size header');
  assert.equal(body.readUInt8(20), 65, 'the server key length');
  assert.notEqual(body.subarray(0, 16).toString('hex'), '0'.repeat(32), 'the salt is random, not zero');
  const again = encryptPayload({ payload: 'привет', p256dh: SUBSCRIPTION.keys.p256dh, auth: SUBSCRIPTION.keys.auth });
  assert.notEqual(body.toString('base64url'), again.toString('base64url'), 'each message gets its own salt and key');

  assert.throws(() => encryptPayload({ payload: 'x', p256dh: 'AAAA', auth: SUBSCRIPTION.keys.auth }), /P-256 point/);
  assert.throws(() => encryptPayload({ payload: 'x', p256dh: SUBSCRIPTION.keys.p256dh, auth: 'c2hvcnQ' }), /16 bytes/);
});

test('the VAPID header is a JWT the push service can actually verify', () => {
  const keys = generateVapidKeys();
  const now = Date.UTC(2026, 0, 1);
  const header = vapidHeader({ endpoint: 'https://push.example.com/send/abc?x=1', ...keys, subject: 'mailto:me@example.com', now });
  const [scheme, token, key] = header.split(/[ ,] ?/).filter(Boolean);
  assert.equal(scheme, 'vapid');
  assert.equal(key, `k=${keys.publicKey}`);

  const jwt = token.replace(/^t=/, '');
  const [rawHeader, rawClaims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(rawHeader, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(rawClaims, 'base64url'));
  assert.equal(claims.aud, 'https://push.example.com', 'the audience is the origin, without the path');
  assert.equal(claims.sub, 'mailto:me@example.com');
  assert.equal(claims.exp, Math.floor(now / 1000) + 12 * 60 * 60);

  const raw = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
    format: 'jwk'
  });
  const verified = crypto.verify('sha256', Buffer.from(`${rawHeader}.${rawClaims}`, 'utf8'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  assert.equal(verified, true, 'the signature must verify against the advertised key');
});

test('only the events an operator waits for become a notification', () => {
  const task = { id: 't1', title: 'Починить очередь' };
  assert.equal(notificationFor({ type: 'PI_EVENT', taskId: 't1' }, task), null);
  assert.equal(notificationFor({ type: 'USER_MESSAGE', taskId: 't1' }, task), null);
  const done = notificationFor({ type: 'TASK_SUCCEEDED', taskId: 't1', at: '2026-09-11T10:00:00.000Z' }, task);
  assert.equal(done.title, 'TaskBridge: Готово');
  assert.equal(done.body, 'Починить очередь');
  assert.equal(done.taskId, 't1');
  assert.equal(notificationFor({ type: 'APPROVAL_REQUIRED', taskId: 't1' }, task).title, 'TaskBridge: Нужно подтверждение');
  // Without a task record the event's own message still says something useful.
  assert.equal(notificationFor({ type: 'TASK_FAILED', taskId: 't2', message: 'Pi упал' }).body, 'Pi упал');
});

test('the push center keeps one key pair, one record per browser, and drops dead endpoints', async t => {
  const root = await tempRoot(t);
  const calls = [];
  const replies = new Map();
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers, size: options.body.length });
    return { ok: (replies.get(url) || 201) < 400, status: replies.get(url) || 201 };
  };
  const center = await new PushCenter(root, { fetchImpl }).load();
  const key = center.publicKey;
  assert.match(key, /^[A-Za-z0-9_-]{87,88}$/, 'a base64url P-256 point');

  await center.subscribe(SUBSCRIPTION, { name: 'Pixel' });
  await center.subscribe({ ...SUBSCRIPTION, endpoint: 'https://push.example.com/send/second' }, { name: 'Ноутбук' });
  // The same browser re-subscribing replaces its record instead of doubling it.
  await center.subscribe(SUBSCRIPTION, { name: 'Pixel 8' });
  assert.equal(center.size, 2);
  assert.deepEqual(new Set(center.list().map(entry => entry.name)), new Set(['Ноутбук', 'Pixel 8']));
  assert.equal(JSON.stringify(center.list()).includes(SUBSCRIPTION.keys.auth), false, 'keys are never listed back');

  const sent = await center.notify({ title: 'TaskBridge: Готово', body: 'Сессия закончилась', taskId: 't1' });
  assert.deepEqual(sent, { sent: 2, removed: 0 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].headers.authorization, /^vapid t=.+, k=/);
  assert.equal(calls[0].headers['content-encoding'], 'aes128gcm');
  assert.ok(calls[0].size > 60, 'the encrypted record carries the payload');

  // A push service that says the subscription is gone is believed at once.
  replies.set('https://push.example.com/send/second', 410);
  const afterGone = await center.notify({ title: 'x', body: 'y', taskId: 't2' });
  assert.equal(afterGone.removed, 1);
  assert.equal(center.size, 1);

  // A key pair must survive a restart: a phone subscribed with the old key
  // would otherwise silently stop receiving anything.
  const reloaded = await new PushCenter(root, { fetchImpl }).load();
  assert.equal(reloaded.publicKey, key);
  assert.equal(reloaded.size, 1);
});

test('an endpoint that keeps failing is dropped instead of retried forever', async t => {
  const root = await tempRoot(t);
  const center = await new PushCenter(root, { fetchImpl: async () => { throw new Error('network down'); } }).load();
  await center.subscribe(SUBSCRIPTION);
  for (let attempt = 0; attempt < 4; attempt++) {
    await center.notify({ title: 'x', body: 'y', taskId: 't' });
    assert.equal(center.size, 1, `dropped too early, after ${attempt + 1} failures`);
  }
  await center.notify({ title: 'x', body: 'y', taskId: 't' });
  assert.equal(center.size, 0, 'the fifth failure retires the subscription');
});

test('HTTP: the machine hands out its public key and stores a subscription', { timeout: 40000 }, async t => {
  const fixture = await startFixture(0);
  t.after(() => fixture.close());

  const first = await fixture.api('/api/push/key');
  assert.match(first.publicKey, /^[A-Za-z0-9_-]{87,88}$/);
  assert.deepEqual(first.subscriptions, []);

  await fixture.api('/api/push/subscribe', { subscription: SUBSCRIPTION, name: 'Телефон' });
  const listed = await fixture.api('/api/push/key');
  assert.equal(listed.publicKey, first.publicKey, 'the key is stable across requests');
  assert.equal(listed.subscriptions.length, 1);
  assert.equal(listed.subscriptions[0].name, 'Телефон');
  assert.equal(listed.subscriptions[0].endpointHost, 'push.example.com');
  assert.equal(JSON.stringify(listed).includes(SUBSCRIPTION.endpoint), false, 'the endpoint itself is not handed back');

  // A subscription without encryption keys is refused, not stored half-way.
  await assert.rejects(() => fixture.api('/api/push/subscribe', { subscription: { endpoint: 'https://push.example.com/x' } }), /ключ/i);

  await fixture.api('/api/push/unsubscribe', { endpoint: SUBSCRIPTION.endpoint });
  assert.deepEqual((await fixture.api('/api/push/key')).subscriptions, []);

  // The key survives a restart of the machine.
  await fixture.restart();
  assert.equal((await fixture.api('/api/push/key')).publicKey, first.publicKey);
});

test('the service worker shows what arrived and opens that session on a tap', async () => {
  const source = await fs.readFile(new URL('../web/sw.js', import.meta.url), 'utf8');
  assert.match(source, /addEventListener\('push'/, 'without a push handler the browser shows its own placeholder');
  assert.match(source, /showNotification/);
  assert.match(source, /addEventListener\('notificationclick'/);
  assert.match(source, /\/session\/\$\{encodeURIComponent\(taskId\)\}/, 'a tap must land on the session that finished');
});

test('HTTP: a finished session actually reaches the push loop', { timeout: 60000 }, async t => {
  const fixture = await startFixture(0);
  t.after(() => fixture.close());
  await fixture.api('/api/push/subscribe', { subscription: SUBSCRIPTION, name: 'Телефон' });

  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'закончись' });
  for (let i = 0; i < 400; i++) {
    const current = await fixture.api(`/api/tasks/${task.id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(current.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // push.example.com does not exist, so the only proof the machine tried is the
  // failure counter on the subscription — which is exactly what we want to see:
  // the event reached the push loop instead of being dropped silently.
  const attempted = await (async () => {
    for (let i = 0; i < 100; i++) {
      const [subscription] = (await fixture.api('/api/push/key')).subscriptions;
      if (subscription && subscription.failures > 0) return subscription;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  })();
  assert.ok(attempted, 'a finished session must be handed to the push center');
});
