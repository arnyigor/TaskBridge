// Durable local HTTP command acceptance/replay. No session, runtime or UI logic.
export class CommandCoordinator {
  constructor(store) {
    this.store = store;
    this.cache = new Map();
  }
  async run(commandId, clientId, hashOf, fn) {
    if (!hashOf) throw new Error('internal: hashOf required');
    this.#evictCommands();
    const hash = hashOf();
    let entry = this.cache.get(commandId);
    if (!entry) {
      // Durable lookup: a finished command from a previous process replays, and
      // an ACCEPTED-but-unfinished id is a possible crash.
      const stored = this.store.getCommand(commandId);
      if (stored) {
        if (stored.hash !== hash) {
          throw Object.assign(new Error('Команда уже принималась с другим содержимым.'), { code: 'CONFLICT' });
        }
        if (stored.done) {
          const status = stored.status || (stored.result != null ? 'COMPLETED' : 'REJECTED');
          const replay = { hash, done: true, result: stored.result, at: stored.at, clientId: stored.clientId, status };
          this.cache.set(commandId, replay);
          if (status === 'REJECTED') throw this.#commandError(stored.result);
          return stored.result;
        }
        this.cache.set(commandId, { hash, done: false, result: null, at: stored.at, clientId: stored.clientId, status: 'UNKNOWN_AFTER_CRASH' });
        throw Object.assign(new Error('Исход команды неизвестен после перезапуска — проверьте историю перед повтором.'), { code: 'UNKNOWN_AFTER_CRASH' });
      }
    } else {
      if (entry.hash !== hash) {
        throw Object.assign(new Error('Команда уже принималась с другим содержимым.'), { code: 'CONFLICT' });
      }
      if (entry.done) {
        if (entry.status === 'REJECTED') throw this.#commandError(entry.result);
        return entry.result;
      }
      throw Object.assign(new Error('Команда уже выполняется.'), { code: entry.status === 'UNKNOWN_AFTER_CRASH' ? 'UNKNOWN_AFTER_CRASH' : 'ACCEPTED' });
    }
    // New command: persist ACCEPTED before running, so we cannot lose track of a
    // command that crashed mid-run. If we cannot record it we must not run it.
    try {
      this.store.upsertCommand(commandId, { hash, done: false, clientId, status: 'ACCEPTED' });
    } catch (error) {
      throw Object.assign(new Error('Не удалось зафиксировать команду: ' + (error?.message || error)), { code: 'COMMAND_LEDGER_FAILED' });
    }
    const receipt = { hash, done: false, result: null, at: Date.now(), clientId, status: 'DISPATCHING' };
    this.cache.set(commandId, receipt);
    // ACCEPTED is already durable; a failure to refine its stage cannot lose
    // the identity that prevents execution after an unknown outcome.
    try { this.store.upsertCommand(commandId, receipt); } catch {}
    let result;
    try {
      result = await fn();
    } catch (error) {
      const rejected = { error: { code: error?.code || 'INTERNAL_ERROR', message: error?.message || String(error) } };
      this.#finish(commandId, { ...receipt, done: true, result: rejected, status: 'REJECTED' });
      throw error;
    }
    this.#finish(commandId, { ...receipt, done: true, result, status: 'COMPLETED' });
    return result;
  }

  #finish(commandId, receipt) {
    try { this.store.upsertCommand(commandId, receipt); }
    catch {
      this.cache.set(commandId, { ...receipt, done: false, result: null, status: 'UNKNOWN_AFTER_CRASH' });
      throw Object.assign(new Error('Действие могло завершиться, но результат не удалось сохранить. Проверьте историю перед повтором.'), { code: 'UNKNOWN_OUTCOME' });
    }
    this.cache.set(commandId, receipt);
  }

  #commandError(result) {
    const saved = result?.error;
    return Object.assign(new Error(saved?.message || 'Команда была отклонена.'), { code: saved?.code || 'INTERNAL_ERROR' });
  }

  status(commandId) {
    const key = String(commandId);
    const e = this.cache.get(key);
    if (e) return { commandId: key, status: e.status || (e.done ? 'COMPLETED' : 'DISPATCHING'), done: e.done, at: e.at, clientId: e.clientId || null };
    const stored = this.store.getCommand(key);
    if (!stored) return null;
    return {
      commandId: key,
      status: stored.status || (stored.done ? (stored.result != null ? 'COMPLETED' : 'REJECTED') : 'UNKNOWN_AFTER_CRASH'),
      done: stored.done,
      at: stored.at,
      clientId: stored.clientId || null,
    };
  }

  #evictCommands() {
    const now = Date.now();
    if (this.cache.size >= 2) {
      const ttl = 24 * 60 * 60 * 1000;
      for (const [k, v] of this.cache) if (v.done && now - v.at > ttl) this.cache.delete(k);
    }
    // Hard ceiling for the in-memory cache: SQLite remains the source of
    // truth, so a resolved entry is safe to drop. In-flight entries (done:false)
    // are never evicted here — a replay of a command that is being executed
    // must keep seeing ACCEPTED.
    const maxCommands = 1000;
    if (this.cache.size > maxCommands) {
      const removable = [...this.cache.entries()]
        .filter(([, v]) => v.done)
        .sort((a, b) => a[1].at - b[1].at);
      const excess = this.cache.size - maxCommands;
      for (let i = 0; i < Math.min(excess, removable.length); i++) this.cache.delete(removable[i][0]);
    }
    // A cache lifetime is not an idempotency lifetime. Durable receipts must
    // remain available when an offline client returns with an older command ID.
  }
}
