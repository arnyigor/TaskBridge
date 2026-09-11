import crypto from 'node:crypto';

// Web Push from the machine itself (RFC 8030 / 8291 / 8292).
//
// The PC is the source of truth, so it also is the application server: it signs
// its own VAPID token and posts the encrypted message straight to the push
// service the phone chose. The cloud is not involved and never sees the text —
// the payload is encrypted with keys only the phone and this machine share.
//
// Everything here is pure Node crypto; the only IO is one POST per subscription.

const b64url = buffer => Buffer.from(buffer).toString('base64url');
const fromB64url = value => Buffer.from(String(value), 'base64url');

const RECORD_SIZE = 4096;
const KEY_INFO = Buffer.from('WebPush: info\0', 'utf8');
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'utf8');

const hkdf = (ikm, salt, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));

/** A fresh VAPID key pair, stored once per machine (data/vapid.json). */
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: b64url(publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)),
    privateKey: String(jwk.d)
  };
}

function vapidKeyObject({ publicKey, privateKey }) {
  const raw = fromB64url(publicKey);
  if (raw.length !== 65 || raw[0] !== 0x04) throw Object.assign(new Error('VAPID public key must be a 65-byte uncompressed P-256 point'), { code: 'INPUT_INVALID' });
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33)) },
    format: 'jwk'
  });
}

/**
 * The VAPID Authorization header for one push service (RFC 8292). `subject` is
 * how that service reaches the operator — a mailto: or https: URL.
 */
export function vapidHeader({ endpoint, publicKey, privateKey, subject = 'mailto:taskbridge@localhost', now = Date.now(), ttlSeconds = 12 * 60 * 60 }) {
  const audience = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + ttlSeconds, sub: subject }));
  const signingInput = `${header}.${claims}`;
  // JOSE wants the raw r||s pair, not the DER encoding Node signs with by default.
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: vapidKeyObject({ publicKey, privateKey }),
    dsaEncoding: 'ieee-p1363'
  });
  return `vapid t=${signingInput}.${b64url(signature)}, k=${publicKey}`;
}

/**
 * aes128gcm body for one subscription (RFC 8291 §3). `salt` and `serverKeys` are
 * injectable so the RFC's own example can be reproduced exactly in a test.
 */
export function encryptPayload({ payload, p256dh, auth, salt = crypto.randomBytes(16), serverKeys = null }) {
  const clientPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  if (clientPublic.length !== 65 || clientPublic[0] !== 0x04) throw Object.assign(new Error('subscription p256dh is not a P-256 point'), { code: 'INPUT_INVALID' });
  if (authSecret.length !== 16) throw Object.assign(new Error('subscription auth secret must be 16 bytes'), { code: 'INPUT_INVALID' });

  const ecdh = crypto.createECDH('prime256v1');
  if (serverKeys) ecdh.setPrivateKey(fromB64url(serverKeys.privateKey));
  else ecdh.generateKeys();
  const serverPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(clientPublic);

  // The push-specific step: the shared secret is bound to both public keys and
  // to the subscription's auth secret before the generic aes128gcm scheme runs.
  const ikm = hkdf(shared, authSecret, Buffer.concat([KEY_INFO, clientPublic, serverPublic]), 32);
  const key = hkdf(ikm, salt, CEK_INFO, 16);
  const nonce = hkdf(ikm, salt, NONCE_INFO, 12);

  const plaintext = Buffer.from(payload, 'utf8');
  if (plaintext.length + 17 > RECORD_SIZE) throw Object.assign(new Error('push payload is too large for one record'), { code: 'INPUT_INVALID' });
  const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce);
  // 0x02 is the "last record" delimiter; there is only ever one record here.
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(5);
  header.writeUInt32BE(RECORD_SIZE, 0);
  header.writeUInt8(serverPublic.length, 4);
  return Buffer.concat([salt, header, serverPublic, ciphertext]);
}

/**
 * Delivers one notification. Returns { ok, status, gone } — `gone` marks a
 * subscription the push service has retired (404/410), which the caller should
 * forget instead of retrying forever.
 */
export async function sendPush({ subscription, payload, vapid, ttlSeconds = 12 * 60 * 60, urgency = 'normal', fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 10_000 }) {
  const endpoint = subscription?.endpoint;
  if (!endpoint || !/^https:\/\//i.test(endpoint)) throw Object.assign(new Error('push subscription endpoint is invalid'), { code: 'INPUT_INVALID' });
  const body = encryptPayload({ payload, p256dh: subscription.keys?.p256dh, auth: subscription.keys?.auth });
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidHeader({ endpoint, publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: vapid.subject, now }),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttlSeconds),
      urgency
    },
    body,
    // A push service that never answers must not hold up the next notification.
    signal: AbortSignal.timeout(timeoutMs)
  });
  const gone = response.status === 404 || response.status === 410;
  return { ok: response.ok, status: response.status, gone };
}
