import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ProbeCooldown, probeAvailability, probeLatency, providerCheckStatus, streamError } from '../src/model-probe.mjs';
import { startFixture } from './server-fixture.mjs';

// Пункт §3.3 плана (запрос оператора 2026-10-14): кнопка проверки модели. Проверка
// обязана быть короткой и не жечь токены: доступность — бесплатный round-trip к списку
// моделей, задержка — один запрос с max_tokens=1 и обрывом сразу после первого чанка.

/** Заглушка провайдера: список моделей и стрим с настраиваемой задержкой и ответом. */
async function providerStub({ delayMs = 120, streamErrorPayload = null, streamChunks = null, status = 200, onRequest = null } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      requests.push({ url: req.url, method: req.method, body, headers: req.headers });
      await onRequest?.();
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"nope"}}');
        return;
      }
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stub-model' }, { id: 'stub-model-2' }] }));
        return;
      }
      if (req.url.endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (streamChunks) {
          for (const chunk of streamChunks) setTimeout(() => res.write(chunk.text), chunk.delayMs);
        } else {
          setTimeout(() => {
            if (streamErrorPayload) res.write(`data: ${JSON.stringify({ error: streamErrorPayload })}\n\n`);
            else res.write('data: {"choices":[{"delta":{"content":"p"}}]}\n\n');
          }, delayMs);
        }
        // Поток намеренно не закрываем: проба обязана оборвать его сама.
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise(r => server.close(r)) };
}

test('availability costs nothing: one models round-trip, tokensUsed 0', async t => {
  const stub = await providerStub();
  t.after(() => stub.close());
  const result = await probeAvailability({ baseUrl: stub.base });
  assert.equal(result.ok, true);
  assert.equal(result.tokensUsed, 0, 'токены не тратятся');
  assert.equal(result.models, 2, 'провайдер отдал две модели');
  assert.equal(stub.requests.filter(request => request.url.endsWith('/chat/completions')).length, 0, 'к модели не обращались');
});

test('latency measures from the request start and aborts the stream itself', async t => {
  const stub = await providerStub({ delayMs: 150 });
  t.after(() => stub.close());
  const result = await probeLatency({ baseUrl: stub.base, id: 'stub-model' });
  assert.equal(result.ok, true);
  assert.equal(result.tokensUsed, 1, 'потрачен ровно один токен — и это видно');
  // TTFT считается от начала запроса: при замере от заголовков было бы ~0 мс.
  assert.ok(result.ms >= 140 && result.ms < 2000, `замер от начала запроса: ${result.ms} мс`);
  const body = JSON.parse(stub.requests.at(-1).body);
  assert.equal(body.max_tokens, 1, 'не больше одного токена');
  assert.equal(body.stream, true);
});

test('latency ignores SSE comments and role-only deltas until a real token', async t => {
  const stub = await providerStub({ streamChunks: [
    { delayMs: 10, text: ': keepalive\n\n' },
    { delayMs: 20, text: 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' },
    { delayMs: 140, text: 'data: {"choices":[{"delta":{"content":"p"}}]}\n\n' },
  ] });
  t.after(() => stub.close());
  const result = await probeLatency({ baseUrl: stub.base, id: 'stub-model' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.ms >= 125, `TTFT должен ждать токен, а не первый чанк: ${result.ms} мс`);
});

test('a provider error split across network chunks is not reported as success', async t => {
  const stub = await providerStub({ streamChunks: [
    { delayMs: 10, text: 'data: {"error":{"message":"model ' },
    { delayMs: 40, text: 'is loading"}}\n\n' },
  ] });
  t.after(() => stub.close());
  const result = await probeLatency({ baseUrl: stub.base, id: 'stub-model' });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'PROVIDER_ERROR');
  assert.match(result.message, /model is loading/);
});

test('every failure has its own code instead of a fake number', async t => {
  const missing = await providerStub({ status: 404 });
  t.after(() => missing.close());
  assert.equal((await probeLatency({ baseUrl: missing.base, id: 'нет' })).code, 'MODEL_NOT_FOUND');

  const unauthorized = await providerStub({ status: 401 });
  t.after(() => unauthorized.close());
  assert.equal((await probeAvailability({ baseUrl: unauthorized.base })).code, 'AUTH');
  assert.equal((await probeLatency({ baseUrl: unauthorized.base, id: 'x' })).code, 'AUTH');

  // Провайдер ответил 200 и положил ошибку ВНУТРЬ потока: «модель отвечает» показывать нельзя.
  const inStream = await providerStub({ streamErrorPayload: { message: 'model is loading', type: 'unavailable' } });
  t.after(() => inStream.close());
  const broken = await probeLatency({ baseUrl: inStream.base, id: 'x' });
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'PROVIDER_ERROR');
  assert.match(broken.message, /model is loading/);

  // Недоступный адрес — не таймаут и не «ок».
  const unreachable = await probeAvailability({ baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 700 });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.code, 'UNREACHABLE');
  assert.equal(unreachable.tokensUsed, 0);
});

