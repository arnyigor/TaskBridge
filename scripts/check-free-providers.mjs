// One-off check: free providers/models availability + latency measurement.
// Usage: node scripts/check-free-providers.mjs [--probe] [--skip-long]
// --probe sends a minimal chat completion to each free model (uses configured keys).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const probe = process.argv.includes('--probe');
// Only probe the providers named on the command line, if any: --only=openrouter,gemini
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice('--only='.length).split(',').filter(Boolean);
const modelsJson = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'models.json'), 'utf8'));

// models.json stores keys as env references ("$OPENROUTER_API_KEY"); Pi expands them at runtime.
function expandKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('$')) return process.env[s.slice(1)] || '';
  return s;
}

const FREE = ['gemini', 'openrouter', 'wormsoft'];
const promptMessages = [{ role: 'user', content: 'Reply with the single word: ok' }];
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 45000);

function ms(n) { return n == null ? '-' : `${n}ms`; }

async function chatProbe(baseUrl, key, authHeader, model, timeoutMs) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  // Pi (pi-models-manager) always sends `Authorization: Bearer <key>` for
  // openai-completions, including providers with authHeader === true.
  if (key) headers[authHeader && authHeader !== true ? authHeader : 'Authorization'] = `Bearer ${key}`;
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages: promptMessages, max_tokens: 64, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const latencyMs = Date.now() - started;
  const text = await res.text();
  let usage = null;
  let firstContent = null;
  try {
    const j = JSON.parse(text);
    usage = j.usage || null;
    firstContent = j.choices?.[0]?.message?.content ?? null;
  } catch { /* non-json error body */ }
  return { ok: res.ok, status: res.status, latencyMs, usage, firstContent, errorBody: res.ok ? null : text.slice(0, 200) };
}

const out = [];
for (const provider of FREE) {
  if (only.length && !only.includes(provider)) continue;
  const cfg = modelsJson.providers?.[provider];
  if (!cfg) { out.push({ provider, error: 'no-config' }); continue; }
  const models = (cfg.models || []).map(m => m.id || m.name || m).filter(Boolean);
  const key = expandKey(cfg.apiKey);
  out.push({ provider, baseUrl: cfg.baseUrl, keyResolved: Boolean(key), models: models.length });

  if (probe && key) {
    for (const model of models) {
      try {
        const r = await chatProbe(cfg.baseUrl, key, cfg.authHeader, model, PROBE_TIMEOUT_MS);
        out.push({
          model, ok: r.ok, status: r.status, latency: ms(r.latencyMs),
          tokens: r.usage ? `${r.usage.completion_tokens ?? r.usage.completionTokens ?? '?'}/${r.usage.prompt_tokens ?? r.usage.promptTokens ?? '?'}` : '-',
          reply: r.firstContent == null ? null : String(r.firstContent).slice(0, 40),
          error: r.errorBody,
        });
      } catch (e) {
        out.push({ model, ok: false, error: String(e.message || e).slice(0, 160) });
      }
    }
  }
}

console.log(JSON.stringify(out, null, 1));
