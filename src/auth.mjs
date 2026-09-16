import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fail = (message, code = 'AUTH_REQUIRED') => Object.assign(new Error(message), { code });
// An address as the OS reports it: IPv4-mapped IPv6 is unwrapped and an IPv6
// zone id is dropped, so two spellings of the same host compare equal.
const normalizeAddress = value => String(value || '').trim().replace(/^::ffff:/i, '').replace(/%.*$/, '');
const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(normalizeAddress(address));
const same = (a, b) => {
  const aa = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};

export class AccessControl {
  constructor(config = {}, dataRoot) {
    this.enabled = config.enabled === true;
    this.dataRoot = dataRoot;
    this.attempts = new Map();
  }

  async init() {
    if (!this.enabled) return;
    const file = path.join(this.dataRoot, 'server-auth.json');
    try { this.secret = JSON.parse(await fs.readFile(file, 'utf8')).secret; }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.secret = crypto.randomBytes(32).toString('hex');
      await fs.writeFile(file, JSON.stringify({ secret: this.secret }), { flag: 'wx', mode: 0o600 });
    }
    if (!/^[a-f0-9]{64}$/.test(this.secret)) throw new Error('Повреждён файл авторизации TaskBridge.');
  }

  local(req) {
    let host;
    try { host = new URL(`http://${req.headers.host}`).hostname; } catch { return false; }
    return isLoopback(req.socket.remoteAddress) && ['localhost', '127.0.0.1', '[::1]'].includes(host.toLowerCase());
  }

  // The address the request really came from. A loopback peer is either the
  // browser on this machine or our own reverse proxy; the proxy appends the
  // address it saw the request from as the LAST X-Forwarded-For entry, and that
  // entry is the only one a client cannot forge (its own header is prepended).
  clientAddress(req) {
    const peer = normalizeAddress(req.socket?.remoteAddress);
    if (isLoopback(peer)) {
      const forwarded = String(req.headers['x-forwarded-for'] || '')
        .split(',').map(normalizeAddress).filter(Boolean).pop();
      if (forwarded) return forwarded;
    }
    return peer;
  }

  // True when the request came from the machine itself — a browser opened on
  // 127.0.0.1, or one opened on the machine's own LAN address while a phone on
  // the same network does not qualify. Needed for actions that run on the host
  // (opening a file with its OS application), where the Host-only `local` check
  // is too strict: on the LAN proxy every peer is loopback and Host is the only
  // leg, so a PC using its LAN address would be mistaken for a phone.
  isThisMachine(address) {
    const value = normalizeAddress(address);
    if (!value) return false;
    if (isLoopback(value)) return true;
    if (!this.ownAddresses) {
      this.ownAddresses = new Set();
      for (const list of Object.values(os.networkInterfaces())) for (const item of list || []) this.ownAddresses.add(normalizeAddress(item.address));
    }
    return this.ownAddresses.has(value);
  }

  machine(req) {
    return this.isThisMachine(this.clientAddress(req));
  }

  sign(text) { return crypto.createHmac('sha256', this.secret).update(text).digest('hex'); }

  pairing() {
    const bucket = Math.floor(Date.now() / 600000);
    const code = (parseInt(this.sign(`pair:${bucket}`).slice(0, 12), 16) % 100000000).toString().padStart(8, '0');
    return { code, expiresAt: (bucket + 1) * 600000 };
  }

  authenticated(req) {
    if (!this.enabled || this.local(req)) return true;
    const token = /(?:^|;\s*)taskbridge_session=([a-f0-9.]+)/.exec(req.headers.cookie || '')?.[1];
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const expires = Number(parts[0]);
    return Number.isSafeInteger(expires) && expires > Date.now() && expires <= Date.now() + 31 * 86400000 && same(parts[2], this.sign(`${parts[0]}.${parts[1]}`));
  }

  require(req) {
    if (!this.authenticated(req)) throw fail('Введите код подключения с компьютера.');
  }

  checkOrigin(req) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('Запрос с другого сайта запрещён.', 'ORIGIN_FORBIDDEN');
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { throw fail('Недопустимый Origin.', 'ORIGIN_FORBIDDEN'); }
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) throw fail('Запрос с другого сайта запрещён.', 'ORIGIN_FORBIDDEN');
    }
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const type = req.headers['content-type'] || '';
      const isJson = /^application\/json(?:;|$)/i.test(type);
      // multipart/form-data is a CORS-"simple" content type, so a cross-origin
      // form could send it without a preflight. Require a custom header that
      // such a form cannot set without a preflight the server never allows.
      const isUpload = /^multipart\/form-data(?:;|$)/i.test(type) && req.headers['x-taskbridge-upload'] === '1';
      if (!isJson && !isUpload) throw fail('Требуется JSON-запрос.', 'INPUT_INVALID');
    }
  }

  pair(req, res, code) {
    if (!this.enabled) return;
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    // Bound memory, including requests from changing addresses.
    for (const [key, value] of this.attempts) if (now - value.since > 600000) this.attempts.delete(key);
    if (!this.attempts.has(ip) && this.attempts.size >= 1000) throw fail('Слишком много попыток подключения.', 'RATE_LIMITED');
    const record = this.attempts.get(ip) || { since: now, count: 0 };
    if (record.count >= 5) throw fail('Слишком много попыток. Повторите через 10 минут.', 'RATE_LIMITED');
    record.count++;
    this.attempts.set(ip, record);
    if (!same(String(code || '').replaceAll(' ', ''), this.pairing().code)) throw fail('Неверный или истёкший код.', 'AUTH_REQUIRED');
    this.attempts.delete(ip);
    const unsigned = `${now + 30 * 86400000}.${crypto.randomBytes(16).toString('hex')}`;
    res.setHeader('set-cookie', `taskbridge_session=${unsigned}.${this.sign(unsigned)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${req.socket.encrypted ? '; Secure' : ''}`);
  }
}
