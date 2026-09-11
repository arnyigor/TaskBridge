import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveLocalProviderId, usesLocalRuntime } from '../src/dispatcher.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';

// Pi knows two ids for the same local llama.cpp endpoint: the hand-written
// models.json provider ("llamacpp") and Pi's built-in router provider
// ("llama.cpp"). The built-in one resolves its endpoint from LLAMA_BASE_URL (or
// `/login llama.cpp`) and answers "Provider is not configured: llama.cpp"
// without it, and it shadows a hand-written provider of the same id. So the id
// TaskBridge hands to Pi must be one Pi actually lists.

test('the local provider id follows what Pi actually lists', () => {
  const catalog = provider => [{ provider, id: 'qwen-27b-q3' }];
  // The configured id is unusable (built-in without LLAMA_BASE_URL) while the
  // hand-written provider exists: switch to the one Pi serves.
  assert.equal(resolveLocalProviderId({ configured: 'llama.cpp', catalog: catalog('llamacpp') }), 'llamacpp');
  // And the other direction, for an installation that only exports the built-in.
  assert.equal(resolveLocalProviderId({ configured: 'llamacpp', catalog: catalog('llama.cpp') }), 'llama.cpp');
  // The configured id wins when it is present.
  assert.equal(resolveLocalProviderId({ configured: 'llamacpp', catalog: catalog('llamacpp') }), 'llamacpp');
  assert.equal(resolveLocalProviderId({ configured: 'llama.cpp', catalog: catalog('llama.cpp') }), 'llama.cpp');
  // Both present: the configured id wins, so an explicit choice is honoured.
  const both = [...catalog('llamacpp'), ...catalog('llama.cpp')];
  assert.equal(resolveLocalProviderId({ configured: 'llama.cpp', catalog: both }), 'llama.cpp');
  assert.equal(resolveLocalProviderId({ configured: 'llamacpp', catalog: both }), 'llamacpp');
  // Nothing local, or no catalog yet: keep the configured id (old behaviour).
  assert.equal(resolveLocalProviderId({ configured: 'llama.cpp', catalog: catalog('openai') }), 'llama.cpp');
  assert.equal(resolveLocalProviderId({ configured: 'llama.cpp', catalog: null }), 'llama.cpp');
  assert.equal(resolveLocalProviderId({ configured: 'llama.cpp' }), 'llama.cpp');
});

test('both ids keep passing the local runtime gate', () => {
  assert.equal(usesLocalRuntime({ provider: 'llama.cpp' }, 'llamacpp'), true);
  assert.equal(usesLocalRuntime({ provider: 'llamacpp' }, 'llama.cpp'), true);
  assert.equal(usesLocalRuntime({ provider: 'llama.cpp' }, 'openai'), false);
});

test('localStatus advertises the id Pi serves, not the stale configured one', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-local-provider-'));
  const store = new TaskStore(path.join(root, 'data'));
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const manager = new TaskManager({
    projects: [],
    localRuntime: { provider: 'llama.cpp', router: { enabled: true, command: 'llama-server' }, defaultProfile: 'qwen-27b-q3' }
  }, path.join(root, 'data'), store);

  manager.local.getStatus = async () => ({ enabled: true, provider: 'llama.cpp', models: [], loaded: [] });

  // Pi has not been probed yet: the configured id is kept.
  manager.modelCatalog.peek = () => null;
  assert.equal((await manager.localStatus()).provider, 'llama.cpp');

  // Pi lists the hand-written provider only: advertise it, so a model chosen in
  // the picker is sent to Pi under an id it can serve.
  manager.modelCatalog.peek = () => ({ models: [{ provider: 'llamacpp', id: 'qwen-27b-q3' }] });
  const status = await manager.localStatus();
  assert.equal(status.provider, 'llamacpp');
  assert.equal(status.enabled, true);
  assert.deepEqual(status.models, []);
});

test('the local models endpoint probes Pi once, the polled info call does not', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-local-probe-'));
  const store = new TaskStore(path.join(root, 'data'));
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const manager = new TaskManager({
    projects: [],
    localRuntime: { provider: 'llama.cpp', router: { enabled: true, command: 'llama-server' } }
  }, path.join(root, 'data'), store);
  manager.local.getStatus = async () => ({ enabled: true, provider: 'llama.cpp', models: [], loaded: [] });

  let probes = 0;
  manager.modelCatalog.list = async () => { probes += 1; return { models: [{ provider: 'llamacpp', id: 'qwen-27b-q3' }], thinkingLevels: [] }; };
  // Whatever the catalog would return later is irrelevant for the polled call.
  let cached = null;
  manager.modelCatalog.peek = () => cached;

  assert.equal((await manager.localStatus()).provider, 'llama.cpp');
  assert.equal(probes, 0, '/api/info must not start a Pi probe');

  manager.modelCatalog.list = async () => {
    probes += 1;
    cached = { models: [{ provider: 'llamacpp', id: 'qwen-27b-q3' }], thinkingLevels: [] };
    return cached;
  };
  assert.equal((await manager.localStatus({ probeCatalog: true })).provider, 'llamacpp');
  assert.equal(probes, 1);

  // Already warm: no second probe.
  assert.equal((await manager.localStatus({ probeCatalog: true })).provider, 'llamacpp');
  assert.equal(probes, 1);
});
