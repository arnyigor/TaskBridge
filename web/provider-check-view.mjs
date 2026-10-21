// Подписи к результату проверки соединения с провайдером (TB-PROV-01B).
//
// Отдельный модуль, а не строки внутри providers.js: по этим подписям оператор
// решает, что делать (задать ключ, подождать, проверить URL), и их надо проверять
// тестом — как `provider-status-view.mjs` для балансов.

export const PROVIDER_CHECK_LABELS = Object.freeze({
  AVAILABLE: 'Доступен',
  UNAUTHORIZED: 'Ключ не принят',
  RATE_LIMITED: 'Ограничение частоты',
  TIMEOUT: 'Не ответил вовремя',
  UNREACHABLE: 'Недоступен',
  UNSUPPORTED: 'Так проверить нельзя',
  UNKNOWN: 'Неизвестно',
});

/** Что делать оператору при таком статусе. Коротко: это подсказка, не документация. */
const HINTS = Object.freeze({
  AVAILABLE: 'Сервер ответил на GET /models. Генерация модели не проверялась.',
  UNAUTHORIZED: 'Проверьте переменную окружения с ключом на компьютере и перезапустите сервер.',
  RATE_LIMITED: 'Провайдер ограничил частоту запросов. Повторите позже.',
  TIMEOUT: 'Проверьте загрузку машины и доступность сети до провайдера.',
  UNREACHABLE: 'Проверьте URL, DNS и доступность провайдера или локального сервера.',
  UNSUPPORTED: 'У провайдера нет адреса в каталоге Pi или нет GET /models.',
  UNKNOWN: 'Проверку завершить не удалось. Смотрите код и HTTP-статус в подробностях.',
});

export function providerCheckLabel(status) {
  return PROVIDER_CHECK_LABELS[String(status || '').toUpperCase()] || PROVIDER_CHECK_LABELS.UNKNOWN;
}

/**
 * Одна строка для списка подключений: статус, задержка и что делать.
 * Неизвестные поля не печатаются — «Нет данных» вместо нуля.
 */
export function providerCheckText(result = {}) {
  const status = String(result.status || 'UNKNOWN').toUpperCase();
  const label = providerCheckLabel(status);
  const latency = Number.isFinite(result.latencyMs) ? ` · ${result.latencyMs} мс` : '';
  const http = Number.isFinite(result.httpStatus) ? ` · HTTP ${result.httpStatus}` : '';
  const hint = HINTS[status] || HINTS.UNKNOWN;
  return `${label}${latency}${http}. ${hint}`;
}

/** Нейтральная подпись для строки списка, пока проверки не было. */
export const PROVIDER_CHECK_IDLE = 'Проверка не выполнялась';
