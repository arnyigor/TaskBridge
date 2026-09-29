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
    // Count of parsed outgoing frames. A pending request snapshots it at start
    // to tell a hung process (no frame since) from one that is alive and merely
    // slow to acknowledge (frames still arrive). A counter, not a timestamp:
    // two events in the same millisecond must still be distinguishable.
    this.frameCount = 0;
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
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      // On POSIX Pi must lead its own process group: killTree() signals the
      // group (-pid), and without one that call fails and only Pi itself dies,
      // leaving the pytest/gradle it started running as orphans. Windows kills
      // the tree with taskkill /T instead. The process is never unref'd, so it
      // still lives and dies with this session (stdin EOF, close(), killTree()).
      detached: process.platform !== 'win32'
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

    this.frameCount += 1;
    this.emit('frame', frame);

    if (frame.type === 'response' && frame.id && this.pending.has(frame.id)) {
      if (frame.success) this.#settle(frame.id, true, frame);
      else this.#settle(frame.id, false, new Error(frame.error || `${frame.command || 'RPC command'} failed`));
      return;
    }

    if (frame.type !== 'response') {
      // Any output proves the process is alive and working, so re-arm the idle
      // timers of every pending request: a slow-but-progressing Pi must not be
      // reported as hung while it is still emitting events.
      this.#bumpPending();
      this.emit('event', frame);
    }
  }

  #settle(id, ok, value) {
    const pending = this.pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    clearTimeout(pending.hardTimer);
    this.pending.delete(id);
    if (ok) pending.resolve(value);
    else pending.reject(value);
    return true;
  }

  #bumpPending() {
    for (const pending of this.pending.values()) {
      if (typeof pending.bump === 'function') pending.bump();
    }
  }

  // A single timeout used to hide three very different situations: the process
  // is gone, the process is alive but silent (hung), or the process is alive
  // and still producing output but has not acknowledged this command (slow).
  // Report all three with distinct codes so the caller can retry the slow/exited
  // cases and stop the hung one instead of treating every timeout the same.
  #timeoutError(command, timeoutMs, startCount) {
    const type = command.type || 'RPC command';
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    const alive = Boolean(this.proc) && !this.closed && this.proc.exitCode === null && !this.proc.killed;
    if (!alive) {
      return Object.assign(new Error(`Pi RPC process is not running while waiting for ${type}.`), { code: 'PI_RPC_EXITED', retryable: true });
    }
    if (this.frameCount > startCount) {
      return Object.assign(new Error(`Pi RPC slow response for ${type}: Pi is alive and sending events, but has not acknowledged within ${seconds}s.`), { code: 'PI_RPC_SLOW', retryable: true });
    }
    return Object.assign(new Error(`Pi RPC timeout for ${type}: no output from the Pi process for ${seconds}s — it looks hung.`), { code: 'PI_RPC_HUNG', retryable: false });
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      clearTimeout(pending.hardTimer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  // Can this session still accept a command? The one predicate send() and the
  // session owners must agree on. Pi exiting leaves stdin closed while `closed`
  // (set by the close event) has not necessarily been processed yet; every
  // command sent inside that window fails, so a caller that wants to hand the
  // command to a live Pi has to ask this, not `closed`.
  canSend() {
    return Boolean(this.proc) && !this.closed && this.proc.stdin?.writable === true;
  }

  send(command) {
    if (!this.canSend()) {
      // Classified and retryable: a channel that is already gone is not a server
      // fault, and the caller's recovery is "start the session again", not
      // "give up". Without a code this became an opaque INTERNAL_ERROR.
      throw Object.assign(new Error('Pi RPC session is not writable'), {
        code: 'PI_RPC_NOT_WRITABLE',
        retryable: true
      });
    }
    this.proc.stdin.write(JSON.stringify(command) + '\n');
  }

  // `bumpOnFrames: false` keeps a request's idle timer from being re-armed by the
  // process's own output. Only abort needs it (see abort): every other request
  // benefits from the "alive but slow" classification.
  request(command, timeoutMs = 15000, { bumpOnFrames = true } = {}) {
    const id = command.id || randomId();
    const payload = { ...command, id };
    const startedAt = Date.now();
    const startCount = this.frameCount;
    // The idle timer fires only after `timeoutMs` with no frame at all; every
    // frame Pi emits re-arms it (see #bumpPending). A hard cap guarantees
    // termination even if a request is never answered but events keep flowing.
    const hardCapMs = timeoutMs * 8;
    return new Promise((resolve, reject) => {
      const onTimeout = () => this.#settle(id, false, this.#timeoutError(command, timeoutMs, startCount));
      const pending = {
        resolve,
        reject,
        bump: () => {
          if (!bumpOnFrames) return;
          const remaining = startedAt + hardCapMs - Date.now();
          if (remaining <= 0) return;
          clearTimeout(pending.timer);
          pending.timer = setTimeout(onTimeout, Math.min(timeoutMs, remaining));
        }
      };
      pending.timer = setTimeout(onTimeout, timeoutMs);
      pending.hardTimer = setTimeout(onTimeout, hardCapMs);
      this.pending.set(id, pending);
      try {
        this.send(payload);
      } catch (error) {
        clearTimeout(pending.timer);
        clearTimeout(pending.hardTimer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async prompt(message) {
    return this.request({ type: 'prompt', message });
  }

  // A state read decides what TaskBridge does next (steer or prompt, wait or
  // deliver) — it is not a command the operator watches. A healthy Pi can be
  // slower than the 15 s default: measured on 2026-09-28 with a real Pi, the
  // first get_state after a spawn took 9.0 s and 13.2 s (the cold boot loads the
  // extensions and the MCP adapter; #createPi documents 17-19 s), and one at a
  // tool/turn boundary took 7.5 s. With the 15 s budget those reads were
  // reported as "Pi RPC timeout for get_state … it looks hung" and the message
  // failed although Pi was only slow. (Pi answers in ~1 ms while it waits out a
  // provider rate limit, so a rate-limited Pi is not the case this covers.)
  // 60 s matches the readiness probe #createPi already uses for the cold boot.
  static PROBE_TIMEOUT_MS = 60000;

  async getState(timeoutMs = 15000) {
    const response = await this.request({ type: 'get_state' }, timeoutMs);
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

  // Model switching mirrors Pi's own /model command: Pi owns the provider and
  // model catalogs, so the list of usable models (and their auth state) can
  // only be asked of a running Pi over RPC, never re-derived from config files.
  async getAvailableModels() {
    const response = await this.request({ type: 'get_available_models' }, 60000);
    return response.data?.models || [];
  }

  async cycleModel(direction = 'forward') {
    const response = await this.request({ type: 'cycle_model', direction });
    return response.data || null;
  }

  async getAvailableThinkingLevels() {
    const response = await this.request({ type: 'get_available_thinking_levels' }, 30000);
    return response.data?.levels || [];
  }

  async getCommands() {
    const response = await this.request({ type: 'get_commands' }, 30000);
    return response.data?.commands || [];
  }

  async abort(timeoutMs = 10000) {
    await this.request({ type: 'clear_queue' }, 5000).catch(() => null);
    // The abort must not be extended by the very stream it is stopping. Every
    // frame Pi emits while it ignores the abort used to re-arm this request's
    // idle timer (#bumpPending), so a Pi that kept streaming thinking deltas
    // held STOP for the whole `timeoutMs * 8` hard cap — 80 s at the 10 s
    // default — before the caller gave up and killed the tree. With the timer
    // left alone it fires on time and #cancel runs its ABORT_TIMEOUT path
    // (kill the tree) as designed.
    return this.request({ type: 'abort' }, timeoutMs, { bumpOnFrames: false });
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
