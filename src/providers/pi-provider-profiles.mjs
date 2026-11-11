/**
 * TaskBridge-managed Pi providers (first, intentionally narrow UI slice).
 *
 * Only `tb-*` entries are editable. Existing config entries may be explicitly
 * deleted with a revision and backup. API tokens are NEVER accepted: use $ENV_VAR references instead.
 * This adapter is deliberately replaceable by a future OMP adapter.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseProviderModels } from '../provider-models.mjs';
import { providerEndpoint as normalizedUrl } from '../../web/provider-endpoint.mjs';

// ID собственной записи. Префикс `tb-` больше не требуется: он был соглашением,
// а не защитой — владение доказывает маркер `name` (OWNED_NAME), а чужой ID
// по-прежнему не перезаписывается (см. upsert). Старые `tb-*` подходят под это же
// правило, поэтому существующие записи остаются управляемыми.
const ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const ENV = /^[A-Z][A-Z0-9_]{0,95}$/;
const MODEL_ID = /^[A-Za-z0-9_.:/+@-]{1,160}$/;
// ID провайдера в Pi: имена вида deepseek, llama.cpp, strata-ud-iq4xs — не только tb-*.
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_MODELS = 100;
// Pi models.json API identifiers (docs/models-configuration.md).
const APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages']);
function providerApi(value = 'openai-completions') {
  if (!APIS.has(value)) throw fail('INPUT_INVALID', 'Выберите поддерживаемый протокол API.');
  return value;
}
const authHeaders = (api, key) => api === 'anthropic-messages'
  ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
  : key ? { Authorization: `Bearer ${key}` } : {};
const OWNED_NAME = id => `TaskBridge: ${id}`;
// Метка владения — начало имени. Человеческое название идёт после « — », иначе
// оператор видел в Pi служебную строку «TaskBridge: tb-local» вместо своего имени.
const OWNED_PREFIX = id => `${OWNED_NAME(id)} — `;
const ownedName = (id, name) => (name ? OWNED_PREFIX(id) : OWNED_NAME(id)) + (name || '');
const isOwned = (id, entry) => typeof entry?.name === 'string'
  && (entry.name === OWNED_NAME(id) || entry.name.startsWith(OWNED_PREFIX(id)));
const humanName = (id, entry) => (typeof entry?.name === 'string' && entry.name.startsWith(OWNED_PREFIX(id))
  ? entry.name.slice(OWNED_PREFIX(id).length).trim() || null
  : null);
const MAX_BYTES = 4 * 1024 * 1024;
// Секретные значения в headers и литеральные ключи не покидают машину: клиент
// видит маркер и при записи возвращает его обратно, означающий «не менять».
const REDACTED = '$REDACTED';
const SECRETLIKE = value => typeof value === 'string' && value.length >= 24 && !value.startsWith('$');
const MAX_ENTRY_BYTES = 256 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });


function validateDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw fail('INPUT_INVALID', 'Требуется профиль провайдера.');
  const id = String(draft.id || '').trim();
  if (!ID.test(id)) throw fail('INPUT_INVALID', 'ID должен содержать только маленькие латинские буквы, цифры и дефисы и не начинаться/заканчиваться дефисом.');
  const { baseUrl, local } = normalizedUrl(draft.baseUrl);
  const rawEnv = String(draft.keyEnv || '').trim();
  if (rawEnv && !ENV.test(rawEnv)) throw fail('INPUT_INVALID', 'Укажите имя переменной окружения, не сам API-ключ.');
  if (!local && !rawEnv) throw fail('INPUT_INVALID', 'Для облачного провайдера требуется имя переменной окружения API-ключа.');
  if (!Array.isArray(draft.models) || draft.models.length < 1 || draft.models.length > MAX_MODELS) {
    throw fail('INPUT_INVALID', `Укажите от 1 до ${MAX_MODELS} моделей.`);
  }
  const unique = new Set();
  const models = draft.models.map((m) => {
    const modelId = typeof m === 'string' ? m.trim() : typeof m?.id === 'string' ? m.id.trim() : '';
    if (!MODEL_ID.test(modelId) || unique.has(modelId)) throw fail('INPUT_INVALID', `Некорректный или повторяющийся ID модели: ${modelId.slice(0, 100)}`);
    unique.add(modelId);
    return { id: modelId };
  });
  return {
    id, baseUrl, api: providerApi(draft.api), apiKey: rawEnv ? `$${rawEnv}` : 'local', models,
    modelDefaults: modelDefaults(draft.modelDefaults), displayName: displayName(draft.name),
  };
}

/**
 * Человеческое название записи — то, что оператор написал в форме.
 *
 * Отдельное поле модели не нужно: имя пишется в `name` после метки владения
 * (`TaskBridge: <id> — <название>`), поэтому маркер и подпись не конфликтуют.
 */
