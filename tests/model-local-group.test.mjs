import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { localProviderIds } from '../src/dispatcher.mjs';

// The picker groups local models under one heading. Which provider ids are local
// is a server fact (localRuntime.provider + externalServers), so the client never
// has to guess it from a name.
test('localProviderIds covers both llama.cpp ids, the configured provider and external servers', () => {
  const ids = localProviderIds({ provider: 'my-llama' }, [{ provider: 'strata-iq3' }, { model: 'no-provider' }]);
  assert.deepEqual([...ids].sort(), ['llama.cpp', 'llamacpp', 'my-llama', 'strata-iq3']);
});

test('localProviderIds tolerates a missing localRuntime and junk servers', () => {
  assert.deepEqual([...localProviderIds()].sort(), ['llama.cpp', 'llamacpp']);
  assert.deepEqual([...localProviderIds({}, [null, {}, { provider: '' }])].sort(), ['llama.cpp', 'llamacpp']);
});

async function managerWithCatalog(t, localRuntime, models) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-local-group-test-'));
  const store = new TaskStore(root);
  const manager = new TaskManager({ localRuntime }, root, store);
  t.after(async () => {
    await manager.close().catch(() => {});
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  // The Pi probe is not what this test is about: the catalog is stubbed, the
  // grouping decision (listModels) is the real code under test.
  manager.modelCatalog.list = async () => ({ models, thinkingLevels: [], defaultModel: null, defaultThinkingLevel: null });
  return manager;
}

test('listModels marks router presets and configured external servers as local', async t => {
  const manager = await managerWithCatalog(t, {
    provider: 'llama.cpp',
    externalServers: [{ provider: 'strata-iq3', model: 'qwen3.8-flash-next-iq3-xxs' }]
  }, [
    { provider: 'llama.cpp', id: 'qwen-27b-q3' },
    { provider: 'strata-iq3', id: 'qwen3.8-flash-next-iq3-xxs' },
    { provider: 'openrouter', id: 'glm-5' }
  ]);
  const catalog = await manager.listModels();
  const byKey = new Map(catalog.models.map(m => [`${m.provider}/${m.id}`, m]));
  assert.equal(byKey.get('llama.cpp/qwen-27b-q3').local, true);
  assert.equal(byKey.get('strata-iq3/qwen3.8-flash-next-iq3-xxs').local, true);
  assert.equal(byKey.get('openrouter/glm-5').local, undefined);
  // The provider id itself must survive: it is what Pi is given to select the model.
  assert.equal(byKey.get('strata-iq3/qwen3.8-flash-next-iq3-xxs').provider, 'strata-iq3');
});

test('listModels keeps the rest of the catalog response intact', async t => {
  const manager = await managerWithCatalog(t, { provider: 'llamacpp' }, [{ provider: 'llamacpp', id: 'qwen' }]);
  const catalog = await manager.listModels();
  assert.deepEqual(catalog.thinkingLevels, []);
  assert.equal(catalog.defaultModel, null);
  assert.deepEqual(catalog.latency, {});
});
