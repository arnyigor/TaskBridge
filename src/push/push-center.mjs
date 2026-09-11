import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateVapidKeys, sendPush } from './web-push.mjs';

// Who gets told when a session finishes or asks for a confirmation.
//
// The machine pushes directly to the push service the phone chose: the cloud is
// not in the path and cannot read the text (RFC 8291 encrypts it end to end).
// Subscriptions and the machine's VAPID key pair live in data/push.json — the
// private key never leaves the PC and is never sent to a browser.

const FILE = 'push.json';
const MAX_SUBSCRIPTIONS = 30;
const MAX_FAILURES = 5;

// Only the events an operator actually waits for. A push for every delta would
// be noise the phone would silence altogether.
export const PUSH_EVENTS = new Set(['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_CANCELLED', 'APPROVAL_REQUIRED']);

const TITLES = {
  TASK_SUCCEEDED: 'Готово',
  TASK_FAILED: 'Ошибка',
  TASK_CANCELLED: 'Остановлено',
  APPROVAL_REQUIRED: 'Нужно подтверждение'
};

export function notificationFor(event, task = null) {
  if (!PUSH_EVENTS.has(event?.type)) return null;
  const title = `TaskBridge: ${TITLES[event.type]}`;
  const body = String(task?.title || task?.prompt || event.message || '').slice(0, 140);
  return { title, body, taskId: event.taskId, type: event.type, at: event.at || new Date().toISOString() };
}

export class PushCenter {
  #file;
  #vapid = null;
  #subscriptions = new Map();   // endpoint -> record
  #loaded = false;
  #writing = Promise.resolve();
  #fetchImpl;
  #logger;
  #subject;

  constructor(dataRoot, { fetchImpl = globalThis.fetch, logger = () => {}, subject = 'mailto:taskbridge@localhost' } = {}) {
    this.#file = path.join(dataRoot, FILE);
    this.#fetchImpl = fetchImpl;
    this.#logger = logger;
    this.#subject = subject;
  }

  async load() {
    if (this.#loaded) return this;
    try {
      const parsed = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      if (parsed?.vapid?.publicKey && parsed?.vapid?.privateKey) this.#vapid = parsed.vapid;
      for (const record of Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : []) {
        if (record?.endpoint) this.#subscriptions.set(record.endpoint, record);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.#logger('warn', { component: 'PushCenter', event: 'file_unreadable', message: error.message });
    }
    // One key pair per machine, made on first use: a phone that subscribed with
    // the old key would never receive anything, so it is never regenerated.
    if (!this.#vapid) {
      this.#vapid = generateVapidKeys();
      await this.#save();
    }
    this.#loaded = true;
    return this;
  }

  get publicKey() { return this.#vapid?.publicKey || null; }

  list() {
    return [...this.#subscriptions.values()].map(({ endpoint, keys, ...rest }) => ({
      ...rest,
      // Enough to recognise the phone, never enough to push from elsewhere.
      endpointHost: safeHost(endpoint)
    }));
  }

  get size() { return this.#subscriptions.size; }

  async subscribe(subscription, { name = '', deviceId = null } = {}) {
    const endpoint = String(subscription?.endpoint || '');
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    if (!/^https:\/\//i.test(endpoint)) throw Object.assign(new Error('Некорректный адрес подписки.'), { code: 'INPUT_INVALID' });
    if (!p256dh || !auth) throw Object.assign(new Error('Подписка без ключей шифрования.'), { code: 'INPUT_INVALID' });
    // Re-subscribing from the same browser replaces the record instead of
    // growing the list: endpoints are unique per browser installation.
    const existing = this.#subscriptions.get(endpoint);
    if (!existing && this.#subscriptions.size >= MAX_SUBSCRIPTIONS) {
      const oldest = [...this.#subscriptions.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      if (oldest) this.#subscriptions.delete(oldest.endpoint);
    }
    const record = {
      id: existing?.id || `sub-${crypto.randomBytes(6).toString('hex')}`,
      endpoint,
      keys: { p256dh, auth },
      name: String(name || existing?.name || '').slice(0, 60) || 'Браузер',
      deviceId: deviceId || existing?.deviceId || null,
      createdAt: existing?.createdAt || new Date().toISOString(),
      lastOkAt: existing?.lastOkAt || null,
      failures: 0
    };
    this.#subscriptions.set(endpoint, record);
    await this.#save();
    return { id: record.id, name: record.name, endpointHost: safeHost(endpoint) };
  }

  async unsubscribe(endpoint) {
    if (!this.#subscriptions.delete(String(endpoint || ''))) return false;
    await this.#save();
    return true;
  }

  /**
   * Fans one notification out to every subscription. A push service that says
   * the subscription is gone (404/410) is believed immediately; other failures
   * are counted, and a consistently failing endpoint is dropped rather than
   * retried forever.
   */
  async notify(notification) {
    if (!notification || !this.#subscriptions.size) return { sent: 0, removed: 0 };
    const payload = JSON.stringify(notification);
    let sent = 0;
    let removed = 0;
    for (const record of [...this.#subscriptions.values()]) {
      try {
        const result = await sendPush({
          subscription: { endpoint: record.endpoint, keys: record.keys },
          payload,
          vapid: { ...this.#vapid, subject: this.#subject },
          fetchImpl: this.#fetchImpl
        });
        if (result.gone) { this.#subscriptions.delete(record.endpoint); removed++; continue; }
        if (result.ok) { record.failures = 0; record.lastOkAt = new Date().toISOString(); sent++; continue; }
        record.failures = (record.failures || 0) + 1;
        this.#logger('warn', { component: 'PushCenter', event: 'push_rejected', status: result.status, host: safeHost(record.endpoint) });
      } catch (error) {
        record.failures = (record.failures || 0) + 1;
        this.#logger('warn', { component: 'PushCenter', event: 'push_failed', message: error.message, host: safeHost(record.endpoint) });
      }
      if (record.failures >= MAX_FAILURES) { this.#subscriptions.delete(record.endpoint); removed++; }
    }
    await this.#save();
    return { sent, removed };
  }

  #save() {
    this.#writing = this.#writing.then(async () => {
      const payload = JSON.stringify({ version: 1, vapid: this.#vapid, subscriptions: [...this.#subscriptions.values()] }, null, 2);
      const tmp = `${this.#file}.tmp`;
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, this.#file);
    }, () => {});
    return this.#writing;
  }
}

function safeHost(endpoint) {
  try { return new URL(endpoint).host; } catch { return 'unknown'; }
}