function displayName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) return null;
  if (name.length > 60) throw fail('INPUT_INVALID', 'Название подключения — не длиннее 60 символов.');
  if ([...name].some(ch => ch.codePointAt(0) < 32)) throw fail('INPUT_INVALID', 'В названии недопустимые символы.');
  return name;
}

/**
 * Поля модели, которые форма задаёт новым моделям сразу.
 *
 * Без них модель из models.json не умеет размышлять: `supportedThinkingLevels`
 * (src/model-catalog.mjs) видит `reasoning !== true` и отдаёт только «off», а
 * клиент честно подписывает его «None». Раньше новая модель получала один `id`,
 * и уровни размышлений у неё появлялись только после ручной правки JSON.
 *
 * Только allowlist: `reasoning`, `thinkingLevelMap`, `compat`. Применяется к
 * моделям, которых ещё нет в файле — настроенные вручную значения не трогаются.
 */
function modelDefaults(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw fail('INPUT_INVALID', 'Некорректные значения по умолчанию для моделей.');
  const out = {};
  if (value.reasoning !== undefined) {
    if (typeof value.reasoning !== 'boolean') throw fail('INPUT_INVALID', 'reasoning должен быть true или false.');
    out.reasoning = value.reasoning;
  }
  for (const key of ['thinkingLevelMap', 'compat']) {
    const field = value[key];
    if (field === undefined) continue;
    if (!field || typeof field !== 'object' || Array.isArray(field)) throw fail('INPUT_INVALID', `Некорректное поле ${key}.`);
    if (key === 'compat' && field.thinkingFormat !== undefined && typeof field.thinkingFormat !== 'string') {
      throw fail('INPUT_INVALID', 'compat.thinkingFormat должен быть строкой.');
    }
    out[key] = field;
  }
  return Object.keys(out).length ? out : null;
}

function publicView(id, entry, env) {
  // Explicit allowlist: model compat, headers and literal API secrets do not leak.
  const raw = typeof entry?.apiKey === 'string' ? entry.apiKey : '';
  const ref = /^\$([A-Z][A-Z0-9_]{0,95})$/.exec(raw);
  return {
    id, managed: isOwned(id, entry), name: humanName(id, entry),
    baseUrl: typeof entry?.baseUrl === 'string' ? entry.baseUrl : null,
    api: typeof entry?.api === 'string' ? entry.api : null,
    keyEnv: ref ? ref[1] : '',
    auth: raw === 'local' ? 'keyless-local' : ref ? (env[ref[1]] ? 'configured' : 'missing-env') : raw ? 'configured-elsewhere' : 'unknown',
    models: Array.isArray(entry?.models) ? entry.models.slice(0, MAX_MODELS).map((m) => {
      // Аналог Pi Manager: клиенту нужны редактируемые поля модели
      // (name, contextWindow, maxTokens, input, thinkingLevelMap, compat, …),
      // иначе форма не сможет их показать. Секретов в модели не бывает:
      // ключ жив¸т на уровне провайдера.
      const model = m && typeof m === 'object' && !Array.isArray(m) ? { ...m } : {};
      model.id = String(m?.id || '').slice(0, 160);
      return model;
    }) : [],
    modelCount: Array.isArray(entry?.models) ? entry.models.length : 0,
  };
}