test('streamError sees only real provider errors', () => {
  assert.equal(streamError('data: {"choices":[{"delta":{"content":"п"}}]}'), null);
  assert.equal(streamError('data: [DONE]'), null);
  assert.match(streamError('data: {"error":{"message":"quota"}}'), /quota/);
});

test('the cooldown is per model and counts down', () => {
  let now = 1_000_000;
  const cooldown = new ProbeCooldown({ cooldownMs: 5000, now: () => now });
  assert.equal(cooldown.remaining('a/b'), 0);
  cooldown.mark('a/b');
  assert.equal(cooldown.remaining('a/b'), 5000);
  now += 2000;
  assert.equal(cooldown.remaining('a/b'), 3000);
  assert.equal(cooldown.remaining('c/d'), 0, 'другая модель не затронута');
  now += 4000;
  assert.equal(cooldown.remaining('a/b'), 0, 'кулдаун истёк');
});

test('local probes use each external server address and the router key', { timeout: 60000 }, async t => {
  const router = await providerStub();
  // A heartbeat/status request may reach the router while the external probe
  // is in flight. Force that interleaving instead of depending on runner speed.
  const external = await providerStub({ onRequest: async () => {
    const response = await fetch(`${router.base}/health`);
    await response.arrayBuffer();
  } });
  t.after(() => external.close());
  t.after(() => router.close());
  const fixture = await startFixture(undefined, { root: { localRuntime: {
    provider: 'local-router',
    router: { enabled: true, baseUrl: router.base, apiKey: 'router-secret' },
    externalServers: [{ provider: 'strata-test', model: 'stub-model', baseUrl: external.base }],
  } } });
  t.after(() => fixture.close());

  const externalResult = await fixture.api('/api/models/probe', { provider: 'strata-test', id: 'stub-model', mode: 'latency' });
  assert.equal(externalResult.ok, true, JSON.stringify(externalResult));
  const externalCalls = external.requests.filter(request => request.url.endsWith('/chat/completions'));
  assert.equal(externalCalls.length, 1, 'внешняя модель проверяется на своём port');
  assert.equal(JSON.parse(externalCalls[0].body).model, 'stub-model');
  assert.equal(router.requests.filter(request => request.url.endsWith('/chat/completions')).length, 0, 'внешняя модель не должна попадать в router');
  assert.ok(router.requests.some(request => request.url.endsWith('/health')), 'фоновый запрос намеренно совпал с пробой');

  const routerResult = await fixture.api('/api/models/probe', { provider: 'local-router', id: 'router-model' });
  assert.equal(routerResult.ok, true, JSON.stringify(routerResult));
  assert.equal(router.requests.filter(request => request.url.endsWith('/models')).at(-1)?.headers?.authorization, 'Bearer router-secret');
});

