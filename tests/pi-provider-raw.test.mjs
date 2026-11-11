// Полный редактор записи провайдера и модели (аналог Pi Manager): все поля
// читаются и пишутся, но секреты не покидают машину и не затираются формой.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PiProviderProfiles } from '../src/providers/pi-provider-profiles.mjs';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-raw-'));
  const file = path.join(dir, 'models.json');
  await fs.writeFile(file, JSON.stringify({
    providers: {
      deepseek: {
        baseUrl: 'https://api.deepseek.com', api: 'openai-completions', apiKey: '$DEEPSEEK_API_KEY',
        name: 'DeepSeek (ручной)', headers: { 'X-Trace': 'trace-abcdefghijklmnopqrstuvwxyz-1234' },
        compat: { requiresReasoningContentOnAssistantMessages: true },
        models: [
          { id: 'deepseek-flash', name: 'Flash', contextWindow: 1048576, maxTokens: 393216, reasoning: true, input: ['text', 'image'] },
          { id: 'deepseek-pro', thinkingLevelMap: { minimal: 'low', high: 'high' } },
        ],
      },
    },
  }, null, 2), 'utf8');
  return { dir, file, service: new PiProviderProfiles({ agentDir: dir, env: { DEEPSEEK_API_KEY: 'x' } }) };
}

test('rawProvider отдаёт все поля модели и провайдера, скрывая секреты', async t => {
  const { dir, service } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { entry, revision } = await service.rawProvider('deepseek');
  assert.match(revision, /^[0-9a-f]{64}$/);
  assert.equal(entry.baseUrl, 'https://api.deepseek.com');
  assert.equal(entry.name, 'DeepSeek (ручной)');
  assert.equal(entry.apiKey, '$DEEPSEEK_API_KEY', 'ссылка на переменную видна');
  assert.deepEqual(entry.compat, { requiresReasoningContentOnAssistantMessages: true });
  assert.equal(entry.headers['X-Trace'], '$REDACTED', 'секретоподобный заголовок скрыт');
  assert.equal(entry.models[0].contextWindow, 1048576);
  assert.equal(entry.models[0].reasoning, true);
  assert.deepEqual(entry.models[0].input, ['text', 'image']);
  assert.deepEqual(entry.models[1].thinkingLevelMap, { minimal: 'low', high: 'high' });
});

test('литеральный apiKey в ответ не попадает', async t => {
  const { dir, file, service } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  doc.providers.deepseek.apiKey = 'sk-live-abcdef123456';
  await fs.writeFile(file, JSON.stringify(doc, null, 2));
  const { entry } = await service.rawProvider('deepseek');
  assert.equal(entry.apiKey, '$REDACTED');
  assert.ok(!JSON.stringify(entry).includes('sk-live-abcdef123456'));
});

test('setProviderRaw сохраняет поля и не затирает скрытые секреты', async t => {
  const { dir, file, service } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { entry, revision } = await service.rawProvider('deepseek');
  entry.models.push({ id: 'deepseek-lite', name: 'Lite', maxTokens: 8192 });
  entry.compat = { ...entry.compat, supportsTemperature: false };
  const saved = await service.setProviderRaw('deepseek', entry, revision);
  assert.ok(saved.revision);

  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(doc.providers.deepseek.apiKey, '$DEEPSEEK_API_KEY', 'ключ не тронут');
  assert.equal(doc.providers.deepseek.headers['X-Trace'], 'trace-abcdefghijklmnopqrstuvwxyz-1234', 'скрытый заголовок сохранён');
  assert.equal(doc.providers.deepseek.compat.supportsTemperature, false);
  assert.equal(doc.providers.deepseek.models.length, 3);
  assert.equal(doc.providers.deepseek.models[2].maxTokens, 8192);
});

test('setProviderRaw отвергает литеральный ключ, повтор модели и устаревшую ревизию', async t => {
  const { dir, service } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { entry, revision } = await service.rawProvider('deepseek');
  await assert.rejects(service.setProviderRaw('deepseek', { ...entry, apiKey: 'sk-live' }, revision), e => e.code === 'INPUT_INVALID');
  await assert.rejects(
    service.setProviderRaw('deepseek', { ...entry, models: [{ id: 'a' }, { id: 'a' }] }, revision),
    e => e.code === 'INPUT_INVALID',
  );
  await assert.rejects(service.setProviderRaw('deepseek', entry, 'deadbeef'), e => e.code === 'CONFLICT');
  await assert.rejects(service.setProviderRaw('absent', entry, revision), e => e.code === 'NOT_FOUND');
});

test('setModelRaw пишет все поля модели и переименовывает по id', async t => {
  const { dir, file, service } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { revision } = await service.list();
  const model = {
    id: 'deepseek-flash-2', name: 'Flash 2', contextWindow: 262144, maxTokens: 65536,
    reasoning: false, input: ['text'], samplingParams: { temperature: 0.2 },
    thinkingLevelMap: { low: 'low' }, compat: { special: true },
  };
  await service.setModelRaw('deepseek', 'deepseek-flash', model, revision);
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  const saved = doc.providers.deepseek.models.find(m => m.id === 'deepseek-flash-2');
  assert.ok(saved, 'модель переименована');
  assert.equal(doc.providers.deepseek.models.some(m => m.id === 'deepseek-flash'), false);
  assert.equal(saved.maxTokens, 65536);
  assert.deepEqual(saved.samplingParams, { temperature: 0.2 });
  assert.equal(doc.providers.deepseek.models[1].id, 'deepseek-pro', 'соседняя модель не тронута');

  // Занятый ID — отказ, пустой settings убирается.
  const latest = (await service.list()).revision;
  await assert.rejects(
    service.setModelRaw('deepseek', 'deepseek-flash-2', { ...model, id: 'deepseek-pro' }, latest),
    e => e.code === 'INPUT_INVALID',
  );
  const clean = { ...model, settings: {} };
  await service.setModelRaw('deepseek', 'deepseek-flash-2', clean, (await service.list()).revision);
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(after.providers.deepseek.models.find(m => m.id === 'deepseek-flash-2').settings, undefined);
});
