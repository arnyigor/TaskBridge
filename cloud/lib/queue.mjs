const retention = 7 * 24 * 60 * 60;

function oidc(req) {
  const token = req.headers['x-vercel-oidc-token'] || process.env.VERCEL_OIDC_TOKEN;
  if (!token) throw Object.assign(new Error('Vercel OIDC token is unavailable'), { status: 503 });
  return token;
}

async function call(req, pathname, options = {}, allowed = []) {
  const region = process.env.QUEUE_REGION || 'fra1';
  if (!/^[a-z0-9-]+$/.test(region)) throw Object.assign(new Error('Invalid QUEUE_REGION'), { status: 503 });
  const response = await fetch(`https://${region}.vercel-queue.com/api/v3${pathname}`, {
    ...options, headers: { authorization: `Bearer ${oidc(req)}`, ...(options.headers || {}) }
  });
  if (!response.ok && response.status !== 204 && !allowed.includes(response.status)) {
    const detail = (await response.text()).slice(0, 500);
    throw Object.assign(new Error(`Queue ${response.status}: ${detail}`), { status: response.status >= 500 ? 502 : response.status });
  }
  return response;
}

export async function send(req, topic, body, idempotencyKey) {
  await call(req, `/topic/${encodeURIComponent(topic)}`, {
    method: 'POST', body: JSON.stringify(body), headers: {
      'content-type': 'application/json', 'vqs-retention-seconds': String(retention),
      ...(idempotencyKey ? { 'vqs-idempotency-key': idempotencyKey } : {})
    }
  });
}

export async function receive(req, topic, consumer, limit = 10, maxConcurrency = null) {
  const response = await call(req, `/topic/${encodeURIComponent(topic)}/consumer/${encodeURIComponent(consumer)}`, {
    method: 'POST', headers: { accept: 'application/x-ndjson', 'vqs-max-messages': String(Math.min(Math.max(limit, 1), 10)),
      'vqs-visibility-timeout-seconds': '60', ...(maxConcurrency ? { 'vqs-max-concurrency': String(maxConcurrency) } : {}) }
  });
  if (response.status === 204) return [];
  const text = await response.text();
  return text.split('\n').filter(Boolean).map(line => {
    const envelope = JSON.parse(line);
    return { ...envelope, value: JSON.parse(Buffer.from(envelope.body, 'base64').toString('utf8')) };
  });
}

export async function acknowledge(req, topic, consumer, receiptHandle) {
  await call(req, `/topic/${encodeURIComponent(topic)}/consumer/${encodeURIComponent(consumer)}/lease/${encodeURIComponent(receiptHandle)}`, { method: 'DELETE' }, [404, 410]);
}