test('the endpoint checks a real provider and reports its own refusals', { timeout: 60000 }, async t => {
  const stub = await providerStub({ delayMs: 80 });
  t.after(() => stub.close());
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-probe-agent-'));
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }).catch(() => {}));
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      stub: { api: 'openai-completions', baseUrl: stub.base, apiKey: '$STUB_KEY', models: [{ id: 'stub-model' }, { id: 'stub-model-2' }] },
      keyless: { api: 'openai-completions', baseUrl: 'https://example.invalid/v1', models: [{ id: 'other' }] },
    },
  }), 'utf8');

  const fixture = await startFixture(undefined, { env: { PI_AGENT_DIR: agentDir, STUB_KEY: 'test-key' } });
  t.after(() => fixture.close());
  const { api } = fixture;

  const availability = await api('/api/models/probe', { provider: 'stub', id: 'stub-model' });
  assert.equal(availability.mode, 'availability');
  assert.equal(availability.ok, true, JSON.stringify(availability));
  assert.equal(availability.tokensUsed, 0);

  // Кулдаун один на модель, поэтому задержку проверяем у второй модели того же
  // провайдера: так и кулдаун проверяется отдельно, и оба режима видны.
  const latency = await api('/api/models/probe', { provider: 'stub', id: 'stub-model-2', mode: 'latency' });
  assert.equal(latency.ok, true, JSON.stringify(latency));
  assert.equal(latency.tokensUsed, 1);
  assert.ok(latency.ms >= 70, `TTFT: ${latency.ms} мс`);
  // Ключ провайдера ушёл в заголовке — без него провайдер отвечает отказом.
  assert.ok(stub.requests.length >= 2);

  // Повторное нажатие сразу — кулдаун, а не второй запрос к провайдеру.
  const again = await api('/api/models/probe', { provider: 'stub', id: 'stub-model-2', mode: 'latency' });
  assert.equal(again.code, 'COOLDOWN');
  // И у той модели, что уже проверялась на доступность, тоже действует кулдаун.
  assert.equal((await api('/api/models/probe', { provider: 'stub', id: 'stub-model' })).code, 'COOLDOWN');
  assert.ok(again.retryInMs > 0);

  // Внятные отказы вместо пустоты.
  const noKey = await api('/api/models/probe', { provider: 'keyless', id: 'other' });
  assert.equal(noKey.code, 'NO_KEY', JSON.stringify(noKey));
  const unknownModel = await api('/api/models/probe', { provider: 'stub', id: 'нет-такой' });
  assert.equal(unknownModel.code, 'MODEL_UNKNOWN');
  const unknownProvider = await api('/api/models/probe', { provider: 'нет', id: 'x' });
  assert.equal(unknownProvider.code, 'NO_ENDPOINT');
  await assert.rejects(api('/api/models/probe', { provider: 'stub' }), { code: 'INPUT_INVALID' });
  await assert.rejects(api('/api/models/probe', { provider: 'stub', id: 'stub-model', mode: 'чепуха' }), { code: 'INPUT_INVALID' });
});

test('providerCheckStatus: один HTTP-ответ даёт один статус контракта', () => {
  // Контракт из аудита TB-PROV-01: AVAILABLE/UNAUTHORIZED/RATE_LIMITED/TIMEOUT/
  // UNREACHABLE/UNSUPPORTED/UNKNOWN — иначе UI не сможет сказать, что делать.
  assert.equal(providerCheckStatus({ ok: true, httpStatus: 200 }), 'AVAILABLE');
  assert.equal(providerCheckStatus({ ok: false, httpStatus: 401 }), 'UNAUTHORIZED');
  assert.equal(providerCheckStatus({ ok: false, httpStatus: 403 }), 'UNAUTHORIZED');
  assert.equal(providerCheckStatus({ ok: false, httpStatus: 429 }), 'RATE_LIMITED');
  assert.equal(providerCheckStatus({ ok: false, httpStatus: 404 }), 'UNSUPPORTED', 'нет /models — не «сломано»');
  assert.equal(providerCheckStatus({ ok: false, code: 'AUTH' }), 'UNAUTHORIZED');
  assert.equal(providerCheckStatus({ ok: false, code: 'NO_KEY' }), 'UNAUTHORIZED');
  assert.equal(providerCheckStatus({ ok: false, code: 'TIMEOUT' }), 'TIMEOUT');
  assert.equal(providerCheckStatus({ ok: false, code: 'UNREACHABLE' }), 'UNREACHABLE');
  assert.equal(providerCheckStatus({ ok: false, code: 'NO_ENDPOINT' }), 'UNSUPPORTED');
  assert.equal(providerCheckStatus({ ok: false, code: 'MODEL_UNKNOWN' }), 'UNSUPPORTED');
  assert.equal(providerCheckStatus({ ok: false, httpStatus: 500, code: 'HTTP_ERROR' }), 'UNKNOWN', '5xx не выдаёт вердикт');
  assert.equal(providerCheckStatus({}), 'UNKNOWN');
});

