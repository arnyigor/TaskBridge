import { readDeepseekCost } from './deepseek-cost.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

// Billing/subscription data belongs to the account of the exact Pi provider,
// not to the model family in its id. For example, routerai/deepseek/* must show
// RouterAI credits rather than the balance of a separate DeepSeek account.

const DEFAULT_CACHE_MS = 10 * 60 * 1000;
// The /api/info poll serves the last known state without touching providers at
// all; data older than this is marked stale so the panel stays quiet about
// freshness right after a refresh or a model request.
const CACHE_ONLY_FRESH_MS = 30 * 60 * 1000;
const cache = new Map();

function apiKey(config, env, defaultEnv) {
  const raw = String(config?.apiKey || `$${defaultEnv}`);
  return raw.startsWith('$') ? env?.[raw.slice(1)] || null : raw || null;
}

async function fetchJson(fetchImpl, url, key, timeoutMs) {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function cached(provider, key, cacheMs, options, load) {
  const now = Date.now();
  const cacheKey = `${provider}:${key}`;
  const previous = cache.get(cacheKey);
  // Cache-only serving: the poll reads the last known state without touching
  // the provider at all — an operator refreshes explicitly instead, so an
  // always-on status endpoint cannot get the account blocked.
  if (options.cacheOnly) {
    if (!previous?.value) return { provider, available: false, reason: 'not-fetched' };
    return now - previous.at < CACHE_ONLY_FRESH_MS ? previous.value : { ...previous.value, stale: true };
  }
  if (previous?.inFlight) return previous.inFlight;
  if (options.noCache) {
    // Explicit refresh with a cooldown: hammering the refresh endpoint must
    // not hammer the provider — the last result within the window is served.
    if (previous && options.minRefreshMs && now - previous.at < options.minRefreshMs) return previous.value;
  } else if (previous && now - previous.at < cacheMs) {
    return previous.value;
  }

  const request = (async () => {
    try {
      const value = await load();
      // The result is stored even for an explicit refresh, so the cooldown and
      // the cache-only reads see it as the last known state.
      cache.set(cacheKey, { at: Date.now(), value });
      return value;
    } catch (error) {
      const value = previous?.value?.available
        ? { ...previous.value, stale: true }
        : { provider, available: false, reason: error?.message || String(error) };
      // Negative caching prevents a 2-second /api/info poll from hammering a
      // provider that is down. A configured smaller cacheMs can shorten it.
      cache.set(cacheKey, { at: Date.now(), value });
      return value;
    }
  })();
  // The in-flight entry keeps the previous value visible to cache-only reads
  // and hands concurrent callers the same request instead of a second fetch.
  cache.set(cacheKey, { ...previous, at: previous?.at || 0, inFlight: request });
  return request;
}

export function parseWormsoftSubscription(payload, plansPayload) {
  // The live API intentionally uses the historical `subcription*` spelling.
  const plan = String(payload?.subcriptionType || payload?.subscriptionType || '').trim();
  const remainingRaw = payload?.subcriptionLimit ?? payload?.subscriptionLimit;
  if (remainingRaw == null || String(remainingRaw).trim() === '') return null;
  const remaining = Number(remainingRaw);
  if (!plan || !Number.isFinite(remaining)) return null;

  const rawPlan = plansPayload?.[plan];
  const total = Number(rawPlan?.amount);
  const normalizedTotal = Number.isFinite(total) && total > 0 ? total : null;
  const numberOrNull = (value) => {
    if (value == null || String(value).trim() === '') return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  };
  return {
    plan,
    remaining,
    total: normalizedTotal,
    used: normalizedTotal == null ? null : Math.max(0, normalizedTotal - remaining),
    remainingRatio: normalizedTotal == null ? null : remaining / normalizedTotal,
    windowSeconds: numberOrNull(rawPlan?.seconds),
    periodDays: numberOrNull(rawPlan?.periodDays),
    priceRub: numberOrNull(rawPlan?.price),
    rateLimitRequests: numberOrNull(rawPlan?.rateLimitRequests),
    rateLimitSeconds: numberOrNull(rawPlan?.rateLimitSeconds),
    concurrentRequests: numberOrNull(rawPlan?.concurrentRequests),
  };
}

// The WormSoft API exposes no reset timestamps (neither subscription end nor
// limit refresh), so TaskBridge tracks the remainder itself: every status poll
// appends a {t, remaining} sample and the burn rate is derived from them.
// Windows are split on gaps longer than the plan window (4 h for payed): a gap
// means the counter was reset or the account was idle, so the rate restarts
// from the remainder observed after it. If the counter in fact just accumulates
// over the period, the latest gap-free run is still the freshest rate estimate.
const USAGE_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;
const USAGE_MIN_SPAN_MS = 30 * 60 * 1000;
const USAGE_NOOP_MS = 60 * 60 * 1000;
const USAGE_DEFAULT_WINDOW_SECONDS = 14_400;

export function computeWormsoftUsage(samples, now = Date.now(), windowSeconds = USAGE_DEFAULT_WINDOW_SECONDS) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const sorted = samples
    .filter(sample => Number.isFinite(sample?.t) && Number.isFinite(sample?.remaining))
    .sort((a, b) => a.t - b.t);
  if (sorted.length < 2) return null;
  const rawWindow = Number(windowSeconds);
  const windowMs = (Number.isFinite(rawWindow) && rawWindow > 0 ? rawWindow : USAGE_DEFAULT_WINDOW_SECONDS) * 1000;
  let start = 0;
  let lastResetAt = null;
  for (let i = 1; i < sorted.length; i++) {
    const increased = sorted[i].remaining > sorted[i - 1].remaining;
    // A gap restarts the rate estimate, but only an observed upward jump
    // proves a reset. Never claim an exact reset time from a gap alone.
    const longGap = sorted[i].t - sorted[i - 1].t > windowMs;
    if (longGap) {
      start = i;
      lastResetAt = null; // the old reset anchor is no longer trustworthy
    }
    if (increased) {
      start = i;
      if (!longGap) lastResetAt = sorted[i].t;
    }
  }
  const first = sorted[start];
  const last = sorted[sorted.length - 1];
  const spanMs = last.t - first.t;
  const used = first.remaining - last.remaining;
  const usage = {
    firstSeenAt: new Date(sorted[0].t).toISOString(),
    windowStartAt: new Date(first.t).toISOString(),
  };
  // The API exposes no reset timestamps. When a refresh was observed in the
  // samples, the next one is one plan window later — measured, not invented.
  // Known even while the span is too short for a rate.
  if (lastResetAt != null) usage.nextResetAt = new Date(lastResetAt + windowMs).toISOString();
  // firstSeen is known immediately; the rate is withheld until the window
  // span is long enough — a few minutes of samples extrapolate wildly.
  if (used <= 0) return lastResetAt != null ? usage : null;
  if (spanMs < USAGE_MIN_SPAN_MS) return usage;
  const perDay = used / (spanMs / 86_400_000);
  usage.perDay = perDay;
  usage.projectedEmptyAt = new Date(last.t + (last.remaining / perDay) * 86_400_000).toISOString();
  return usage;
}

