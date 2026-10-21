// Правила выбора модели для Web-пикера: поиск, фильтры, сортировка и хранение
// избранного. Модуль намеренно чистый — ни DOM, ни сети, ни localStorage:
// правила проверяются тестами без браузера, а страница только рисует результат.
//
// Источник данных — ответ `GET /api/models` (проекция каталога Pi). Возможности
// модели приходят от Pi как boolean; здесь «неизвестно» никогда не считается
// «есть»: фильтр оставляет только модели с явным `true`.

/** Ключ localStorage для избранного. Префикс как у остальных предпочтений Web. */
export const FAVORITES_KEY = 'taskbridge.favoriteModels';
export const MAX_FAVORITES = 5000;

/**
 * Возможности, которые умеет фильтровать пикер. Ключ — поле модели в `/api/models`.
 * Метка показывается в чипе; неизвестные ключи фильтр игнорирует.
 */
export const CAPABILITIES = Object.freeze([
  { key: 'images', label: 'Vision' },
  { key: 'tools', label: 'Tools' },
  { key: 'reasoning', label: 'Thinking' },
]);

/** Составной ключ `provider/id`: одноимённые модели разных провайдеров не сливаются. */
export function modelKey(model) {
  const id = String(model?.id ?? '').trim();
  if (!id) return '';
  return `${String(model?.provider ?? '').trim()}/${id}`;
}

/** Текст, по которому ищет поиск: провайдер, id и человеческое имя. */
export function modelSearchText(model) {
  return [model?.provider, model?.id, model?.name]
    .filter(value => typeof value === 'string' && value)
    .join(' ')
    .toLowerCase();
}