test('POST /api/providers/check: проверка неуправляемого провайдера по контракту', { timeout: 90000 }, async t => {
  const ok = await providerStub();
  const denied = await providerStub({ status: 401 });
  const limited = await providerStub({ status: 429 });
  t.after(() => Promise.all([ok.close(), denied.close(), limited.close()]));
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-check-agent-'));
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }).catch(() => {}));
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      stub: { api: 'openai-completions', baseUrl: ok.base, apiKey: '$STUB_KEY', models: [{ id: 'stub-model' }] },
      denied: { api: 'openai-completions', baseUrl: denied.base, apiKey: '$STUB_KEY', models: [{ id: 'stub-model' }] },
      limited: { api: 'openai-completions', baseUrl: limited.base, apiKey: '$STUB_KEY', models: [{ id: 'stub-model' }] },
      // Внешний адрес без ключа: проверка обязана отказать до сети.
      keyless: { api: 'openai-completions', baseUrl: 'https://example.invalid/v1', models: [{ id: 'other' }] },
    },
  }), 'utf8');

  const fixture = await startFixture(undefined, { env: { PI_AGENT_DIR: agentDir, STUB_KEY: 'test-key' } });
  t.after(() => fixture.close());
  const { api } = fixture;

  const available = await api('/api/providers/check', { provider: 'stub' });
  assert.equal(available.status, 'AVAILABLE', JSON.stringify(available));
  assert.equal(available.ok, true);
  assert.equal(available.provider, 'stub');
  assert.ok(Number.isFinite(available.latencyMs), 'задержка измерена');
  assert.equal(available.models, 2);
  assert.ok(available.checkedAt, 'время проверки есть');
  assert.equal(ok.requests.filter(request => request.url.endsWith('/chat/completions')).length, 0, 'токены не тратились');
  assert.ok(ok.requests.every(request => request.url.endsWith('/models')), 'только список моделей');

  assert.equal((await api('/api/providers/check', { provider: 'denied' })).status, 'UNAUTHORIZED');
  assert.equal((await api('/api/providers/check', { provider: 'limited' })).status, 'RATE_LIMITED');

  const keyless = await api('/api/providers/check', { provider: 'keyless' });
  assert.equal(keyless.status, 'UNAUTHORIZED', JSON.stringify(keyless));
  assert.equal(keyless.code, 'NO_KEY');

  // Провайдера нет в каталоге Pi — это не поломка, а «так проверить нельзя».
  const unknown = await api('/api/providers/check', { provider: 'nobody-here' });
  assert.equal(unknown.status, 'UNSUPPORTED', JSON.stringify(unknown));

  // Без provider — понятная ошибка, а не пустая проверка.
  await assert.rejects(api('/api/providers/check', {}), error => error.code === 'INPUT_INVALID');

  // Повторная проверка того же провайдера — кулдаун, а не второй запрос.
  const again = await api('/api/providers/check', { provider: 'stub' });
  assert.equal(again.status, 'UNKNOWN');
  assert.equal(again.code, 'COOLDOWN');
  assert.equal(ok.requests.length, 1, 'провайдеру не отправляли второй запрос');
});
