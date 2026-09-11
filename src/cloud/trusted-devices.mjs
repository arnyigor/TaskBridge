import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Which phones may reach this machine through the relay (§ pairing).
//
// Device tokens are stateless HMACs: the relay can check a signature without any
// registry, which is exactly why revocation has to live here. The machine is the
// source of truth, so the list of paired devices — and the fact that one was
// revoked — stays on the PC in data/trusted-devices.json, and the connector
// refuses frames from a device that is not on it.
//
// The file is small and rewritten whole: a handful of phones, never a hot path.

const FILE = 'trusted-devices.json';
const MAX_DEVICES = 50;

const now = () => new Date().toISOString();

export function newDeviceId() {
  return `dev-${crypto.randomBytes(8).toString('hex')}`;
}

export class TrustedDevices {
  #file;
  #devices = new Map();
  #loaded = false;
  #writing = Promise.resolve();

  constructor(dataRoot) {
    this.#file = path.join(dataRoot, FILE);
  }

  async load() {
    if (this.#loaded) return this;
    try {
      const parsed = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      for (const device of Array.isArray(parsed?.devices) ? parsed.devices : []) {
        if (typeof device?.deviceId === 'string' && device.deviceId) this.#devices.set(device.deviceId, device);
      }
    } catch (error) {
      // A missing or unreadable file means "no device is paired yet", never a
      // crash on boot: pairing simply starts from scratch.
      if (error.code !== 'ENOENT') console.error(`[TaskBridge] trusted-devices.json unreadable: ${error.message}`);
    }
    this.#loaded = true;
    return this;
  }

  list() {
    return [...this.#devices.values()]
      .map(device => ({ ...device }))
      .sort((a, b) => String(b.pairedAt).localeCompare(String(a.pairedAt)));
  }

  get(deviceId) {
    const device = this.#devices.get(deviceId);
    return device ? { ...device } : null;
  }

  /** A device may talk to this machine while it is paired and not revoked. */
  allowed(deviceId) {
    const device = this.#devices.get(deviceId);
    return Boolean(device) && !device.revokedAt;
  }

  async add({ deviceId, name = '', machineId = '', expiresAt = null }) {
    if (!deviceId) throw Object.assign(new Error('deviceId is required'), { code: 'INPUT_INVALID' });
    // Oldest revoked entries go first: the list is a record of live devices, not
    // an audit log, and it must not grow without bound.
    if (this.#devices.size >= MAX_DEVICES) {
      const victim = [...this.#devices.values()].filter(device => device.revokedAt).sort((a, b) => String(a.pairedAt).localeCompare(String(b.pairedAt)))[0];
      if (victim) this.#devices.delete(victim.deviceId);
    }
    const device = {
      deviceId,
      name: String(name || '').slice(0, 60) || 'Устройство',
      machineId,
      pairedAt: now(),
      lastSeenAt: null,
      expiresAt,
      revokedAt: null
    };
    this.#devices.set(deviceId, device);
    await this.#save();
    return { ...device };
  }

  async revoke(deviceId) {
    const device = this.#devices.get(deviceId);
    if (!device) throw Object.assign(new Error('Устройство не найдено.'), { code: 'NOT_FOUND' });
    if (device.revokedAt) return { ...device };
    device.revokedAt = now();
    await this.#save();
    return { ...device };
  }

  async remove(deviceId) {
    if (!this.#devices.delete(deviceId)) throw Object.assign(new Error('Устройство не найдено.'), { code: 'NOT_FOUND' });
    await this.#save();
  }

  /** Presence, best effort: a failed write must never break a live connection. */
  touch(deviceId) {
    const device = this.#devices.get(deviceId);
    if (!device || device.revokedAt) return false;
    device.lastSeenAt = now();
    this.#save().catch(() => {});
    return true;
  }

  #save() {
    // Serialized writes: two pairings at once must not interleave into a
    // half-written file.
    this.#writing = this.#writing.then(async () => {
      const payload = JSON.stringify({ version: 1, devices: [...this.#devices.values()] }, null, 2);
      const tmp = `${this.#file}.tmp`;
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, this.#file);
    }, () => {});
    return this.#writing;
  }
}
