import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LocalModelService, normalizeModels, parseLoadProgress, parsePrometheusMetrics, quantFromPath } from '../src/local-models.mjs';

test('parseLoadProgress mirrors llama.cpp /models/sse load events', () => {
  assert.equal(parseLoadProgress({ status: 'loading' }), null);
  assert.equal(parseLoadProgress({ progress: {} }).message, 'Загрузка модели');
  const staged = parseLoadProgress({ progress: { current: 'loading_tensors', stages: ['loading_tensors', 'warming_up'], value: 0.5 } });
  assert.equal(staged.message, 'Загрузка: loading tensors');
  assert.equal(staged.ratio, 0.25); // stage 0 of 2 + half of it
  assert.equal(parseLoadProgress({ progress: { current: 'x', value: 4 } }).ratio, 1);
});

test('normalizeModels distinguishes a router catalog from a single-model endpoint', () => {
  assert.equal(normalizeModels({ models: [{ name: 'qwen' }] }), null);
  assert.equal(normalizeModels(null), null);
  const models = normalizeModels({
    data: [
      { id: 'vision', status: { value: 'loaded' }, architecture: { input_modalities: ['text', 'image'] }, meta: { n_ctx: 33792 } },
      { id: 'text', status: { value: 'unloaded' }, architecture: { input_modalities: ['text'] }, meta: { n_ctx_train: 65536 } },
      { id: 'bad', status: { value: 'failed', failed: true, exit_code: 3 } }
    ]
  });
  assert.deepEqual(models.map(m => [m.id, m.status, m.vision]), [['vision', 'loaded', true], ['text', 'unloaded', false], ['bad', 'failed', false]]);
  assert.equal(models[0].contextWindow, 33792);
  assert.equal(models[1].contextWindow, 65536);
  assert.equal(models[2].failed, true);
  assert.equal(models[2].exitCode, 3);
});

test('normalizeModels derives quantization and configured ctx from child args', () => {
  const models = normalizeModels({
    data: [
      { id: 'q3', status: { value: 'unloaded', args: ['--model', 'G:\\m\\Qwen3.8-27B-UD-Q3_K_XL.gguf', '--ctx-size', '56320'] } },
      { id: 'iq4v', status: { value: 'unloaded', args: ['--model', 'G:\\m\\Qwen3.8-27B-UD-IQ4_XS.gguf', '--ctx-size', '33792', '--mmproj', 'G:\\m\\mmproj.gguf'] } }
    ]
  });
  assert.equal(models[0].quant, 'Q3_K_XL');
  assert.equal(models[0].contextWindow, 56320);
  assert.equal(models[0].vision, false);
  assert.equal(models[1].quant, 'IQ4_XS');
  assert.equal(models[1].contextWindow, 33792);
  assert.equal(models[1].vision, true); // inferred from --mmproj even without architecture
  assert.equal(quantFromPath('G:\\m\\Qwen3.8-27B-UD-IQ4_XS.gguf'), 'IQ4_XS');
  assert.equal(quantFromPath(null), null);
});

