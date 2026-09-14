import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (code, message) => Object.assign(new Error(message), { code });

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
      const modelPath = argValue(args, '--model') || model.path || null;
      const ctxArg = Number(argValue(args, '--ctx-size'));
      const contextWindow = Number.isFinite(model.meta?.n_ctx) ? model.meta.n_ctx
        : (Number.isFinite(model.meta?.n_ctx_train) ? model.meta.n_ctx_train
          : (Number.isFinite(ctxArg) ? ctxArg : null));
      return {
        id: model.id,
        name: typeof model.name === 'string' && model.name ? model.name : model.id,
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
// `modelKey` scopes the instant-rate delta state per model/server.
const prevMetricSample = new Map();

export function parsePrometheusMetrics(text, modelKey = '') {
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
    const prev = prevMetricSample.get(modelKey);
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
    prevMetricSample.set(modelKey, { at: Date.now(), c: counters });
  }
  if (pp === null) pp = pick('llamacpp:prompt_tokens_seconds');
  if (tg === null) tg = pick('llamacpp:predicted_tokens_seconds');
  return {
    pp,
    tg,
    requestsProcessing: pick('llamacpp:requests_processing'),
    requestsDeferred: pick('llamacpp:requests_deferred')
  };
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
    return normalizeBaseUrl(this.config.router?.baseUrl)
      || normalizeBaseUrl(String(this.config.healthUrl || '').replace(/\/health$/iu, ''))
      || 'http://127.0.0.1:8080';
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
    // instead of blocking the request on loading one.
    const loaded = models.filter(m => m.status === 'loaded' || m.status === 'sleeping');
    if (!loaded.length) return { unknown: false, busy: false, loaded: false };
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
      contextWindow: loaded[0]?.contextWindow ?? null,
      loaded: loaded.map(m => m.id),
      slots: null,
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
      const parsed = parsePrometheusMetrics(await response.text(), model.id);
      return { available: true, source: 'llama.cpp', model: model.id, ...parsed };
    }
    return { available: false, reason: 'unreachable' };
  }

  async getStatus() {
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
    const already = (await this.listModels().catch(() => [])).find(m => m.id === id);
    if (already && (already.status === 'loaded' || already.status === 'sleeping')) {
      this.activeProfileId = id;
      return already;
    }
    this.startWatching();
    const onProg = event => { if (!event.model || event.model === id) onProgress?.(event); };
    this.on('progress', onProg);
    try {
      await this.request('/models/load', { method: 'POST', body: { model: id }, timeout: 30000, signal });
      const deadline = Date.now() + (this.management.loadTimeoutMs || 900000);
      while (true) {
        if (signal?.aborted) throw failure('LOCAL_LOAD_CANCELLED', 'Загрузка отменена.');
        const entry = (await this.listModels().catch(() => [])).find(m => m.id === id);
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
