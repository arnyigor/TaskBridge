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
  // Аналог Pi Manager: поля модели (compat, contextWindow, …) видны в списке,
  // иначе форма модели не сможет их показать. Секретов в модели нет.
  assert.deepEqual(list.providers[0].models, [{ id: 'real-model', compat: { special: true } }]);
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
  doc.providers['tb-test'].models[0].settings = { promptTemplate: 'Be brief.', timeoutMs: 15000 };
  await fs.writeFile(file, JSON.stringify(doc, null, 2));
  const latest = await service.list();
  const after = await service.upsert(draft(latest.revision, { models: [{ id: 'qwen/qwen3:27b' }] }));
  assert.equal(after.providers.find(p => p.id === 'tb-test').modelCount, 1);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(saved.providers['tb-test'].models[0].compat, { thinkingFormat: 'chat-template' });
  // Сохранение подключения не должно сбрасывать настройки модели, которые правит отдельный редактор.
  assert.deepEqual(saved.providers['tb-test'].models[0].settings, { promptTemplate: 'Be brief.', timeoutMs: 15000 });
  assert.notEqual(first.revision, after.revision);
});

// P0 из аудита: update провайдера не должен терять произвольные поля провайдера
// (ручная настройка совместимости, доп. заголовки, vendor-specific настройки).
test('upsert preserves unknown provider-level fields', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-upsert-fields-'));
  const file = path.join(dir, 'models.json');
  const original = {
    providers: {
      'tb-manual': {
        id: 'tb-manual', baseUrl: 'https://manual.example/v1', api: 'openai-completions',
        apiKey: '$TB_KEY', name: 'TaskBridge: tb-manual',
        customField: 'keep-me', extraHeaders: { 'X-Custom': 'header' }, compat: { special: true },
        models: [{ id: 'model-a' }],
      },
    },
  };
  await fs.writeFile(file, JSON.stringify(original, null, 2));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const service = new PiProviderProfiles({ agentDir: dir });
  const old = await service.list();
  const next = {
    id: 'tb-manual', baseUrl: 'https://manual.example/v1', keyEnv: 'TB_KEY',
    api: 'openai-completions', models: [{ id: 'model-a' }, { id: 'model-b' }],
  };
  const updated = await service.upsert({ ...next, revision: old.revision });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(updated.providers.find(p => p.id === 'tb-manual').managed, true);
  assert.deepEqual(saved.providers['tb-manual'].customField, 'keep-me');
  assert.deepEqual(saved.providers['tb-manual'].extraHeaders, { 'X-Custom': 'header' });
  assert.deepEqual(saved.providers['tb-manual'].compat, { special: true });
  assert.equal(saved.providers['tb-manual'].models.length, 2);
  assert.deepEqual(saved.providers['tb-manual'].apiKey, '$TB_KEY');
  assert.equal(saved.providers['tb-manual'].name, 'TaskBridge: tb-manual');
});

test('stale edits are rejected; non-owned entries cannot be adopted', async t => {
  const { dir, service } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const old = await service.list();
  await service.upsert(draft(old.revision));
  await rejectCode(service.upsert(draft(old.revision)), 'CONFLICT');
  // Чужой ID больше не отвергается по формату (префикс `tb-` снят), но и не
  // присваивается: запись с таким именем уже есть, и она не наша.
  await rejectCode(service.upsert(draft((await service.list()).revision, { id: 'existing' })), 'CONFLICT');
});

