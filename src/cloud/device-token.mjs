import crypto from 'node:crypto';

// Device tokens (§ cloud-protocol.md, pairing).
//
// A phone proves it is paired with a machine by presenting a token the machine
// signed. Nobody has to keep a registry: the relay knows the machine secret (it
// must, to accept the machine itself) and can verify the signature, while the
// list of trusted devices stays on the PC in trusted-devices.json.
//
// Token format: v1.<base64url payload>.<base64url HMAC-SHA256(payload)>

export const DEVICE_TOKEN_VERSION = 'v1';
export const DEFAULT_DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const b64url = buffer => Buffer.from(buffer).toString('base64url');
const fail = (reason, message) => ({ ok: false, reason, message });

function sign(payload, secret) {
  return b64url(crypto.createHmac('sha256', String(secret)).update(payload).digest());
}

export function issueDeviceToken({ machineId, deviceId, secret, ttlMs = DEFAULT_DEVICE_TOKEN_TTL_MS, now = Date.now() } = {}) {
  if (!machineId || !deviceId) throw Object.assign(new Error('machineId and deviceId are required'), { code: 'INPUT_INVALID' });
  if (!secret || String(secret).length < 16) throw Object.assign(new Error('machine secret is required and must be at least 16 characters'), { code: 'INPUT_INVALID' });
  const payload = b64url(JSON.stringify({ v: DEVICE_TOKEN_VERSION, machineId, deviceId, iat: now, exp: now + ttlMs }));
  return `${DEVICE_TOKEN_VERSION}.${payload}.${sign(payload, secret)}`;
}

/**
 * Verifies a token: signature, version, expiry and that it names this machine
 * (and this device, when the caller insists on one). Never throws on bad input —
 * a relay must treat malformed credentials as a plain "no".
 */
export function verifyDeviceToken(token, { secret, machineId, deviceId = null, now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token.trim()) return fail('TOKEN_MISSING', 'device token is required');
  if (!secret) return fail('MACHINE_UNKNOWN', 'machine secret is not configured');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== DEVICE_TOKEN_VERSION) return fail('TOKEN_MALFORMED', 'device token is malformed');
  const [, payload, signature] = parts;
  const expected = sign(payload, secret);
  const givenBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (givenBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(givenBuffer, expectedBuffer)) {
    return fail('TOKEN_SIGNATURE', 'device token signature does not match');
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return fail('TOKEN_MALFORMED', 'device token payload is not JSON'); }
  if (claims?.v !== DEVICE_TOKEN_VERSION || typeof claims.machineId !== 'string' || typeof claims.deviceId !== 'string') {
    return fail('TOKEN_MALFORMED', 'device token claims are invalid');
  }
  if (machineId && claims.machineId !== machineId) return fail('TOKEN_MACHINE_MISMATCH', 'device token belongs to another machine');
  if (deviceId && claims.deviceId !== deviceId) return fail('TOKEN_DEVICE_MISMATCH', 'device token belongs to another device');
  if (!Number.isFinite(claims.exp) || claims.exp <= now) return fail('TOKEN_EXPIRED', 'device token has expired');
  return { ok: true, machineId: claims.machineId, deviceId: claims.deviceId, expiresAt: claims.exp };
}
