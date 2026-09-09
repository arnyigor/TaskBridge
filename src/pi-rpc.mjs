import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import fs from 'node:fs';

function randomId() {
  return `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export class PiRpcSession extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.proc = null;
    this.pending = new Map();
    this.closed = false;
    this.lastState = null;
  }

  async start() {
    if (this.proc) return;

    const {
      command = 'pi',
      args = [],
      cwd,
      sessionDir,
      sessionName,
      sessionFile,
      persistSessions = true,
      projectTrust = 'approve',
      env = null
    } = this.options;

    if (persistSessions && sessionDir) fs.mkdirSync(sessionDir, { recursive: true });

    const piArgs = ['--mode', 'rpc', ...args];
    if (projectTrust === 'approve') piArgs.push('--approve');
    if (projectTrust === 'deny') piArgs.push('--no-approve');

    if (sessionFile) {
      piArgs.push('--session', path.resolve(sessionFile));
      if (sessionDir) piArgs.push('--session-dir', path.resolve(sessionDir));
    } else if (persistSessions && sessionDir) {
      piArgs.push('--session-dir', path.resolve(sessionDir));
      if (sessionName) piArgs.push('--name', sessionName);
    } else {
      piArgs.push('--no-session');
    }

    this.emit('diagnostic', { type: 'PI_STARTING', command, args: piArgs, cwd });

    const proc = spawn(command, piArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      ...(env ? { env: { ...process.env, ...env } } : {})
    });
    this.proc = proc;

    proc.on('error', (error) => {
      this.emit('error', error);
      this.#rejectAll(error);
    });

    proc.stderr.on('data', (chunk) => {
      this.emit('stderr', chunk.toString('utf8'));
    });

    this.#attachStrictJsonl(proc.stdout);

    proc.on('close', (code, signal) => {
      this.closed = true;
      const error = new Error(`Pi RPC process exited (code=${code}, signal=${signal ?? 'none'})`);
      this.emit('close', { code, signal });
      this.#rejectAll(error);
    });
  }

  #attachStrictJsonl(stream) {
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    const consume = () => {
      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) break;
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.trim()) this.#onLine(line);
      }
    };

    stream.on('data', (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      consume();
    });

    stream.on('end', () => {
      buffer += decoder.end();
      if (buffer.length > 0) {
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        if (line.trim()) this.#onLine(line);
      }
    });
  }

  #onLine(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch (error) {
      this.emit('protocol_error', { line, error: error.message });
      return;
    }

    this.emit('frame', frame);

    if (frame.type === 'response' && frame.id && this.pending.has(frame.id)) {
      const pending = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.success) pending.resolve(frame);
      else pending.reject(new Error(frame.error || `${frame.command || 'RPC command'} failed`));
      return;
    }

    if (frame.type !== 'response') this.emit('event', frame);
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(command) {
    if (!this.proc || this.closed || !this.proc.stdin.writable) {
      throw new Error('Pi RPC session is not writable');
    }
    this.proc.stdin.write(JSON.stringify(command) + '\n');
  }

  request(command, timeoutMs = 15000) {
    const id = command.id || randomId();
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC timeout for ${command.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async prompt(message) {
    return this.request({ type: 'prompt', message });
  }

  async getState() {
    const response = await this.request({ type: 'get_state' });
    this.lastState = response.data || null;
    return this.lastState;
  }

  async sendFollowUp(message, mode = 'auto') {
    if (mode === 'steer') return this.request({ type: 'steer', message });
    if (mode === 'follow_up') return this.request({ type: 'follow_up', message });
    const state = await this.getState().catch(() => null);
    if (state?.isStreaming) return this.request({ type: 'steer', message });
    return this.request({ type: 'prompt', message });
  }

  async compact(customInstructions = '') {
    const cmd = customInstructions
      ? { type: 'compact', customInstructions }
      : { type: 'compact' };
    return this.request(cmd, 120000);
  }

  // Runtime model/thinking changes (§51). Both commands exist in Pi's RPC
  // protocol; the response carries the new model object / nothing respectively.
  async setModel(provider, modelId) {
    const response = await this.request({ type: 'set_model', provider, modelId }, 60000);
    if (response.data) this.lastState = { ...(this.lastState || {}), model: response.data };
    return response.data || null;
  }

  async setThinkingLevel(level) {
    return this.request({ type: 'set_thinking_level', level }, 30000);
  }

  async setAutoCompaction(enabled) {
    return this.request({ type: 'set_auto_compaction', enabled });
  }

  async abort(timeoutMs = 10000) {
    await this.request({ type: 'clear_queue' }, 5000).catch(() => null);
    return this.request({ type: 'abort' }, timeoutMs);
  }

  async killTree() {
    if (!this.proc?.pid) return;
    const pid = this.proc.pid;
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        });
        killer.on('close', resolve);
        killer.on('error', resolve);
      });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  }

  closeStdin() {
    if (this.proc?.stdin?.writable) this.proc.stdin.end();
  }
}
