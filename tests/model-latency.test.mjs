import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelLatency } from '../src/model-latency.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';

test('ModelLatency records TTFT samples and computes avg/p50/last', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-latency-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const latency = new ModelLatency(root);
  await latency.record({ provider: 'deepseek', id: 'deepseek-chat' }, 1200);
  await latency.record({ provider: 'deepseek', id: 'deepseek-chat' }, 3000);
  await latency.record({ provider: 'deepseek', id: 'deepseek-chat' }, 2000);
  const stats = latency.stats();
  assert.deepEqual(Object.keys(stats), ['deepseek/deepseek-chat']);
  const entry = stats['deepseek/deepseek-chat'];
  assert.equal(entry.count, 3);
  assert.equal(entry.avgMs, 2067);
  assert.equal(entry.p50Ms, 2000);
  assert.equal(entry.lastMs, 2000);
  assert.equal(entry.samples.length, 3);
  assert.ok(entry.samples[0].at, 'samples carry a timestamp');
});

test('ModelLatency ignores bad input and caps the rolling window', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-latency-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const latency = new ModelLatency(root);
  await latency.record(null, 100);
  await latency.record({ provider: 'p' }, 100);
  await latency.record({ provider: 'p', id: 'm' }, 0);
  await latency.record({ provider: 'p', id: 'm' }, -5);
  await latency.record({ provider: 'p', id: 'm' }, NaN);
  assert.deepEqual(latency.stats(), {});
  for (let i = 0; i < 30; i++) await latency.record({ provider: 'p', id: 'm' }, 100 + i);
  const entry = latency.stats()['p/m'];
  assert.equal(entry.count, 20, 'the window is capped');
  assert.equal(entry.lastMs, 129);
});

test('a model without a provider is filed under /id, like the client key', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-latency-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const latency = new ModelLatency(root);
  // Pi reports the default model without a provider; ModelRef.key renders that as "/id".
  await latency.record({ provider: null, id: 'fixture' }, 180);
  assert.deepEqual(Object.keys(latency.stats()), ['/fixture']);
});

test('ModelLatency persists across instances', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-latency-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new ModelLatency(root);
  await first.record({ provider: 'p', id: 'm' }, 4200);
  const second = new ModelLatency(root);
  await second.load();
  const entry = second.stats()['p/m'];
  assert.ok(entry, 'a fresh instance loads the persisted history');
  assert.equal(entry.lastMs, 4200);
});

test('listModels merges the per-model latency stats into the catalog', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-latency-test-'));
  const store = new TaskStore(root);
  const manager = new TaskManager({ projects: [] }, root, store);
  t.after(async () => {
    await manager.close().catch(() => {});
    store.close();
    for (let i = 0; i < 10; i++) {
      try { await fs.rm(root, { recursive: true, force: true }); break; }
      catch { await new Promise(r => setTimeout(r, 60)); }
    }
  });
  manager.modelCatalog = { list: async () => ({ models: [], thinkingLevels: [] }) };
  await manager.modelLatency.record({ provider: 'deepseek', id: 'deepseek-chat' }, 1500);
  const catalog = await manager.listModels();
  assert.equal(catalog.latency['deepseek/deepseek-chat'].lastMs, 1500);
  assert.deepEqual(catalog.models, [], 'the catalog itself is untouched');
});
