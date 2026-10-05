import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

// Сценарий с телефона (2026-10-04): модель удалена с диска, строка осталась, а
// кнопки «убрать из списка» нет. Строка оказалась НАЙДЕННОЙ автоматически
// (провайдер в Pi models.json + конфиг движка в каталоге установки), и такие
// строки нельзя удалить — их можно только скрыть. Проверяем весь путь через
// живой сервер: список → forget (скрытие) → hidden → unhide (возврат).
async function discoverySetup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-hide-'));
  const agentDir = path.join(root, 'agent');
  const installDir = path.join(root, 'install');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(installDir, { recursive: true });
  // Провайдер Pi с локальным baseUrl + конфиг движка на том же порту — ровно то,
  // из чего собирается найденная строка.
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: { 'strata-ud': { baseUrl: 'http://127.0.0.1:18084/v1', models: [{ id: 'ud-model', name: 'UD model' }] } }
  }), 'utf8');
  await fs.writeFile(path.join(installDir, 'strata-ud.json'), JSON.stringify({
    port: 18084,
    args: ['--native', path.join(root, 'нет-такого-файла.gguf'), '--max-context', '262144']
  }), 'utf8');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, agentDir, installDir };
}

const rowOf = (status, id) => status.models.find(model => model.id === id || model.provider === id);

test('an auto-discovered row with a missing file can be dropped from the list and brought back', async t => {
  const { agentDir, installDir } = await discoverySetup(t);
  const fixture = await startFixture(undefined, {
    env: { PI_AGENT_DIR: agentDir },
    root: { localRuntime: { externalDiscovery: { dir: installDir, configGlob: 'strata-*.json' } } }
  });
  t.after(() => fixture.close());

  const before = await fixture.api('/api/local?fresh=1');
  const row = rowOf(before, 'ud-model');
  assert.ok(row, 'найденная строка есть в списке');
  assert.equal(row.external, true);
  assert.equal(row.removable, false, 'удалять запись неоткуда: она не в конфиге TaskBridge');
  assert.equal(row.hideable, true, 'но убрать из списка можно — скрытием');
  assert.equal(row.filesPresent, false, `${row.missingFile} — весов нет`);
  assert.deepEqual(before.hidden, []);

  // «Убрать из списка» на телефоне: строка уходит, id запоминается скрытым.
  const removed = await fixture.api('/api/local/forget', { model: 'ud-model' });
  assert.deepEqual(removed.removed, { provider: 'strata-ud', model: 'ud-model', hidden: true });
  assert.equal(rowOf(removed, 'ud-model'), undefined, 'в ответе строки уже нет');
  assert.deepEqual(removed.hidden, ['strata-ud']);

  // Скрытие переживает перезапуск сервера: оно записано в config.json.
  await fixture.restart();
  const after = await fixture.api('/api/local?fresh=1');
  assert.equal(rowOf(after, 'ud-model'), undefined);
  assert.deepEqual(after.hidden, ['strata-ud']);
  // Чужие файлы не тронуты: провайдер Pi и конфиг установки на месте.
  const pi = JSON.parse(await fs.readFile(path.join(agentDir, 'models.json'), 'utf8'));
  assert.ok(pi.providers['strata-ud'], 'models.json Pi не переписывается');
  assert.ok(await fs.readFile(path.join(installDir, 'strata-ud.json'), 'utf8'));
  const app = JSON.parse(await fs.readFile(path.join(fixture.root, 'config.json'), 'utf8'));
  assert.deepEqual(app.localRuntime.externalHidden, ['strata-ud'], 'скрытые — в конфиге TaskBridge');

  // «Вернуть» из раздела «Скрытые»: строка снова в списке, конфиг чистый.
  const restored = await fixture.api('/api/local/unhide', { model: 'strata-ud' });
  assert.deepEqual(restored.hidden, []);
  assert.ok(rowOf(restored, 'ud-model'), 'строка вернулась');
  await assert.rejects(() => fixture.api('/api/local/unhide', { model: 'strata-ud' }), /нет среди скрытых/);
  await assert.rejects(() => fixture.api('/api/local/forget', { model: 'совсем-нет-такого' }), /убирать нечего/);
});
