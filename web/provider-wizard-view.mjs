// Мастер подключения провайдера (пункт 2.3 плана), шаги 4–6.
//
// Чистые функции, а не строки внутри providers.js: по предпросмотру оператор
// решает, записывать ли изменения в models.json, поэтому его содержимое и порядок
// отбора моделей должны проверяться тестом.

import { providerEndpoint } from './provider-endpoint.mjs';

export const PROVIDER_APIS = Object.freeze({
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
});

export const PROVIDER_PRESETS = Object.freeze({
  custom: { id: 'tb-', baseUrl: '', keyEnv: '', api: 'openai-completions' },
  local: { id: 'tb-local', baseUrl: 'http://127.0.0.1:8083/v1', keyEnv: '', api: 'openai-completions' },
  lmstudio: { id: 'tb-lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', keyEnv: '', api: 'openai-completions' },
  ollama: { id: 'tb-ollama', baseUrl: 'http://127.0.0.1:11434/v1', keyEnv: '', api: 'openai-completions' },
  llamacpp: { id: 'tb-llamacpp', baseUrl: 'http://127.0.0.1:8080/v1', keyEnv: '', api: 'openai-completions' },
  openrouter: { id: 'tb-openrouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', api: 'openai-completions' },
  openai: { id: 'tb-openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', api: 'openai-responses' },
  anthropic: { id: 'tb-anthropic', baseUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY', api: 'anthropic-messages' },
});

export function endpointHint(raw) {
  try {
    const { baseUrl, local } = providerEndpoint(raw);
    return `${baseUrl} — ${local ? 'локальный/LAN API; ключ может быть пустым' : 'публичный API; HTTPS и переменная с ключом обязательны'}. Адрес открывает компьютер сервера TaskBridge, не телефон.`;
  } catch (error) { return error.message; }
}

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
export function draftPreviewText({ id, baseUrl, keyEnv, api = 'openai-completions', models = [] } = {}) {
  const name = String(id || '').trim() || '—';
  let url = String(baseUrl || '').trim() || '—';
  try { url = providerEndpoint(baseUrl).baseUrl; } catch { /* validation is shown by endpointHint */ }
  const env = String(keyEnv || '').trim();
  const count = Array.isArray(models) ? models.length : 0;
  const key = env ? `ключ из переменной ${env}` : 'без ключа (локальный сервер)';
  const list = count ? [...models].slice(0, 5).map(model => (typeof model === 'string' ? model : model?.id)).filter(Boolean).join(', ') : '—';
  const tail = count > 5 ? ` и ещё ${count - 5}` : '';
  return `Будет записано: ${name} → ${url} (${PROVIDER_APIS[api] || api}), ${key}. Моделей: ${count}. ${list}${tail}`;
}

/** Когда мастер считает черновик пригодным к записи — те же правила, что у сервера. */
export function draftReady({ id, baseUrl, keyEnv, api = 'openai-completions', models = [] } = {}) {
  const readyId = /^tb-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(String(id || '').trim());
  let local;
  try { ({ local } = providerEndpoint(baseUrl)); } catch { return false; }
  const env = String(keyEnv || '').trim();
  const readyKey = env ? /^[A-Z][A-Z0-9_]{0,95}$/.test(env) : local;
  const readyModels = Array.isArray(models) && models.length >= 1 && models.length <= WIZARD_MODEL_LIMIT
    && models.every(model => typeof model === 'string' && /^[A-Za-z0-9_.:/+@-]{1,160}$/.test(model))
    && new Set(models).size === models.length;
  return Boolean(readyId && readyKey && readyModels && Object.hasOwn(PROVIDER_APIS, api));
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
