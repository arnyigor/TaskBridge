import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeModels, supportedThinkingLevels, providerThinkingValues, ModelCatalog } from '../src/model-catalog.mjs';

// A catalog that talks to the test fixture instead of the real `pi` command.
// PiRpcSession spawns with shell:true on Windows, so a direct node.exe path
// (spaces in "Program Files") breaks there — the same .cmd wrapper trick the
// other RPC tests use is required. args therefore stay empty: the wrapper
// forwards them and PiRpcSession appends --mode rpc itself.
async function fixtureCatalog(options = {}, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-catalog-test-'));
  const fixture = fileURLToPath(new URL('fake-pi.mjs', import.meta.url));
  const command = path.join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  await fs.writeFile(command, process.platform === 'win32'
    ? `@echo off
node "${fixture}" %*
`
    : `#!/bin/sh
exec node '${fixture}' "$@"
`, { mode: 0o755 });
  return new ModelCatalog({ pi: { command, args: [] }, cwd: root, ...config }, options);
}

test('normalizeModels projects Pi models to a safe, sorted shape', () => {
  const models = normalizeModels([
    { provider: 'ollama', id: 'glm-5', name: 'GLM 5', contextWindow: 200000, maxTokens: 8000, reasoning: true, tools: true, input: ['text'], cost: { input: 0.5, output: 2, cacheRead: 0.1 } },
    { provider: 'llamacpp', id: 'qwen', input: ['text', 'image'] },
    { provider: 'ollama', id: 'aaa' }
  ]);
  assert.deepEqual(models.map(m => `${m.provider}/${m.id}`), ['llamacpp/qwen', 'ollama/aaa', 'ollama/glm-5']);
  const glm = models.find(m => m.id === 'glm-5');
  assert.equal(glm.name, 'GLM 5');
  assert.equal(glm.contextWindow, 200000);
  assert.equal(glm.maxTokens, 8000);
  assert.equal(glm.reasoning, true);
  assert.equal(glm.images, false);
  assert.equal(glm.tools, true);
  assert.deepEqual(glm.cost, { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: null });
  const qwen = models.find(m => m.id === 'qwen');
  assert.equal(qwen.images, true);
  assert.equal(qwen.reasoning, false);
  assert.equal(qwen.contextWindow, null);
  assert.deepEqual(qwen.cost, { input: null, output: null, cacheRead: null, cacheWrite: null });
});

