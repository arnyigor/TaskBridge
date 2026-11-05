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

const ID = /^tb-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
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
const isOwned = (id, entry) => ID.test(id) && entry?.name === OWNED_NAME(id);
const MAX_BYTES = 4 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });


function validateDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw fail('INPUT_INVALID', 'Требуется профиль провайдера.');
  const id = String(draft.id || '').trim();
  if (!ID.test(id)) throw fail('INPUT_INVALID', 'ID должен начинаться с tb- и содержать только маленькие латинские буквы, цифры и дефисы.');
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
  return { id, baseUrl, api: providerApi(draft.api), apiKey: rawEnv ? `$${rawEnv}` : 'local', models };
}

function publicView(id, entry, env) {
  // Explicit allowlist: model compat, headers and literal API secrets do not leak.
  const raw = typeof entry?.apiKey === 'string' ? entry.apiKey : '';
  const ref = /^\$([A-Z][A-Z0-9_]{0,95})$/.exec(raw);
  return {
    id, managed: isOwned(id, entry), baseUrl: typeof entry?.baseUrl === 'string' ? entry.baseUrl : null,
    api: typeof entry?.api === 'string' ? entry.api : null,
    keyEnv: ref ? ref[1] : '',
    auth: raw === 'local' ? 'keyless-local' : ref ? (env[ref[1]] ? 'configured' : 'missing-env') : raw ? 'configured-elsewhere' : 'unknown',
    models: Array.isArray(entry?.models) ? entry.models.slice(0, MAX_MODELS).map(m => ({ id: String(m?.id || '').slice(0, 160) })) : [],
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
      if (current && !(ID.test(next.id) && isOwned(next.id, current))) {
        throw fail('CONFLICT', 'Этот ID занят чужим провайдером.');
      }
      const existingModels = new Map((Array.isArray(current?.models) ? current.models : []).map(m => [m?.id, m]));
      old.doc.providers[next.id] = {
        ...next,
        name: OWNED_NAME(next.id),
        // Preserve existing hand-tuned metadata for unchanged models.
        models: next.models.map(m => ({ ...(existingModels.get(m.id) || {}), id: m.id })),
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