async function recordWormsoftSample(storagePath, remaining, now, windowSeconds) {
  try {
    let samples = [];
    try {
      const parsed = JSON.parse(await fs.readFile(storagePath, 'utf8'));
      samples = Array.isArray(parsed?.samples) ? parsed.samples : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const last = samples[samples.length - 1];
    // A flat remainder adds no rate signal; skip the write until an hour passes.
    if (last && last.remaining === remaining && now - last.t < USAGE_NOOP_MS) {
      return computeWormsoftUsage(samples, now, windowSeconds);
    }
    samples.push({ t: now, remaining });
    samples = samples.filter(sample => now - sample.t <= USAGE_MAX_AGE_MS);
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, `${JSON.stringify({ samples }, null, 2)}\n`, 'utf8');
    return computeWormsoftUsage(samples, now, windowSeconds);
  } catch {
    // Usage stats are best-effort; never break the status read over them.
    return null;
  }
}

// The cabinet shows the subscription end as a plain date; a date-only value
// ends on the last second of that day.
function normalizeEndsAt(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const at = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T23:59:59`) : Date.parse(text);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

export function parseRouterAiCredits(payload) {
  const raw = payload?.data?.credits;
  if (raw == null || String(raw).trim() === '') return null;
  const credits = Number(raw);
  return Number.isFinite(credits) ? credits : null;
}

export async function readWormsoftStatus(config = {}, options = {}) {
  const env = options.env || process.env;
  const key = apiKey(config, env, 'WORMSOFT_API_KEY');
  if (!key) return { provider: 'wormsoft', available: false, reason: 'no-key' };
  const baseUrl = String(config.baseUrl || 'https://ai.wormsoft.ru').replace(/\/+$/, '');
  const fetchImpl = options.fetch || fetch;
  const timeoutMs = Number(config.timeoutMs || options.timeoutMs || 10000);
  const cacheMs = Number(config.cacheMs || DEFAULT_CACHE_MS);
  return cached('wormsoft', key, cacheMs, options, async () => {
    const account = await fetchJson(fetchImpl, `${baseUrl}/api/gpt/subscription-limit`, key, timeoutMs);
    // Plan metadata is useful but not required to show the account's remainder.
    const plans = await fetchJson(fetchImpl, `${baseUrl}/api/user-connector/subscription-limits`, key, timeoutMs).catch(() => null);
    const subscription = parseWormsoftSubscription(account, plans);
    if (!subscription) throw new Error('unexpected subscription payload');
    const status = {
      provider: 'wormsoft',
      label: 'WormSoft',
      kind: 'subscription',
      available: true,
      asOf: new Date().toISOString(),
      subscription,
    };
    if (options.storagePath) {
      status.usage = await recordWormsoftSample(
        options.storagePath,
        subscription.remaining,
        Date.now(),
        subscription.windowSeconds,
      );
    }
    const endsAt = normalizeEndsAt(config.endsAt || env.WORMSOFT_SUBSCRIPTION_ENDS_AT);
    if (endsAt) status.endsAt = endsAt;
    return status;
  });
}

export async function readRouterAiStatus(config = {}, options = {}) {
  const env = options.env || process.env;
  const key = apiKey(config, env, 'ROUTERAI_API_KEY');
  if (!key) return { provider: 'routerai', available: false, reason: 'no-key' };
  const url = String(config.url || 'https://routerai.ru/api/v1/credits');
  const fetchImpl = options.fetch || fetch;
  const timeoutMs = Number(config.timeoutMs || options.timeoutMs || 10000);
  const cacheMs = Number(config.cacheMs || DEFAULT_CACHE_MS);
  return cached('routerai', key, cacheMs, options, async () => {
    const payload = await fetchJson(fetchImpl, url, key, timeoutMs);
    const credits = parseRouterAiCredits(payload);
    if (credits == null) throw new Error('unexpected credits payload');
    return {
      provider: 'routerai',
      label: 'RouterAI',
      kind: 'credits',
      available: true,
      asOf: new Date().toISOString(),
      credits,
    };
  });
}

/**
 * Normalized status registry for account-backed Pi providers. Unsupported
 * providers simply have no entry; adding one adapter does not change the UI or
 * /api/info contract again.
 */
export async function readProviderStatuses(config = {}, options = {}) {
  const statusConfig = config.providerStatus || {};
  const [deepseek, wormsoft, routerai] = await Promise.all([
    readDeepseekCost(config.deepseek, options),
    readWormsoftStatus(statusConfig.wormsoft, options),
    readRouterAiStatus(statusConfig.routerai, options),
  ]);
  return {
    deepseek: {
      ...deepseek,
      provider: 'deepseek',
      label: 'DeepSeek',
      kind: 'balance',
    },
    wormsoft,
    routerai,
  };
}
