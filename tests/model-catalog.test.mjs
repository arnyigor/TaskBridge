import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeModels, ModelCatalog } from '../src/model-catalog.mjs';

// A catalog that talks to the test fixture instead of the real `pi` command.
// PiRpcSession spawns with shell:true on Windows, so a direct node.exe path
// (spaces in "Program Files") breaks there — the same .cmd wrapper trick the
// other RPC tests use is required. args therefore stay empty: the wrapper
// forwards them and PiRpcSession appends --mode rpc itself.
async function fixtureCatalog(options = {}) {
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
  return new ModelCatalog({ pi: { command, args: [] }, cwd: root }, options);
}

test('normalizeModels projects Pi models to a safe, sorted shape', () => {
  const models = normalizeModels([
    { provider: 'ollama', id: 'glm-5', name: 'GLM 5', contextWindow: 200000, maxTokens: 8000, reasoning: true, input: ['text'] },
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
  const qwen = models.find(m => m.id === 'qwen');
  assert.equal(qwen.images, true);
  assert.equal(qwen.reasoning, false);
  assert.equal(qwen.contextWindow, null);
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
