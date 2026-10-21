// Минимальный клиент OMP RPC для OMP-01 (не путать с src/pi-rpc.mjs: у OMP свой
// протокол, и по ТЗ он проверяется отдельно, без интеграции).
//
// Что реализовано из docs/rpc.md:
//   • готовность: кадр `ready` (protocolVersion, maxFrameBytes);
//   • корреляция команд по `id`; ответы — `type: "response"`;
//   • завершение запроса — `prompt_result` с тем же id (yield агента), а полнота
//     сессии — `session_settled`; это РАЗНЫЕ вещи и ждать нужно обе;
//   • опциональный protocol v2: крупные кадры приходят как `rpc_chunk`
//     (base64 по индексам), их нужно собрать и разобрать как один JSON;
//   • `--profile` и `--session-dir` — изоляция от конфигурации и истории Pi.
import { spawn } from 'node:child_process';

export class OmpRpc {
  constructor({ command = 'omp', args = [], cwd, env = null } = {}) {
    this.proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pending = new Map();
    this.frames = [];
    this.listeners = new Set();
    this.stdout = '';
    this.stderr = '';
    this.chunks = new Map();
    // Сколько последовательностей rpc_chunk собрано (для проверок протокола).
    this.chunkSequences = 0;
    this.protocol = null;
    this.ready = null;
    this.closed = false;
    this.proc.stderr.on('data', chunk => { this.stderr += chunk; });
    this.proc.stdout.on('data', chunk => this.#onData(chunk));
    this.proc.on('exit', code => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`OMP завершился (code=${code}): ${this.stderr.slice(-600)}`));
      }
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
      const frame = record.type === 'rpc_chunk' ? this.#reassemble(record) : record;
      if (!frame) continue;
      if (frame.type === 'ready') { this.ready = frame; this.protocol = frame.protocolVersion || 1; }
      if (frame.type === 'response' && frame.id) {
        const waiter = this.pending.get(frame.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(frame.id);
          waiter.resolve(frame);
        }
      }
      this.frames.push(frame);
      for (const listener of [...this.listeners]) listener(frame);
    }
  }

  /** rpc_chunk: base64-сегменты одного логического кадра, собираются по index. */
  #reassemble(chunk) {
    const entry = this.chunks.get(chunk.chunkId) || { parts: new Array(chunk.count), count: chunk.count };
    if (chunk.count !== entry.count) return null;
    entry.parts[chunk.index] = chunk.data;
    this.chunks.set(chunk.chunkId, entry);
    if (entry.parts.filter(part => typeof part === 'string').length !== entry.count) return null;
    this.chunks.delete(chunk.chunkId);
    this.chunkSequences += 1;
    try {
      return JSON.parse(Buffer.concat(entry.parts.map(part => Buffer.from(part, 'base64'))).toString('utf8'));
    } catch { return null; }
  }

  send(command, timeoutMs = 30000) {
    const id = `${command.type}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`нет ответа на ${command.type} за ${timeoutMs} мс`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  /** Ждёт НОВЫЙ кадр по предикату (уже пришедшие не годятся). */
  waitFor(predicate, timeoutMs, { from = this.frames.length } = {}) {
    const seen = this.frames.slice(from).find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error('кадр не дождались')); }, timeoutMs);
      const listener = frame => {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(frame);
      };
      this.listeners.add(listener);
    });
  }

  /**
   * Запрос целиком: ответ на команду, затем `prompt_result` этого id, затем
   * (по умолчанию) `session_settled`. Возвращает всё, что нужно для метрик.
   */
  async promptAndWait(message, { timeoutMs = 300000, waitSettled = true, streamingBehavior = undefined } = {}) {
    const before = this.frames.length;
    const response = await this.send({ type: 'prompt', message, ...(streamingBehavior ? { streamingBehavior } : {}) });
    if (!response.success) return { response, result: null, settled: false, frames: this.frames.slice(before) };
    const id = response.id;
    if (response.data?.agentInvoked === false) {
      return { response, result: null, settled: true, frames: this.frames.slice(before) };
    }
    const result = await this.waitFor(frame => frame.type === 'prompt_result' && frame.id === id, timeoutMs, { from: before }).catch(() => null);
    let settled = false;
    if (waitSettled) {
      settled = result?.sessionSettled === true
        || await this.waitFor(frame => frame.type === 'session_settled', timeoutMs, { from: before }).then(() => true, () => false);
    }
    return { response, result, settled, frames: this.frames.slice(before) };
  }

  async stop() {
    try { this.proc.stdin.end(); } catch { /* уже закрыт */ }
    const exited = await new Promise(resolve => {
      if (this.closed) return resolve(true);
      const timer = setTimeout(() => resolve(false), 5000);
      this.proc.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) this.proc.kill();
    return exited;
  }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Сводка по кадрам одного хода: текст ответа, инструменты, ошибки, usage. */
export function summarizeFrames(frames) {
  const toolCalls = [];
  let text = '';
  let usage = null;
  let stopReason = null;
  let errorMessage = null;
  for (const frame of frames) {
    if (frame.type === 'tool_execution_start') {
      const args = frame.args || {};
      toolCalls.push({
        name: frame.toolName,
        target: String(args.command || args.path || args.file_path || args.pattern || args.query || '').split('\n')[0].slice(0, 160),
      });
    }
    if (frame.type === 'tool_execution_end') {
      const call = [...toolCalls].reverse().find(item => item.id === frame.toolCallId) || toolCalls.at(-1);
      if (call) call.isError = frame.isError === true;
    }
    if (frame.type === 'message_end' && frame.message?.role === 'assistant') {
      const content = Array.isArray(frame.message.content) ? frame.message.content : [];
      const chunk = content.filter(part => part.type === 'text').map(part => part.text).join('');
      if (chunk) text = chunk;
      usage = frame.message.usage || usage;
      stopReason = frame.message.stopReason || stopReason;
      errorMessage = frame.message.errorMessage || errorMessage;
    }
  }
  return { text, toolCalls, usage, stopReason, errorMessage };
}
