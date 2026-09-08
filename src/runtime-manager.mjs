import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class RuntimeManager {
  constructor(config, dataRoot) {
    this.config = config || {};
    this.dataRoot = dataRoot;
    this.proc = null;
    this.state = 'STOPPED';
  }

  async isReady() {
    const url = this.config.healthUrl;
    if (!url) return true;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  // /health returns ok even while the single -np N slot is busy generating a
  // response for another request; /slots is the only way to see that.
  async getBusyStatus() {
    const url = this.config.healthUrl;
    if (!url) return { unknown: true };
    try {
      const slotsUrl = url.replace(/\/health$/, '/slots');
      const res = await fetch(slotsUrl, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return { unknown: true };
      const slots = await res.json();
      if (!Array.isArray(slots) || !slots.length) return { unknown: true };
      return { unknown: false, busy: slots.every((s) => s.is_processing) };
    } catch {
      return { unknown: true };
    }
  }

  async ensureRunning(onLog = () => {}) {
    if (await this.isReady()) {
      this.state = this.proc ? 'MANAGED_RUNNING' : 'EXTERNAL_RUNNING';
      return { state: this.state };
    }

    const managed = this.config.managed || {};
    if (!managed.enabled || !managed.command) {
      const error = new Error(`Local model runtime is not reachable at ${this.config.healthUrl || '(no health URL)'}`);
      error.code = 'LOCAL_RUNTIME_FAILED';
      throw error;
    }

    if (!this.proc) {
      this.state = 'STARTING';
      const logDir = path.join(this.dataRoot, 'runtime');
      fs.mkdirSync(logDir, { recursive: true });
      const log = fs.createWriteStream(path.join(logDir, 'llama-runtime.log'), { flags: 'a' });
      const proc = spawn(managed.command, managed.args || [], {
        cwd: managed.cwd || undefined,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
      });
      this.proc = proc;
      proc.stdout.on('data', (c) => { log.write(c); onLog(c.toString('utf8')); });
      proc.stderr.on('data', (c) => { log.write(c); onLog(c.toString('utf8')); });
      proc.on('close', () => {
        this.proc = null;
        this.state = 'STOPPED';
        log.end();
      });
      proc.on('error', (err) => onLog(`[runtime error] ${err.message}\n`));
    }

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (await this.isReady()) {
        this.state = 'MANAGED_RUNNING';
        return { state: this.state, pid: this.proc?.pid };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const error = new Error('Timed out waiting for local model runtime');
    error.code = 'LOCAL_RUNTIME_FAILED';
    throw error;
  }
}
