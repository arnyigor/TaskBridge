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
  const cost = model.cost && typeof model.cost === 'object' ? model.cost : {};
  const price = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const levels = supportedThinkingLevels(model);
  return {
    provider: model.provider || null,
    id: model.id,
    name: model.name || null,
    contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
    maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : null,
    reasoning: model.reasoning === true,
    images: input.includes('image'),
    tools: model.tools === true || model.capabilities?.tools === true,
    // Which thinking levels THIS model takes, and what each one means for the
    // provider — the map differs per model (a local Strata model rejects
    // «minimal» and sends «high» to the engine as «xhigh»).
    thinkingLevels: levels,
    thinkingMap: providerThinkingValues(model, levels),
    cost: {
      input: price(cost.input),
      output: price(cost.output),
      cacheRead: price(cost.cacheRead),
      cacheWrite: price(cost.cacheWrite)
    }
  };
}

// Pi's thinking levels, in Pi's own order.
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The levels one model accepts, by Pi's own rule (getSupportedThinkingLevels in
 * Pi's model runtime, mirrored here so the client can show exactly what the
 * session's model will take):
 *  - a model without reasoning supports only «off»;
 *  - a level is unsupported when the model's thinkingLevelMap marks it `null`;
 *  - the extended «xhigh»/«max» additionally need an explicit map entry.
 * For the configured Strata models this yields off/low/medium/high/xhigh —
 * «minimal» and «max» are null there, and the map's `"max*"` key is a wildcard,
 * not «max». Pure, so it is covered without spawning Pi.
 */
export function supportedThinkingLevels(model) {
  if (model?.reasoning !== true) return ['off'];
  const map = model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object' ? model.thinkingLevelMap : {};
  return THINKING_LEVELS.filter(level => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

/**
 * Level → the value the provider actually receives (`thinkingLevelMap[level] ??
 * level`, the same expression Pi uses when it fills the request). Only the
 * levels the model supports, and only where the value differs from the level
 * name, so the client can say «Глубоко → xhigh» instead of inventing «xhigh».
 */
export function providerThinkingValues(model, levels = supportedThinkingLevels(model)) {
  const map = model?.thinkingLevelMap && typeof model.thinkingLevelMap === 'object' ? model.thinkingLevelMap : {};
  const values = {};
  for (const level of levels) {
    const mapped = map[level];
    const value = typeof mapped === 'string' ? mapped : level;
    if (value !== level) values[level] = value;
  }
  return values;
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
      // Stale-while-revalidate: an expired catalog still answers the picker
      // instantly. A fresh Pi probe takes seconds, and with a 60s TTL the
      // cache was almost always cold for a client (a phone) that opens the
      // picker rarely — so it paid the full probe on every open. The refresh
      // runs in the background for the next caller instead.
      if (this.cache) {
        if (!this.inFlight) this.#start().catch(() => {});
        return this.cache.value;
      }
    }
    if (!this.inFlight) this.#start();
    return this.inFlight;
  }

  // One probe at a time: concurrent callers share the same in-flight promise.
  #start() {
    this.inFlight = this.#probe()
      .then(value => {
        this.cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => { this.inFlight = null; });
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
