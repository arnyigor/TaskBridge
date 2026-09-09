import crypto from 'node:crypto';

// Machine authentication (§11). The secret is only ever used inside the local
// process: it never reaches frontend JavaScript and never appears in logs.

export function machineAuthHeaders({ machineId, secret, authMode = 'bearer', method = 'GET', path = '/', body = '', timestamp = Date.now(), protocolVersion = 1 }) {
  const headers = {
    'x-taskbridge-machine': machineId,
    'x-taskbridge-protocol': String(protocolVersion)
  };
  if (authMode === 'hmac') {
    const ts = String(timestamp);
    headers['x-taskbridge-timestamp'] = ts;
    headers['x-taskbridge-signature'] = signRequest({ secret, method, path, body, timestamp: ts });
  } else {
    headers.authorization = `Bearer ${secret}`;
  }
  return headers;
}

export function bodyHash(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function signRequest({ secret, method, path, body, timestamp }) {
  const payload = [String(method).toUpperCase(), path, String(timestamp), bodyHash(body)].join('\n');
  return `sha256=${crypto.createHmac('sha256', String(secret)).update(payload).digest('hex')}`;
}

// Constant-time comparison; length differences are folded into the result
// instead of short-circuiting, so a wrong-length signature cannot be probed.
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  const length = Math.max(left.length, right.length, 1);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  return crypto.timingSafeEqual(paddedLeft, paddedRight) && left.length === right.length;
}

export function verifySignature({ secret, method, path, body, timestamp, signature, toleranceMs = 300000, now = Date.now() }) {
  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts) || ts <= 0) return false;
  if (Math.abs(now - ts) > toleranceMs) return false;
  const expected = signRequest({ secret, method, path, body, timestamp: String(timestamp) });
  return safeEqual(expected, signature);
}

export function verifyMachineSecret(secret, provided) {
  return safeEqual(secret, provided);
}

// Never log the secret itself (§86): only a short fingerprint, useful for
// matching a machine to the value stored in the cloud.
export function secretFingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret ?? '')).digest('hex').slice(0, 12);
}
