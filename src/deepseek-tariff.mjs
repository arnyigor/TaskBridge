/**
 * Тариф DeepSeek: ставки, часы пика и стоимость одного ответа.
 *
 * Ставки есть в двух валютах, и это не пересчёт одной из другой: DeepSeek публикует
 * прайс в USD, а биллинг исторических выгрузок (`cost-*.csv`, currency=CNY) шёл по
 * своему ровному прайсу в юанях. Обе таблицы сверены с фактами:
 *  - USD — официальная страница цен (проверено DEEPSEEK_TARIFF_VERIFIED_AT);
 *  - CNY — ровно то, что списывает биллинг: токены дня 2026-09-13, умноженные на
 *    эту таблицу, дают выставленную сумму до последнего знака (см. тест).
 * Поэтому стоимость ответа считается в той валюте, в которой списывают деньги
 * сейчас (у DeepSeek это USD), а юаневая таблица нужна для сводок по периодам,
 * когда кошелёк был юаневым.
 *
 * Расписание пика официальное, проверено 2026-11-02:
 *   пик — 01:00–04:00 и 06:00–10:00 UTC, только Пн–Пт по UTC;
 *   выходные и праздники КНР — непик целиком; пик ровно в два раза дороже.
 * Часовой пояс в правиле — UTC: в местном времени окна съезжают, и считать их
 * по локальному дню недели нельзя.
 *
 * Не документировано (и здесь предполагается): по какой отметке времени
 * тарифицируется запрос, начатый до границы и закончившийся после. Считаем по
 * началу вызова модели — ошибка возможна только на самом стыке окна.
 */

export const DEEPSEEK_TARIFF_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/';

/** Когда расписание и ставки сверены с официальной страницей цен. */
export const DEEPSEEK_TARIFF_VERIFIED_AT = '2026-11-02';

/** USD за 1M токенов, непиковый (базовый) тариф — официальный прайс. */
export const DEEPSEEK_RATES_USD = {
  // V4.1-Flash — текущая модель, её id у Pi: deepseek-flash.
  'deepseek-flash': { hit: 0.003, miss: 0.15, out: 0.6 },
  // V4-Flash: снята с обслуживания, но её вызовы до 2026-09-10 шли по этим ставкам.
  'deepseek-v4-flash': { hit: 0.007, miss: 0.22, out: 0.66 },
  'deepseek-v4-flash-vision-exp': { hit: 0.007, miss: 0.22, out: 0.66 },
  'deepseek-v4-pro': { hit: 0.022, miss: 0.66, out: 1.98 },
};

/** CNY за 1M токенов — ровно то, что списывал биллинг, пока кошелёк был юаневым. */
export const DEEPSEEK_RATES_CNY = {
  'deepseek-flash': { hit: 0.02, miss: 1, out: 4 },
  'deepseek-v4-flash': { hit: 0.05, miss: 1.5, out: 4.5 },
  'deepseek-v4-flash-vision-exp': { hit: 0.05, miss: 1.5, out: 4.5 },
  'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5 },
};

/** Как та же модель называется в исторических выгрузках биллинга. */
export const DEEPSEEK_ALIASES = {
  flash: 'deepseek-v4-flash',
  pro: 'deepseek-v4-pro',
  'deepseek-v4.1-flash-expires-on-0910': 'deepseek-v4-flash',
  'deepseek-v4-flash-0731': 'deepseek-v4-flash',
};

/** Пик: окна в UTC, [from, to). */
export const DEEPSEEK_PEAK = {
  multiplier: 2,
  weekdaysUtc: [1, 2, 3, 4, 5],
  windowsUtc: [
    { from: '01:00', to: '04:00' },
    { from: '06:00', to: '10:00' },
  ],
};

function minutesOfDayUtc(clock) {
  const [hours, minutes] = String(clock).split(':');
  return Number(hours) * 60 + Number(minutes || 0);
}

