// Мастер подключения провайдера (пункт 2.3 плана), шаги 4–6.
//
// Чистые функции, а не строки внутри providers.js: по предпросмотру оператор
// решает, записывать ли изменения в models.json, поэтому его содержимое и порядок
// отбора моделей должны проверяться тестом.

/** Шаги мастера — по одному предложению, чтобы экран не превращался в анкету. */
export const WIZARD_STEPS = Object.freeze([
  'Тип подключения',
  'Адрес и ключ',
  'Проверка',
  'Модели',
  'Предпросмотр',
  'Готово',
]);

/**
 * Поиск по найденному каталогу (шаг 4). Ищем по ID и названию, регистр не важен;
 * пустой запрос показывает всё, но не больше `limit` — провайдеры отвечают сотнями
 * моделей, и грузить их все в один список незачем.
 */
export function filterDiscoveredModels({ models = [], query = '', limit = 50 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const matched = (Array.isArray(models) ? models : []).filter(model => {
    if (!needle) return true;
    return String(model?.id || '').toLowerCase().includes(needle)
      || String(model?.name || '').toLowerCase().includes(needle);
  });
  return { matched, shown: matched.slice(0, Math.max(1, limit)), total: matched.length };
}

/** Сколько ещё можно отметить: сервер принимает не больше 100 моделей на подключение. */
export const WIZARD_MODEL_LIMIT = 100;

/**
 * Отметка модели: возвращает новый список выбранных ID, не меняя порядок выбора.
 * Сверх лимита выбор не расширяется — молча обрезать чужой выбор хуже, чем не дать.
 */
export function toggleDiscoveredModel(selected = [], id, { limit = WIZARD_MODEL_LIMIT } = {}) {
  const value = String(id || '');
  if (!value) return { selected: [...selected], added: false, reason: 'empty' };
  if (selected.includes(value)) return { selected: selected.filter(entry => entry !== value), added: false };
  if (selected.length >= limit) return { selected: [...selected], added: false, reason: 'limit' };
  return { selected: [...selected, value], added: true };
}

/**
 * Предпросмотр записи (шаг 5): ровно то, что уйдёт в models.json, без секретов.
 * Секрета здесь нет по построению — в файл пишется только имя переменной.
 */
export function draftPreviewText({ id, baseUrl, keyEnv, models = [] } = {}) {
  const name = String(id || '').trim() || '—';
  const url = String(baseUrl || '').trim() || '—';
  const env = String(keyEnv || '').trim();
  const count = Array.isArray(models) ? models.length : 0;
  const key = env ? `ключ из переменной ${env}` : 'без ключа (локальный сервер)';
  const list = count ? [...models].slice(0, 5).map(model => (typeof model === 'string' ? model : model?.id)).filter(Boolean).join(', ') : '—';
  const tail = count > 5 ? ` и ещё ${count - 5}` : '';
  return `Будет записано: ${name} → ${url}, ${key}. Моделей: ${count}. ${list}${tail}`;
}

/** Когда мастер считает черновик пригодным к записи — те же правила, что у сервера. */
export function draftReady({ id, baseUrl, keyEnv, models = [] } = {}) {
  const readyId = /^tb-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(String(id || '').trim());
  const url = String(baseUrl || '').trim();
  const readyUrl = /^https?:\/\//.test(url);
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
  const readyKey = local || /^[A-Z][A-Z0-9_]{0,95}$/.test(String(keyEnv || '').trim());
  const readyModels = Array.isArray(models) && models.length >= 1 && models.length <= WIZARD_MODEL_LIMIT;
  return Boolean(readyId && readyUrl && readyKey && readyModels) && !/^tb-$/.test(String(id || '').trim());
}

/**
 * Итог (шаг 6): что произошло и что делать дальше. Отдельно — нужен ли перезапуск
 * сервера: без него новый ключ из переменной окружения не появится в процессе.
 */
export function wizardResultText({ id, keyEnv = '', changed = false, modelCount = 0 } = {}) {
  const name = String(id || '').trim() || 'подключение';
  const head = changed ? `Подключение ${name} сохранено` : `Подключение ${name} не изменено`;
  const parts = [head];
  if (modelCount) parts.push(`моделей: ${modelCount}`);
  if (keyEnv) parts.push(`задайте переменную ${keyEnv} в процессе запуска TaskBridge и перезапустите сервер, иначе ключ не подхватится`);
  parts.push('обновите каталог моделей, чтобы новые модели появились в списке выбора');
  return `${parts.join('. ')}.`;
}
