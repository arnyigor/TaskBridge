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
const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const CLIENT_KINDS = new Set(['android', 'desktop', 'web', 'cli']);
// lastSeenAt is kept fresh in memory; the file only needs it roughly.
const LAST_SEEN_SAVE_MS = 3600000;

// R1.1: TaskBridge runs shell commands, so without pairing anyone who reaches the
// port owns the PC. Beyond loopback only with auth on; otherwise the caller
// falls back to 127.0.0.1 and says so.
export const lanAllowed = (host, auth = {}) =>
  auth?.enabled === true || ['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase());
// Tailscale hands out addresses from the CGNAT block 100.64.0.0/10.
export const isTailnetIp = ip => {
  const [a, b] = String(ip).split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
};
export const LAN_CLOSED_WARNING = 'WARNING: server.auth.enabled is false — listening on 127.0.0.1 only. Enable auth in config.json to reach TaskBridge from other devices.';

export class AccessControl {
  constructor(config = {}, dataRoot) {
    this.enabled = config?.enabled === true;
    // R1.3: origins other than the one the page was served from, e.g. the
    // `https://pc.<tailnet>.ts.net` of `tailscale serve`.
    this.allowedOrigins = new Set((config?.allowedOrigins || []).map(origin => String(origin).replace(/\/+$/, '').toLowerCase()));
    this.dataRoot = dataRoot;
    this.attempts = new Map();
    this.devices = [];
    this.saving = Promise.resolve();
  }

  get file() { return path.join(this.dataRoot, 'server-auth.json'); }

  async init() {
    if (!this.enabled) return;
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.secret = saved.secret;
      this.devices = Array.isArray(saved.devices) ? saved.devices : [];
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.secret = crypto.randomBytes(32).toString('hex');
      await fs.writeFile(this.file, JSON.stringify({ secret: this.secret, devices: [] }), { flag: 'wx', mode: 0o600 });
    }
    if (!/^[a-f0-9]{64}$/.test(this.secret)) throw new Error('Повреждён файл авторизации TaskBridge.');
  }

  // Writes are chained so two pairings in the same tick cannot lose each other,
  // and go through a temp file so a crash never leaves a half-written secret.
  save() {
    this.saving = this.saving.catch(() => {}).then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ secret: this.secret, devices: this.devices }, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    return this.saving;
  }

  // R1.2: every paired client is a device with its own token. The server keeps
  // only the token's hash; the token itself leaves this process once.
  async addDevice({ name, kind } = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const clientKind = CLIENT_KINDS.has(kind) ? kind : 'web';
    const device = {
      deviceId: `d_${crypto.randomBytes(6).toString('hex')}`,
      name: String(name || '').trim().slice(0, 80) || (clientKind === 'web' ? 'Браузер' : 'Устройство'),
      kind: clientKind,
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: now
    };
    this.devices.push(device);
    await this.save();
    return { device, token };
  }

  listDevices() {
    return this.devices.map(({ tokenHash, ...device }) => device);
  }

  async removeDevice(deviceId) {
    const before = this.devices.length;
    this.devices = this.devices.filter(device => device.deviceId !== deviceId);
    if (this.devices.length === before) throw fail('Устройство не найдено.', 'NOT_FOUND');
    await this.save();
  }

  deviceByToken(token) {
    if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
    const hash = hashToken(token);
    const device = this.devices.find(item => same(item.tokenHash, hash));
    if (!device) return null;
    const now = Date.now();
    const seen = Date.parse(device.lastSeenAt) || 0;
    device.lastSeenAt = new Date(now).toISOString();
    if (now - seen > LAST_SEEN_SAVE_MS) this.save().catch(() => {});
    return device;
  }

  bearer(req) {
    return /^Bearer\s+([a-f0-9]{64})\s*$/i.exec(req.headers.authorization || '')?.[1] || null;
  }

  // The paired device behind this request, if any.
  device(req) {
    if (!this.enabled) return null;
    const token = this.bearer(req) || /(?:^|;\s*)taskbridge_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    return token ? this.deviceByToken(token) : null;
  }

  local(req) {
    let host;
    try { host = new URL(`http://${req.headers.host}`).hostname; } catch { return false; }
    // R1.4: behind a reverse proxy (ours, or `tailscale serve`) the peer is
    // always loopback, and a proxy may rewrite Host to 127.0.0.1. The real
    // client — the last X-Forwarded-For entry — must be loopback too, and a
    // request Tailscale tagged with a tailnet identity is never local.
    return isLoopback(req.socket.remoteAddress) && isLoopback(this.clientAddress(req))
      && !req.headers['tailscale-user-login']
      && ['localhost', '127.0.0.1', '[::1]'].includes(host.toLowerCase());
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
    const bearer = this.bearer(req);
    if (bearer) return Boolean(this.deviceByToken(bearer));
    // R1.3: a browser always sends Origin on a state-changing request, so a
    // cookie without one is not a browser — native clients use Bearer.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.headers.origin) return false;
    const token = /(?:^|;\s*)taskbridge_session=([a-f0-9.]+)/.exec(req.headers.cookie || '')?.[1];
    if (!token) return false;
    if (/^[a-f0-9]{64}$/.test(token)) return Boolean(this.deviceByToken(token));
    // Signed cookies issued before device tokens: valid until they expire.
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
      const allowed = origin.host === req.headers.host || this.allowedOrigins.has(origin.origin.toLowerCase());
      if (!['http:', 'https:'].includes(origin.protocol) || !allowed) throw fail('Запрос с другого сайта запрещён.', 'ORIGIN_FORBIDDEN');
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

  async pair(req, res, { code, deviceName, clientKind } = {}) {
    if (!this.enabled) return null;
    // Behind the LAN proxy every peer is loopback; count attempts per real client,
    // or one phone's typos lock out every other device.
    const ip = this.clientAddress(req);
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
    const { device, token } = await this.addDevice({ name: deviceName, kind: clientKind });
    // Browsers keep the same device token as an HttpOnly cookie. Chrome caps a
    // cookie at 400 days; revoking the device is the real expiry.
    res.setHeader('set-cookie', `taskbridge_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000${req.socket.encrypted ? '; Secure' : ''}`);
    return { deviceId: device.deviceId, token };
  }
}
