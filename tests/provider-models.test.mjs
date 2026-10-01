import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  mergeProviderModels,
  parseProviderModels,
  remoteModelsUrl,
  syncProviderModels,
} from '../src/provider-models.mjs';

// The wire format wormsoft answers with (measured live 2026-09-30): OpenAI
// /models payload with its own metadata names.
const wormsoftPayload = {
  object: 'list',
  data: [
    {
      id: 'openai/gpt-6-luna',
      object: 'model',
      owned_by: 'wormsoft',
      capabilities: { vision: false, tools: true, reasoning: true },
      context_length: 400000,
      max_completion_tokens: 120000,
      input_modalities: ['text'],
      output_modalities: ['text'],
    },
    {
      id: 'zai/glm-5.3-flash:NVFP4',
      object: 'model',
      capabilities: { vision: true, tools: true, reasoning: true },
      context_length: 1000000,
      max_completion_tokens: 65536,
      input_modalities: ['text', 'image'],
    },
  ],
};

test('parseProviderModels maps OpenAI field names to Pi entry fields', () => {
  assert.deepEqual(parseProviderModels(wormsoftPayload), [
    { id: 'openai/gpt-6-luna', name: 'openai/gpt-6-luna', contextWindow: 400000, maxTokens: 120000, reasoning: true, input: ['text'] },
    { id: 'zai/glm-5.3-flash:NVFP4', name: 'zai/glm-5.3-flash:NVFP4', contextWindow: 1000000, maxTokens: 65536, reasoning: true, input: ['text', 'image'] },
  ]);
});

test('parseProviderModels keeps the entry minimal when the endpoint reports nothing', () => {
  assert.deepEqual(parseProviderModels({ data: [{ id: 'some/model' }, null, {}, { id: ' ' }] }), [
    { id: 'some/model', name: 'some/model' },
  ]);
  assert.deepEqual(parseProviderModels(null), []);
  assert.deepEqual(parseProviderModels({}), []);
});

test('merge adds only the models the static list misses', () => {
  const existing = [
    { id: 'openai/gpt-5.6-luna', name: 'openai/gpt-5.6-luna', compat: { supportsStore: false } },
    { id: 'openai/gpt-6-luna', name: 'gpt-6-luna' },
  ];
  const remote = [
    { id: 'openai/gpt-6-luna', name: 'openai/gpt-6-luna' },
    { id: 'openai/gpt-6-astra', name: 'openai/gpt-6-astra', contextWindow: 400000 },
    { id: 'openai/gpt-6-luna', name: 'duplicate id' },
  ];
  const merged = mergeProviderModels(existing, remote, 'wormsoft');
  assert.deepEqual(merged.added, [{ id: 'openai/gpt-6-astra', name: 'openai/gpt-6-astra', contextWindow: 400000 }]);
  // Existing entries survive untouched — hand-tuned compat metadata included.
  assert.equal(merged.models[0], existing[0]);
  assert.equal(merged.models[1], existing[1]);
  assert.equal(merged.models.length, 3);
});

test('merge skips the provider own prefixed aliases', () => {
  const merged = mergeProviderModels([], [
    { id: 'wormsoft/agent/high' },
    { id: 'wormsoft/mine/alias' },
    { id: 'wormsoft/agent/high' },
    { id: 'zai/glm-5.3' },
  ], 'wormsoft');
  assert.deepEqual(merged.added.map(m => m.id), ['zai/glm-5.3']);
});

test('remoteModelsUrl joins the models path without doubling slashes', () => {
  assert.equal(remoteModelsUrl('https://ai.wormsoft.ru/api/gpt'), 'https://ai.wormsoft.ru/api/gpt/models');
  assert.equal(remoteModelsUrl('https://ai.wormsoft.ru/api/gpt/'), 'https://ai.wormsoft.ru/api/gpt/models');
});

const providerDoc = (entries) => JSON.stringify({
  providers: {
    wormsoft: {
      baseUrl: 'https://ai.wormsoft.ru/api/gpt',
      api: 'openai-completions',
      apiKey: '$WORMSOFT_API_KEY',
      models: entries,
    },
    // Local llama.cpp router: never a sync target.
    'llama.cpp': {
      baseUrl: 'http://127.0.0.1:8080/v1',
      api: 'openai-completions',
      apiKey: '',
      models: [{ id: 'qwen-27b-q3' }],
    },
  },
});

