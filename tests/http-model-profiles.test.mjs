// Пресеты модели (шаг 03): /api/model-profiles. Хранятся в отдельном файле рядом с
// models.json — конфиг Pi не меняется; запись идёт по ревизии файла пресетов.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startFixture } from './server-fixture.mjs';

test('пресеты модели: создание, конфликт ревизии, удаление; models.json не трогается', async t => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-profiles-agent-'));
  const modelsFile = path.join(agentDir, 'models.json');
  const profilesFile = path.join(agentDir, 'model-profiles.json');
  const modelsSource = JSON.stringify({
    providers: { 'tb-local': { baseUrl: 'https://gateway.example/v1', api: 'openai-completions', apiKey: '$TB_KEY', name: 'TaskBridge: tb-local', models: [{ id: 'model-a' }] } },
  }, null, 2);
  await fs.writeFile(modelsFile, modelsSource, 'utf8');
  const fixture = await startFixture(null, { env: { PI_AGENT_DIR: agentDir } });
  t.after(async () => {
    await fixture.close();
    await fs.rm(agentDir, { recursive: true, force: true });
  });

  const empty = await fixture.api('/api/model-profiles');
  assert.deepEqual(empty.profiles, []);
  assert.match(empty.revision, /^[0-9a-f]{64}$/);
  // Чтение не создаёт файл: пока пресетов нет, рядом с models.json ничего не появляется.
  await assert.rejects(fs.stat(profilesFile));

  const put = (body) => fetch(`${fixture.base}/api/model-profiles`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const created = await put({
    revision: empty.revision, id: 'p-bystryy', name: 'Быстрый', providerId: 'tb-local', modelId: 'model-a',
    settings: { timeoutMs: 90000, reasoning: 'off' },
  });
  assert.equal(created.status, 200);
  const page = await created.json();
  assert.equal(page.profiles.length, 1);
  const profile = page.profiles[0];
  assert.equal(page.profiles[0].name, 'Быстрый');
  assert.deepEqual(profile.settings, { timeoutMs: 90000, reasoning: 'off' });

  // models.json не переписан.
  assert.equal(await fs.readFile(modelsFile, 'utf8'), modelsSource);

  // Устаревшая ревизия пресетов — конфликт.
  const stale = await put({ revision: empty.revision, id: 'p-second', name: 'Второй', providerId: 'tb-local', modelId: 'model-a', settings: {} });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'CONFLICT');

  // Дубликат имени у той же модели — конфликт, не тихая замена.
  const dup = await put({ revision: page.revision, id: 'p-second', name: 'Быстрый', providerId: 'tb-local', modelId: 'model-a', settings: {} });
  assert.equal(dup.status, 409);

  const remove = (id, revision) => fetch(`${fixture.base}/api/model-profiles/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision }),
  });
  assert.equal((await remove('p-absent', page.revision)).status, 404);
  const removed = await remove(profile.id, page.revision);
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).profiles, []);
});