function toDate(when) {
  if (when == null) return null;
  const at = when instanceof Date ? when : new Date(when);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Пик ли это. `when` — момент начала вызова модели (ISO или Date).
 * `holidays` — праздники КНР по датам UTC (YYYY-MM-DD): в эти дни непик весь день.
 */
export function isPeak(when, options = {}) {
  const at = toDate(when);
  if (at == null) return false;
  const holidays = Array.isArray(options.holidays) ? options.holidays : [];
  if (holidays.includes(at.toISOString().slice(0, 10))) return false;
  if (!DEEPSEEK_PEAK.weekdaysUtc.includes(at.getUTCDay())) return false;
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  return DEEPSEEK_PEAK.windowsUtc.some(window => minutes >= minutesOfDayUtc(window.from) && minutes < minutesOfDayUtc(window.to));
}

/** Канонический id модели: `deepseek/deepseek-flash`, `flash`, `pro` — одна запись. */
export function canonicalModel(model) {
  if (!model) return null;
  const id = String(model).trim().toLowerCase().replace(/^[^/]+\//, '');
  return DEEPSEEK_ALIASES[id] || id;
}

/** Ставки модели в валюте `currency` (USD — по умолчанию, как в официальном прайсе). */
export function ratesFor(model, currency = 'USD') {
  const id = canonicalModel(model);
  if (!id) return null;
  const table = String(currency).toUpperCase() === 'CNY' ? DEEPSEEK_RATES_CNY : DEEPSEEK_RATES_USD;
  return table[id] || null;
}

/** Миллиардные доли: double иначе отдаёт 21.368305600000003 вместо суммы биллинга. */
function roundAmount(value) {
  return Math.round(value * 1e9) / 1e9;
}

function amountFor(rates, usage, multiplier) {
  return roundAmount(((Number(usage.hit) || 0) * rates.hit
    + (Number(usage.miss) || 0) * rates.miss
    + (Number(usage.out) || 0) * rates.out) / 1_000_000 * multiplier);
}

/**
 * Стоимость одного ответа модели.
 * `usage` — { model, hit, miss, out }; hit — попадания в кэш (cacheRead),
 * miss — обычный вход (input), out — вывод.
 * Возвращает `usd` и `cny` (каждая по своей таблице), плюс признак пика.
 * null — модель не из тарифа DeepSeek (локальная, чужой провайдер).
 */
export function deepseekCost(usage = {}, at = null, options = {}) {
  const id = canonicalModel(usage.model);
  const usdRates = id ? DEEPSEEK_RATES_USD[id] : null;
  if (!usdRates) return null;
  const peak = isPeak(at ?? usage.at, options);
  const multiplier = peak ? DEEPSEEK_PEAK.multiplier : 1;
  const cnyRates = DEEPSEEK_RATES_CNY[id];
  return {
    usd: amountFor(usdRates, usage, multiplier),
    cny: cnyRates ? amountFor(cnyRates, usage, multiplier) : null,
    peak,
    multiplier,
    rates: usdRates,
  };
}

/**
 * В какой валюте списывают деньги сейчас: tariff.currency решает, что показывать
 * в чате за ответ. Явная настройка важнее баланса; иначе — по кошельку, где есть
 * деньги (у DeepSeek их два: CNY и USD). Когда оба пусты или баланс недоступен,
 * берём USD — в этой валюте публикуется официальный прайс.
 */
export function walletCurrency(balance, config = {}) {
  const forced = config?.currency;
  if (forced) return String(forced).toUpperCase();
  const cny = Number(balance?.cny);
  const usd = Number(balance?.usd);
  const hasCny = Number.isFinite(cny) && cny > 0;
  const hasUsd = Number.isFinite(usd) && usd > 0;
  if (hasUsd && !hasCny) return 'USD';
  if (hasCny && !hasUsd) return 'CNY';
  return 'USD';
}

/**
 * Тариф для клиента: что считать и по какому расписанию (без сети и без секретов).
 * `currency` — валюта, в которой списываются деньги сейчас.
 */
export function deepseekTariff(config = {}) {
  return {
    currency: String(config.currency || 'USD').toUpperCase(),
    unit: 'per_1m_tokens',
    multiplier: DEEPSEEK_PEAK.multiplier,
    rates: DEEPSEEK_RATES_USD,
    ratesCny: DEEPSEEK_RATES_CNY,
    aliases: DEEPSEEK_ALIASES,
    peak: {
      weekdaysUtc: DEEPSEEK_PEAK.weekdaysUtc,
      windowsUtc: DEEPSEEK_PEAK.windowsUtc,
      holidays: Array.isArray(config.holidays) ? config.holidays : [],
      timeZoneRule: 'utc',
    },
    source: DEEPSEEK_TARIFF_SOURCE,
    verifiedAt: DEEPSEEK_TARIFF_VERIFIED_AT,
  };
}
