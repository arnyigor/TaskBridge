import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProcesses, processesUsingFile } from './process-info.mjs';
import { discoverExternalServers } from './external-discovery.mjs';
import { CONTEXT_FLAG, missingModelPaths, readEngineArg, writeContextFile } from './engine-context.mjs';

const ORPHAN_LAUNCHER = fileURLToPath(new URL('./orphan-launcher.mjs', import.meta.url));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (code, message) => Object.assign(new Error(message), { code });

// Best-effort tree kill: a spawned router that outlived its readiness window
// must not leak a listening process (and its log file handle) into the next
// ensureRunning() call.
function killTree(proc) {
  if (!proc || proc.exitCode != null || proc.signalCode != null || !proc.pid) return Promise.resolve();
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, resolve);
    } else {
      // A bare `{ pid }` carries no ChildProcess: an orphaned server is only a
      // pid here (see ExternalLocalServers.start).
      try { (proc.kill ? proc.kill('SIGKILL') : process.kill(proc.pid, 'SIGKILL')); } catch { /* already gone */ }
      resolve();
    }
  });
}

// The pid the orphan launcher printed for the server it started, or null when
// the launcher never got that far (a bad command, an immediate exit). Its stdout
// is a pipe and `close` follows the last chunk, so the read needs no timing
// assumption — only a bound, so a wedged launcher cannot hang a load.
function launcherPid(proc, { timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    let buffer = '';
    let done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const read = () => {
      const match = /^\s*(\d+)/u.exec(buffer);
      if (match) finish(Number(match[1]));
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    proc.stdout?.on('data', chunk => { buffer += String(chunk); read(); });
    proc.once('close', () => { read(); finish(null); });
    proc.once('error', () => finish(null));
  });
}

// llama.cpp router mode (server started without -m, with --models-dir or
// --models-preset) owns a single port and loads presets on demand. Pi already
// ships a client for exactly these endpoints, so TaskBridge speaks the same
// protocol instead of inventing its own: /models, /models/load, /models/unload,
// /models/sse. This is what lets one always-on server replace the old
// "text vs vision profile = restart the process" approach.
export function normalizeBaseUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/u, '').replace(/\/v1$/u, '') || '';
    return url.toString().replace(/\/$/u, '');
  } catch {
    return null;
  }
}

// Автоопределение порта llama-server.
//
// TaskBridge берёт порт из config.json (`localRuntime.router.args --port N`),
// но llama-server часто поднимают вручную на другом порту. Тогда `/health` по
// сконфигурированному адресу молчит и панель показывала «Модель: не загружена»,
// хотя модель была загружена и работала. Поэтому при недоступности
// сконфигурированного адреса порт ищется среди запущенных llama-server.exe.
//
// Best-effort: там, где командную строку процесса прочитать нечем, список
// кандидатов просто пуст и поведение остаётся прежним.
const DETECT_CACHE_MS = 10000;
// Status of the configured external servers (Strata и др.): two loopback
// /health probes per poll would otherwise hammer them every 2 s.
const STATUS_CACHE_MS = 5000;
const DETECT_ENV = 'TASKBRIDGE_LLAMA_URL';

/** `--port N` из командных строк процессов. Чистая функция — покрыта тестом. */
export function parseLlamaPorts(commandLines) {
  const ports = new Set();
  for (const line of commandLines || []) {
    const m = /(?:^|\s)--port[=\s]+(\d{2,5})(?:\s|$)/u.exec(String(line));
    if (!m) continue;
    const port = Number(m[1]);
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
  }
  return [...ports];
}

/** Кандидаты-адреса: env, затем порты живых llama-server.exe. */
async function candidateLlamaUrls() {
  const urls = [];
  const fromEnv = normalizeBaseUrl(String(process.env[DETECT_ENV] || ''));
  if (fromEnv) urls.push(fromEnv);
  if (process.platform !== 'win32') return urls;
  const lines = await new Promise(resolve => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | Select-Object -ExpandProperty CommandLine"],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => resolve(err ? [] : String(stdout || '').split(/\r?\n/u)),
    );
  });
  for (const port of parseLlamaPorts(lines)) urls.push(`http://127.0.0.1:${port}`);
  return urls;
}

