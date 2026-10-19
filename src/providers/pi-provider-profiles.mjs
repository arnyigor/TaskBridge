/**
 * TaskBridge-managed Pi providers (first, intentionally narrow UI slice).
 *
 * Only `tb-*` entries are writable.  Existing/built-in/custom providers remain
 * untouched.  API tokens are NEVER accepted: use $ENV_VAR references instead.
 * This adapter is deliberately replaceable by a future OMP adapter.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ID = /^tb-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const ENV = /^[A-Z][A-Z0-9_]{0,95}$/;
const MODEL_ID = /^[A-Za-z0-9_.:/+@-]{1,160}$/;
const MAX_MODELS = 100;
const OWNED_NAME = id => `TaskBridge: ${id}`;
const isOwned = (id, entry) => ID.test(id) && entry?.name === OWNED_NAME(id);
const MAX_BYTES = 4 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });

function normalizedUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 512) throw fail('INPUT_INVALID', 'Некорректный адрес сервера модели.');
  let url;
  try { url = new URL(raw.trim()); } catch { throw fail('INPUT_INVALID', 'Некорректный URL.'); }
  if (url.username || url.password || url.hash || url.search || !url.hostname || !['https:', 'http:'].includes(url.protocol)) {
    throw fail('INPUT_INVALID', 'Используйте URL HTTP(S) без логина, пароля, query и fragment.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipv4 = host.split('.').map(Number);
  const localV4 = ipv4.length === 4 && ipv4.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (ipv4[0] === 10 || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168) || ipv4[0] === 127);
  const local = host === 'localhost' || host === '::1' || localV4;
  if (url.protocol === 'http:' && !local) throw fail('INPUT_INVALID', 'Обычный HTTP допустим только для localhost и локальных IPv4-адресов.');
  if (url.protocol === 'http:' && !localV4 && host !== 'localhost' && host !== '::1') throw fail('INPUT_INVALID', 'Локальный адрес не поддерживается.');
  const result = url.toString().replace(/\/+$/, '');
  if (result.length > 512) throw fail('INPUT_INVALID', 'Слишком длинный URL.');
  return { baseUrl: result, local };
}

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
  return { id, baseUrl, api: 'openai-completions', apiKey: rawEnv ? `$${rawEnv}` : 'local', models };
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
      if (!ID.test(id)) throw fail('INPUT_INVALID', 'Это не управляемый провайдер.');
      const old = await readDocument(this.file);
      if (revision !== old.revision) throw fail('CONFLICT', 'Конфигурация изменилась. Обновите список.');
      if (!isOwned(id, old.doc.providers[id])) throw fail('NOT_FOUND', 'Управляемый провайдер не найден.');
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
    if (!local && !key) return { ok: false, status: 'missing-key', note: 'Сначала задайте переменную окружения на компьютере и перезапустите сервер.' };
    const started = performance.now();
    try {
      const response = await this.fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        headers: key ? { Authorization: `Bearer ${key}` } : {},
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