async function writeAgentDir(entries) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-models-'));
  await fs.writeFile(path.join(dir, 'models.json'), providerDoc(entries), 'utf8');
  return dir;
}

const fetchOk = async () => ({ ok: true, json: async () => wormsoftPayload });

test('sync adds the missing models, backs the file up and reports the summary', async () => {
  const dir = await writeAgentDir([{ id: 'openai/gpt-5.6-luna' }]);
  const result = await syncProviderModels({ agentDir: dir, env: { WORMSOFT_API_KEY: 'k' }, fetch: fetchOk });
  assert.equal(result.changed, true);
  assert.deepEqual(result.providers, [{
    provider: 'wormsoft',
    added: 2,
    total: 3,
    addedIds: ['openai/gpt-6-luna', 'zai/glm-5.3-flash:NVFP4'],
  }]);
  const doc = JSON.parse(await fs.readFile(path.join(dir, 'models.json'), 'utf8'));
  const models = doc.providers.wormsoft.models.map(m => m.id);
  assert.deepEqual(models, ['openai/gpt-5.6-luna', 'openai/gpt-6-luna', 'zai/glm-5.3-flash:NVFP4']);
  // The local router was never touched.
  assert.deepEqual(doc.providers['llama.cpp'].models, [{ id: 'qwen-27b-q3' }]);
  const backups = (await fs.readdir(dir)).filter(name => name.startsWith('models.json.bak-'));
  assert.equal(backups.length, 1);
  // The backup holds the pre-sync state.
  const backupDoc = JSON.parse(await fs.readFile(path.join(dir, backups[0]), 'utf8'));
  assert.deepEqual(backupDoc.providers.wormsoft.models, [{ id: 'openai/gpt-5.6-luna' }]);
});

test('sync with no new models does not rewrite the file', async () => {
  const dir = await writeAgentDir([{ id: 'openai/gpt-6-luna' }, { id: 'zai/glm-5.3-flash:NVFP4' }]);
  const result = await syncProviderModels({ agentDir: dir, env: { WORMSOFT_API_KEY: 'k' }, fetch: fetchOk });
  assert.equal(result.changed, false);
  assert.deepEqual(result.providers[0].added, 0);
  assert.equal((await fs.readdir(dir)).some(name => name.startsWith('models.json.bak-')), false);
});

test('sync honors the only list and the key rule', async () => {
  const dir = await writeAgentDir([]);
  // only=[] (no providers opted in): nothing is fetched at all.
  let calls = 0;
  const counting = async () => { calls += 1; return fetchOk(); };
  let result = await syncProviderModels({ agentDir: dir, env: { WORMSOFT_API_KEY: 'k' }, fetch: counting, only: [] });
  assert.equal(result.changed, false);
  assert.equal(calls, 0);
  // no key: the provider is skipped, not an error.
  result = await syncProviderModels({ agentDir: dir, env: {}, fetch: counting });
  assert.equal(result.changed, false);
  assert.deepEqual(result.providers, []);
  assert.equal(calls, 0);
});

test('a failing provider is reported and never blocks the others', async () => {
  const dir = await writeAgentDir([]);
  const doc = JSON.parse(await fs.readFile(path.join(dir, 'models.json'), 'utf8'));
  doc.providers.routerai = {
    baseUrl: 'https://routerai.ru/api/v1',
    api: 'openai-completions',
    apiKey: '$ROUTERAI_API_KEY',
    models: [],
  };
  await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify(doc), 'utf8');
  const result = await syncProviderModels({
    agentDir: dir,
    env: { WORMSOFT_API_KEY: 'k', ROUTERAI_API_KEY: 'r' },
    fetch: async (url) => {
      if (String(url).includes('routerai')) return { ok: false, status: 500, json: async () => ({}) };
      return fetchOk();
    },
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.providers.find(p => p.provider === 'routerai').error, 'HTTP 500');
  const models = JSON.parse(await fs.readFile(path.join(dir, 'models.json'), 'utf8')).providers.wormsoft.models;
  assert.equal(models.length, 2);
});

test('sync without models.json reports the skip instead of throwing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-models-'));
  const result = await syncProviderModels({ agentDir: dir, env: {}, fetch: fetchOk });
  assert.equal(result.changed, false);
  assert.equal(result.error, 'models.json is missing or unreadable');
});
