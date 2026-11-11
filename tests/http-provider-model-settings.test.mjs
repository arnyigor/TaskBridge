// Маршрут настроек модели (шаг 02 плана): PUT
// /api/provider-profiles/:id/models/:modelId/settings. Правится ТОЛЬКО объект settings
// одной модели; адрес провайдера, ключ и соседние модели остаются как были.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startFixture } from './server-fixture.mjs';

test('настройки модели: правится только settings, ревизия и промах по ID отклоняются', async t => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-model-settings-'));
  const file = path.join(agentDir, 'models.json');
  await fs.writeFile(file, JSON.stringify({
    providers: {
      'tb-local': {
        baseUrl: 'https://gateway.example/v1', api: 'openai-completions', apiKey: '$TB_KEY',
        name: 'TaskBridge: tb-local',
        models: [{ id: 'model-a' }, { id: 'model-b' }],
      },
    },
  }, null, 2), 'utf8');
  const fixture = await startFixture(null, { env: { PI_AGENT_DIR: agentDir } });
  t.after(async () => {
    await fixture.close();
    await fs.rm(agentDir, { recursive: true, force: true });
  });
  const put = (modelId, body) => fetch(
    `${fixture.base}/api/provider-profiles/tb-local/models/${encodeURIComponent(modelId)}/settings`,
    { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );

  const { revision } = await fixture.api('/api/provider-profiles');
  const response = await put('model-a', {
    revision,
    settings: { promptTemplate: 'Be brief.', timeoutMs: 30000, contextWindow: 65536, reasoning: 'on' },
  });
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.deepEqual(page.providers[0].models.find(model => model.id === 'model-a').settings, {
    promptTemplate: 'Be brief.', timeoutMs: 30000, contextWindow: 65536, reasoning: 'on',
  });

  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(doc.providers['tb-local'].models[0].settings.timeoutMs, 30000);
  assert.deepEqual(doc.providers['tb-local'].models[1], { id: 'model-b' }, 'соседняя модель не тронута');
  assert.equal(doc.providers['tb-local'].apiKey, '$TB_KEY', 'ключ не тронут');
  assert.equal(doc.providers['tb-local'].baseUrl, 'https://gateway.example/v1', 'адрес не тронут');

  // Устаревшая ревизия — конфликт, не тихая перезапись.
  const stale = await put('model-a', { revision, settings: { timeoutMs: 1 } });
  assert.equal(stale.status, 409);
  const { revision: fresh } = await fixture.api('/api/provider-profiles');
  // Промах по ID модели и по ID провайдера — отказ без записи.
  assert.equal((await put('нет-такой', { revision: fresh, settings: {} })).status, 400);
  const absent = await fetch(`${fixture.base}/api/provider-profiles/absent-provider/models/model-a/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: fresh, settings: {} }),
  });
  assert.equal(absent.status, 404);
  // settings обязан быть объектом.
  assert.equal((await put('model-a', { revision: fresh, settings: 'oops' })).status, 400);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).providers['tb-local'].models[0].settings.timeoutMs, 30000);
});