/** Поиск словами: каждое слово должно найтись («deepseek flash» — да, «deepseek xyz» — нет). */
export function searchTokens(query) {
  return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

export function matchesQuery(model, tokens) {
  const words = Array.isArray(tokens) ? tokens : searchTokens(tokens);
  if (!words.length) return true;
  const haystack = modelSearchText(model);
  return words.every(word => haystack.includes(word));
}

/** Возможность подтверждена, только если API прислал именно `true`. */
export function hasCapability(model, key) {
  return Boolean(key) && model?.[key] === true;
}

/**
 * Возможности, для которых в каталоге есть хотя бы одна подтверждённая модель.
 * Пустой список означает «метаданных нет» — чипы фильтра тогда не показываются,
 * и пикер не обещает фильтров, которых не из чего построить.
 */
export function availableCapabilities(models) {
  const list = Array.isArray(models) ? models : [];
  return CAPABILITIES
    .filter(capability => list.some(model => hasCapability(model, capability.key)))
    .map(capability => capability.key);
}

/** Провайдеры каталога с числом моделей — для выпадающего фильтра. */
export function providersOf(models) {
  const counts = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const provider = String(model?.provider ?? '').trim();
    if (!provider) continue;
    counts.set(provider, (counts.get(provider) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([provider, count]) => ({ provider, count }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Локальные/облачные: единственный достоверный признак — флаг `local` от сервера. */
export function matchesScope(model, scope) {
  if (scope === 'local') return model?.local === true;
  if (scope === 'cloud') return model?.local !== true;
  return true;
}

function favoriteSetOf(favorites) {
  if (favorites instanceof Set) return favorites;
  if (Array.isArray(favorites)) return new Set(favorites.filter(key => typeof key === 'string'));
  return new Set();
}

export function isFavorite(model, favorites) {
  const key = modelKey(model);
  return Boolean(key) && favoriteSetOf(favorites).has(key);
}

/** Новое множество избранного: добавление и снятие одним действием. */
export function toggleFavorite(favorites, key) {
  const next = new Set(favoriteSetOf(favorites));
  if (!key) return next;
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Фильтр каталога. Возвращает новый массив и ничего не меняет на входе;
 * выбранная модель (состояние сессии) фильтрацией не затрагивается.
 */
export function filterModels(models, options = {}) {
  const list = Array.isArray(models) ? models : [];
  const {
    query = '',
    provider = '',
    scope = 'all',
    capabilities = [],
    favoritesOnly = false,
    favorites = null,
  } = options;
  const tokens = searchTokens(query);
  const required = (Array.isArray(capabilities) ? capabilities : [])
    .filter(key => CAPABILITIES.some(capability => capability.key === key));
  const favoriteSet = favoriteSetOf(favorites);
  const wantedProvider = String(provider ?? '').trim();
  return list.filter(model => {
    if (wantedProvider && String(model?.provider ?? '').trim() !== wantedProvider) return false;
    if (!matchesScope(model, scope)) return false;
    if (favoritesOnly && !favoriteSet.has(modelKey(model))) return false;
    if (required.length && !required.every(key => hasCapability(model, key))) return false;
    return matchesQuery(model, tokens);
  });
}

/**
 * Порядок: избранные, затем локальные, затем остальные — внутри каждой группы
 * исходный порядок каталога сохраняется (устойчивая сортировка).
 */
export function sortModels(models, favorites = null) {
  const list = Array.isArray(models) ? models : [];
  const favoriteSet = favoriteSetOf(favorites);
  const pinned = [];
  const local = [];
  const rest = [];
  for (const model of list) {
    if (favoriteSet.has(modelKey(model))) pinned.push(model);
    else if (model?.local === true) local.push(model);
    else rest.push(model);
  }
  return [...pinned, ...local, ...rest];
}

/** Фильтр + порядок одним вызовом — то, что рисует пикер. */
export function selectModels(models, options = {}) {
  return sortModels(filterModels(models, options), options.favorites);
}

/** Русская форма слова «модель» — чтобы «1 модель», «2 модели», «552 модели». */
export function plural(n) {
  const value = Math.abs(Number(n) || 0) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return 'моделей';
  if (last === 1) return 'модель';
  if (last >= 2 && last <= 4) return 'модели';
  return 'моделей';
}

/** Счётчик под заголовком: сколько показано из всего каталога. */
export function describeCount(shown, total) {
  const visible = Number(shown) || 0;
  const all = Number(total) || 0;
  if (!all) return '';
  const word = plural(all);
  return visible === all ? `${all} ${word}` : `${visible} из ${all} ${word}`;
}

/** Текст пустого результата: «ничего не нашлось» — это не «нет каталога». */
export function describeEmpty({ total = 0, hasFilters = false } = {}) {
  if (!(Number(total) > 0)) return 'Pi не вернул ни одной доступной модели.';
  return hasFilters ? 'Ничего не найдено. Сбросьте фильтры.' : 'Ничего не найдено.';
}

/** Есть ли хоть один активный фильтр (синоним — «показывать только избранное»). */
export function hasActiveFilters(options = {}) {
  return Boolean(
    searchTokens(options.query).length
    || String(options.provider ?? '').trim()
    || (options.scope && options.scope !== 'all')
    || (Array.isArray(options.capabilities) && options.capabilities.length)
    || options.favoritesOnly === true
  );
}

/**
 * Разбор сохранённого избранного. Повреждённое или чужое значение — пустое
 * множество, а не исключение: сломанный localStorage не должен ломать пикер.
 */
export function parseFavorites(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return new Set();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return new Set(); }
  if (!Array.isArray(parsed)) return new Set();
  const set = new Set();
  for (const item of parsed.slice(0, MAX_FAVORITES)) {
    if (typeof item !== 'string') continue;
    const key = item.trim();
    if (!key || key.length > 300 || !key.includes('/')) continue;
    set.add(key);
  }
  return set;
}

/** Стабильная запись: отсортированный JSON, чтобы значение не «дёргалось». */
export function serializeFavorites(favorites) {
  const keys = [...favoriteSetOf(favorites)]
    .filter(key => typeof key === 'string' && key.includes('/'))
    .sort()
    .slice(0, MAX_FAVORITES);
  return JSON.stringify(keys);
}

/** Чтение из хранилища браузера; недоступное хранилище — пустое множество. */
export function loadFavorites(storage) {
  try {
    return parseFavorites(storage?.getItem?.(FAVORITES_KEY) ?? null);
  } catch {
    return new Set();
  }
}

/** Запись в хранилище. Отказ хранилища не мешает работе, но виден по `false`. */
export function saveFavorites(storage, favorites) {
  try {
    storage?.setItem?.(FAVORITES_KEY, serializeFavorites(favorites));
    return true;
  } catch {
    return false;
  }
}
