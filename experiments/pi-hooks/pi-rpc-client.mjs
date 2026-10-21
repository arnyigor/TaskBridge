// Минимальный клиент Pi RPC для экспериментов (CORE-01/CORE-02).
//
// JSONL по stdin/stdout, ответы сопоставляются по id; ожидание событий — только
// НОВЫХ (иначе `agent_settled` предыдущего хода закрывал бы ожидание следующего).
// Здесь намеренно нет ни одного механизма TaskBridge: это стенд, а не транспорт.
import { spawn } from 'node:child_process';

export class PiRpc {
  constructor({ cwd, args, env }) {
    this.proc = spawn('pi', ['--mode', 'rpc', ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: process.platform === 'win32' });
    this.pending = new Map();
    this.events = [];
    this.listeners = new Set();
    this.stderr = '';
    this.stdout = '';
    this.closed = false;
    this.proc.stderr.on('data', chunk => { this.stderr += chunk; });
    this.proc.stdout.on('data', chunk => this.#onData(chunk));
    this.proc.on('exit', code => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error(`Pi завершился (code=${code}): ${this.stderr.slice(-500)}`)); }
      this.pending.clear();
    });
  }

  #onData(chunk) {
    this.stdout += chunk;
    let index;
    while ((index = this.stdout.indexOf('\n')) >= 0) {
      const line = this.stdout.slice(0, index).replace(/\r$/, '');
      this.stdout = this.stdout.slice(index + 1);
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === 'response' && record.id) {
        const waiter = this.pending.get(record.id);
        if (waiter) { clearTimeout(waiter.timer); this.pending.delete(record.id); waiter.resolve(record); }
        continue;
      }
      this.events.push(record);
      for (const listener of [...this.listeners]) listener(record);
    }
  }

  send(command, timeoutMs = 30000) {
    const id = `${command.type}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`нет ответа на ${command.type} за ${timeoutMs} мс`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  /**
   * Ждёт НОВОЕ событие по предикату. Уже пришедшие не годятся: `agent_settled`
   * предыдущего хода иначе закрывал бы ожидание следующего.
   */
  waitFor(predicate, timeoutMs) {
    const from = this.events.length;
    const seen = this.events.slice(from).find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error('событие не дождались')); }, timeoutMs);
      const listener = record => {
        if (!predicate(record)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(record);
      };
      this.listeners.add(listener);
    });
  }

  async stop() {
    try { this.proc.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`); } catch { /* уже закрыт */ }
    await sleep(300);
    if (!this.closed) this.proc.kill();
    await sleep(200);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export { sleep };
