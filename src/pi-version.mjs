// Which Pi TaskBridge is talking to (backend plan, stage B0).
//
// TaskBridge speaks Pi's RPC protocol, and that protocol is internal to Pi: a
// new Pi can rename a command or a frame field and the session breaks in a way
// that looks like a model error. The supported range below is the one the RPC
// fixtures were recorded against. Outside it TaskBridge keeps working — the
// operator may well be on a compatible build — but /api/info says so, and the
// UI shows a warning instead of the failure showing up mid-turn.

import { spawn } from 'node:child_process';

// Inclusive lower bound, exclusive upper bound.
// 0.87.x: checked on the operator's machine (Pi 0.87.1 — smoke, real sessions
// and the RPC recorder) before the range was widened.
export const SUPPORTED_PI = Object.freeze({ min: '0.85.0', below: '0.88.0' });

// `pi --version` has printed both "0.85.1" and "pi 0.85.1"; take the first
// x.y.z anywhere in the output rather than depend on the prefix.
export function parsePiVersion(output) {
  const match = String(output || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function compare(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function isSupportedPiVersion(version, range = SUPPORTED_PI) {
  if (!version) return false;
  return compare(version, range.min) >= 0 && compare(version, range.below) < 0;
}

// Runs `<command> --version` once. Never throws: a missing or broken Pi is a
// status to report, not a reason for the server to fail to start.
export function readPiVersion({ command = 'pi', env = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    let proc;
    try {
      proc = spawn(command, ['--version'], {
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
      });
    } catch (error) {
      resolve({ version: null, error: error.message });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      finish({ version: null, error: `pi --version did not answer in ${timeoutMs} ms` });
    }, timeoutMs);
    proc.stdout.on('data', (chunk) => { out += chunk; });
    proc.stderr.on('data', (chunk) => { out += chunk; });
    proc.on('error', (error) => finish({ version: null, error: error.message }));
    proc.on('close', (code) => {
      const version = parsePiVersion(out);
      if (version) finish({ version, error: null });
      else if (code === 0) finish({ version: null, error: 'unrecognised pi --version output' });
      // On Windows Pi starts through cmd.exe, so a missing Pi is not ENOENT but
      // cmd's own "is not recognized" message with exit code 1 (9009 on some
      // setups). Name that case instead of reporting a bare exit code.
      else if (/not recognized|not found|не является|не найден/i.test(out) || code === 9009 || code === 127) {
        finish({ version: null, error: `Pi не найден: ${command}` });
      } else {
        const detail = out.trim().split(/\r?\n/)[0];
        finish({ version: null, error: `pi --version exited with ${code}${detail ? `: ${detail.slice(0, 200)}` : ''}` });
      }
    });
  });
}

// The /api/info view. Cached: Pi does not change under a running server often
// enough to spawn a process on every poll, and `refresh()` covers the case
// where it does (the operator updated Pi and restarted nothing).
export class PiVersionProbe {
  constructor(options = {}, read = readPiVersion) {
    this.options = options;
    this.read = read;
    this.pending = null;
    this.result = null;
  }

  refresh() {
    this.pending = this.read(this.options).then((raw) => {
      this.result = {
        version: raw.version,
        supported: isSupportedPiVersion(raw.version),
        supportedRange: `>=${SUPPORTED_PI.min} <${SUPPORTED_PI.below}`,
        error: raw.error || null,
      };
      return this.result;
    });
    return this.pending;
  }

  // Last known result without waiting; starts the first probe on demand.
  current() {
    if (!this.pending) this.refresh();
    return this.result;
  }
}
