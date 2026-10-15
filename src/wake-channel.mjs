// Свой push-канал в локальной сети (раздел 4.3 плана, «push вместо опроса»).
// Решение оператора 2026-10-14: канал работает ТОЛЬКО когда устройство в одной
// сети с сервером — никаких внешних сервисов (FCM) не требуется.
//
// Как это устроено:
//   1. Клиент (Android) держит крошечный HTTP-приёмник на своём порту и
//      регистрирует его на сервере: `POST /api/clients/wake {port}`. Адрес
//      устройства сервер берёт из самого запроса (socket.remoteAddress).
//   2. Когда ход завершается (TASK_SUCCEEDED / FAILED / CANCELLED), сервер
//      fire-and-forget отправляет каждому зарегистрированному устройству
//      короткий POST {taskId,type,at}. Устройство просыпается, делает обычный
//      refresh списка и показывает уведомление.
//   3. Промах — штатная ситуация (телефон уснул, Wi-Fi оборвался): фоновый
//      опрос остаётся запасным каналом, push лишь сокращает задержку и число
//      пустых запросов. Поэтому доставка «at-most-once», без ретраев и очередей.

const LAN_V4 = [/^10\./u, /^127\./u, /^192\.168\./u, /^172\.(1[6-9]|2\d|3[01])\./u];

/** Только приватные адреса: публичный IP зарегистрировать нельзя — канал задуман для локальной сети. */
export function isLanAddress(address) {
  const value = String(address || '').replace(/^::ffff:/u, '').replace(/[[\]]/gu, '');
  if (LAN_V4.some(pattern => pattern.test(value))) return true;
  // IPv6: loopback и ULA fc00::/7; глобальные адреса (2xxx:, публичные) — нет.
  if (/^::1$/u.test(value)) return true;
  return /^f[cd][0-9a-f]{2}:/iu.test(value);
}

/** Порт приёмника: число 1..65535, не «порт из догадки». */
export function isValidWakePort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export const WAKE_TIMEOUT_MS = 2_000;

export class WakeChannel {
  #devices = new Map(); // id -> { address, port, failures, registeredAt }
  #now;

  constructor({ now = () => Date.now(), timeoutMs = WAKE_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.#now = now;
  }

  /**
   * Регистрация приёмника устройства. Повторная регистрация того же адреса
   * обновляет порт (приложение могло перезапуститься и получить другой).
   * Публичный адрес отклоняется: канал только для локальной сети.
   */
  register({ address, port }) {
    if (!isLanAddress(address)) {
      return { ok: false, code: 'NOT_LAN', message: 'wake-канал работает только в локальной сети' };
    }
    if (!isValidWakePort(port)) {
      return { ok: false, code: 'INPUT_INVALID', message: 'порт приёмника — целое число 1..65535' };
    }
    const id = `${address}:${port}`;
    // Приложение после перезапуска получило другой порт: старую запись того же
    // адреса снимаем, чтобы не будить мёртвый приёмник.
    for (const device of this.#devices.values()) {
      if (device.address === address && device.port !== port) this.#devices.delete(device.id);
    }
    this.#devices.set(id, { address, port, id, failures: 0, registeredAt: this.#now() });
    return { ok: true, id };
  }

  unregister({ address, port }) {
    return this.#devices.delete(`${address}:${port}`);
  }

  get devices() {
    return [...this.#devices.values()];
  }

  /** Адрес, как его видит сервер: IPv4-маппинг IPv6 разворачивается. */
  static normalize(address) {
    return String(address || '').replace(/^::ffff:/u, '');
  }

  /**
   * Разбудить все зарегистрированные устройства. Ошибки не выбрасываются:
   * недоступный телефон — не ошибка сервера, а штатный сон устройства. После
   * WAKE_PRUNE_FAILURES подряд неудачных попыток устройство выбывается —
   * иначе мёртвые записи копились бы вечно.
   */
  async sendAll(event) {
    const results = await Promise.allSettled(this.devices.map(device => this.#send(device, event)));
    const failures = new Map();
    results.forEach((result, index) => {
      const device = this.devices[index];
      if (result.status === 'fulfilled' && result.value) failures.set(device.id, 0);
      else failures.set(device.id, device.failures + 1);
    });
    for (const device of this.devices) {
      const count = failures.get(device.id) ?? 0;
      if (count >= WAKE_PRUNE_FAILURES) this.#devices.delete(device.id);
      else device.failures = count;
    }
    return { sent: this.devices.length };
  }

  async #send(device, event) {
    try {
      const response = await this.fetchImpl(`http://${device.address}:${device.port}/wake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/** Сколько неудачных wake подряд держим запись, прежде чем забыть устройство. */
export const WAKE_PRUNE_FAILURES = 5;
