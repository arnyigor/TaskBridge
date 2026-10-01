import fs from 'node:fs/promises';
import path from 'node:path';

// The model list of a cloud provider in Pi's models.json (~/.pi/agent/models.json)
// is static: the entries were written by hand, and models the provider added
// later (wormsoft's openai/gpt-6-luna) never reach the picker. ProviderModelSync
// asks the provider's own OpenAI-compatible GET {baseUrl}/models endpoint and
// merges the models that are missing. It only ever ADDS: existing entries and
// their hand-tuned compat metadata stay untouched, so a stale id (gpt-5.6-luna
// retired by the provider) keeps working until the operator removes it.
//
// Sync is opt-in per provider (config.modelSync.providers): openrouter and
// routerai answer with 400-500+ models, and merging all of them would bloat
// both models.json and the picker. Local llama.cpp/Strata providers are skipped
// by the remote-https rule below, not by name.

// {baseUrl}/models — the OpenAI-compatible listing next to the completions
// endpoint the provider already serves (measured live on wormsoft, deepseek,
// openrouter, routerai on 2026-09-30).
export function remoteModelsUrl(baseUrl) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/models`;
}

// The provider's own prefixed ids (wormsoft/agent/high, wormsoft/mine/alias) are
// its internal routing aliases, not vendor models — the hand-written list never
// carried them, and they would flood the picker with rows the provider routes
// itself. Pure, so the merge rule is covered without any network.
export function mergeProviderModels(existing, remote, providerName) {
  const current = Array.isArray(existing) ? existing : [];
  const known = new Set(current.map(model => model?.id).filter(Boolean));
  const added = [];
  for (const model of Array.isArray(remote) ? remote : []) {
    if (!model?.id || known.has(model.id)) continue;
    if (providerName && model.id.startsWith(`${providerName}/`)) continue;
    known.add(model.id);
    added.push(model);
  }
  return { added, models: [...current, ...added] };
}

// OpenAI /models payload → the minimal Pi model entry. Mirrors the fields the
// provider reports (context_length, max_completion_tokens, capabilities,
// input_modalities); it never invents compat metadata the endpoint did not send.
export function parseProviderModels(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.map(model => {
    if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim()) return null;
    const capabilities = model.capabilities && typeof model.capabilities === 'object' ? model.capabilities : {};
    const input = Array.isArray(model.input_modalities)
      ? model.input_modalities
      : (Array.isArray(model.input) ? model.input : []);
    const entry = { id: model.id, name: model.id };
    const contextWindow = Number(model.context_length ?? model.contextWindow);
    if (Number.isFinite(contextWindow)) entry.contextWindow = contextWindow;
    const maxTokens = Number(model.max_completion_tokens ?? model.maxTokens);
    if (Number.isFinite(maxTokens)) entry.maxTokens = maxTokens;
    if (capabilities.reasoning === true) entry.reasoning = true;
    const inputs = input.filter(kind => kind === 'text' || kind === 'image');
    if (inputs.length) entry.input = inputs;
    return entry;
  }).filter(Boolean);
}

// Same rule as Pi's own env-var references ($WORMSOFT_API_KEY in models.json).
function apiKey(raw, env) {
  const value = String(raw || '');
  return value.startsWith('$') ? env?.[value.slice(1)] || null : value || null;
}

// Remote means the provider's own server: 127.0.0.1/localhost entries are the
// local llama.cpp router and the configured Strata servers, whose "models"
// endpoint answers their own presets and must not be rewritten from here.
function isRemote(baseUrl) {
  return !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(String(baseUrl || ''));
}

/**
 * Syncs every qualifying provider of models.json against its own /models
 * endpoint. One pass adds the missing models and rewrites the file once
 * (backup first, tmp+rename last); a provider that fails is reported in the
 * summary and never blocks the others or the caller.
 *
 * agentDir — каталог Pi (piAgentDir(env)), там лежит models.json;
 * only     — провайдеры, которым синхронизация разрешена
 *            (config.modelSync.providers; пусто — никого не трогать).
 */
export async function syncProviderModels({ agentDir, env = process.env, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10000, only = null } = {}) {
  const modelsPath = path.join(agentDir, 'models.json');
  let doc;
  try {
    doc = JSON.parse(await fs.readFile(modelsPath, 'utf8'));
  } catch {
    return { changed: false, providers: [], error: 'models.json is missing or unreadable' };
  }
  const providers = doc.providers && typeof doc.providers === 'object' ? doc.providers : {};
  const wanted = Array.isArray(only) ? only : null;
  const targets = Object.entries(providers).filter(([name, entry]) =>
    entry?.api === 'openai-completions'
    && isRemote(entry.baseUrl)
    && apiKey(entry.apiKey, env)
    && (!wanted || wanted.includes(name)));
  if (!targets.length) return { changed: false, providers: [] };

  const summary = [];
  let changed = false;
  for (const [name, entry] of targets) {
    try {
      const response = await fetchImpl(remoteModelsUrl(entry.baseUrl), {
        headers: { Authorization: `Bearer ${apiKey(entry.apiKey, env)}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const remote = parseProviderModels(await response.json());
      const merged = mergeProviderModels(entry.models, remote, name);
      summary.push({ provider: name, added: merged.added.length, total: merged.models.length, addedIds: merged.added.map(m => m.id) });
      if (merged.added.length) {
        entry.models = merged.models;
        changed = true;
      }
    } catch (error) {
      summary.push({ provider: name, error: String(error.message || error) });
    }
  }
  if (changed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(modelsPath, `${modelsPath}.bak-${stamp}`);
    const tmp = `${modelsPath}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, modelsPath);
  }
  return { changed, providers: summary };
}
