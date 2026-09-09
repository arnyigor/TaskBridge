import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class RuntimeManager {
  constructor(config, dataRoot) {
    this.config = config || {};
    this.dataRoot = dataRoot;
    this.proc = null;
    this.state = 'STOPPED';
    this.activeProfileId = null;
    this.lastError = null;
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

  #resolveProfile(profileId) {
    const configured = this.config.profiles;
    const profiles = Array.isArray(configured) ? configured : Object.entries(configured || {}).map(([id, profile]) => ({ ...profile, id }));
    const id = profileId || this.config.defaultProfile || profiles[0]?.id;
    return profiles.find(p => p.id === id) || null;
  }

  async getStatus() {
    // Nothing updates `state` while idle: if this process never called
    // ensureRunning (e.g. the model was already running externally before
    // TaskBridge started, or has since been stopped/started outside it),
    // the cached value would be stale. Re-check live whenever we're not
    // the ones managing a spawned process.
    if (!this.proc) this.state = (await this.isReady()) ? 'EXTERNAL_RUNNING' : 'STOPPED';
    return { state: this.state, pid: this.proc?.pid ?? null, profileId: this.activeProfileId, error: this.lastError };
  }

  async ensureRunning(onLog = () => {}, profileId) {
    if (await this.isReady()) {
      this.state = this.proc ? 'MANAGED_RUNNING' : 'EXTERNAL_RUNNING';
      return { state: this.state };
    }

    const managed = this.config.managed || {};
    const profile = this.#resolveProfile(profileId);
    const command = profile?.command || managed.command;
    if (!managed.enabled && !profile) {
      const error = new Error(`Local model runtime is not reachable at ${this.config.healthUrl || '(no health URL)'}`);
      error.code = 'LOCAL_RUNTIME_FAILED';
      throw error;
    }
    if (!command) {
      const error = new Error('Не задана команда запуска модели.');
      error.code = 'LOCAL_RUNTIME_FAILED';
      throw error;
    }

    if (!this.proc) {
      this.state = 'STARTING';
      this.lastError = null;
      this.activeProfileId = profile?.id ?? null;
      const logDir = path.join(this.dataRoot, 'runtime');
      fs.mkdirSync(logDir, { recursive: true });
      const log = fs.createWriteStream(path.join(logDir, 'llama-runtime.log'), { flags: 'a' });
      const proc = spawn(command, profile?.args || managed.args || [], {
        cwd: profile?.cwd || managed.cwd || undefined,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.proc = proc;
      proc.stdout.on('data', (c) => { log.write(c); onLog(c.toString('utf8')); });
      proc.stderr.on('data', (c) => { log.write(c); onLog(c.toString('utf8')); });
      proc.on('close', (code, signal) => {
        this.proc = null;
        this.state = 'STOPPED';
        if (code) this.lastError = `Процесс модели завершился с кодом ${code}${signal ? ` (${signal})` : ''}.`;
        log.end();
      });
      proc.on('error', (err) => { this.lastError = err.message; onLog(`[runtime error] ${err.message}\n`); });
    }

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (!this.proc) {
        const error = new Error(this.lastError || 'Процесс модели завершился до готовности.');
        error.code = 'LOCAL_RUNTIME_FAILED';
        throw error;
      }
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