// Запрос оператора: чужое подключение тоже должно удаляться — с ревизией, копией
// файла и отказом по промаху в ID, но без «присвоения» чужой записи.
test('non-managed provider is deleted explicitly, stale revision and missing id are refused', async t => {
  const { dir, file, original, service } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { revision } = await service.list();
  const removed = await service.remove('existing', revision);
  assert.equal(removed.providers.find(p => p.id === 'existing'), undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { ...original, providers: {} });
  const backups = (await fs.readdir(dir)).filter(name => name.startsWith('models.json.bak-taskbridge-'));
  assert.equal(backups.length, 1, 'перед удалением снимается копия файла');
  const fresh = (await service.list()).revision;
  await rejectCode(service.remove('existing', fresh), 'NOT_FOUND');
  await service.upsert(draft((await service.list()).revision));
  await rejectCode(service.remove('tb-test', revision), 'CONFLICT');
  await rejectCode(service.remove('../secret', (await service.list()).revision), 'INPUT_INVALID');
  // Чужую запись по-прежнему нельзя переписать под себя: `existing` уже удалён
  // выше, поэтому чужая запись создаётся заново и проверяется на коллизию.
  await fs.writeFile(file, JSON.stringify({ providers: { ...original.providers, existing: original.providers.existing } }, null, 2));
  await rejectCode(service.upsert(draft((await service.list()).revision, { id: 'existing' })), 'CONFLICT');
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

// Пункт 2.3 плана, шаги 3–4: проверка черновика до сохранения. Адрес приходит от
// клиента, поэтому здесь же проверяется, что проверка не превращается в SSRF-ручку.
test('draft-check отдаёт каталог моделей и не идёт по redirect', async t => {
  const seen = [];
  const { dir } = await fixture({
    env: { TB_TEST_API_KEY: 'k' },
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), redirect: options?.redirect, auth: options?.headers?.Authorization ?? null });
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen/qwen3:27b', context_length: 32768 }, { id: 'openai/gpt-5' }] }) };
    },
  });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const service = new PiProviderProfiles({ agentDir: dir, env: { TB_TEST_API_KEY: 'k' }, fetchImpl: async (url, options) => {
    seen.push({ url: String(url), redirect: options?.redirect, auth: options?.headers?.Authorization ?? null });
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen/qwen3:27b', context_length: 32768 }, { id: 'openai/gpt-5' }] }) };
  } });

  const result = await service.draftCheck({ baseUrl: 'https://gateway.example/v1', keyEnv: 'TB_TEST_API_KEY' });
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map(model => model.id), ['qwen/qwen3:27b', 'openai/gpt-5']);
  assert.equal(result.models[0].contextWindow, 32768, 'размер контекста не теряется');
  assert.equal(seen[0].url, 'https://gateway.example/v1/models');
  assert.equal(seen[0].redirect, 'manual', 'за редиректом ходить нельзя');
  assert.equal(seen[0].auth, 'Bearer k');

  // 302 — отказ, а не поход на внутренний адрес.
  const redirecting = new PiProviderProfiles({ agentDir: dir, env: { TB_TEST_API_KEY: 'k' }, fetchImpl: async () => ({ ok: false, status: 302, json: async () => ({}) }) });
  const redirected = await redirecting.draftCheck({ baseUrl: 'https://gateway.example/v1', keyEnv: 'TB_TEST_API_KEY' });
  assert.equal(redirected.status, 'REDIRECT');
  assert.equal(redirected.ok, false);
});

test('draft-check отказывает опасным адресам и не подставляет ключ молча', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-provider-draft-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const service = new PiProviderProfiles({ agentDir: dir, env: {}, fetchImpl: async () => { throw new Error('ходить нельзя'); } });

  // Link-local (metadata облака), multicast, 0.0.0.0 и file: не проверяются вообще.
  for (const baseUrl of ['http://169.254.169.254/latest', 'https://169.254.169.254/v1', 'http://224.0.0.1/v1', 'http://0.0.0.0:8080/v1', 'file:///etc/passwd']) {
    await assert.rejects(service.draftCheck({ baseUrl }), error => error.code === 'INPUT_INVALID', baseUrl);
  }
  // Параметр keyEnv — имя переменной, а не секрет.
  await assert.rejects(service.draftCheck({ baseUrl: 'https://gateway.example/v1', keyEnv: 'sk-live-123' }), error => error.code === 'INPUT_INVALID');
  // Облачный провайдер без имени переменной не проверяется.
  await assert.rejects(service.draftCheck({ baseUrl: 'https://gateway.example/v1' }), error => error.code === 'INPUT_INVALID');
  // Имя есть, переменная не задана: честное NO_KEY без сетевого запроса.
  const missing = await service.draftCheck({ baseUrl: 'https://gateway.example/v1', keyEnv: 'TB_TEST_API_KEY' });
  assert.equal(missing.status, 'NO_KEY');
  assert.deepEqual(missing.models, []);
});

