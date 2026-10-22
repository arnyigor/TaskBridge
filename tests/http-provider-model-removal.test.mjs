// Маршрут «убрать модель» (запрос оператора 2026-10-22) на настоящем сервере:
// правится только models, запись идёт по ревизии файла, промах по ID отклоняется.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startFixture } from './server-fixture.mjs';

test('удаление модели: файл меняется только в списке моделей, чужая правка не затирается', async t => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-remove-agent-'));
  const file = path.join(agentDir, 'models.json');
  await fs.writeFile(file, JSON.stringify({
    providers: {
      deepseek: {
        baseUrl: 'https://api.deepseek.com', api: 'openai-completions', apiKey: '$DEEPSEEK_API_KEY',
        models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
      },
    },
  }, null, 2), 'utf8');
  const fixture = await startFixture(null, { env: { PI_AGENT_DIR: agentDir } });
  t.after(async () => {
    await fixture.close();
    await fs.rm(agentDir, { recursive: true, force: true });
  });
  const post = (body) => fetch(`${fixture.base}/api/provider-profiles/deepseek/models/remove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const { revision } = await fixture.api('/api/provider-profiles');

  const response = await post({ models: ['deepseek-v4-pro'], revision });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.removed, ['deepseek-v4-pro']);
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(doc.providers.deepseek.models.map(model => model.id), ['deepseek-flash']);
  assert.equal(doc.providers.deepseek.apiKey, '$DEEPSEEK_API_KEY');

  // Повтор с прежней ревизией — конфликт, а не тихая перезапись.
  const stale = await post({ models: ['deepseek-flash'], revision });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'CONFLICT');

  // Уже убранной модели нет — отказ без записи.
  const { revision: fresh } = await fixture.api('/api/provider-profiles');
  const absent = await post({ models: ['deepseek-v4-pro'], revision: fresh });
  assert.equal(absent.status, 400);
  assert.match((await absent.json()).error, /нет моделей|нет у провайдера/i);
});