test('supportedThinkingLevels mirrors Pi: null excludes a level, xhigh/max need an entry', () => {
  // The configured local Strata models, verbatim from Pi's models.json.
  const strata = {
    provider: 'strata-iq3', id: 'qwen3.8-flash-next-iq3-xxs', reasoning: true,
    thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh', 'max*': null }
  };
  assert.deepEqual(supportedThinkingLevels(strata), ['off', 'low', 'medium', 'high', 'xhigh']);
  // «high» reaches the engine as «xhigh», and the wildcard «max*» is not «max».
  assert.deepEqual(providerThinkingValues(strata), { off: 'none', high: 'xhigh' });

  // No map at all: the plain levels, while xhigh/max stay unsupported.
  assert.deepEqual(supportedThinkingLevels({ provider: 'deepseek', id: 'deepseek-flash', reasoning: true }), ['off', 'minimal', 'low', 'medium', 'high']);
  // A model that cannot think takes one level, whatever its map says.
  assert.deepEqual(supportedThinkingLevels({ provider: 'p', id: 'plain', reasoning: false, thinkingLevelMap: { high: 'high' } }), ['off']);
  // Other real shapes: minimal → low, xhigh null, max allowed.
  const varied = { provider: 'p', id: 'z', reasoning: true, thinkingLevelMap: { minimal: 'low', xhigh: null, max: 'max' } };
  assert.deepEqual(supportedThinkingLevels(varied), ['off', 'minimal', 'low', 'medium', 'high', 'max']);
  assert.deepEqual(providerThinkingValues(varied), { minimal: 'low' });
  // Junk maps must not throw either.
  assert.deepEqual(supportedThinkingLevels({ provider: 'p', id: 'junk', reasoning: true, thinkingLevelMap: 'nonsense' }), ['off', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(supportedThinkingLevels(null), ['off']);
});

test('normalizeModels carries the per-model thinking map to the client', () => {
  const [model] = normalizeModels([{
    provider: 'strata-iq3', id: 'qwen3.8-flash-next-iq3-xxs', reasoning: true, input: ['text', 'image'],
    thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh', 'max*': null }
  }]);
  assert.deepEqual(model.thinkingLevels, ['off', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(model.thinkingMap, { off: 'none', high: 'xhigh' });
  // A model without a map still carries its levels, so the picker never falls
  // back to the catalogue-wide list by accident.
  const [plain] = normalizeModels([{ provider: 'p', id: 'nothink', reasoning: false }]);
  assert.deepEqual(plain.thinkingLevels, ['off']);
  assert.deepEqual(plain.thinkingMap, {});
});

test('normalizeModels tolerates junk and never throws', () => {
  assert.deepEqual(normalizeModels(null), []);
  assert.deepEqual(normalizeModels([null, {}, { id: '' }, { provider: 'p' }]), []);
  assert.equal(normalizeModels([{ provider: 'p', id: 'x', input: 'image' }])[0].images, false);
});

test('list() answers from the cache without a new probe while fresh', async () => {
  const catalog = await fixtureCatalog({ ttlMs: 60_000 });
  const first = await catalog.list();
  assert.ok(first.models.length >= 2);
  // A fresh cache must not start a background probe...
  const cached = await catalog.list();
  assert.equal(catalog.inFlight, null);
  assert.deepEqual(cached, first);
});

test('list() serves the stale catalog immediately and revalidates in the background', async () => {
  // ttlMs 0 → peek() considers any cache expired, the worst case for a picker
  // on a rarely-used client: without stale-while-revalidate this paid the full
  // Pi probe on every open.
  const catalog = await fixtureCatalog({ ttlMs: 0 });
  await catalog.list();
  const startedAt = Date.now();
  const stale = await catalog.list();
  assert.ok(Date.now() - startedAt < 1000, 'a stale hit must not wait for a probe');
  assert.ok(stale.models.length >= 2);
  // ...and the background revalidate refills the cache for the next caller.
  await catalog.inFlight.catch(() => {});
  assert.equal(catalog.inFlight, null);
  assert.ok(catalog.cache, 'the background probe refreshed the cache');
});

test('refresh=true always waits for a fresh probe, never the stale cache', async () => {
  const catalog = await fixtureCatalog({ ttlMs: 0 });
  await catalog.list();
  const pending = catalog.list({ refresh: true });
  assert.ok(catalog.inFlight, 'refresh starts its own probe');
  const fresh = await pending;
  assert.ok(fresh.models.length >= 2);
});

// models.json меняется кнопками страницы провайдеров, а кэш каталога — нет:
// без сброса убранная модель ещё TTL предлагается в выборе модели, а её выбор
// падает на следующем ходе (STAB-00, «обновление каталога после удаления»).
test('invalidate() drops the fresh cache so the next list() probes again', async () => {
  const catalog = await fixtureCatalog({ ttlMs: 60_000 });
  const first = await catalog.list();
  assert.ok(catalog.cache, 'cache filled');
  catalog.invalidate();
  assert.equal(catalog.cache, null);
  const again = await catalog.list({ refresh: true });
  assert.deepEqual(again.models.length, first.models.length, 'каталог собран заново, а не из кэша');
  assert.ok(catalog.cache.at > 0);
});

test('a probe started before invalidate() does not refill the cache', async () => {
  const catalog = await fixtureCatalog({ ttlMs: 60_000 });
  const pending = catalog.list({ refresh: true });
  catalog.invalidate();
  await pending; // ответ ещё устарел: его ещё ждали, но кэшировать его нельзя
  assert.equal(catalog.cache, null, 'результат старой пробы не попал в кэш');
});

// Полный сценарий STAB-00B: медленная проба уже идёт, models.json правится,
// приходит invalidate(), старая проба завершается. Кэш не должен «вылечиться»
// старым списком, а следующий запрос — описывать уже новый файл.
test('медленная проба, пережившая invalidate(), не возвращает старый каталог', async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-models-file-'));
  const modelsFile = path.join(workDir, 'models.json');
  const modelEntry = id => [{ provider: 'p', id, name: id, contextWindow: 8000, maxTokens: 512, input: ['text'] }];
  await fs.writeFile(modelsFile, JSON.stringify(modelEntry('old-model')), 'utf8');
  const marker = path.join(workDir, 'models-read.marker');
  const catalog = await fixtureCatalog({ ttlMs: 60_000 }, {
    env: { ...process.env, FAKE_PI_MODELS_FILE: modelsFile, FAKE_PI_MODELS_DELAY_MS: '600', FAKE_PI_MODELS_READ_MARKER: marker },
  });

  // 1. Проба, которая читает файл ДО правки, и заканчивается позже неё.
  const slow = catalog.list({ refresh: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await fs.access(marker).then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(await fs.readFile(marker, 'utf8'), '["old-model"]', 'проба прочитала прежний список');
  // 2. Файл меняется (модель убрана из записи провайдера).
  await fs.writeFile(modelsFile, JSON.stringify(modelEntry('new-model')), 'utf8');
  // 3. Правка провайдера сбрасывает кэш.
  catalog.invalidate();
  // 4–5. Старая проба досчитывается; её ответ ещё ждут, но в кэш он не идёт.
  const stale = await slow;
  assert.deepEqual(stale.models.map(m => m.id), ['old-model'], 'вызывающий получил то, что успела прочитать проба');
  assert.equal(catalog.cache, null, 'кэш не заполнен устаревшим списком');
  // 6. Следующий запрос собирает каталог заново — уже по новому models.json.
  const fresh = await catalog.list();
  assert.deepEqual(fresh.models.map(m => m.id), ['new-model'], 'каталог описывает изменённый файл');
  assert.ok(catalog.cache, 'свежая проба закэширована');
  assert.notEqual(stale, fresh, 'старый и новый ответы — разные объекты');
});