async function readDocument(file) {
  let content;
  try { content = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    content = '{"providers":{}}\n';
  }
  if (Buffer.byteLength(content) > MAX_BYTES) throw fail('BODY_TOO_LARGE', 'models.json слишком велик для безопасного изменения.');
  let doc;
  try { doc = JSON.parse(content); } catch { throw fail('CONFLICT', 'models.json повреждён или некорректен; запись запрещена.'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !doc.providers || typeof doc.providers !== 'object' || Array.isArray(doc.providers)) {
    throw fail('CONFLICT', 'Неизвестный формат models.json; запись запрещена.');
  }
  return { doc, content, revision: crypto.createHash('sha256').update(content).digest('hex') };
}

export class PiProviderProfiles {
  #writing = Promise.resolve();
  constructor({ agentDir, env = process.env, fetchImpl = globalThis.fetch } = {}) {
    if (!agentDir) throw new Error('PiProviderProfiles requires agentDir');
    this.file = path.join(agentDir, 'models.json');
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  async list() {
    const { doc, revision } = await readDocument(this.file);
    const providers = Object.entries(doc.providers).map(([id, entry]) => publicView(id, entry, this.env));
    providers.sort((a, b) => Number(b.managed) - Number(a.managed) || a.id.localeCompare(b.id));
    return { revision, providers };
  }

  async upsert(body) {
    return this.#serialize(async () => {
      const next = validateDraft(body);
      const old = await readDocument(this.file);
      if (body.revision !== old.revision) throw fail('CONFLICT', 'Конфигурация изменилась. Обновите список и повторите правку.');
      const current = old.doc.providers[next.id];
      // Collision-safe: do not adopt or silently overwrite somebody else's provider.
      if (current && !isOwned(next.id, current)) {
        throw fail('CONFLICT', 'Этот ID занят чужим провайдером.');
      }
      const existingModels = new Map((Array.isArray(current?.models) ? current.models : []).map(m => [m?.id, m]));
      // Safe partial update: preserve every field of the current provider object that
      // TaskBridge does not control itself (hand-tuned compatibility, extra headers,
      // vendor-specific settings). Only controlled values are taken from the draft,
      // and the models list is rewritten from the draft IDs while keeping metadata
      // for unchanged model IDs.
      // `modelDefaults` — вход формы, а не поле провайдера в models.json.
      const { modelDefaults: defaults, displayName: label, ...fields } = next;
      // Название не передали (пересохранение формы или старый клиент) — сохраняем прежнее.
      const name = ownedName(next.id, label ?? humanName(next.id, current));
      old.doc.providers[next.id] = { ...current, ...fields, name,
        // Существующие модели сохраняют свои поля; новые получают значения формы,
        // иначе они остались бы без reasoning/thinkingLevelMap/compat.
        models: next.models.map(m => ({ ...(defaults || {}), ...(existingModels.get(m.id) || {}), id: m.id })),
      };
      await this.#write(old);
      return this.list();
    });
  }

  async remove(id, revision) {
    return this.#serialize(async () => {
      if (!PROVIDER_ID.test(id)) throw fail('INPUT_INVALID', 'Некорректный ID провайдера.');
      const old = await readDocument(this.file);
      if (revision !== old.revision) throw fail('CONFLICT', 'Конфигурация изменилась. Обновите список.');
      if (!Object.hasOwn(old.doc.providers, id)) throw fail('NOT_FOUND', 'Провайдер не найден в models.json.');
      delete old.doc.providers[id];
      await this.#write(old);
      return this.list();
    });
  }

  async check(id) {
    if (!ID.test(id)) throw fail('INPUT_INVALID', 'Некорректный ID.');
    const { doc } = await readDocument(this.file);
    const entry = doc.providers[id];
    if (!isOwned(id, entry)) throw fail('NOT_FOUND', 'Управляемый провайдер не найден.');
    const { baseUrl, local } = normalizedUrl(entry.baseUrl);
    const match = /^\$([A-Z][A-Z0-9_]{0,95})$/.exec(String(entry.apiKey || ''));
    const key = match ? this.env[match[1]] : null;
    if ((match || !local) && !key) return { ok: false, status: 'missing-key', note: 'Сначала задайте переменную окружения на компьютере и перезапустите сервер.' };
    const started = performance.now();
    try {
      const response = await this.fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        headers: authHeaders(entry.api, key),
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      await response.body?.cancel?.().catch(() => {});
      return {
        ok: response.ok, status: response.ok ? 'reachable' : `http-${response.status}`,
        httpStatus: response.status, ms: Math.round(performance.now() - started),
        note: 'Проверен только GET /models. Генерация модели не выполнялась.',
      };
    } catch (e) {
      return { ok: false, status: e.name === 'TimeoutError' ? 'timeout' : 'unreachable', ms: Math.round(performance.now() - started), note: 'Проверьте URL, DNS, TLS или доступность локального сервера.' };
    }
  }

  /**
   * Убрать модели из записи провайдера в models.json (запрос оператора 2026-10-22:
   * «нельзя удалить модель»). Касается ТОЛЬКО списка моделей: адрес, api, ключ и
   * прочие поля чужой записи остаются как были — их TaskBridge по-прежнему не
   * правит. Действие явное (оператор видит список ID и подтверждает), поэтому это
   * не «незаметная потеря чужих настроек»: перед записью снимается резервная копия,
   * запись идёт через ревизию файла (CAS), а промах по ID отклоняется.
   */
  async removeModels(id, { models = [], revision = null } = {}) {
    const providerId = String(id || '');
    if (!PROVIDER_ID.test(providerId)) throw fail('INPUT_INVALID', 'Некорректный ID провайдера.');
    const wanted = (Array.isArray(models) ? models : []).map(model => String(model?.id ?? model ?? '').trim()).filter(Boolean);
    if (!wanted.length) throw fail('INPUT_INVALID', 'Не указано ни одной модели.');
    if (wanted.length > MAX_MODELS) throw fail('INPUT_INVALID', `За один раз можно убрать не более ${MAX_MODELS} моделей.`);
    return this.#serialize(async () => {
      const old = await readDocument(this.file);
      if (revision !== old.revision) throw fail('CONFLICT', 'Конфигурация изменилась. Обновите список и повторите правку.');
      const entry = old.doc.providers[providerId];
      if (!entry) throw fail('NOT_FOUND', `Провайдера ${providerId} нет в models.json.`);
      const current = Array.isArray(entry.models) ? entry.models : [];
      const present = new Set(current.map(model => String(model?.id ?? '')));
      const missing = wanted.filter(modelId => !present.has(modelId));
      if (missing.length) throw fail('INPUT_INVALID', `Этих моделей нет у провайдера ${providerId}: ${missing.join(', ')}`);
      entry.models = current.filter(model => !wanted.includes(String(model?.id ?? '')));
      await this.#write(old);
      return { ...(await this.list()), removed: wanted };
    });
  }

  /**
   * Полная запись провайдера для редактора, аналога Pi Manager.
   *
   * Отдаются все поля записи (baseUrl, api, name, headers, compat, oauth, models
   * с их полями), КРОМЕ секретов: литеральный apiKey превращается в маркер
   * `$REDACTED`, секретоподобные значения headers — тоже.
   */
  async rawProvider(id) {
    const providerId = String(id || '');
    if (!PROVIDER_ID.test(providerId)) throw fail('INPUT_INVALID', 'Некорректный ID провайдера.');
    const { doc, revision } = await readDocument(this.file);
    const entry = doc.providers[providerId];
    if (!entry) throw fail('NOT_FOUND', `Провайдера ${providerId} нет в models.json.`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail('CONFLICT', 'Запись провайдера не объект.');
    const copy = JSON.parse(JSON.stringify(entry));
    const rawKey = typeof copy.apiKey === 'string' ? copy.apiKey : '';
    if (rawKey && !/^\$[A-Z][A-Z0-9_]{0,95}$/.test(rawKey) && rawKey !== 'local') copy.apiKey = REDACTED;
    if (copy.headers && typeof copy.headers === 'object') {
      for (const [name, value] of Object.entries(copy.headers)) {
        if (SECRETLIKE(value)) copy.headers[name] = REDACTED;
      }
    }
    return { revision, entry: copy };
  }

  /**
   * Полная замена записи провайдера из редактора.
   *
   * Ключ из UI не принимается: только `$ENV` или `local`. Маркер `$REDACTED`
   * означает «оставить прежнее значение» — так правка, например, headers не
   * затирает секрет, который клиент не видел.
   */
  async setProviderRaw(id, entry, revision) {
    const providerId = String(id || '');
    if (!PROVIDER_ID.test(providerId)) throw fail('INPUT_INVALID', 'Некорректный ID провайдера.');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail('INPUT_INVALID', 'Запись провайдера должна быть объектом.');
    if (Buffer.byteLength(JSON.stringify(entry)) > MAX_ENTRY_BYTES) throw fail('INPUT_INVALID', 'Запись провайдера слишком велика.');
    const next = JSON.parse(JSON.stringify(entry));
    delete next.id;
    if (next.baseUrl !== undefined) next.baseUrl = normalizedUrl(next.baseUrl).baseUrl;
    if (next.api !== undefined) next.api = providerApi(next.api);
    if (next.apiKey !== undefined) {
      const key = String(next.apiKey || '').trim();
      if (key && key !== 'local' && key !== REDACTED && !/^\$[A-Z][A-Z0-9_]{0,95}$/.test(key)) {
        throw fail('INPUT_INVALID', 'Ключ принимается только как $ПЕРЕМЕННАЯ или local, не как значение.');
      }
    }
    if (next.models !== undefined) {
      if (!Array.isArray(next.models) || next.models.length > MAX_MODELS) {
        throw fail('INPUT_INVALID', `Модели — массив до ${MAX_MODELS} записей.`);
      }
      const seen = new Set();
      next.models = next.models.map((model) => {
        if (!model || typeof model !== 'object' || Array.isArray(model)) throw fail('INPUT_INVALID', 'Модель должна быть объектом.');
        const modelId = String(model.id || '').trim();
        if (!MODEL_ID.test(modelId)) throw fail('INPUT_INVALID', `Некорректный ID модели: ${modelId.slice(0, 100)}`);
        if (seen.has(modelId)) throw fail('INPUT_INVALID', `Повторяющийся ID модели: ${modelId.slice(0, 100)}`);
        seen.add(modelId);
        return { ...model, id: modelId };
      });
    }
    return this.#serialize(async () => {
      const old = await readDocument(this.file);
      if (revision !== old.revision) throw fail('CONFLICT', 'Конфигурация изменилась. Обновите список и повторите правку.');
      const previous = old.doc.providers[providerId];
      if (!previous) throw fail('NOT_FOUND', `Провайдера ${providerId} нет в models.json.`);
      // Маркеры означают «не менять»: иначе правка формы стёрла бы секрет, которого клиент не видел.
      if (next.apiKey === REDACTED) next.apiKey = previous.apiKey;
      if (next.headers && typeof next.headers === 'object' && previous.headers && typeof previous.headers === 'object') {
        for (const [name, value] of Object.entries(next.headers)) {
          if (value === REDACTED && previous.headers[name] !== undefined) next.headers[name] = previous.headers[name];
        }
      }
      old.doc.providers[providerId] = next;
      await this.#write(old);
      return { ...(await this.list()), revision: (await readDocument(this.file)).revision };
    });
  }

  /**
   * Полная замена объекта ОДНОЙ модели (все поля: name, contextWindow, maxTokens,
   * input, reasoning, thinkingLevelMap, compat, samplingParams, …) — как в Pi Manager.
   * Смена `id` переименовывает модель, если новый ID свободен.
   */
  async setModelRaw(id, modelId, model, revision) {
    const providerId = String(id || '');
    if (!PROVIDER_ID.test(providerId)) throw fail('INPUT_INVALID', 'Некорректный ID провайдера.');
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw fail('INPUT_INVALID', 'Модель должна быть объектом.');
    const nextId = String(model.id || '').trim();
    if (!MODEL_ID.test(nextId)) throw fail('INPUT_INVALID', 'Некорректный ID модели.');
    if (Buffer.byteLength(JSON.stringify(model)) > MAX_ENTRY_BYTES) throw fail('INPUT_INVALID', 'Запись модели слишком велика.');
    return this.#serialize(async () => {
      const old = await readDocument(this.file);
      if (revision !== old.revision) throw fail('CONFLICT', 'Конфигурация изменилась. Обновите список и повторите правку.');
      const entry = old.doc.providers[providerId];
      if (!entry) throw fail('NOT_FOUND', `Провайдера ${providerId} нет в models.json.`);
      const models = Array.isArray(entry.models) ? entry.models : [];
      const index = models.findIndex((item) => String(item?.id ?? '') === String(modelId));
      if (index === -1) throw fail('INPUT_INVALID', `Модели ${modelId} нет у провайдера ${providerId}.`);
      if (nextId !== String(modelId) && models.some((item, at) => at !== index && String(item?.id ?? '') === nextId)) {
        throw fail('INPUT_INVALID', `У ${providerId} уже есть модель ${nextId}.`);
      }
      const clean = JSON.parse(JSON.stringify(model));
      clean.id = nextId;
      // `settings` остаётся отдельным объектом-настройкой: пустой — убираем, чтобы не
      // показывать «настроена» без настроек.
      if (clean.settings && typeof clean.settings === 'object' && !Array.isArray(clean.settings)
        && Object.keys(clean.settings).length === 0) delete clean.settings;
      models[index] = clean;
      entry.models = models;
      await this.#write(old);
      return { ...(await this.list()), revision: (await readDocument(this.file)).revision };
    });
  }

  /**
   * Индивидуальные настройки модели (шаг 02 плана). Правится ТОЛЬКО объект `settings`:
   * промпт, таймаут, контекстное окно, reasoning, cost и vendor-specific поля; ID модели,
   * ключ и адрес провайдера — вне зоны правки.
   */
  async setModelSettings(id, modelId, settings, revision) {
    const providerId = String(id || '');
    if (!PROVIDER_ID.test(providerId)) throw fail('INPUT_INVALID', 'Некорректный ID провайдера.');
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      throw fail('INPUT_INVALID', 'Настройки модели должны быть объектом (можно пустым {}).');
    }
    return this.#serialize(async () => {
      const old = await readDocument(this.file);
      if (revision !== old.revision) throw fail('CONFLICT', 'Конфигурация изменилась. Обновите список и повторите правку.');
      const entry = old.doc.providers[providerId];
      if (!entry) throw fail('NOT_FOUND', `Провайдера ${providerId} нет в models.json.`);
      const current = Array.isArray(entry.models) ? entry.models : [];
      const index = current.findIndex((model) => String(model?.id ?? '') === String(modelId));
      if (index === -1) throw fail('INPUT_INVALID', `Модели ${modelId} нет у провайдера ${providerId}.`);
      const clean = {};
      for (const [key, value] of Object.entries(settings)) {
        if (typeof value === 'object' || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          clean[key] = value;
        }
      }
      // Пустой объект — это сброс: у модели не должно остаться пустого «настроена».
      if (Object.keys(clean).length) current[index] = { ...current[index], settings: clean };
      else delete current[index].settings;
      await this.#write(old);
      return { ...(await this.list()) };
    });
  }

  /**
   * Проверка ЧЕРНОВИКА подключения — до сохранения (шаги 3–4 мастера): соединение,
   * ответ /models и каталог моделей для выбора.
   *
   * Адрес приходит от клиента, поэтому права и разбор URL те же, что у сохранения:
   * только localhost-администратор (проверяется на маршруте), только http(s), без
   * логина/пароля/query, служебные диапазоны запрещены, redirect не выполняется
   * (иначе проверка черновика стала бы SSRF-ручкой).
   */
  async draftCheck({ baseUrl, keyEnv = '', api = 'openai-completions', kind = 'remote', limit = 300 } = {}) {
    providerApi(api);
    const { baseUrl: url, local } = normalizedUrl(baseUrl);
    const rawEnv = String(keyEnv || '').trim();
    if (rawEnv && !ENV.test(rawEnv)) throw fail('INPUT_INVALID', 'Укажите имя переменной окружения, не сам API-ключ.');
    const key = rawEnv ? this.env[rawEnv] : null;
    // Локальный endpoint может быть без ключа; облачный без ключа не проверяем —
    // «нет ключа» это не «недоступен», и делать вид обратного нельзя.
    if (!local && !rawEnv) throw fail('INPUT_INVALID', 'Для облачного провайдера требуется имя переменной окружения API-ключа.');
    if (rawEnv && !key) return { ok: false, status: 'NO_KEY', code: 'NO_KEY', baseUrl: url, models: [], note: `Переменная ${rawEnv} не задана на компьютере или сервер запущен без неё.` };
    const started = performance.now();
    try {
      const response = await this.fetchImpl(`${url}/models`, {
        method: 'GET',
        headers: authHeaders(api, key),
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      const latencyMs = Math.round(performance.now() - started);
      if (response.status >= 300 && response.status < 400) {
        return { ok: false, status: 'REDIRECT', code: 'REDIRECT', httpStatus: response.status, latencyMs, baseUrl: url, models: [], note: 'Сервер перенаправляет запрос; переход по redirect не выполняется.' };
      }
      if (!response.ok) {
        return { ok: false, status: response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : response.status === 429 ? 'RATE_LIMITED' : `HTTP_${response.status}`, httpStatus: response.status, latencyMs, baseUrl: url, models: [], note: 'Проверен только GET /models. Генерация модели не выполнялась.' };
      }
      const payload = await response.json().catch(() => null);
      const models = parseProviderModels(payload).slice(0, Math.max(1, Math.min(500, Number(limit) || 300)));
      if (!models.length) {
        return { ok: false, status: 'UNSUPPORTED', code: 'NO_MODELS', httpStatus: response.status, latencyMs, baseUrl: url, models: [], note: 'Сервер ответил, но список моделей пуст или в незнакомом формате. ID можно ввести вручную.' };
      }
      return { ok: true, status: 'AVAILABLE', httpStatus: response.status, latencyMs, baseUrl: url, models, note: 'Проверен только GET /models. Генерация модели не выполнялась.' };
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return { ok: false, status: timeout ? 'TIMEOUT' : 'UNREACHABLE', code: timeout ? 'TIMEOUT' : 'UNREACHABLE', latencyMs: Math.round(performance.now() - started), baseUrl: url, models: [], note: 'Проверьте URL, DNS, TLS или доступность локального сервера.' };
    }
  }

  #serialize(work) {
    const run = this.#writing.then(work);
    this.#writing = run.catch(() => {});
    return run;
  }

  async #write(old) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const now = await readDocument(this.file);
    if (now.revision !== old.revision) throw fail('CONFLICT', 'models.json изменён сторонним процессом, запись отменена.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${this.file}.bak-taskbridge-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    const temp = `${this.file}.tb-${process.pid}-${crypto.randomBytes(5).toString('hex')}.tmp`;
    // Critical: a backup must be the source bytes, not reserialized JSON.
    const existed = await fs.stat(this.file).then(() => true, e => e.code === 'ENOENT' ? false : Promise.reject(e));
    if (existed) await fs.copyFile(this.file, backup, fs.constants.COPYFILE_EXCL);
    try {
      await fs.writeFile(temp, `${JSON.stringify(old.doc, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      // External editor race is not fully preventable without a common file lock.
      // We refuse to overwrite when we observe any external changes.
      const latest = await readDocument(this.file);
      if (latest.revision !== old.revision) throw fail('CONFLICT', 'Файл изменился во время записи.');
      await fs.rename(temp, this.file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
}
