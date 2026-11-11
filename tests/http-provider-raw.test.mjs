// Маршруты полного редактора (аналог Pi Manager): запись провайдера и модели
// целиком. Секреты приходят как $REDACTED и не затираются формой.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startFixture } from './server-fixture.mjs';

test('raw-редактор: чтение и запись провайдера и модели, секреты не утекают', async t => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-raw-http-'));
  const file = path.join(agentDir, 'models.json');
  await fs.writeFile(file, JSON.stringify({
    providers: {
      deepseek: {
        baseUrl: 'https://api.deepseek.com', api: 'openai-completions', apiKey: '$DEEPSEEK_API_KEY',
        name: 'DeepSeek', headers: { 'X-Trace': 'trace-abcdefghijklmnopqrstuvwxyz-1234' },
        models: [{ id: 'deepseek-flash', contextWindow: 1048576, maxTokens: 393216, reasoning: true }],
      },
    },
  }, null, 2), 'utf8');
  const fixture = await startFixture(null, { env: { PI_AGENT_DIR: agentDir, DEEPSEEK_API_KEY: 'x' } });
  t.after(async () => {
    await fixture.close();
    await fs.rm(agentDir, { recursive: true, force: true });
  });

  const raw = await fixture.api('/api/provider-profiles/deepseek/raw');
  assert.equal(raw.entry.apiKey, '$DEEPSEEK_API_KEY');
  assert.equal(raw.entry.headers['X-Trace'], '$REDACTED');
  assert.equal(raw.entry.models[0].contextWindow, 1048576);

  // Сохранение: форма вернула маркеры — секреты на месте, новые поля записались.
  const entry = { ...raw.entry, compat: { supportsTemperature: false } };
  entry.models = [...entry.models, { id: 'deepseek-lite', maxTokens: 8192 }];
  const saved = await fetch(`${fixture.base}/api/provider-profiles/deepseek/raw`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: raw.revision, entry }),
  });
  assert.equal(saved.status, 200);
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(after.providers.deepseek.headers['X-Trace'], 'trace-abcdefghijklmnopqrstuvwxyz-1234');
  assert.equal(after.providers.deepseek.compat.supportsTemperature, false);
  assert.equal(after.providers.deepseek.models.length, 2);

  // Модель целиком, с переименованием ID.
  const { revision } = await fixture.api('/api/provider-profiles');
  const model = { id: 'deepseek-flash-2', name: 'Flash 2', contextWindow: 262144, maxTokens: 65536, input: ['text', 'image'] };
  const modelSaved = await fetch(`${fixture.base}/api/provider-profiles/deepseek/models/deepseek-flash/raw`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision, model }),
  });
  assert.equal(modelSaved.status, 200);
  const afterModel = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(afterModel.providers.deepseek.models[0].input, ['text', 'image']);
  assert.equal(afterModel.providers.deepseek.models[0].id, 'deepseek-flash-2');

  // Литеральный ключ из формы не принимается.
  const literal = await fetch(`${fixture.base}/api/provider-profiles/deepseek/raw`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: (await fixture.api('/api/provider-profiles')).revision, entry: { ...raw.entry, apiKey: 'sk-live-1' } }),
  });
  assert.equal(literal.status, 400);
});
