// Скрытые провайдеры и модели: кто из каталога Pi не показывается в выборе
// модели и в управлении. Отдельный файл в data/, потому что models.json —
// файл Pi, а enabledModels в settings.json имеет другое назначение (закреплённые).
// Правки ревизионные и с резервной копией — как у pi-provider-profiles.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY = { hiddenProviders: [], hiddenModels: [] };

function revisionOf(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 20);
}

function normalize(hidden = {}) {
  const list = (value) => (Array.isArray(value) ? value : [])
    .map(v => String(v).trim()).filter(Boolean);
  return {
    hiddenProviders: [...new Set(list(hidden.hiddenProviders))].sort(),
    hiddenModels: [...new Set(list(hidden.hiddenModels))].sort(),
  };
}

/** Плоский вид для клиента: ModelVisibility в Models.kt знает эти поля верхнего уровня. */
function publicView(revision, hidden) {
  return { revision, hiddenProviders: hidden.hiddenProviders, hiddenModels: hidden.hiddenModels };
}

export class ModelVisibility {
  constructor({ dataRoot }) {
    if (!dataRoot) throw new Error('ModelVisibility requires dataRoot');
    this.file = path.join(dataRoot, 'hidden-models.json');
  }

  /** Текущий список и ревизия файла. Пустой список при отсутствии файла — не ошибка. */
  async read() {
    const { revision, hidden } = await this.#readRaw();
    return publicView(revision, hidden);
  }

  async #readRaw() {
    let text;
    try { text = await fs.readFile(this.file, 'utf8'); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return { revision: revisionOf(JSON.stringify(EMPTY)), hidden: EMPTY };
    }
    return { revision: revisionOf(text), hidden: normalize(JSON.parse(text)) };
  }

  /** Полная замена списка. `revision` — текущая, иначе 409: конкурирующая правка. */
  async replace(hidden, revision) {
    const { revision: current, hidden: existing } = await this.#readRaw();
    if (revision != null && revision !== current) {
      throw Object.assign(new Error('Список скрытых изменился параллельно — обновите.'), { code: 'REVISION_CONFLICT' });
    }
    const next = normalize(hidden);
    if (JSON.stringify(next) === JSON.stringify(existing)) return publicView(current, existing);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const text = JSON.stringify(next, null, 2) + '\n';
    await fs.copyFile(this.file, this.file + '.bak').catch(() => {});
    await fs.writeFile(this.file, text);
    return publicView(revisionOf(text), next);
  }
}

/** Фильтр каталога: скрытый провайдер убирает все свои модели, скрытая модель — одну. */
export function filterHidden(models, hidden) {
  const normalized = normalize(hidden);
  const providers = new Set(normalized.hiddenProviders);
  const hiddenModels = new Set(normalized.hiddenModels);
  return (models || []).filter(m =>
    !providers.has(m?.provider) && !hiddenModels.has(`${m?.provider ?? ''}/${m?.id ?? ''}`));
}
