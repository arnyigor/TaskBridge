import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelVisibility, filterHidden } from '../src/model-visibility.mjs';

const models = [
  { provider: 'anthropic', id: 'claude-x' },
  { provider: 'anthropic', id: 'claude-y' },
  { provider: 'routerai', id: 'qwen-27b' },
];

test('filterHidden: провайдер целиком и отдельная модель', () => {
  assert.equal(filterHidden(models, { hiddenProviders: ['anthropic'] }).length, 1);
  assert.equal(filterHidden(models, { hiddenModels: ['anthropic/claude-x'] }).length, 2);
  assert.equal(filterHidden(models, { hiddenProviders: ['anthropic'], hiddenModels: ['routerai/qwen-27b'] }).length, 0);
});

test('ModelVisibility: ревизия, замена, конфликт', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-visibility-'));
  const store = new ModelVisibility({ dataRoot: dir });
  const first = await store.read();
  assert.deepEqual(first.hiddenProviders, []);

  const saved = await store.replace({ hiddenProviders: ['anthropic'], hiddenModels: ['routerai/qwen-27b'] }, first.revision);
  assert.deepEqual(saved.hiddenProviders, ['anthropic']);

  await assert.rejects(
    () => store.replace({ hiddenProviders: [] }, first.revision),
    /Список скрытых изменился/,
  );

  const reread = await store.read();
  assert.equal(reread.revision, saved.revision);
  // Повторная та же запись ничего не пишет и ревизию не меняет.
  const again = await store.replace({ hiddenProviders: ['anthropic'], hiddenModels: ['routerai/qwen-27b'] }, reread.revision);
  assert.equal(again.revision, reread.revision);
});