// Запрос оператора 2026-10-22: «нельзя удалить модель». Чужие записи TaskBridge
// не редактирует, но список моделей убрать можно — явно, с ревизией и бэкапом.
test('модель убирается из чужой записи, остальные поля не трогаются', async t => {
  const { dir, file, service } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(file, JSON.stringify({
    providers: {
      deepseek: {
        baseUrl: 'https://api.deepseek.com', api: 'openai-completions', apiKey: '$DEEPSEEK_API_KEY',
        models: [{ id: 'deepseek-flash', name: 'Flash' }, { id: 'deepseek-v4-pro', thinkingLevelMap: { max: 'max' } }],
      },
    },
  }, null, 2), 'utf8');
  const { revision } = await service.list();

  const result = await service.removeModels('deepseek', { models: ['deepseek-v4-pro'], revision });
  assert.deepEqual(result.removed, ['deepseek-v4-pro']);
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(doc.providers.deepseek.models, [{ id: 'deepseek-flash', name: 'Flash' }]);
  assert.equal(doc.providers.deepseek.apiKey, '$DEEPSEEK_API_KEY', 'ключ не тронут');
  assert.equal(doc.providers.deepseek.baseUrl, 'https://api.deepseek.com', 'адрес не тронут');
  const backups = (await fs.readdir(dir)).filter(name => name.startsWith('models.json.bak-'));
  assert.equal(backups.length, 1, 'перед записью снимается резервная копия');

  // Промах по ID и устаревшая ревизия отклоняются, файл не меняется.
  const fresh = (await service.list()).revision;
  await rejectCode(service.removeModels('deepseek', { models: ['нет-такой'], revision: fresh }), 'INPUT_INVALID');
  await rejectCode(service.removeModels('deepseek', { models: ['deepseek-flash'], revision: revision }), 'CONFLICT');
  await rejectCode(service.removeModels('absent-provider', { models: ['x'], revision: fresh }), 'NOT_FOUND');
  // Не-ASCII идентификатор — не имя провайдера Pi, а мусор из запроса.
  await rejectCode(service.removeModels('нет-провайдера', { models: ['x'], revision: fresh }), 'INPUT_INVALID');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).providers.deepseek.models, [{ id: 'deepseek-flash', name: 'Flash' }]);
});

// Шаг 02 плана: у модели есть собственный объект settings (промпт, таймаут, контекст,
// reasoning, cost), который сохраняется в models.json и не задевает остальные модели,
// адрес провайдера и ключ.
test('настройки модели сохраняются отдельно от адреса провайдера и его ключа', async t => {
  const { dir, file, service } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(file, JSON.stringify({
    providers: {
      'tb-local': {
        baseUrl: 'https://gateway.example/v1', api: 'openai-completions', apiKey: '$TB_KEY',
        name: 'TaskBridge: tb-local',
        models: [{ id: 'model-a' }, { id: 'model-b' }],
      },
    },
  }, null, 2), 'utf8');
  const { revision } = await service.list();
  const saved = await service.setModelSettings('tb-local', 'model-a', {
    promptTemplate: 'Answer briefly.', timeoutMs: 45000, contextWindow: 131072,
    reasoning: 'on', cost: { 'price-per-million-tokens': 0.5 },
  }, revision);
  assert.deepEqual(saved.providers[0].models.find(m => m.id === 'model-a').settings, {
    promptTemplate: 'Answer briefly.', timeoutMs: 45000, contextWindow: 131072,
    reasoning: 'on', cost: { 'price-per-million-tokens': 0.5 },
  });
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(doc.providers['tb-local'].models[0].settings.promptTemplate, 'Answer briefly.');
  assert.deepEqual(doc.providers['tb-local'].models[1], { id: 'model-b' }, 'соседняя модель не тронута');
  assert.equal(doc.providers['tb-local'].apiKey, '$TB_KEY', 'ключ не тронут');
  assert.equal(doc.providers['tb-local'].baseUrl, 'https://gateway.example/v1', 'адрес не тронут');
  assert.equal(doc.providers['tb-local'].name, 'TaskBridge: tb-local', 'имя записи не тронуто');

  // Устаревшая ревизия и промах по ID отклоняются, файл не меняется.
  await rejectCode(service.setModelSettings('tb-local', 'model-a', { timeoutMs: 1 }, revision), 'CONFLICT');
  const fresh = (await service.list()).revision;
  await rejectCode(service.setModelSettings('tb-local', 'нет-такой', {}, fresh), 'INPUT_INVALID');
  await rejectCode(service.setModelSettings('absent-provider', 'model-a', {}, fresh), 'NOT_FOUND');
  await rejectCode(service.setModelSettings('tb-local', 'model-a', [], fresh), 'INPUT_INVALID');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).providers['tb-local'].models[0].settings.timeoutMs, 45000);

  // Пустой объект — сброс: пустого «настроена» у модели остаться не должно.
  const resetRevision = (await service.list()).revision;
  const cleared = await service.setModelSettings('tb-local', 'model-a', {}, resetRevision);
  assert.equal(cleared.providers[0].models.find(m => m.id === 'model-a').settings, undefined);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).providers['tb-local'].models[0].settings, undefined);
});

