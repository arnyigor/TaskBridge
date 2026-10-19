import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiProviderProfiles } from '../src/providers/pi-provider-profiles.mjs';

async function fixture({ fetchImpl, env = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-provider-'));
  const file = path.join(dir, 'models.json');
  const original = {
    anotherSetting: { doNotModify: true },
    providers: {
      existing: {
        baseUrl: 'https://external.example/v1', api: 'openai-completions', apiKey: 'literal-top-secret',
        models: [{ id: 'real-model', compat: { special: true } }],
      },
    },
  };
  await fs.writeFile(file, JSON.stringify(original, null, 2));
  return { dir, file, original, service: new PiProviderProfiles({ agentDir: dir, env, fetchImpl }) };
}
const draft = (revision, extra = {}) => ({
  revision, id: 'tb-test', baseUrl: 'https://gateway.example/v1', keyEnv: 'TB_TEST_API_KEY',
  models: [{ id: 'qwen/qwen3:27b' }, { id: 'openai/gpt-5' }], ...extra,
});

async function rejectCode(promise, code) {
  await assert.rejects(promise, error => error.code === code);
}

test('listing never returns existing literal API keys or unknown settings', async t => {
  const { dir, service } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const list = await service.list();
  assert.equal(list.providers.length, 1);
  assert.equal(list.providers[0].id, 'existing');
  assert.equal(list.providers[0].managed, false);
  assert.ok(!JSON.stringify(list).includes('literal-top-secret'));
  assert.ok(!JSON.stringify(list).includes('doNotModify'));
  assert.deepEqual(list.providers[0].models, [{ id: 'real-model' }]);
});

test('save creates managed provider, preserves unknown records and writes original backup', async t => {
  const { dir, file, original, service } = await fixture({ env: { TB_TEST_API_KEY: 'do-not-log-this' } });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const old = await service.list();
  const updated = await service.upsert(draft(old.revision));
  assert.notEqual(old.revision, updated.revision);
  assert.equal(updated.providers.find(p => p.id === 'tb-test').auth, 'configured');
  assert.ok(!JSON.stringify(updated).includes('do-not-log-this'));
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(doc.providers.existing, original.providers.existing);
  assert.deepEqual(doc.anotherSetting, original.anotherSetting);
  assert.equal(doc.providers['tb-test'].apiKey, '$TB_TEST_API_KEY');
  assert.equal(doc.providers['tb-test'].name, 'TaskBridge: tb-test');
  const backups = (await fs.readdir(dir)).filter(f => f.startsWith('models.json.bak-taskbridge-'));
  assert.equal(backups.length, 1);
  const back = JSON.parse(await fs.readFile(path.join(dir, backups[0]), 'utf8'));
  assert.deepEqual(back, original);
});

test('update keeps metadata for unchanged model IDs', async t => {
  const { dir, file, service } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = await service.upsert(draft((await service.list()).revision));
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  doc.providers['tb-test'].models[0].compat = { thinkingFormat: 'chat-template' };
  await fs.writeFile(file, JSON.stringify(doc, null, 2));
  const latest = await service.list();
  const after = await service.upsert(draft(latest.revision, { models: [{ id: 'qwen/qwen3:27b' }] }));
  assert.equal(after.providers.find(p => p.id === 'tb-test').modelCount, 1);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(saved.providers['tb-test'].models[0].compat, { thinkingFormat: 'chat-template' });
  assert.notEqual(first.revision, after.revision);
});

test('stale edits are rejected; non-owned entries cannot be adopted or deleted', async t => {
  const { dir, service } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const old = await service.list();
  await service.upsert(draft(old.revision));
  await rejectCode(service.upsert(draft(old.revision)), 'CONFLICT');
  await rejectCode(service.remove('existing', (await service.list()).revision), 'INPUT_INVALID');
  await rejectCode(service.upsert(draft((await service.list()).revision, { id: 'existing' })), 'INPUT_INVALID');
});

test('reject unsafe hosts, literal credentials, duplicated models and traversal IDs', async t => {
  const { dir, service } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const revision = (await service.list()).revision;
  await rejectCode(service.upsert(draft(revision, { baseUrl: 'http://public.example/v1' })), 'INPUT_INVALID');
  await rejectCode(service.upsert(draft(revision, { baseUrl: 'https://username:password@public.example/v1' })), 'INPUT_INVALID');
  await rejectCode(service.upsert(draft(revision, { baseUrl: 'file:///tmp/my-file' })), 'INPUT_INVALID');
  await rejectCode(service.upsert(draft(revision, { keyEnv: 'sk-secret-key' })), 'INPUT_INVALID');
  await rejectCode(service.upsert(draft(revision, { id: 'tb-../hidden' })), 'INPUT_INVALID');
  await rejectCode(service.upsert(draft(revision, { models: ['same', 'same'] })), 'INPUT_INVALID');
  assert.equal((await service.list()).revision, revision);
});

test('check does only GET /models and redacts keys from results', async t => {
  const seen = [];
  const { dir, service } = await fixture({
    env: { TB_TEST_API_KEY: 'SECRET123' },
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, body: { cancel: async () => {} } };
    },
  }); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await service.upsert(draft((await service.list()).revision));
  const result = await service.check('tb-test');
  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://gateway.example/v1/models');
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer SECRET123');
  assert.ok(!JSON.stringify(result).includes('SECRET123'));
});

test('missing env does not attempt network; keyless local checks are supported', async t => {
  let calls = 0;
  const { dir, service } = await fixture({ fetchImpl: async () => { calls++; return { ok: false, status: 404 }; } });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await service.upsert(draft((await service.list()).revision));
  const result = await service.check('tb-test');
  assert.equal(result.status, 'missing-key');
  assert.equal(calls, 0);
  const local = await service.upsert(draft((await service.list()).revision, {
    id: 'tb-local', keyEnv: '', baseUrl: 'http://127.0.0.1:8080/v1', models: ['qwen-local'],
  }));
  assert.equal(local.providers.find(p => p.id === 'tb-local').auth, 'keyless-local');
  assert.equal((await service.check('tb-local')).status, 'http-404');
  assert.equal(calls, 1);
});

test('delete only removes managed provider, preserves other entries and backs up', async t => {
  const { dir, file, original, service } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const saved = await service.upsert(draft((await service.list()).revision));
  const removed = await service.remove('tb-test', saved.revision);
  assert.equal(removed.providers.find(p => p.id === 'tb-test'), undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
  const backups = (await fs.readdir(dir)).filter(f => f.startsWith('models.json.bak-taskbridge-'));
  assert.equal(backups.length, 2);
});