/** Отвечает ли адрес как llama-эндпоинт. */
async function llmEndpointAlive(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

// Mirrors the shape llama.cpp sends on /models/sse load events. Kept pure and
// exported so it can be tested without a running server.
export function parseLoadProgress(payload) {
  const progress = payload && typeof payload === 'object' ? payload.progress : null;
  if (!progress || typeof progress !== 'object') return null;
  const stages = Array.isArray(progress.stages) ? progress.stages.filter(s => typeof s === 'string') : [];
  const stage = typeof progress.current === 'string'
    ? progress.current
    : (typeof progress.stage === 'string' ? progress.stage : null);
  const stageRatio = typeof progress.value === 'number' ? Math.max(0, Math.min(1, progress.value)) : null;
  let ratio = stageRatio;
  if (stage && stages.length) {
    const index = stages.indexOf(stage);
    if (index >= 0) ratio = (index + (stageRatio ?? 0)) / stages.length;
  }
  return { message: stage ? `Загрузка: ${stage.replaceAll('_', ' ')}` : 'Загрузка модели', ratio };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

// Quantization is not a separate field in the router catalog, but the child
// args (and the model path) always carry the .gguf filename, whose last dash
// segment is the quant (IQ4_XS, Q3_K_XL, ...).
export function quantFromPath(value) {
  if (!value) return null;
  const base = String(value).split(/[\\/]/).pop().replace(/\.gguf$/i, '');
  const parts = base.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

// /models returns { data: [{ id, status: { value, progress, failed, exit_code,
// args }, architecture: { input_modalities }, meta: { n_ctx }, path }] }.
// Anything without `data` is a single-model endpoint, not a router.
export function normalizeModels(payload) {
  if (!payload || !Array.isArray(payload.data)) return null;
  return payload.data
    .filter(model => model && typeof model.id === 'string')
    .map((model) => {
      const status = model.status && typeof model.status === 'object' ? model.status : {};
      const modalities = model.architecture?.input_modalities;
      const args = Array.isArray(status.args) ? status.args : [];
      const isPath = String(model.id || '').includes('\\') || String(model.id || '').includes('/');
      const modelPath = argValue(args, '--model') || model.path || (isPath ? model.id : null);
      const ctxArg = Number(argValue(args, '--ctx-size'));
      const contextWindow = Number.isFinite(model.meta?.n_ctx) ? model.meta.n_ctx
        : (Number.isFinite(model.meta?.n_ctx_train) ? model.meta.n_ctx_train
          : (Number.isFinite(ctxArg) ? ctxArg : null));
      let displayName = typeof model.name === 'string' && model.name ? model.name : model.id;
      if (displayName.includes('\\') || displayName.includes('/')) {
        displayName = displayName.split(/[\\/]/).pop().replace(/\.gguf$/i, '');
      }
      return {
        id: model.id,
        name: displayName,
        status: typeof status.value === 'string' ? status.value : (typeof model.status === 'string' ? model.status : 'unknown'),
        progress: status.progress ?? null,
        failed: status.failed === true,
        exitCode: Number.isFinite(status.exit_code) ? status.exit_code : null,
        vision: Array.isArray(modalities) ? modalities.includes('image') : Boolean(argValue(args, '--mmproj')),
        contextWindow,
        quant: quantFromPath(modelPath),
        modelPath,
        path: typeof model.path === 'string' ? model.path : null
      };
    });
}

// llama.cpp /metrics (server-task.cpp) is Prometheus text. The UI needs PP
// (prompt) and TG (generation) tokens/s. NOTE: the `*_tokens_seconds` gauges
// are unreliable (often stuck at 0 while the model works), so the rates are
// derived from the cumulative counters when present:
//   PP = prompt_tokens_total / prompt_seconds_total
//   TG = tokens_predicted_total / tokens_predicted_seconds_total
// A delta between consecutive parses gives the INSTANT rate (what the
// llama.cpp Web UI shows); the counters' cumulative average is the fallback.
// The gauges are only used as a last resort when counters are absent.
//
// `samples` scopes the instant-rate delta state per model/server; it is owned
// by the caller (service instance) instead of module state, so instances do
// not leak data to each other and tests stay deterministic.
export function parsePrometheusMetrics(text, modelKey = '', samples = new Map()) {
  const values = new Map();
  for (const rawLine of String(text || '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const space = line.lastIndexOf(' ');
    if (space <= 0) continue;
    const value = Number(line.slice(space + 1));
    if (Number.isFinite(value)) values.set(line.slice(0, space).trim(), value);
  }
  const pick = name => (values.has(name) ? values.get(name) : null);
  const counters = {
    promptTokens: pick('llamacpp:prompt_tokens_total'),
    promptSeconds: pick('llamacpp:prompt_seconds_total'),
    predictedTokens: pick('llamacpp:tokens_predicted_total'),
    predictedSeconds: pick('llamacpp:tokens_predicted_seconds_total')
  };
  let pp = null;
  let tg = null;
  const hasCounters = counters.promptTokens !== null && counters.promptSeconds !== null
    && counters.predictedTokens !== null && counters.predictedSeconds !== null;
  if (hasCounters) {
    if (counters.promptSeconds > 0) pp = counters.promptTokens / counters.promptSeconds;
    if (counters.predictedSeconds > 0) tg = counters.predictedTokens / counters.predictedSeconds;
    const prev = samples.get(modelKey);
    if (prev) {
      const elapsed = Date.now() - prev.at;
      if (elapsed > 500) {
        const dPt = counters.promptTokens - prev.c.promptTokens;
        const dPs = counters.promptSeconds - prev.c.promptSeconds;
        const dTt = counters.predictedTokens - prev.c.predictedTokens;
        const dTs = counters.predictedSeconds - prev.c.predictedSeconds;
        if (dPt > 0 && dPs > 0) pp = dPt / dPs;
        if (dTt > 0 && dTs > 0) tg = dTt / dTs;
      }
    }
    samples.set(modelKey, { at: Date.now(), c: counters });
  }
  if (pp === null) pp = pick('llamacpp:prompt_tokens_seconds');
  if (tg === null) tg = pick('llamacpp:predicted_tokens_seconds');
  return {
    pp,
    tg,
    requestsProcessing: pick('llamacpp:requests_processing'),
    requestsDeferred: pick('llamacpp:requests_deferred'),
    // Context (KV) usage. Not every llama.cpp build emits kv_cache_usage_ratio
    // (checked against the running server 2026-09: absent), so n_tokens_max is
    // carried through as the fallback — see contextUsage().
    kvCacheRatio: pick('llamacpp:kv_cache_usage_ratio'),
    nTokensMax: pick('llamacpp:n_tokens_max')
  };
}

// Доля переиспользованного промпта, выше которой PP не публикуется.
//
// У Strata `prompt_ms` — время всей промпт-фазы запроса, и оно складывается из
// ПОСТОЯННЫХ накладных расходов на запрос плюс чтение новых токенов. Измерено на
// живом сервере (iq3_s, порт 8083, 2026-09-30, 12 запросов одной сессии):
// `prompt_ms` зависит от новых токенов (регрессия: ~1.19 с на запрос + 1.55 мс на
// токен, r²=0.91 => ~650 ток/с) и совсем не зависит от переиспользованной части
// (r²=0.003). Поэтому на почти полностью закешированной беседе «новые / prompt_ms»
// — это уже не скорость чтения, а накладные расходы, делённые на остаток:
// 23 новых токена за 677 мс давали «34 tok/s», 163 за 1502 мс — «108 tok/s»
// (та самая «посадка до 105»), хотя новые токены движок читает на ~650 ток/с
// (документация Strata даёт 931-1070 ток/с для IQ3_S на 64K-128K). Такой промпт
// движок вспомнил, а не прочитал — честной скорости чтения у него нет.
const STRATA_CACHED_PROMPT_MAX = 0.5;

/**
 * Телеметрия внешнего сервера Strata. В отличие от llama.cpp это JSON
 * (`GET /metrics`), а не prometheus-текст: там есть фаза работы, прогресс
 * чтения промпта и скорость последнего запроса. Функция чистая — тестируется
 * без сети.
 *
 * Что отдаём:
 *  - phase/busy — что модель делает прямо сейчас (в т.ч. «reading the prompt»);
 *  - promptRead/promptTotal/progress — процент чтения промпта на длинном вводе.
 *    Внимание: `prompt_read` считает и переиспользованный префикс прочитанным
 *    (движок, issue #29), поэтому на кешированном промпте процент почти сразу 100% —
 *    это счётчик движка, а не вычисленное нами число;
 *  - pp — скорость ЧТЕНИЯ новых токенов (новые за prompt_ms) и только для
 *    запроса, который промпт действительно читал. Промпт, пришедший из кеша
 *    беседы, скорости чтения не даёт: pp = null, ppUnavailable = 'conversation-cache'
 *    (см. STRATA_CACHED_PROMPT_MAX — там же измерения);
 *  - freshTokens/reusedPrompt — сколько промпта прочитано и сколько вспомнено:
 *    по ним видно, почему pp нет, без выдумывания скорости;
 *  - tg — скорость генерации (живая или из последнего запроса).
 */
export function parseStrataMetrics(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const engine = payload.engine || null;
  const live = payload.live || null;
  if (!engine && !live) return null;

  const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const read = num(live && live.prompt_read);
  const total = num(live && live.prompt_total);
  const progress = read !== null && total !== null && total > 0 ? Math.min(1, read / total) : null;

  const last = Array.isArray(payload.requests) && payload.requests.length ? payload.requests[0] : null;
  let promptTokens = null;
  let freshTokens = null;
  let reusedRatio = null;
  if (last) {
    const tokens = num(last.prompt_tokens);
    const reused = num(last.reused);
    if (tokens !== null && tokens > 0) {
      // Движки до 0.1.3 поля `reused` не отдают: тогда переиспользовать было нечего
      // и весь промпт — прочитанный.
      promptTokens = tokens;
      freshTokens = reused === null ? tokens : Math.max(0, tokens - reused);
      reusedRatio = reused === null ? 0 : Math.min(1, reused / tokens);
    }
  }
  const cachedPrompt = reusedRatio !== null && reusedRatio > STRATA_CACHED_PROMPT_MAX;
  let pp = null;
  if (last && !cachedPrompt) {
    const ms = num(last.prompt_ms);
    if (freshTokens !== null && freshTokens > 0 && ms !== null && ms > 0) pp = freshTokens / ms * 1000;
  }

  const liveRate = num(live && live.tok_s);
  const lastRate = last ? num(last.decode_tok_s) : null;

  return {
    available: true,
    source: 'strata',
    model: engine ? engine.model ?? null : null,
    state: live ? live.state ?? null : null,
    busy: Boolean(live && live.state && live.state !== 'idle'),
    phase: live ? live.phase ?? null : null,
    promptRead: read,
    promptTotal: total,
    progress,
    generated: live ? num(live.generated) : null,
    elapsedS: live ? num(live.elapsed_s) : null,
    pp,
    ppUnavailable: cachedPrompt ? 'conversation-cache' : null,
    promptTokens,
    freshTokens,
    tg: liveRate ?? lastRate,
    requestsProcessing: live ? num(live.queued) : null,
    kvRatio: null,
    nTokensMax: null,
    contextWindow: engine ? num(engine.context) ?? num(engine.max_context) : null
  };
}

/**
 * Доля занятого контекста (KV), 0..1, или null если данных нет.
 *
 * Перенесено из расширения `model-state`, которое выводило это только в консольный
 * виджет. Предпочитаем `kv_cache_usage_ratio`; если метрики нет, считаем
 * `n_tokens_max / n_ctx` (самая длинная обработанная последовательность) — то же
 * правило, что было фолбэком в расширении.
 *
 * Ничего не выдумываем: нет данных — null (правило TZ v3 §13: «—», а не ноль).
 */
export function contextUsage(parsed, model) {
  const ctx = Number.isFinite(model?.contextWindow) ? model.contextWindow : null;
  const raw = parsed?.kvCacheRatio;
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return { kvRatio: raw, contextWindow: ctx };
  // Some builds report absolute tokens instead of a ratio.
  if (Number.isFinite(raw) && raw > 1 && ctx) return { kvRatio: Math.min(1, raw / ctx), contextWindow: ctx };
  const max = parsed?.nTokensMax;
  if (Number.isFinite(max) && ctx && ctx > 0) return { kvRatio: Math.min(1, max / ctx), contextWindow: ctx };
  return { kvRatio: null, contextWindow: ctx };
}

export class LocalModelService extends EventEmitter {
  constructor(config = {}, dataRoot) {
    super();
    this.config = config || {};
    this.dataRoot = dataRoot;
    this.proc = null;
    this.state = 'STOPPED';
    this.lastError = null;
    this.activeProfileId = null;
    this.watchController = null;
    this.metricSamples = new Map();
    // Адрес, найденный автодетектом (null = используем сконфигурированный).
    this.detectedBaseUrl = null;
    this.detectedAt = 0;
  }

  // `managed` = TaskBridge can start/stop this router (a command is configured).
  // `enabled` = router mode is configured at all (managed or an external one we
  // only talk to over HTTP). Both gate different things: process control needs
  // `managed`, list/load/progress only need reachable HTTP.
  get managed() {
    return Boolean(this.config.router?.command);
  }

  get enabled() {
    return Boolean(this.config.router?.enabled || this.config.router?.command);
  }

  get provider() {
    return this.config.provider || 'llama.cpp';
  }

  get baseUrl() {
    return this.detectedBaseUrl || this.configuredBaseUrl;
  }

  /** Адрес из конфигурации — прежнее поведение. */
  get configuredBaseUrl() {
    return normalizeBaseUrl(this.config.router?.baseUrl)
      || normalizeBaseUrl(String(this.config.healthUrl || '').replace(/\/health$/iu, ''))
      || 'http://127.0.0.1:8080';
  }

  /**
   * Убедиться, что this.baseUrl указывает на живой сервер.
   *
   * Если сконфигурированный адрес молчит — ищем порт среди процессов llama-server.
   * Результат кэшируется.
   *
   * ВАЖНО: уже найденный живой адрес НИКОГДА не обнуляется до тех пор, пока он
   * отвечает. Иначе на время повторной проверки `baseUrl` откатывается на мёртвый
   * сконфигурированный адрес, и параллельный запрос (опрос идёт каждые 2 с) успевает
   * показать «Модель: не загружена» — панель мигала.
   */
  async ensureBaseUrl() {
    const now = Date.now();
    if (now - this.detectedAt < DETECT_CACHE_MS) return this.baseUrl;

    // Сконфигурированный адрес в приоритете: если он ожил — автодетект больше не нужен.
    if (await llmEndpointAlive(this.configuredBaseUrl)) {
      this.detectedBaseUrl = null;
      this.detectedAt = now;
      return this.baseUrl;
    }

    // Прошлый найденный адрес ещё жив — оставляем его как есть.
    if (this.detectedBaseUrl && await llmEndpointAlive(this.detectedBaseUrl)) {
      this.detectedAt = now;
      return this.baseUrl;
    }

    for (const url of await candidateLlamaUrls()) {
      if (url === this.configuredBaseUrl) continue;
      if (url === this.detectedBaseUrl) continue;
      if (await llmEndpointAlive(url)) {
        this.detectedBaseUrl = url;
        this.detectedAt = now;
        return this.baseUrl;
      }
    }

    // Ничего живого не нашли. Ранее найденный адрес НЕ обнуляем — иначе мигание.
    this.detectedAt = now;
    return this.baseUrl;
  }

  get management() {
    return this.config.router || this.config.managed || {};
  }

  async request(pathname, { method = 'GET', body, timeout = 15000, signal } = {}) {
    const timer = new AbortController();
    const timerId = setTimeout(() => timer.abort(new Error('timeout')), timeout);
    const signals = signal ? [signal, timer.signal] : [timer.signal];
    const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : timer.signal;
    try {
      const response = await fetch(this.baseUrl + pathname, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: combined
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      if (!response.ok) {
        throw failure('LOCAL_HTTP_ERROR', payload?.error?.message || `${pathname} → HTTP ${response.status}`);
      }
      return payload;
    } finally {
      clearTimeout(timerId);
    }
  }

  async isReady() {
    if (!this.managed && !this.config.healthUrl && !this.config.router?.baseUrl) return true;
    await this.ensureBaseUrl();
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels() {
    const payload = await this.request('/models', { timeout: 5000 });
    const models = normalizeModels(payload);
    if (!models) throw failure('LOCAL_NOT_ROUTER', 'llama.cpp не запущен в router-режиме (нет /models с data[]).');
    return models;
  }

  // The router multiplexes models, but a model that is loaded still runs in its
  // own child server, and the router forwards /slots?model=<id> to it (verified
  // against llama.cpp b10883). Only already-loaded models are probed: asking
  // about an unloaded one would autoload it (--models-autoload is on), so the
  // slot query would itself make the model busy.
  async getBusyStatus() {
    const models = await this.listModels().catch(() => null);
    if (!models) return { unknown: true, busy: false, loaded: null };
    // loaded — positively "no model is loaded" lets the caller park a prompt
    // instead of blocking the request on loading one. A model whose status the
    // router does not report (external server, plain llama.cpp) must NOT count
    // as "not loaded": it may well be loaded and answering, and parking every
    // message behind a model-load that cannot even be attempted is what made
    // the queue look stuck.
    const loaded = models.filter(m => m.status === 'loaded' || m.status === 'sleeping');
    if (!loaded.length) {
      const known = models.some(m => m.status && m.status !== 'unknown');
      if (known) return { unknown: false, busy: false, loaded: false };
      // The model list carries no status (an external llama-server owns the
      // port, or a plain llama.cpp build). Ask its slots directly — that is
      // where the honest "a generation is running" answer lives for a
      // single-model server. Without this, a busy local model could not be
      // detected at all and every prompt was delivered immediately instead of
      // taking its place in the queue.
      const slots = await this.request('/slots', { timeout: 1500 }).catch(() => null);
      if (Array.isArray(slots) && slots.length) {
        return { unknown: false, busy: slots.some(slot => slot?.is_processing === true), loaded: true };
      }
      return { unknown: false, busy: false, loaded: null };
    }
    let inspected = false;
    for (const model of loaded) {
      let slots;
      try {
        slots = await this.request(`/slots?model=${encodeURIComponent(model.id)}`, { timeout: 1500 });
      } catch {
        continue;
      }
      if (!Array.isArray(slots) || !slots.length) continue;
      inspected = true;
      if (slots.some(slot => slot?.is_processing)) return { unknown: false, busy: true, loaded: true };
    }
    return inspected ? { unknown: false, busy: false, loaded: true } : { unknown: true, busy: false, loaded: true };
  }

  async getEngineInfo() {
    if (!this.enabled) return { configured: false, reachable: false, state: this.state };
    const reachable = await this.isReady();
    if (!reachable) return { configured: true, reachable: false, state: this.state, error: this.lastError };
    const models = await this.listModels().catch(() => []);
    const loaded = models.filter(m => m.status === 'loaded' || m.status === 'sleeping');
    return {
      configured: true,
      reachable: true,
      state: this.state,
      model: loaded[0]?.id ?? null,
      name: loaded[0]?.name ?? null,
      contextWindow: loaded[0]?.contextWindow ?? null,
      loaded: loaded.map(m => m.id),
      slots: null,
      // Какой адрес реально опрошен; autoDetected=true означает, что
      // сконфигурированный порт молчал и порт найден среди процессов.
      baseUrl: this.baseUrl,
      autoDetected: Boolean(this.detectedBaseUrl),
      metrics: await this.getMetrics(models)
    };
  }

  // PP/TG for the loaded model, read from llama.cpp /metrics. The router proxies
  // the endpoint to the child server (server.cpp), and the child must have been
  // started with --metrics — otherwise it answers 501 and the UI is told the
  // data is unavailable instead of being shown a zero.
  async getMetrics(models = null) {
    if (!this.enabled) return { available: false, reason: 'not-configured' };
    const list = models || await this.listModels().catch(() => null);
    if (!list) return { available: false, reason: 'unreachable' };
    const loaded = list.filter(m => m.status === 'loaded' || m.status === 'sleeping');
    if (!loaded.length) return { available: false, reason: 'no-model' };
    for (const model of loaded) {
      let response;
      try {
        response = await fetch(`${this.baseUrl}/metrics?model=${encodeURIComponent(model.id)}`, { signal: AbortSignal.timeout(2000) });
      } catch {
        continue;
      }
      if (!response.ok) {
        if (response.status === 501) return { available: false, reason: 'metrics-disabled', model: model.id };
        continue;
      }
      const parsed = parsePrometheusMetrics(await response.text(), model.id, this.metricSamples);
      return { available: true, source: 'llama.cpp', model: model.id, name: model.name ?? model.id, ...parsed, ...contextUsage(parsed, model) };
    }
    return { available: false, reason: 'unreachable' };
  }

  async getStatus() {
    await this.ensureBaseUrl();
    if (!this.proc && this.state !== 'STARTING') {
      this.state = (await this.isReady()) ? 'EXTERNAL_RUNNING' : 'STOPPED';
    }
    let models = null;
    if (this.state !== 'STOPPED') models = await this.listModels().catch(() => null);
    return {
      enabled: this.enabled,
      mode: 'router',
      state: this.state,
      pid: this.proc?.pid ?? null,
      baseUrl: this.baseUrl,
      provider: this.provider,
      reachable: models != null,
      models: models || [],
      loaded: (models || []).filter(m => m.status === 'loaded' || m.status === 'sleeping').map(m => m.id),
      loading: (models || []).filter(m => m.status === 'loading').map(m => m.id),
      error: this.lastError
    };
  }

  async #spawnRouter(onLog = () => {}) {
    const management = this.management;
    const command = management.command;
    const args = management.args || [];
    if (!command) throw failure('LOCAL_RUNTIME_FAILED', 'Не задана команда запуска router-сервера.');
    this.state = 'STARTING';
    this.lastError = null;
    this.emit('status', { state: this.state });
    fs.mkdirSync(path.join(this.dataRoot, 'runtime'), { recursive: true });
    const log = fs.createWriteStream(path.join(this.dataRoot, 'runtime', 'router.log'), { flags: 'a' });
    const proc = spawn(command, args, {
      cwd: management.cwd || undefined,
      env: { ...process.env, ...(management.env || {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.proc = proc;
    proc.stdout.on('data', chunk => { log.write(chunk); onLog(chunk.toString('utf8')); });
    proc.stderr.on('data', chunk => { log.write(chunk); onLog(chunk.toString('utf8')); });
    proc.on('close', (code, signal) => {
      this.proc = null;
      this.state = 'STOPPED';
      if (code) this.lastError = `Router завершился с кодом ${code}${signal ? ` (${signal})` : ''}.`;
      this.stopWatching();
      log.end();
      this.emit('status', { state: this.state, error: this.lastError });
    });
    proc.on('error', (error) => {
      this.lastError = error.message;
      onLog(`[router error] ${error.message}\n`);
      // A failed spawn (ENOENT, EACCES) never emits 'close': release the slot
      // and the log handle so the next ensureRunning() does not believe a
      // router is running and spawn a second process.
      if (this.proc === proc) {
        this.proc = null;
        this.state = 'STOPPED';
      }
      log.end();
      this.emit('status', { state: this.state, error: this.lastError });
    });

    const deadline = Date.now() + (management.startTimeoutMs || 120000);
    while (Date.now() < deadline) {
      if (!this.proc) throw failure('LOCAL_RUNTIME_FAILED', this.lastError || 'Router завершился до готовности.');
      if (await this.isReady()) {
        this.state = 'MANAGED_RUNNING';
        this.emit('status', { state: this.state, pid: this.proc?.pid ?? null });
        return;
      }
      await sleep(500);
    }
    // The router never became healthy: it must not survive this call, or the
    // next ensureRunning() would spawn a second process while the first keeps
    // the port and the log file.
    await killTree(proc).catch(() => {});
    this.proc = null;
    this.state = 'STOPPED';
    log.end();
    throw failure('LOCAL_RUNTIME_FAILED', 'Таймаут ожидания router-сервера.');
  }

  // Starts the router if it is not already listening, then (optionally) loads a
  // specific model with progress. Safe to call for every task.
  async ensureRunning(onLog = () => {}, modelId) {
    if (this.managed && !(await this.isReady())) {
      await this.#spawnRouter(onLog);
    } else if (await this.isReady()) {
      this.state = this.proc ? 'MANAGED_RUNNING' : 'EXTERNAL_RUNNING';
    }
    if (await this.isReady()) this.startWatching();
    if (modelId && await this.isReady()) await this.loadModel(modelId);
    return { state: this.state, pid: this.proc?.pid ?? null, modelId: modelId || null };
  }

  async loadModel(id, { onProgress, signal } = {}) {
    if (!id) throw failure('INPUT_INVALID', 'Не указана модель.');
    const models = await this.listModels().catch(() => []);
    const already = models.find(m => m.id === id || m.name === id);
    if (already && (already.status === 'loaded' || already.status === 'sleeping' || already.status === 'unknown')) {
      this.activeProfileId = already.id;
      return already;
    }
    // An external single-model llama-server doesn't support /models/load: it already runs this model.
    if (this.state === 'EXTERNAL_RUNNING' && models.some(m => m.status === 'unknown')) {
      this.activeProfileId = id;
      return already || { id, status: 'loaded' };
    }
    this.startWatching();
    const onProg = event => { if (!event.model || event.model === id) onProgress?.(event); };
    this.on('progress', onProg);
    try {
      await this.request('/models/load', { method: 'POST', body: { model: id }, timeout: 30000, signal });
      const deadline = Date.now() + (this.management.loadTimeoutMs || 900000);
      while (true) {
        if (signal?.aborted) throw failure('LOCAL_LOAD_CANCELLED', 'Загрузка отменена.');
        const entry = (await this.listModels().catch(() => [])).find(m => m.id === id || m.name === id);
        if (entry?.status === 'loaded') {
          this.activeProfileId = id;
          this.emit('loaded', entry);
          return entry;
        }
        if (entry?.failed) {
          throw failure('LOCAL_LOAD_FAILED', `Модель ${id} не загрузилась${entry.exitCode != null ? ` (код ${entry.exitCode})` : ''}.`);
        }
        if (Date.now() > deadline) throw failure('LOCAL_LOAD_TIMEOUT', `Таймаут загрузки модели ${id}.`);
        await sleep(500);
      }
    } catch (err) {
      if (['LOCAL_HTTP_ERROR', 'LOCAL_NOT_ROUTER'].includes(err.code) && await this.isReady()) {
        this.activeProfileId = id;
        return already || { id, status: 'loaded' };
      }
      throw err;
    } finally {
      this.off('progress', onProg);
    }
  }

  async unloadModel(id) {
    if (!id) throw failure('INPUT_INVALID', 'Не указана модель.');
    await this.request('/models/unload', { method: 'POST', body: { model: id }, timeout: 20000 });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const entry = (await this.listModels().catch(() => [])).find(m => m.id === id);
      if (!entry || entry.status === 'unloaded' || entry.status === 'sleeping') break;
      await sleep(300);
    }
    if (this.activeProfileId === id) this.activeProfileId = null;
    this.emit('unloaded', { id });
    return { id, status: 'unloaded' };
  }

  // Only a router this process started can be stopped; an externally launched
  // one is left alone (same safety rule as the single-model runtime).
  async stop() {
    if (!this.proc) throw failure('LOCAL_RUNTIME_NOT_MANAGED', 'Router запущен извне — остановите его в приложении, которое его запустило.');
    const proc = this.proc;
    this.stopWatching();
    await new Promise(resolve => {
      const killer = process.platform === 'win32'
        ? execFile('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, resolve)
        : (proc.kill('SIGTERM'), resolve());
      killer.on?.('error', resolve);
    });
    this.proc = null;
    this.state = 'STOPPED';
    this.lastError = null;
    this.emit('status', { state: this.state });
    return this.getStatus();
  }

  startWatching() {
    if (this.watchController) return;
    const controller = new AbortController();
    this.watchController = controller;
    this.#watchLoop(controller.signal).catch(() => {});
  }

  stopWatching() {
    this.watchController?.abort();
    this.watchController = null;
  }

  async #watchLoop(signal) {
    while (!signal.aborted) {
      try {
        const response = await fetch(`${this.baseUrl}/models/sse`, { signal });
        if (!response.ok || !response.body) throw new Error('sse unavailable');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const dataLine = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            if (!dataLine) continue;
            let event;
            try { event = JSON.parse(dataLine); } catch { continue; }
            this.emit('event', event);
            const model = event?.model ?? event?.data?.model ?? null;
            const progress = parseLoadProgress(event?.data ?? event);
            if (progress) this.emit('progress', { model, ...progress });
          }
        }
      } catch { /* stream error: reconnect below unless aborted */ }
      if (signal.aborted) break;
      await sleep(2000);
    }
  }
}

/* ---------------- external local servers (Strata и другие не-llama.cpp) ---------------- */

// Some local engines are not llama.cpp and have no /models/load or /models/sse:
// Strata loads the whole model before the server starts listening, so "the model
// is loaded" = "the server answers /health". Loading a model is starting the
// whole server, unloading it is stopping that process. The servers are
// configured (localRuntime.externalServers), not discovered: a port that answers
// /health says nothing about which model is behind it, and the model id Pi serves
// is a Pi catalog fact, not a probing guess.
export class ExternalLocalServers {
  constructor(config = {}, { agentDir = null } = {}) {
    this.config = config || {};
    // Каталог Pi (~/.pi/agent): оттуда читается models.json для автообнаружения.
    this.agentDir = agentDir;
    // Started by this process («Загрузить» in the dialog): a tracked detached
    // process that stop() kills directly, without matching command lines.
    this.procs = new Map();       // provider -> { proc, server }
    this.starting = new Set();    // providers a start() is polling /health for right now
    this.cache = null;
    this.cacheAt = 0;
  }

  // Записи конфига плюс найденные автоматически (провайдер с локальным baseUrl
  // в Pi models.json + каталог установки из localRuntime.externalDiscovery).
  // Ручная запись сильнее обнаружения: провайдер из конфига в объединение не
  // попадает второй раз (см. discoverExternalServers).
  get servers() {
    const configured = Array.isArray(this.config.externalServers) ? this.config.externalServers : [];
    let discovered = [];
    try {
      discovered = discoverExternalServers({
        agentDir: this.agentDir,
        discovery: { ...(this.config.externalDiscovery || {}), healthUrl: this.config.healthUrl },
        configured,
        // Провайдеры самого локального рантайма обнаруживать не нужно: они уже
        // обслуживаются роутером и его health/busy-гейтом.
        exclude: [this.config.provider, 'llama.cpp', 'llamacpp']
      });
    } catch {
      // Обнаружение вспомогательное: его сбой не должен ломать статус и запуск
      // уже настроенных серверов.
      discovered = [];
    }
    return [...discovered, ...configured];
  }

  get configured() {
    return this.servers.length > 0;
  }

  /**
   * Убрать внешний сервер из списка TaskBridge — то есть из его собственного
   * конфига (`localRuntime.externalServers`). Файлы модели, конфиг движка и уже
   * запущенный процесс не трогаются: это действие про список, а не про модель.
   *
   * Возвращает удалённую запись или null, если её в конфиге нет: такая строка
   * пришла из Pi (`~/.pi/agent/models.json`) — туда TaskBridge не пишет, удалять
   * её надо в Pi.
   *
   * Сам файл на диск кладёт вызывающий (saveConfig): у класса нет rootDir, и он не
   * решает, когда переписывать config.json целиком.
   */
  forget(id) {
    const list = Array.isArray(this.config.externalServers) ? this.config.externalServers : [];
    const index = list.findIndex(entry => entry && (entry.model === id || entry.provider === id));
    if (index < 0) return null;
    const [removed] = list.splice(index, 1);
    // Кэш статуса: иначе убранная строка живёт в панели до пяти секунд.
    this.cache = null;
    return removed;
  }

  /** The server behind a model id or a provider id. Matched by the model and
   *  the provider only: an id that collides with a server's display name must
   *  not divert a router load. null = not one of ours. */
  find(id) {
    if (!id) return null;
    return this.servers.find(s => s.model === id || s.provider === id) || null;
  }

  /** A command-line fragment only this server's process has: the `--config` value
   *  from its start command (or an explicit killMarker), so stop() never kills
   *  an unrelated process. null = no marker, and stop() then refuses. */
  killMarker(server) {
    if (server.killMarker) return server.killMarker;
    const args = (server.start || []).map(String);
    const i = args.findIndex(a => a.toLowerCase() === '--config');
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  }

  /**
   * Файл, из которого сервер берёт параметры загрузки: `--config` его команды
   * запуска (у найденных автоматически — тот же ключ, абсолютным путём).
   * Относительный путь разрешается от cwd сервера — так его запускают вручную
   * (`--config strata-iq3_s.json` из папки модели). null = менять нечего.
   */
  contextFile(server) {
    const marker = server.killMarker || this.killMarker(server);
    if (!marker) return null;
    return path.isAbsolute(marker) ? marker : path.resolve(server.cwd || process.cwd(), marker);
  }

  /**
   * Текст конфига сервера — один раз на опрос: из него и контекст (что движок
   * получит при загрузке), и наличие файлов модели. null = файла/конфига нет.
   */
  async configText(server) {
    const file = this.contextFile(server);
    if (!file) return null;
    try {
      return { file, text: await fs.promises.readFile(file, 'utf8') };
    } catch {
      return null;
    }
  }

  /**
   * Новый размер контекста внешней локальной модели (Strata).
   *
   * Контекст — параметр ЗАГРУЗКИ, а не сессии: он пишется в `--max-context`
   * файла, из которого сервер стартует движок (см. src/engine-context.mjs), а
   * уже запущенный сервер продолжает работать со старым значением — новое
   * подхватывается при следующей загрузке. Об этом говорит `restartRequired`.
   */
  async setContext(id, context) {
    const server = this.find(id);
    if (!server) {
      throw failure('LOCAL_CONTEXT_UNSUPPORTED',
        `${id} — не внешний локальный сервер (Strata): у пресетов роутера llama.cpp контекст задаёт ctx-size в models.ini, и TaskBridge его не правит.`);
    }
    const file = this.contextFile(server);
    let written = null;
    if (file) {
      try {
        written = await writeContextFile(file, context);
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw failure('LOCAL_CONTEXT_UNSUPPORTED', `Файл ${file} не найден — контекст менять негде.`);
        }
        throw error;
      }
    }
    if (!written) {
      throw failure('LOCAL_CONTEXT_UNSUPPORTED',
        `${server.provider}: в ${file || 'команде запуска (нет --config)'} нет ${CONTEXT_FLAG} — вставьте его вручную, TaskBridge чужие args не переписывает.`);
    }
    // Статус кэширован на несколько секунд: без сброса панель показывала бы старое
    // число до следующего цикла опроса.
    this.cache = null;
    return {
      provider: server.provider,
      model: server.model || id,
      file,
      context: written.context,
      previous: written.previous,
      changed: written.changed,
      // Резидентная часть KV — факт из того же файла: новый контекст может быть
      // меньше неё, и решает это движок, а не TaskBridge.
      kvResident: written.resident,
      restartRequired: written.changed && await this.alive(server)
    };
  }

  /**
   * Everything that may identify the server's process in a command line: the
   * configured path and its file name. The name matters because a server
   * started by hand often carries a RELATIVE path (`--config strata-iq2_xs.json`
   * from the model's folder), and then the full path never appears — the dialog
   * said «выгружено», while the server kept answering /health.
   */
  processMarkers(server) {
    const full = server.killMarker || this.killMarker(server);
    if (!full) return [];
    const name = String(full).split(/[\\/]/u).pop();
    return name && name !== full ? [full, name] : [full];
  }

  async alive(server, timeoutMs = 1500) {
    const base = normalizeBaseUrl(server.baseUrl);
    if (!base) return false;
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * `/health` сервера вместе с контекстом, с которым движок реально поднялся:
   * Strata отдаёт его в `max_context` (`{"status":"ok","max_context":131072,...}`).
   * Это точнее файла конфига: движок мог ужать окно под память, а файл руками
   * правил кто-то другой. Нет поля — null, и вызывающий берёт файл.
   *
   * alive() для этого не годится: ему нужен только факт ответа, а здесь ещё число.
   */
  async health(server, timeoutMs = 1500) {
    const base = normalizeBaseUrl(server.baseUrl);
    if (!base) return { ok: false, maxContext: null };
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return { ok: false, maxContext: null };
      const payload = await response.json().catch(() => null);
      const value = Number(payload?.max_context ?? payload?.n_ctx);
      return { ok: true, maxContext: Number.isFinite(value) && value > 0 ? value : null };
    } catch {
      return { ok: false, maxContext: null };
    }
  }

  /**
   * Телеметрия внешнего сервера (Strata): /metrics как JSON. Недоступность,
   * таймаут или чужой формат — просто null: статус не должен ломаться из-за
   * отсутствия метрик.
   */
  async metrics(server, timeoutMs = 1500) {
    const base = normalizeBaseUrl(server.baseUrl);
    if (!base) return null;
    try {
      const response = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      return parseStrataMetrics(await response.json());
    } catch {
      return null;
    }
  }

  /**
   * The polled status (/api/info calls it every couple of seconds). Cached for
   * a few seconds; a start in progress always reads fresh, so the dialog never
   * pins «не загружена» while the model is being loaded.
   */
  status({ fresh = false } = {}) {
    if (!this.configured) return { configured: false, servers: [], models: [] };
    if (!fresh && !this.starting.size && this.cache && Date.now() - this.cacheAt < STATUS_CACHE_MS) return this.cache;
    const promise = Promise.all(this.servers.map(async server => {
      // Один /health вместо alive(): из него и «жив ли», и окно, с которым движок
      // поднялся. Запущенный движок — источник истины для числа, а файл конфига —
      // предсказание для выгруженного.
      const health = await this.health(server);
      const reachable = health.ok;
      const starting = this.starting.has(server.provider) && !reachable;
      // Телеметрия — только у живого сервера: у выгруженного и спрашивать нечего.
      const metrics = reachable ? await this.metrics(server).catch(() => null) : null;
      // Контекст и наличие файлов берём из файла самого сервера, а не из конфига
      // TaskBridge: контекст задан при загрузке и может быть только что изменён
      // через настройки, а веса могли удалить с диска — тогда строка обязана это
      // сказать, а не предлагать «Загрузить» то, чего нет. Конфиг TaskBridge
      // остаётся фолбэком для серверов, чей файл не прочитать.
      const config = await this.configText(server);
      const fromFile = config ? readEngineArg(config.text, CONTEXT_FLAG) : null;
      const missing = config ? await missingModelPaths(config.text, config.file) : null;
      const model = {
        // Listed even when the server is down: otherwise there would be
        // nothing to «Загрузить».
        id: server.model || server.provider,
        name: server.name || server.model || server.provider,
        provider: server.provider,
        status: reachable ? 'loaded' : starting ? 'loading' : 'unloaded',
        external: true,
        contextWindow: health.maxContext ?? fromFile ?? server.contextWindow ?? null,
        // Менять контекст можно там, где сервер берёт параметры загрузки из файла
        // с `--max-context` (Strata). У остальных строку контекста показываем, но
        // не редактируем: клиент по этому флагу и решает, что рисовать.
        contextEditable: fromFile !== null,
        // null — файлы не проверяются (конфиг чужой): клиент не показывает
        // ничего, а не выдумывает «всё на месте».
        filesPresent: missing === null ? null : missing.length === 0,
        missingFile: missing?.[0] ?? null,
        // Запись есть в config.json TaskBridge — её и можно убрать из списка.
        // Найденные автоматически принадлежат Pi (models.json): там их и удаляют.
        removable: server.discovered !== true
      };
      if (metrics) {
        model.metrics = metrics;
        model.phase = metrics.phase;
        model.promptRead = metrics.promptRead;
        model.promptTotal = metrics.promptTotal;
      }
      return {
        provider: server.provider,
        baseUrl: normalizeBaseUrl(server.baseUrl),
        reachable,
        // Router states are MANAGED_RUNNING/EXTERNAL_RUNNING/STOPPED; here the
        // dialog's badge needs the load state of the model itself.
        state: reachable ? 'EXTERNAL_RUNNING' : 'STOPPED',
        loading: starting,
        metrics,
        models: [model]
      };
    })).then(servers => {
      const value = {
        configured: true,
        servers: servers.map(({ provider, baseUrl, reachable, state, loading }) =>
          ({ provider, baseUrl, reachable, state, loading })),
        models: servers.flatMap(s => s.models)
      };
      this.cache = value;
      this.cacheAt = Date.now();
      return value;
    });
    return promise;
  }

  async start(server) {
    if (await this.alive(server)) return { provider: server.provider, status: 'loaded' };
    if (!Array.isArray(server.start) || !server.start.length) {
      throw failure('LOCAL_RUNTIME_NOT_MANAGED',
        `Для ${server.provider} не задана команда запуска (localRuntime.externalServers.start).`);
    }
    if (this.starting.has(server.provider)) {
      throw failure('LOCAL_LOAD_IN_PROGRESS', `${server.provider} уже запускается — дождитесь ready в окне модели.`);
    }
    this.starting.add(server.provider);
    try {
      // Started through the orphan launcher, never directly: `detached: true`
      // alone would still put the server in this process's tree, and the app's
      // own restart kills that tree with `taskkill /T` — taking a 4-minute
      // model load with it (the 2026-09-29 «Connection error.» in Pi's
      // compaction summary). The launcher is the only child here and it exits
      // at once; the server's own log (strata-<model>.log) is written by the
      // server itself, so nothing is lost to stdio:'ignore'.
      const proc = spawn(process.execPath, [
        ORPHAN_LAUNCHER,
        String(server.start[0]),
        server.cwd || '-',
        ...server.start.slice(1).map(String)
      ], {
        env: { ...process.env },
        windowsHide: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      // ENOENT/EACCES must not become an uncaught exception; the deadline loop
      // reads it instead of waiting for a close that never comes.
      let spawnError = null;
      proc.on('error', error => { spawnError = error; });
      proc.unref();
      // The launcher's stderr is the only place a bad start command says why.
      let launchError = '';
      proc.stderr?.on('data', chunk => { launchError += String(chunk); });
      const pid = await launcherPid(proc);
      // Tracked by pid, not by ChildProcess: the launcher is already gone, and
      // «Выгрузить» must kill the server itself.
      this.procs.set(server.provider, { proc: pid ? { pid } : proc, server });
      const loadTimeoutMs = Number(server.loadTimeoutMs) || 600000;
      const deadline = Date.now() + loadTimeoutMs;
      while (Date.now() < deadline) {
        if (spawnError) {
          throw failure('LOCAL_RUNTIME_FAILED', `Не удалось запустить ${server.provider}: ${spawnError.message}.`);
        }
        if (proc.exitCode != null && proc.exitCode !== 0) {
          // The launcher's stderr carries why the start command failed (ENOENT
          // on the server's interpreter, a bad --config) — the code stays the
          // one callers already map to a 400.
          const reason = launchError.trim().replace(/^orphan-launcher:\s*/u, '') || `код ${proc.exitCode}`;
          throw failure('LOCAL_LOAD_FAILED', `${server.provider} завершился: ${reason}.`);
        }
        if (await this.alive(server, 2000)) return { provider: server.provider, status: 'loaded' };
        await sleep(1000);
      }
      throw failure('LOCAL_LOAD_TIMEOUT',
        `Таймаут ожидания ${server.provider}: сервер не поднялся за ${Math.round(loadTimeoutMs / 1000)} c.`);
    } finally {
      this.starting.delete(server.provider);
    }
  }

  async stop(server) {
    let stopped = false;
    const tracked = this.procs.get(server.provider);
    if (tracked) {
      await killTree(tracked.proc).catch(() => {});
      this.procs.delete(server.provider);
      stopped = true;
    } else {
      // Started by hand (run-<model>.bat) or by a previous TaskBridge run: kill
      // only processes whose command line carries one of this server's markers
      // (its config path or file name) — a marker no unrelated process has.
      // One process list for all markers: the query costs a PowerShell start.
      const markers = this.processMarkers(server);
      if (!markers.length) {
        throw failure('LOCAL_RUNTIME_NOT_MANAGED',
          `Для ${server.provider} не задан маркер процесса (start с --config или killMarker).`);
      }
      const list = await listProcesses({ fresh: true });
      const pids = new Set();
      for (const marker of markers) {
        for (const item of (await processesUsingFile(marker, { list })) || []) pids.add(item.pid);
      }
      for (const pid of pids) {
        await killTree({ pid }).catch(() => {});
        stopped = true;
      }
    }
    let up = await this.alive(server, 1000);
    // Safety net: a wrapper (nohup, launcher) can hide the marker, or the killed
    // wrapper may leave the real listener alive. The owner of the configured
    // port is still our server — the config says which port it listens on.
    const port = portOf(server.baseUrl);
    if (up && port) {
      for (const pid of await pidsListeningOnPort(port)) {
        await killTree({ pid }).catch(() => {});
        stopped = true;
      }
      up = await this.alive(server, 1000);
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && up) {
      await sleep(300);
      up = await this.alive(server, 1000);
    }
    // Silent «выгружено» while the server keeps answering was the bug: say so.
    if (up) {
      throw failure('LOCAL_UNLOAD_FAILED',
        `${server.provider} всё ещё отвечает на ${server.baseUrl}/health${stopped ? ' — процесс не остановился' : ' — процесс не найден (маркеры: ' + this.processMarkers(server).join(', ') + ')'}.`);
    }
    return { provider: server.provider, status: 'unloaded' };
  }
}

/** Порт из baseUrl: 'http://127.0.0.1:8082' → 8082. null = не разобрать. */
export function portOf(baseUrl) {
  try {
    const port = new URL(String(baseUrl)).port;
    return port ? Number(port) : null;
  } catch {
    return null;
  }
}

/** PIDs listening on `port`, from `netstat -ano` output. Windows only: the
 *  project's local runtime is Windows-first, and the marker path is the
 *  primary one — this is the fallback. Pure so it can be tested. */
export function parseListeningPids(output, port) {
  const pids = new Set();
  const needle = `:${Number(port)}`;
  for (const line of String(output || '').split(/\r?\n/u)) {
    const parts = line.trim().split(/\s+/u);
    // Proto  Local Address  Foreign Address  State  PID
    if (parts.length < 5 || parts[0] !== 'TCP' || parts[3] !== 'LISTENING') continue;
    if (!parts[1].endsWith(needle)) continue;
    const pid = Number(parts[4]);
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}

async function pidsListeningOnPort(port) {
  if (process.platform !== 'win32') return [];
  const output = await new Promise(resolve => {
    execFile('netstat.exe', ['-ano'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? '' : String(stdout)));
  });
  return parseListeningPids(output, port);
}