// Оператор 2026-11-11: префикс `tb-` в имени провайдера — внутреннее соглашение,
// а не то, что человек должен набирать. ID без префикса принимается, владение
// по-прежнему доказывает маркер `name`, а старые `tb-*` остаются управляемыми.
test('id без префикса tb- принимается, старые tb-* остаются управляемыми', async t => {
  const { dir, service } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const revision = (await service.list()).revision;
  const saved = await service.upsert(draft(revision, { id: 'my-gateway' }));
  const plain = saved.providers.find(p => p.id === 'my-gateway');
  assert.equal(plain.managed, true);
  assert.equal(plain.baseUrl, 'https://gateway.example/v1');

  const after = await service.upsert(draft(saved.revision, { id: 'tb-legacy' }));
  assert.equal(after.providers.find(p => p.id === 'tb-legacy').managed, true);
  assert.equal(after.providers.find(p => p.id === 'my-gateway').managed, true);
});

// Причина «в выборе модели пишет None»: новая модель получала только `id`, без
// reasoning/thinkingLevelMap/compat, и supportedThinkingLevels отдавал один «off».
test('новые модели получают reasoning, thinkingLevelMap и compat из формы', async t => {
  const { dir, file, service } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const preset = {
    reasoning: true,
    thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, 'max*': null },
    compat: { thinkingFormat: 'chat-template', chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' } } },
  };
  const revision = (await service.list()).revision;
  await service.upsert(draft(revision, { id: 'local-llm', keyEnv: '', baseUrl: 'http://127.0.0.1:8083/v1', modelDefaults: preset }));

  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  const entry = doc.providers['local-llm'];
  assert.equal(entry.modelDefaults, undefined, 'modelDefaults — вход формы, а не поле провайдера');
  for (const model of entry.models) {
    assert.deepEqual(model, { ...preset, id: model.id });
  }
});

test('значения по умолчанию не перетирают настроенную вручную модель', async t => {
  const { dir, file, service } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const revision = (await service.list()).revision;
  await service.upsert(draft(revision, { id: 'hand-tuned', models: [{ id: 'm1' }] }));

  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  doc.providers['hand-tuned'].models[0].thinkingLevelMap = { off: null, low: 'custom' };
  await fs.writeFile(file, JSON.stringify(doc, null, 2));

  const before = (await service.list()).revision;
  await service.upsert({
    revision: before, id: 'hand-tuned', baseUrl: 'https://gateway.example/v1', keyEnv: 'TB_TEST_API_KEY',
    models: [{ id: 'm1' }, { id: 'm2' }],
    modelDefaults: { reasoning: true, thinkingLevelMap: { off: 'none' } },
  });

  const saved = JSON.parse(await fs.readFile(file, 'utf8')).providers['hand-tuned'];
  assert.deepEqual(saved.models[0].thinkingLevelMap, { off: null, low: 'custom' }, 'ручная настройка сохранена');
  assert.equal(saved.models[0].reasoning, true, 'недостающее поле добрано из формы');
  assert.deepEqual(saved.models[1], { reasoning: true, thinkingLevelMap: { off: 'none' }, id: 'm2' });
});

// Оператор видел в Pi служебную строку «TaskBridge: tb-local» вместо своего
// названия. Метка владения остаётся в начале `name`, человеческое название идёт
// после неё, и list() отдаёт его отдельным полем — при этом старая запись без
// названия остаётся управляемой.
test('человеческое название сохраняется и не ломает маркер владения', async t => {
  const { dir, file, service } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const revision = (await service.list()).revision;
  const saved = await service.upsert(draft(revision, { id: 'my-gateway', name: 'Мой  шлюз' }));
  const entry = saved.providers.find(p => p.id === 'my-gateway');
  assert.equal(entry.managed, true, 'владение по-прежнему определяется');
  assert.equal(entry.name, 'Мой шлюз');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).providers['my-gateway'].name, 'TaskBridge: my-gateway — Мой шлюз');

  // Пересохранение без названия не стирает его.
  const again = await service.upsert(draft((await service.list()).revision, { id: 'my-gateway', models: [{ id: 'm1' }] }));
  assert.equal(again.providers.find(p => p.id === 'my-gateway').name, 'Мой шлюз');

  // Старая запись без человеческого имени остаётся управляемой и без подписи.
  const legacy = await service.upsert(draft((await service.list()).revision, { id: 'tb-legacy' }));
  assert.equal(legacy.providers.find(p => p.id === 'tb-legacy').managed, true);
  assert.equal(legacy.providers.find(p => p.id === 'tb-legacy').name, null);
});

test('слишком длинное название отклоняется', async t => {
  const { dir, service } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const revision = (await service.list()).revision;
  await rejectCode(service.upsert(draft(revision, { id: 'too-long', name: 'x'.repeat(61) })), 'INPUT_INVALID');
});
