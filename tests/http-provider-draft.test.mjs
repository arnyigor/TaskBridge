// Маршрут мастера подключения (пункт 2.3 плана, шаги 3–4): POST
// /api/provider-profiles/draft-check. Проверяется связка маршрут → валидация:
// адрес приходит от клиента, поэтому отказы должны быть на входе, а не после
// запроса к внутренней сети.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startFixture } from './server-fixture.mjs';

test('draft-check: опасный адрес и значение ключа отклоняются, NO_KEY без сети', async t => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-draft-agent-'));
  await fs.writeFile(path.join(agentDir, 'models.json'), '{"providers":{}}\n', 'utf8');
  const fixture = await startFixture(null, { env: { PI_AGENT_DIR: agentDir } });
  t.after(async () => {
    await fixture.close();
    await fs.rm(agentDir, { recursive: true, force: true });
  });
  const post = (body) => fetch(`${fixture.base}/api/provider-profiles/draft-check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Metadata-сервис облака: отказ до любого сетевого вызова.
  for (const baseUrl of ['http://169.254.169.254/latest', 'https://169.254.169.254/v1', 'file:///etc/passwd']) {
    const response = await post({ baseUrl, keyEnv: 'TB_DRAFT_KEY' });
    assert.equal(response.status, 400, baseUrl);
    assert.equal((await response.json()).code, 'INPUT_INVALID', baseUrl);
  }
  // В поле «переменная окружения» прислали сам ключ.
  const secret = await post({ baseUrl: 'https://gateway.example/v1', keyEnv: 'sk-live-123' });
  assert.equal(secret.status, 400);
  assert.equal((await secret.json()).code, 'INPUT_INVALID');

  // Облачный адрес без имени переменной — не «недоступен», а ошибка входа.
  const noEnv = await post({ baseUrl: 'https://gateway.example/v1' });
  assert.equal(noEnv.status, 400);

  // Имя переменной есть, значения в процессе нет: честное NO_KEY без запроса.
  const noKey = await post({ baseUrl: 'https://gateway.example/v1', keyEnv: 'TB_DRAFT_KEY' });
  assert.equal(noKey.status, 200);
  const body = await noKey.json();
  assert.equal(body.status, 'NO_KEY');
  assert.deepEqual(body.models, []);
  assert.match(String(body.note), /TB_DRAFT_KEY/);
});
