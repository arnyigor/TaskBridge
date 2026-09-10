import { PiRpcSession } from './pi-rpc.mjs';

// Pi resolves providers, credentials and model availability itself, and only
// exposes the result over RPC (`get_available_models`). ModelCatalog asks a
// short-lived `pi --mode rpc --no-session` probe and caches the answer, so the
// UI lists exactly the models Pi would list — including ones coming from
// extensions and remote providers, not just the local llama.cpp profiles.
//
// The probe process is always killed; a failed probe surfaces as an error to
// the caller and is never cached.

function publicModel(model) {
  if (!model || typeof model !== 'object' || !model.id) return null;
  const input = Array.isArray(model.input) ? model.input : [];
  return {
    provider: model.provider || null,
    id: model.id,
    name: model.name || null,
    contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
    maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : null,
    reasoning: model.reasoning === true,
    images: input.includes('image')
  };
}

// Kept as a pure export so the projection can be tested without spawning Pi.
export function normalizeModels(models) {
  return (Array.isArray(models) ? models : [])
    .map(publicModel)
    .filter(Boolean)
    .sort((a, b) => (a.provider || '').localeCompare(b.provider || '') || a.id.localeCompare(b.id));
}

export class ModelCatalog {
  constructor(config = {}, options = {}) {
    this.config = config || {};
    this.env = options.env || config.env || undefined;
    this.ttlMs = Math.max(0, Number(options.ttlMs ?? config.modelCatalogTtlMs ?? 60000));
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 90000));
    this.cache = null;
    this.inFlight = null;
  }

  // Cached value only; never spawns Pi. Used on hot paths (task creation) to
  // answer questions like "which provider is the current default?".
  peek() {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;
    return null;
  }

  async list({ refresh = false } = {}) {
    if (!refresh) {
      const cached = this.peek();
      if (cached) return cached;
    }
    if (!this.inFlight) {
      this.inFlight = this.#probe()
        .then(value => {
          this.cache = { at: Date.now(), value };
          return value;
        })
        .finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  async #probe() {
    const pi = new PiRpcSession({
      command: this.config.pi?.command || 'pi',
      args: this.config.pi?.args || [],
      cwd: this.config.cwd || process.cwd(),
      env: this.env,
      persistSessions: false,
      projectTrust: 'approve'
    });
    const deadline = setTimeout(() => { pi.killTree().catch(() => {}); }, this.timeoutMs);
    try {
      await pi.start();
      const state = await pi.getState();
      const models = await pi.getAvailableModels();
      let thinkingLevels = [];
      try { thinkingLevels = await pi.getAvailableThinkingLevels(); } catch { thinkingLevels = []; }
      return {
        models: normalizeModels(models),
        thinkingLevels: Array.isArray(thinkingLevels) ? thinkingLevels : [],
        defaultModel: state?.model ? publicModel(state.model) : null,
        defaultThinkingLevel: state?.thinkingLevel ?? null
      };
    } finally {
      clearTimeout(deadline);
      try { pi.closeStdin(); } catch {}
      await pi.killTree().catch(() => {});
    }
  }
}
