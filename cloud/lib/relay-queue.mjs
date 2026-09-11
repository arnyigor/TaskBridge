// Commands that arrive while the PC is off (§ durable queue).
//
// The relay is a telephone exchange, not a database — with one exception: a
// COMMAND sent to a machine that is offline. Losing it would mean the phone's
// "Стоп" or "Отправь" silently evaporates, so it is parked here until the
// machine dials in, and handed over in order at that moment.
//
// Two backends, one interface. Memory is what a single self-hosted host and the
// tests use; Upstash Redis (REST, because a serverless function cannot hold a
// TCP connection) is what survives a redeploy and a cold start on Vercel.
//
// Deliberately narrow: enqueue, drain, size. Events, sessions and history never
// pass through here — they stay on the machine.

export const QUEUE_DEFAULTS = {
  maxItems: 50,          // per machine; a phone cannot fill a disk with taps
  ttlMs: 24 * 60 * 60 * 1000  // a day-old command is stale — better dropped than surprising
};

const key = machineId => `taskbridge:queue:${machineId}`;

export function createMemoryQueue({ maxItems = QUEUE_DEFAULTS.maxItems, ttlMs = QUEUE_DEFAULTS.ttlMs, now = () => Date.now() } = {}) {
  const queues = new Map();

  const fresh = (machineId) => {
    const items = (queues.get(machineId) || []).filter(entry => entry.expiresAt > now());
    if (items.length) queues.set(machineId, items); else queues.delete(machineId);
    return items;
  };

  return {
    kind: 'memory',
    async enqueue(machineId, frame) {
      const items = fresh(machineId);
      items.push({ frame, at: now(), expiresAt: now() + ttlMs });
      // Oldest first out: a queue full of taps keeps the most recent intent.
      while (items.length > maxItems) items.shift();
      queues.set(machineId, items);
      return { queued: items.length };
    },
    async drain(machineId) {
      const items = fresh(machineId);
      queues.delete(machineId);
      return items.map(entry => entry.frame);
    },
    async size(machineId) { return fresh(machineId).length; }
  };
}

/**
 * Upstash Redis over its REST API. One list per machine: RPUSH + LTRIM + PEXPIRE
 * on the way in, LRANGE + DEL on the way out — both as a single pipeline call,
 * so a drain cannot lose a command that arrives mid-flight (it lands in the new
 * list, not in the one being deleted).
 */
export function createUpstashQueue({ url, token, fetchImpl = globalThis.fetch, maxItems = QUEUE_DEFAULTS.maxItems, ttlMs = QUEUE_DEFAULTS.ttlMs, timeoutMs = 5000, logger = () => {} } = {}) {
  if (!url || !token) throw Object.assign(new Error('Upstash queue needs a REST url and token'), { code: 'INPUT_INVALID' });
  const base = String(url).replace(/\/+$/, '');

  async function pipeline(commands) {
    const response = await fetchImpl(`${base}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw Object.assign(new Error(`Upstash replied ${response.status}`), { code: 'QUEUE_UNAVAILABLE' });
    const results = await response.json();
    return (Array.isArray(results) ? results : []).map(entry => entry?.result);
  }

  return {
    kind: 'upstash',
    async enqueue(machineId, frame) {
      const list = key(machineId);
      const [length] = await pipeline([
        ['RPUSH', list, JSON.stringify(frame)],
        ['LTRIM', list, -maxItems, -1],
        ['PEXPIRE', list, String(ttlMs)]
      ]);
      return { queued: Number(length) || 0 };
    },
    async drain(machineId) {
      const list = key(machineId);
      const [items] = await pipeline([
        ['LRANGE', list, '0', '-1'],
        ['DEL', list]
      ]);
      const frames = [];
      for (const raw of Array.isArray(items) ? items : []) {
        // One unparsable entry must not swallow the rest of the queue.
        try { frames.push(JSON.parse(raw)); }
        catch (error) { logger('warn', { event: 'queue_entry_invalid', message: error.message }); }
      }
      return frames;
    },
    async size(machineId) {
      const [length] = await pipeline([['LLEN', key(machineId)]]);
      return Number(length) || 0;
    }
  };
}

/**
 * Upstash when the deployment has it (the Vercel Marketplace sets these two
 * variables), memory otherwise. A missing Redis is not a failure: a single host
 * queues in memory and says so in the log.
 */
export function createQueueFromEnv(env = process.env, { fetchImpl = globalThis.fetch, logger = () => {}, ...options } = {}) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '';
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '';
  if (url && token) return createUpstashQueue({ url, token, fetchImpl, logger, ...options });
  logger('info', { event: 'queue_memory', reason: 'UPSTASH_REDIS_REST_URL/TOKEN are not set' });
  return createMemoryQueue(options);
}
