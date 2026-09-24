import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  computeWormsoftUsage,
  parseRouterAiCredits,
  parseWormsoftSubscription,
  readRouterAiStatus,
  readWormsoftStatus,
} from '../src/provider-status.mjs';

const plans = {
  payed: {
    amount: 3_000_000,
    seconds: 14_400,
    price: 4_000,
    periodDays: 30,
    rateLimitRequests: 120,
    rateLimitSeconds: 60,
    concurrentRequests: 5,
  },
};

test('WormSoft subscription parser keeps credits and time units consistent', () => {
  const result = parseWormsoftSubscription({
    subcriptionType: 'payed',
    subcriptionLimit: 1_402_275,
  }, plans);
  assert.deepEqual(result, {
    plan: 'payed',
    remaining: 1_402_275,
    total: 3_000_000,
    used: 1_597_725,
    remainingRatio: 1_402_275 / 3_000_000,
    windowSeconds: 14_400,
    periodDays: 30,
    priceRub: 4_000,
    rateLimitRequests: 120,
    rateLimitSeconds: 60,
    concurrentRequests: 5,
  });
  assert.equal(result.remaining + result.used, result.total);
  assert.equal(parseWormsoftSubscription({}, plans), null);
  assert.equal(parseWormsoftSubscription({ subcriptionType: 'payed', subcriptionLimit: null }, plans), null);
  assert.equal(parseWormsoftSubscription({ subcriptionType: 'payed', subcriptionLimit: '' }, plans), null);
  const blankMetadata = parseWormsoftSubscription(
    { subcriptionType: 'blank', subcriptionLimit: 10 },
    { blank: { amount: '', seconds: null, price: ' ', periodDays: undefined } },
  );
  assert.equal(blankMetadata.total, null);
  assert.equal(blankMetadata.windowSeconds, null);
  assert.equal(blankMetadata.priceRub, null);
  assert.equal(blankMetadata.periodDays, null);
});

test('WormSoft status reads the account remainder and public plan metadata', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.Authorization });
    return {
      ok: true,
      json: async () => String(url).endsWith('/subscription-limit')
        ? { subcriptionType: 'payed', subcriptionLimit: 1_402_275 }
        : plans,
    };
  };
  const result = await readWormsoftStatus({}, {
    env: { WORMSOFT_API_KEY: 'ws-test' }, fetch: fakeFetch, noCache: true,
  });
  assert.equal(result.available, true);
  assert.equal(result.kind, 'subscription');
  assert.equal(result.subscription.plan, 'payed');
  assert.equal(result.subscription.remaining, 1_402_275);
  assert.equal(result.subscription.total, 3_000_000);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.authorization === 'Bearer ws-test'));
});

