/**
 * Named model presets (step 03 of the model-management plan).
 *
 * Одна и та же модель нужна по-разному: «быстрый» профиль — короткий таймаут и без
 * reasoning, «глубокий» — долгий таймаут и reasoning on. Такие наборы живут в
 * отдельном файле рядом с models.json (`model-profiles.json`), а НЕ в конфиге Pi:
 * Pi не обязан понимать незнакомые ключи в `models.json`, и правка пресета не должна
 * выглядеть как правка подключения.
 *
 * Файл необязателен: пока его нет, `list()` отвечает пустым списком. Запись — только
 * по ревизии файла (CAS), с резервной копией прежних байтов, как у models.json.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE_NAME = 'model-profiles.json';
const ID = /^p-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;// Те же ограничения, что у моделей провайдера: ID из models.json и из /models.
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9_.:/+@-]{1,160}$/;
const MAX_PROFILES = 200;
const MAX_BYTES = 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });

async function readDocument(file) {
  let content;
  try { content = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    content = '{"profiles":{}}\n';
  }
  if (Buffer.byteLength(content) > MAX_BYTES) throw fail('BODY_TOO_LARGE', 'model-profiles.json слишком велик для безопасного изменения.');
  let doc;
  try { doc = JSON.parse(content); } catch { throw fail('CONFLICT', 'model-profiles.json повреждён; запись запрещена.'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !doc.profiles || typeof doc.profiles !== 'object' || Array.isArray(doc.profiles)) {
    throw fail('CONFLICT', 'Неизвестный формат model-profiles.json; запись запрещена.');
  }
  return { doc, revision: crypto.createHash('sha256').update(content).digest('hex') };
}

/** ID профиля: клиент может задать свой, иначе — случайный от сервера (без молчаливой перезаписи). */

/**
 * Единственное место, где решается судьба профиля.
 *
 * `id` можно не передавать — тогда сервер выдаёт свой (`p-` + случайные hex).
 * Молчаливой перезаписи при этом нет: дубликат имени ловится по
 * (провайдер, модель, имя) и отклоняется, а правка идёт только явным id.
 */
function validateDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw fail('INPUT_INVALID', 'Требуется профиль модели.');
  const name = String(draft.name || '').trim();
  if (name.length < 1 || name.length > 60) throw fail('INPUT_INVALID', 'Имя профиля — от 1 до 60 символов.');
  const providerId = String(draft.providerId || '').trim();
  if (!PROVIDER_ID.test(providerId)) throw fail('INPUT_INVALID', 'Некорректный ID провайдера.');
  const modelId = String(draft.modelId || '').trim();
  if (!MODEL_ID.test(modelId)) throw fail('INPUT_INVALID', 'Некорректный ID модели.');
  const settings = draft.settings ?? {};
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw fail('INPUT_INVALID', 'Настройки профиля должны быть объектом.');
  }
  const clean = {};
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'object' || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
  }
  const id = String(draft.id || '').trim() || `p-${crypto.randomBytes(5).toString('hex')}`;
  if (!ID.test(id)) throw fail('INPUT_INVALID', 'ID профиля должен содержать только латинские буквы, цифры и дефисы.');
  return { id, name, providerId, modelId, enabled: draft.enabled !== false, settings: clean };
}

function publicView(id, entry) {
  return {
    id,
    name: typeof entry?.name === 'string' ? entry.name : id,
    providerId: typeof entry?.providerId === 'string' ? entry.providerId : '',
    modelId: typeof entry?.modelId === 'string' ? entry.modelId : '',
    enabled: entry?.enabled !== false,
    settings: entry?.settings && typeof entry.settings === 'object' ? entry.settings : {},
    updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : null,
  };
}

export class ModelProfiles {
  #writing = Promise.resolve();
  constructor({ agentDir } = {}) {
    if (!agentDir) throw new Error('ModelProfiles requires agentDir');
    this.file = path.join(agentDir, FILE_NAME);
  }

  async list() {
    const { doc, revision } = await readDocument(this.file);
    const profiles = Object.entries(doc.profiles)
      .map(([id, entry]) => publicView(id, entry))
      .sort((a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId) || a.name.localeCompare(b.name));
    return { revision, profiles };
  }

  async upsert(body = {}) {
    return this.#serialize(async () => {
      const next = validateDraft(body);
      const old = await readDocument(this.file);
      if (body.revision !== old.revision) throw fail('CONFLICT', 'Профили изменились. Обновите список и повторите правку.');
      if (!Object.hasOwn(old.doc.profiles, next.id) && Object.keys(old.doc.profiles).length >= MAX_PROFILES) {
        throw fail('INPUT_INVALID', `Не больше ${MAX_PROFILES} профилей.`);
      }
      // Одно имя на пару провайдер+модель: иначе «Быстрый» перестаёт быть однозначным.
      const clash = Object.entries(old.doc.profiles).find(([id, entry]) => id !== next.id
        && entry?.providerId === next.providerId && entry?.modelId === next.modelId
        && String(entry?.name || '').toLowerCase() === next.name.toLowerCase());
      if (clash) throw fail('CONFLICT', `У ${next.providerId}/${next.modelId} уже есть профиль «${next.name}».`);
      const now = new Date().toISOString();
      old.doc.profiles[next.id] = {
        name: next.name,
        providerId: next.providerId,
        modelId: next.modelId,
        enabled: next.enabled,
        settings: next.settings,
        createdAt: old.doc.profiles[next.id]?.createdAt ?? now,
        updatedAt: now,
      };
      await this.#write(old);
      return this.list();
    });
  }

  async remove(id, revision) {
    return this.#serialize(async () => {
      if (!ID.test(String(id || ''))) throw fail('INPUT_INVALID', 'Некорректный ID профиля.');
      const old = await readDocument(this.file);
      if (revision !== old.revision) throw fail('CONFLICT', 'Профили изменились. Обновите список.');
      if (!Object.hasOwn(old.doc.profiles, id)) throw fail('NOT_FOUND', 'Профиль не найден.');
      delete old.doc.profiles[id];
      await this.#write(old);
      return this.list();
    });
  }

  #serialize(work) {
    const run = this.#writing.then(work);
    this.#writing = run.catch(() => {});
    return run;
  }

  async #write(old) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const now = await readDocument(this.file);
    if (now.revision !== old.revision) throw fail('CONFLICT', 'model-profiles.json изменён сторонним процессом, запись отменена.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${this.file}.bak-taskbridge-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    const temp = `${this.file}.tb-${process.pid}-${crypto.randomBytes(5).toString('hex')}.tmp`;
    // Копия — исходные байты, а не пересобранный JSON.
    const existed = await fs.stat(this.file).then(() => true, e => e.code === 'ENOENT' ? false : Promise.reject(e));
    if (existed) await fs.copyFile(this.file, backup, fs.constants.COPYFILE_EXCL);
    try {
      await fs.writeFile(temp, `${JSON.stringify(old.doc, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      const latest = await readDocument(this.file);
      if (latest.revision !== old.revision) throw fail('CONFLICT', 'Файл изменился во время записи.');
      await fs.rename(temp, this.file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
}
