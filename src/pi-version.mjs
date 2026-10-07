// Which Pi TaskBridge is talking to (backend plan, stage B0).
//
// TaskBridge speaks Pi's RPC protocol, and that protocol is internal to Pi: a
// new Pi can rename a command or a frame field and the session breaks in a way
// that looks like a model error. The supported range below is the one the RPC
// fixtures were recorded against. Outside it TaskBridge keeps working — the
// operator may well be on a compatible build — but /api/info says so, and the
// UI shows a warning instead of the failure showing up mid-turn. If the version
// probe itself fails, keep the error in /api/info but do not raise the version
// warning: a transient `pi --version` timeout is not proof of incompatibility.

import { spawn } from 'node:child_process';

// Inclusive lower bound, exclusive upper bound.
// 0.87.x and 0.88.x: checked on the operator's machine (smoke, real sessions
// and the RPC recorder) before the range was widened.
// 0.99.x: checked in real sessions on the operator's machine (2026-10-01) —
// TaskBridge itself runs against Pi 0.99.1, steering, prompt delivery and
// task events all exercised. 1.0.4 is the current Pi line used with TaskBridge
// on the operator machine; keep the upper bound on the next minor so 1.0.x does
// not show a false version warning.
export const SUPPORTED_PI = Object.freeze({ min: '0.85.0', below: '1.1.0' });

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

// A probe that produced no version is retried after this delay. The reason is
// real: the one probe at server startup can time out while the machine is busy
// (a Gradle build alongside), and the old code then cached "unknown" forever —
// /api/info reported the version as unknown for the whole life of the process.
export const PI_PROBE_RETRY_MS = 60_000;

export class PiVersionProbe {
  constructor(options = {}, read = readPiVersion) {
    this.options = options;
    this.read = read;
    this.pending = null;
    this.result = null;
    this.retryTimer = null;
  }

  refresh() {
    this.pending = this.read(this.options).then((raw) => {
      this.result = {
        version: raw.version,
        supported: raw.version ? isSupportedPiVersion(raw.version) : true,
        supportedRange: `>=${SUPPORTED_PI.min} <${SUPPORTED_PI.below}`,
        error: raw.error || null,
      };
      // Unknown is not a final answer: retry until the version is read, so a
      // busy startup cannot disable the version check for the whole session.
      if (!this.result.version && !this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.refresh().catch(() => {});
        }, PI_PROBE_RETRY_MS);
        // The timer must not hold the process open on shutdown.
        if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
      }
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
