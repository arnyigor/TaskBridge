// Добавление и удаление провайдера через настоящий сервер (жалоба оператора
// 2026-10-23: «в WEB добавление и удаление не работает»). Проверяется именно
// маршрут: PUT создаёт запись, DELETE убирает и её, и чужое подключение, а файл
// остаётся валидным, с резервной копией рядом.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startFixture } from './server-fixture.mjs';

test('провайдер добавляется и удаляется через HTTP, включая чужую запись', async t => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-provider-crud-'));
  const file = path.join(agentDir, 'models.json');
  await fs.writeFile(file, JSON.stringify({
    providers: {
      existing: { baseUrl: 'https://other.example/v1', api: 'openai-completions', apiKey: '$OTHER_KEY', models: [{ id: 'x' }] },
    },
  }, null, 2), 'utf8');
  const fixture = await startFixture(null, { env: { PI_AGENT_DIR: agentDir } });
  t.after(async () => {
    await fixture.close();
    await fs.rm(agentDir, { recursive: true, force: true });
  });
  const put = async body => {
    const response = await fetch(`${fixture.base}/api/provider-profiles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const del = async (id, revision) => {
    const response = await fetch(`${fixture.base}/api/provider-profiles/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision }),
    });
    return { status: response.status, body: await response.json() };
  };

  const first = await fixture.api('/api/provider-profiles');
  const added = await put({ revision: first.revision, id: 'tb-added', baseUrl: 'https://api.example/v1', keyEnv: 'DEMO_KEY', models: ['m1', 'm2'] });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body.providers.map(provider => provider.id).sort(), ['existing', 'tb-added']);
  assert.equal(added.body.providers.find(provider => provider.id === 'tb-added').modelCount, 2);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).providers['tb-added'].apiKey, '$DEMO_KEY', 'в файл уходит ссылка на переменную');

  // Удаление управляемой записи.
  const removedManaged = await del('tb-added', added.body.revision);
  assert.equal(removedManaged.status, 200, JSON.stringify(removedManaged.body));
  assert.deepEqual(removedManaged.body.providers.map(provider => provider.id), ['existing']);

  // Удаление ЧУЖОЙ записи: раньше сервер отвечал отказом, теперь удаляет с копией.
  const removedForeign = await del('existing', removedManaged.body.revision);
  assert.equal(removedForeign.status, 200, JSON.stringify(removedForeign.body));
  assert.deepEqual(removedForeign.body.providers, []);
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(doc.providers, {}, 'в файле не осталось удалённых записей');
  const backups = (await fs.readdir(agentDir)).filter(name => name.startsWith('models.json.bak-taskbridge-'));
  // Одна копия на каждую запись, которая меняла файл: добавление и два удаления.
  assert.equal(backups.length, 3, 'каждая запись оставила копию файла');

  // Устаревшая ревизия и повторное удаление отклоняются, файл не меняется.
  const stale = await del('existing', first.revision);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CONFLICT');
  const again = await del('existing', removedForeign.body.revision);
  assert.equal(again.status, 404);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).providers, {});
});
