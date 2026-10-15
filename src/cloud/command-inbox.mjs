import { commandPayloadHash } from './protocol.mjs';

const failure = (code, message) => ({ status: 'FAILED', error: { code, message } });
const replay = result => ['ACCEPTED', 'DUPLICATE'].includes(result?.status)
  ? { ...result, status: 'DUPLICATE' } : result;

export function commandIntentHash({ machineId, taskId, type, payload }) {
  return commandPayloadHash({ machineId, taskId, type, payload });
}

// Acceptance is written before effects. A receipt without a final result after
// restart is an unknown outcome, never permission to replay the effect.
export class CommandInbox {
  constructor({ store = null, maxCached = 1000 } = {}) {
    this.store = store;
    this.maxCached = maxCached;
    this.pending = new Map();
    this.completed = new Map();
  }

  async run(command, execute, onDuplicate = () => {}) {
    const key = `cloud-dispatch:${JSON.stringify([command.machineId, command.commandId])}`;
    const hash = commandIntentHash(command);
    const active = this.pending.get(key);
    let saved;
    try { saved = this.completed.get(key) || this.store?.getCommand?.(key); }
    catch { return failure('COMMAND_LEDGER_FAILED', 'Cannot read command receipt'); }
    if ((active || saved)?.hash && (active || saved).hash !== hash) {
      return { status: 'REJECTED', error: { code: 'CONFLICT', message: 'Command id already belongs to a different intent' } };
    }
    if (active) { onDuplicate(); return replay(await active.promise); }
    if (saved) {
      onDuplicate();
      if (!saved.done) return failure('UNKNOWN_AFTER_CRASH', 'Command outcome is unknown; automatic execution is refused');
      if (!saved.result) return failure('UNKNOWN_OUTCOME', 'Command receipt has no recoverable result');
      return replay(saved.result);
    }
    try { this.store?.upsertCommand?.(key, { hash, done: false, status: 'DISPATCHING' }); }
    catch { return failure('COMMAND_LEDGER_FAILED', 'Cannot persist command acceptance'); }

    // Defer execution until pending is registered, including synchronous effects.
    const promise = Promise.resolve().then(execute).catch(error => failure(error?.code || 'INTERNAL_ERROR', error?.message || String(error))).then(result => {
      try { this.store?.upsertCommand?.(key, { hash, done: true, result, status: result.status }); }
      catch { return failure('UNKNOWN_OUTCOME', 'Action may have completed but its result could not be persisted'); }
      this.completed.set(key, { hash, done: true, result });
      if (this.completed.size > this.maxCached) this.completed.delete(this.completed.keys().next().value);
      return result;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, { hash, promise });
    return promise;
  }
}
