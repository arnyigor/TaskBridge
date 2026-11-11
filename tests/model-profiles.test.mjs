import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelProfiles } from '../src/providers/model-profiles.mjs';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-model-profiles-'));
  return { dir, file: path.join(dir, 'model-profiles.json'), service: new ModelProfiles({ agentDir: dir }) };
}

const draft = (revision, extra = {}) => ({
  revision, id: 'p-bystryy', name: 'Быстрый', providerId: 'tb-example', modelId: 'example-model',
  settings: { timeoutMs: 90000, reasoning: 'off' }, ...extra,
});

async function rejectCode(promise, code) {
  await assert.rejects(promise, error => error.code === code);
}

test('пустой файл: список пуст, ревизия есть, models.json не создаётся', async t => {
  const { dir, service } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const list = await service.list();
  assert.deepEqual(list.profiles, []);
  assert.match(list.revision, /^[0-9a-f]{64}$/);
  assert.deepEqual((await fs.readdir(dir)), [], 'чтение не пишет файлов рядом');
});

test('профиль создаётся, читается и удаляется; копия прежнего файла остаётся', async t => {
  const { dir, file, service } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const created = await service.upsert(draft((await service.list()).revision));
  assert.equal(created.profiles.length, 1);
  const profile = created.profiles[0];
  assert.match(profile.id, /^p-[a-z0-9]{1,46}$/);
  assert.equal(profile.name, 'Быстрый');
  assert.equal(profile.providerId, 'tb-example');
  assert.equal(profile.modelId, 'example-model');
  assert.equal(profile.enabled, true);
  assert.deepEqual(profile.settings, { timeoutMs: 90000, reasoning: 'off' });

  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(doc.profiles[profile.id].settings.timeoutMs, 90000);

  // Повторная отправка того же id — правка того же профиля, а не дубликат.
  const same = await service.upsert(draft(created.revision));
  assert.equal(same.profiles.length, 1);
  assert.equal(same.profiles[0].id, profile.id);

  // Правка того же профиля обновляет запись, а не плодит дубликат.
  const updated = await service.upsert(draft(same.revision, { id: profile.id, settings: { timeoutMs: 30000 } }));
  assert.equal(updated.profiles.length, 1);
  assert.deepEqual(updated.profiles[0].settings, { timeoutMs: 30000 });

  const backups = (await fs.readdir(dir)).filter(name => name.startsWith('model-profiles.json.bak-taskbridge-'));
  assert.ok(backups.length >= 1, 'перед записью снимается копия прежних байтов');

  const removed = await service.remove(profile.id, updated.revision);
  assert.deepEqual(removed.profiles, []);
});

test('ревизия, дубликат имени, формат и границы отклоняются', async t => {
  const { dir, service } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const before = (await service.list()).revision;
  const first = await service.upsert(draft(before));
  const revision = first.revision;

  // Устаревшая ревизия — конфликт, а не тихая перезапись.
  await rejectCode(service.upsert(draft(before, { id: 'p-second', name: 'Второй' })), 'CONFLICT');
  const fresh = (await service.list()).revision;

  // Второй профиль с тем же именем у той же модели — неоднозначно.
  await rejectCode(service.upsert(draft(fresh, { id: 'p-second' })), 'CONFLICT');

  // Другая модель — то же имя разрешено.
  const other = await service.upsert(draft(fresh, { id: 'p-second', modelId: 'another-model' }));
  assert.equal(other.profiles.length, 2);

  const latest = (await service.list()).revision;
  await rejectCode(service.upsert(draft(latest, { id: 'p-bad', name: '' })), 'INPUT_INVALID');
  await rejectCode(service.upsert(draft(latest, { id: 'p-bad', modelId: '' })), 'INPUT_INVALID');
  await rejectCode(service.upsert(draft(latest, { id: 'p-bad', providerId: '..' })), 'INPUT_INVALID');
  await rejectCode(service.upsert(draft(latest, { id: 'nope' })), 'INPUT_INVALID');
  await rejectCode(service.upsert(draft(latest, { id: 'p-bad', settings: [] })), 'INPUT_INVALID');

  await rejectCode(service.remove('p-absent', latest), 'NOT_FOUND');
  await rejectCode(service.remove('p-bystryy', revision), 'CONFLICT');
  await rejectCode(service.remove('bad-id', latest), 'INPUT_INVALID');
});

test('без id сервер выдаёт свой; повтор того же имени — конфликт, а не перезапись', async t => {
  const { dir, service } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { id: _ignored, ...noId } = draft((await service.list()).revision);
  const created = await service.upsert(noId);
  assert.match(created.profiles[0].id, /^p-[a-f0-9]{10}$/);
  // Второй раз без id — тот же имя у той же модели: перезаписать чужой пресет нельзя.
  await rejectCode(service.upsert({ ...noId, revision: created.revision }), 'CONFLICT');
});

test('повреждённый файл не перезаписывается', async t => {
  const { dir, file, service } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(file, '{oops', 'utf8');
  await rejectCode(service.list(), 'CONFLICT');
});
