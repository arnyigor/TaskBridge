// PiRunner — thin adapter over a PiRpcSession (TZ stage 2).
//
// Establishes the "runner" abstraction without changing behaviour: a runner is
// a live agent session plus the set of capabilities it supports, so the
// TaskManager / a future SessionManager can drive Pi (and later Claude/Codex)
// through one interface. Future runners are not required to implement every
// capability; the UI hides what a runner cannot do.
//
// This module is additive: nothing here is wired into the execution path yet.
// It also holds a RunnerRegistry so additional runners can be registered by
// id and the active one resolved by name.

// What a first-party Pi runner can do today (via PiRpcSession + pi-settings).
export const PI_CAPABILITIES = Object.freeze({
  steer: true,          // sendFollowUp as steering into an active turn
  compact: true,        // manual context compaction
  model: true,          // switch model
  thinking: true,       // set thinking level
  autoCompaction: true, // toggle auto compaction
  approvals: true,      // tool-approval requests through the extension
  files: true,          // attachments are passed to the runner
  resume: true,         // restore a saved session file
});

export class PiRunner {
  // `session` is a PiRpcSession (or any object implementing its interface).
  // `options.capabilities` may override the defaults (e.g. for a stub).
  constructor(session, options = {}) {
    if (!session) throw new Error('PiRunner requires a session');
    this.session = session;
    this.capabilities = { ...PI_CAPABILITIES, ...(options.capabilities || {}) };
  }

  get closed() { return Boolean(this.session?.closed); }
  get proc() { return this.session?.proc; }

  // --- lifecycle / inspection ---------------------------------------------
  async getState() { return this.session?.getState(); }
  can(what) { return this.capabilities[what] === true; }
  capabilitySet() { return Object.keys(this.capabilities).filter((k) => this.capabilities[k]); }

  // --- messaging -----------------------------------------------------------
  async prompt(message) { return this.session?.prompt(message); }
  async sendFollowUp(message, mode = 'auto') { return this.session?.sendFollowUp(message, mode); }

  // --- model / thinking ----------------------------------------------------
  async compact(customInstructions = '') { return this.session?.compact(customInstructions); }
  async setModel(provider, modelId) { return this.session?.setModel(provider, modelId); }
  async cycleModel(direction = 'forward') { return this.session?.cycleModel(direction); }
  async getAvailableModels() { return this.session?.getAvailableModels(); }
  async setThinkingLevel(level) { return this.session?.setThinkingLevel(level); }
  async getAvailableThinkingLevels() { return this.session?.getAvailableThinkingLevels(); }
  async setAutoCompaction(enabled) { return this.session?.setAutoCompaction(enabled); }

  // --- stop / cleanup ------------------------------------------------------
  async abort(timeoutMs = 10000) { return this.session?.abort(timeoutMs); }
  async killTree() { return this.session?.killTree(); }
  closeStdin() { return this.session?.closeStdin?.(); }
}

// --- RunnerRegistry --------------------------------------------------------

const registry = new Map();

export function registerRunner(id, factory) {
  registry.set(id, factory);
  return id;
}

export function getRunner(id) {
  return registry.get(id) || null;
}

export function hasRunner(id) { return registry.has(id); }

export function listRunners() { return [...registry.keys()]; }

// Convenience factory for a Pi runner given a session.
export function piRunnerFor(session, options = {}) {
  return new PiRunner(session, options);
}