test('WormSoft still reports remaining credits when plan metadata is unavailable', async () => {
  const fakeFetch = async (url) => {
    if (String(url).endsWith('/subscription-limit')) {
      return { ok: true, json: async () => ({ subcriptionType: 'custom', subcriptionLimit: 42 }) };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };
  const result = await readWormsoftStatus({}, {
    env: { WORMSOFT_API_KEY: 'ws-test' }, fetch: fakeFetch, noCache: true,
  });
  assert.equal(result.available, true);
  assert.equal(result.subscription.remaining, 42);
  assert.equal(result.subscription.total, null);
});

test('WormSoft usage rate restarts after a window gap and projects exhaustion', () => {
  const hour = 3_600_000;
  const now = 1_800_000_000_000;
  // Cumulative drain across windows: the rate uses only the latest gap-free run.
  const samples = [
    { t: now - 30 * hour, remaining: 2_900_000 },
    { t: now - 29 * hour, remaining: 2_890_000 },
    { t: now - 3 * hour, remaining: 2_800_000 },
    { t: now - 1 * hour, remaining: 2_760_000 },
  ];
  const usage = computeWormsoftUsage(samples, now, 14_400);
  assert.equal(usage.firstSeenAt, new Date(now - 30 * hour).toISOString());
  assert.equal(usage.windowStartAt, new Date(now - 3 * hour).toISOString());
  assert.equal(usage.perDay, 40_000 * 12, '40k used over a 2h window is 480k/day');
  assert.equal(usage.projectedEmptyAt, new Date(now - hour + (2_760_000 / 480_000) * 86_400_000).toISOString());

  // A jump up means the counter was refreshed: the pre-reset history is ignored.
  // The reset moment is known even while the span is too short for a rate —
  // the next refresh is one plan window after the observed one.
  const afterReset = computeWormsoftUsage([
    { t: now - 5 * hour, remaining: 2_800_000 },
    { t: now - 4 * hour, remaining: 2_700_000 },
    { t: now - 3 * hour, remaining: 2_999_000 },
  ], now, 14_400);
  assert.equal(afterReset.perDay, undefined, 'a single post-reset sample has no rate yet');
  assert.equal(afterReset.windowStartAt, new Date(now - 3 * hour).toISOString());
  assert.equal(afterReset.nextResetAt, new Date(now + hour).toISOString(), 'reset observed at -3h, next one 4h later');

  // With enough span after the reset the rate describes the current window only.
  const afterResetWithSpan = computeWormsoftUsage([
    { t: now - 5 * hour, remaining: 2_800_000 },
    { t: now - 4 * hour, remaining: 2_700_000 },
    { t: now - 3 * hour, remaining: 2_999_000 },
    { t: now - 1 * hour, remaining: 2_990_000 },
  ], now, 14_400);
  assert.equal(afterResetWithSpan.perDay, 9_000 * 12, '9k used over a 2h window is 108k/day');
  assert.equal(afterResetWithSpan.nextResetAt, new Date(now + hour).toISOString());

  assert.equal(computeWormsoftUsage([], now), null);
  assert.equal(computeWormsoftUsage([{ t: now, remaining: 10 }], now), null);
  assert.equal(computeWormsoftUsage([
    { t: now - 30_000, remaining: 100 },
    { t: now, remaining: 100 },
  ], now), null, 'a flat remainder has no rate');
  const short = computeWormsoftUsage([
    { t: now - 20_000, remaining: 100 },
    { t: now, remaining: 90 },
  ], now);
  assert.equal(short.perDay, undefined, 'a span under 30 min is too short for a rate');
  assert.equal(short.firstSeenAt, new Date(now - 20_000).toISOString());
});

test('WormSoft status records usage samples and passes the configured end date', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wormsoft-usage-'));
  try {
    const storagePath = path.join(dir, 'usage.json');
    await fs.writeFile(storagePath, JSON.stringify({
      samples: [
        { t: Date.now() - 2 * 3_600_000, remaining: 2_800_000 },
        { t: Date.now() - 1 * 3_600_000, remaining: 2_760_000 },
      ],
    }));
    const fakeFetch = async (url) => ({
      ok: true,
      json: async () => String(url).endsWith('/subscription-limit')
        ? { subcriptionType: 'payed', subcriptionLimit: 2_705_658 }
        : plans,
    });
    const result = await readWormsoftStatus({}, {
      env: { WORMSOFT_API_KEY: 'ws-test', WORMSOFT_SUBSCRIPTION_ENDS_AT: '2026-09-29' }, fetch: fakeFetch, noCache: true, storagePath,
    });
    assert.equal(result.subscription.remaining, 2_705_658);
    assert.ok(Math.abs(result.usage.perDay - 94_342 * 12) < 1000,
      '94342 used over a ~2h window yields ~1.13M/day');
    assert.equal(result.endsAt, new Date('2026-09-29T23:59:59').toISOString());
    const stored = JSON.parse(await fs.readFile(storagePath, 'utf8'));
    assert.equal(stored.samples.length, 3, 'the new remainder is appended to the samples');
    assert.equal(stored.samples[2].remaining, 2_705_658);


    // Without a storage path the sampler is simply skipped.
    const noStorage = await readWormsoftStatus({}, { env: { WORMSOFT_API_KEY: 'ws-test' }, fetch: fakeFetch, noCache: true });
    assert.equal(noStorage.usage, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RouterAI credits parser and reader reject invented units', async () => {
  assert.equal(parseRouterAiCredits({ data: { credits: 2097.61 } }), 2097.61);
  assert.equal(parseRouterAiCredits({ data: {} }), null);
  assert.equal(parseRouterAiCredits({ data: { credits: null } }), null);
  assert.equal(parseRouterAiCredits({ data: { credits: '' } }), null);
  const result = await readRouterAiStatus({}, {
    env: { ROUTERAI_API_KEY: 'rt-test' },
    fetch: async () => ({ ok: true, json: async () => ({ data: { credits: 2097.61 } }) }),
    noCache: true,
  });
  assert.equal(result.available, true);
  assert.equal(result.kind, 'credits');
  assert.equal(result.credits, 2097.61);
  assert.equal('currency' in result, false, 'API does not declare a currency');
});

test('provider readers are non-throwing without keys or on network failure', async () => {
  const noKey = await readWormsoftStatus({}, { env: {}, noCache: true });
  assert.deepEqual(noKey, { provider: 'wormsoft', available: false, reason: 'no-key' });
  const failed = await readRouterAiStatus({}, {
    env: { ROUTERAI_API_KEY: 'rt-network-failure-test' },
    fetch: async () => { throw new Error('network down'); },
    noCache: true,
  });
  assert.equal(failed.available, false);
  assert.equal(failed.reason, 'network down');
});

test('provider cache deduplicates in-flight reads and negative-caches failures', async () => {
  let calls = 0;
  const slowFetch = async (url) => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return {
      ok: true,
      json: async () => String(url).endsWith('/subscription-limit')
        ? { subcriptionType: 'payed', subcriptionLimit: 100 }
        : plans,
    };
  };
  const options = { env: { WORMSOFT_API_KEY: 'ws-dedupe-test' }, fetch: slowFetch };
  const [first, second] = await Promise.all([readWormsoftStatus({}, options), readWormsoftStatus({}, options)]);
  assert.equal(first.subscription.remaining, 100);
  assert.equal(second.subscription.remaining, 100);
  assert.equal(calls, 2, 'one account request and one plan request');

  let failures = 0;
  const failureOptions = {
    env: { ROUTERAI_API_KEY: 'rt-negative-cache-test' },
    fetch: async () => { failures++; throw new Error('offline'); },
  };
  assert.equal((await readRouterAiStatus({}, failureOptions)).available, false);
  assert.equal((await readRouterAiStatus({}, failureOptions)).available, false);
  assert.equal(failures, 1, 'failure is cached instead of retried on every poll');
});
test('the /api/info poll serves the last known state without touching providers', async () => {
  let calls = 0;
  const countingFetch = async () => { calls++; return { ok: true, json: async () => ({ subcriptionType: 'payed', subcriptionLimit: 500 }) }; };
  const key = { env: { WORMSOFT_API_KEY: 'ws-cacheonly-test' }, fetch: countingFetch };
  // Nothing cached yet: the poll answers "not fetched" and makes zero requests.
  const empty = await readWormsoftStatus({}, { ...key, cacheOnly: true });
  assert.equal(empty.available, false);
  assert.equal(empty.reason, 'not-fetched');
  assert.equal(calls, 0, 'a poll with an empty cache must not touch the provider');

  // A refresh (explicit) fetches and stores; the poll then serves it without
  // a single additional request.
  const refreshed = await readWormsoftStatus({}, { ...key, noCache: true });
  assert.equal(refreshed.subscription.remaining, 500);
  assert.equal(calls, 2);
  const polled = await readWormsoftStatus({}, { ...key, cacheOnly: true });
  assert.equal(polled.subscription.remaining, 500);
  assert.equal(calls, 2, 'the poll serves the cache without touching the provider');
});

test('an explicit refresh is cooldown-guarded and stores its result for the poll', async () => {
  let calls = 0;
  const countingFetch = async () => { calls++; return { ok: true, json: async () => ({ subcriptionType: 'payed', subcriptionLimit: 700 }) }; };
  const key = { env: { WORMSOFT_API_KEY: 'ws-cooldown-test' }, fetch: countingFetch };
  const options = { ...key, noCache: true, minRefreshMs: 60_000 };
  const first = await readWormsoftStatus({}, options);
  assert.equal(first.subscription.remaining, 700);
  const second = await readWormsoftStatus({}, options);
  assert.equal(second.subscription.remaining, 700);
  assert.equal(calls, 2, 'the second refresh within the cooldown is served from the stored result');
  // The stored result is visible to the cache-only poll.
  const polled = await readWormsoftStatus({}, { ...key, cacheOnly: true });
  assert.equal(polled.subscription.remaining, 700);
});