// Minimal llama.cpp router stand-in: enough of /models, /models/load,
// /models/unload and /models/sse to exercise LocalModelService end to end.
async function fakeRouter(t, models) {
  const status = new Map(models.map(m => [m.id, { value: 'unloaded', vision: m.vision === true, ctx: m.ctx ?? null }]));
  const slotsCalls = [];
  const processing = new Map();
  const clients = new Set();
  const broadcast = event => { for (const res of clients) { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {} } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return res.end(JSON.stringify({ status: 'ok' }));
    if (req.method === 'GET' && url.pathname === '/models') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        data: [...status.entries()].map(([id, s]) => ({
          id,
          status: { value: s.value },
          architecture: { input_modalities: s.vision ? ['text', 'image'] : ['text'] },
          meta: { n_ctx: s.ctx }
        }))
      }));
    }
    // Mirrors the router: /slots needs an explicit ?model= and autoloads an
    // unloaded one (which is exactly what getBusyStatus must avoid).
    if (req.method === 'GET' && url.pathname === '/slots') {
      const id = url.searchParams.get('model');
      slotsCalls.push(id);
      const entry = id ? status.get(id) : null;
      if (!entry) { res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 400, message: 'model name is missing from the request' } })); }
      if (entry.value === 'unloaded') entry.value = 'loaded';
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify([{ id: 0, n_ctx: entry.ctx, is_processing: processing.get(id) === true }]));
    }
    if (req.method === 'GET' && url.pathname === '/models/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ready\n\n');
      clients.add(res);
      res.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/models/load' || url.pathname === '/models/unload')) {
      const body = JSON.parse(await new Promise(resolve => { let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d || '{}')); }));
      const entry = status.get(body.model);
      if (!entry) { res.statusCode = 404; return res.end('{}'); }
      if (url.pathname === '/models/load') {
        entry.value = 'loading';
        broadcast({ model: body.model, event: 'model_status', data: { status: 'loading' } });
        let tick = 0;
        const timer = setInterval(() => {
          tick += 1;
          if (tick >= 4) {
            clearInterval(timer);
            entry.value = 'loaded';
            broadcast({ model: body.model, event: 'model_status', data: { status: 'loaded' } });
            return;
          }
          broadcast({ model: body.model, event: 'model_status', data: { status: 'loading', progress: { current: 'loading_tensors', stages: ['loading_tensors', 'warming_up'], value: tick / 4 } } });
        }, 200);
      } else {
        entry.value = 'unloaded';
        broadcast({ model: body.model, event: 'model_status', data: { status: 'unloaded' } });
      }
      return res.end(JSON.stringify({ success: true }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    // Long-lived /models/sse sockets keep the process alive; drop them on teardown.
    server.closeAllConnections?.();
    return new Promise(resolve => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, status, slotsCalls, processing };
}

test('LocalModelService lists, loads with progress, unloads and reports status', async t => {
  const router = await fakeRouter(t, [{ id: 'vision', vision: true, ctx: 33792 }, { id: 'text', vision: false, ctx: 65536 }]);
  const service = new LocalModelService({ provider: 'llama.cpp', healthUrl: `${router.baseUrl}/health` }, t.name);

  assert.equal(service.enabled, false); // no router.command → not managed
  // healthUrl alone is enough to talk to an external router.
  assert.equal(await service.isReady(), true);

  const listed = await service.listModels();
  assert.deepEqual(listed.map(m => m.id), ['vision', 'text']);
  assert.equal(listed[0].vision, true);

  const progress = [];
  service.startWatching();
  const loaded = await service.loadModel('vision', { onProgress: event => progress.push(event) });
  assert.equal(loaded.status, 'loaded');
  assert.ok(progress.some(p => p.ratio != null), JSON.stringify(progress));
  assert.equal(service.activeProfileId, 'vision');

  const status = await service.getStatus();
  assert.equal(status.state, 'EXTERNAL_RUNNING');
  assert.deepEqual(status.loaded, ['vision']);
  assert.equal(status.reachable, true);

  await service.unloadModel('vision');
  assert.deepEqual((await service.getStatus()).loaded, []);
  service.stopWatching();
});

test('LocalModelService reports a loaded router model as busy only while it generates', async t => {
  const router = await fakeRouter(t, [{ id: 'text', ctx: 65536 }, { id: 'vision', vision: true }]);
  const service = new LocalModelService({ provider: 'llama.cpp', healthUrl: `${router.baseUrl}/health` }, t.name);

  // Nothing loaded: idle, and no /slots probe is sent — that would autoload.
  assert.deepEqual(await service.getBusyStatus(), { unknown: false, busy: false, loaded: false });
  assert.deepEqual(router.slotsCalls, []);

  await service.loadModel('text');
  assert.deepEqual(await service.getBusyStatus(), { unknown: false, busy: false, loaded: true });
  assert.deepEqual(router.slotsCalls, ['text']);

  router.processing.set('text', true);
  assert.deepEqual(await service.getBusyStatus(), { unknown: false, busy: true, loaded: true });
  assert.deepEqual(router.slotsCalls, ['text', 'text']);

  router.processing.set('text', false);
  assert.deepEqual(await service.getBusyStatus(), { unknown: false, busy: false, loaded: true });
  service.stopWatching();
});

test('LocalModelService reports unknown busy when the router is unreachable', async t => {
  const service = new LocalModelService({ provider: 'llama.cpp', healthUrl: 'http://127.0.0.1:1/health' }, t.name);
  assert.deepEqual(await service.getBusyStatus(), { unknown: true, busy: false, loaded: null });
});

test('LocalModelService only stops a router it started by itself', async t => {
  const router = await fakeRouter(t, [{ id: 'a' }]);
  const service = new LocalModelService({ healthUrl: `${router.baseUrl}/health` }, t.name);
  await assert.rejects(service.stop(), { code: 'LOCAL_RUNTIME_NOT_MANAGED' });
});

test('parsePrometheusMetrics derives PP/TG from cumulative counters when gauges are stuck at 0', () => {
  const text = [
    'llamacpp:prompt_tokens_seconds 0',
    'llamacpp:predicted_tokens_seconds 0',
    'llamacpp:prompt_tokens_total 14668',
    'llamacpp:prompt_seconds_total 102.096',
    'llamacpp:tokens_predicted_total 334',
    'llamacpp:tokens_predicted_seconds_total 7.47526'
  ].join('\n');
  const { pp, tg } = parsePrometheusMetrics(text, 'counters-test');
  assert.ok(pp > 140 && pp < 145, `pp ${pp}`);
  assert.ok(tg > 44 && tg < 45, `tg ${tg}`);
});

test('parsePrometheusMetrics keeps only the llama.cpp PP/TG gauges', () => {
  const text = [
    '# HELP llamacpp:prompt_tokens_seconds Average prompt throughput in tokens/s',
    '# TYPE llamacpp:prompt_tokens_seconds gauge',
    'llamacpp:prompt_tokens_seconds 118.5',
    '# TYPE llamacpp:predicted_tokens_seconds gauge',
    'llamacpp:predicted_tokens_seconds 42.25',
    'llamacpp:requests_processing 1',
    'llamacpp:requests_deferred 0',
    'llamacpp:prompt_tokens_total 5000',
    ''
  ].join('\n');
  assert.deepEqual(parsePrometheusMetrics(text), { pp: 118.5, tg: 42.25, requestsProcessing: 1, requestsDeferred: 0 });
  // Missing gauges stay null — a zero would read as "the model is frozen".
  assert.deepEqual(parsePrometheusMetrics('llamacpp:prompt_tokens_total 1\n'), {
    pp: null, tg: null, requestsProcessing: null, requestsDeferred: null
  });
});

// Router stand-in that only answers /health, /models and /metrics; `metrics`
// null means the child was started without --metrics (llama.cpp answers 501).
async function metricsRouter(t, { metrics = '' } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return res.end(JSON.stringify({ status: 'ok' }));
    if (url.pathname === '/models') return res.end(JSON.stringify({ data: [{ id: 'm1', status: { value: 'loaded' } }] }));
    if (url.pathname === '/metrics') {
      if (!url.searchParams.get('model')) { res.statusCode = 400; return res.end('{}'); }
      if (metrics === null) { res.statusCode = 501; return res.end(JSON.stringify({ error: { message: 'This server does not support metrics endpoint. Start it with `--metrics`' } })); }
      res.setHeader('content-type', 'text/plain');
      return res.end(metrics);
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('LocalModelService exposes PP/TG for the loaded model from /metrics', async t => {
  const base = await metricsRouter(t, { metrics: 'llamacpp:prompt_tokens_seconds 118.5\nllamacpp:predicted_tokens_seconds 42.25\n' });
  const service = new LocalModelService({ provider: 'llama.cpp', router: { enabled: true }, healthUrl: `${base}/health` }, t.name);
  assert.deepEqual(await service.getMetrics(), {
    available: true, source: 'llama.cpp', model: 'm1', pp: 118.5, tg: 42.25, requestsProcessing: null, requestsDeferred: null
  });
});

test('LocalModelService says metrics are unavailable without --metrics', async t => {
  const base = await metricsRouter(t, { metrics: null });
  const service = new LocalModelService({ provider: 'llama.cpp', router: { enabled: true }, healthUrl: `${base}/health` }, t.name);
  assert.deepEqual(await service.getMetrics(), { available: false, reason: 'metrics-disabled', model: 'm1' });
});

test('LocalModelService refuses to load when the server is not a router catalog', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/models') return res.end(JSON.stringify({ models: [{ name: 'single' }] }));
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const service = new LocalModelService({ healthUrl: `http://127.0.0.1:${server.address().port}/health` }, t.name);
  await assert.rejects(service.listModels(), { code: 'LOCAL_NOT_ROUTER' });
});
