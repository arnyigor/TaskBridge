import fs from 'node:fs/promises';

// Остаток средств на аккаунте DeepSeek и прогноз «на сколько хватит».
//
// Логика взята из apicost (G:\AIModels\MCPs\McpServer\apicost\
// analyze_api_cost_v5_dynamics.py): темп расхода = среднее по завершённым
// дням из истории расходов, запас = ceil(баланс / темп). Баланс берётся
// живым запросом к официальному API DeepSeek (GET /user/balance), история
// расходов — из cost_history.csv, который обновляет apicost.

// ---------------------------------------------------------------------------
// Чистые функции (тестируются без сети)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Десятичная арифметика (BigInt)
// ---------------------------------------------------------------------------
// BigDecimal в JS нет, но деньги и здесь нельзя считать double: 0.1 + 0.2 уже
// не 0.3, а накопленная ошибка решает, будет ceil(баланс / темп) равен N или
// N+1 (Math.ceil(0.07 / 0.01) — 8, а не 7). Поэтому все денежные суммы,
// средние и деления идут через BigInt с фиксированным масштабом 1e12: восемь
// знаков есть в cost_history.csv, остальное — запас на деление.

const DEC_PLACES = 12;
const DEC_FACTOR = 10n ** BigInt(DEC_PLACES);

/** Number → BigInt × 1e12. toFixed даёт десятичную запись самого double, а не его хвост. */
export function decimalOf(value) {
  const text = Number(value).toFixed(DEC_PLACES);
  const match = /^(-?)(\d+)\.(\d+)$/.exec(text);
  if (!match) throw new Error(`не десятичное число: ${value}`);
  const sign = match[1] === '-' ? -1n : 1n;
  return sign * (BigInt(match[2]) * DEC_FACTOR + BigInt(match[3]));
}

/** BigInt × 1e12 → Number. */
export function numberOfDecimal(scaled) {
  const sign = scaled < 0n ? '-' : '';
  const abs = scaled < 0n ? -scaled : scaled;
  const frac = String(abs % DEC_FACTOR).padStart(DEC_PLACES, '0').replace(/0+$/, '');
  return Number(frac ? `${sign}${abs / DEC_FACTOR}.${frac}` : `${sign}${abs / DEC_FACTOR}`);
}

/** Делит два BigInt (масштаб остаётся у делимого), половина — вверх. */
function divideDecimal(numerator, denominator) {
  const sign = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const quotient = a / b;
  return sign * (a % b * 2n >= b ? quotient + 1n : quotient);
}

/** Частное с округлением половины вверх до 1e-12. */
export function decimalRatio(numerator, denominator) {
  // Оба аргумента уже × 1e12 — масштаб частного надо вернуть вручную.
  return numberOfDecimal(divideDecimal(decimalOf(numerator) * DEC_FACTOR, decimalOf(denominator)));
}

/** Произведение точно: (a·1e12 · b·1e12) / 1e12. */
export function decimalMultiply(left, right) {
  return numberOfDecimal(decimalOf(left) * decimalOf(right) / DEC_FACTOR);
}

/** Сумма точно. */
export function decimalAdd(left, right) {
  return numberOfDecimal(decimalOf(left) + decimalOf(right));
}

/** Среднее по десятичным значениям; пустой список — null. */
export function decimalMean(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, v) => acc + decimalOf(v), 0n);
  return numberOfDecimal(divideDecimal(sum, BigInt(values.length)));
}

/** ceil(баланс / темп) точно: темп, посчитанный средним, — тоже десятичное число. */
export function decimalCeilRatio(balance, pace) {
  const b = balance == null ? 0n : decimalOf(balance);
  const p = pace == null ? 0n : decimalOf(pace);
  if (p <= 0n) return null;
  if (b <= 0n) return 0;
  return Number((b + p - 1n) / p);
}

/** day,model,cost → [{day, cost}] с суммой по дням, в порядке дат. */
export function aggregateCostHistory(text) {
  const byDay = new Map();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.toLowerCase().startsWith('day')) continue;
    const cols = line.split(',');
    if (cols.length < 3) continue;
    const day = cols[0].trim();
    const cost = Number(cols[2]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(cost)) continue;
    byDay.set(day, (byDay.get(day) || 0n) + decimalOf(cost));
  }
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, cost]) => ({ day, cost: numberOfDecimal(cost) }));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Достроить календарные дни между первой и последней записью.
 *
 * В cost_history.csv попадают только дни с расходом: пропуск внутри покрытого
 * диапазона — это подтверждённый ноль, а не «нет данных» (так же считает apicost,
 * у которого внутри [first..last] дни материализуются нулями). Без этого среднее
 * делится на число записей, а не на число дней, и окно «3 дня» растягивается на
 * неделю — темп завышается ровно во столько раз.
 */
function fillDates(entries, empty) {
  if (!entries.length) return [];
  const sorted = [...entries].sort((a, b) => (a.day < b.day ? -1 : 1));
  const byDay = new Map(sorted.map(entry => [entry.day, entry]));
  const start = Date.parse(`${sorted[0].day}T00:00:00Z`);
  const end = Date.parse(`${sorted[sorted.length - 1].day}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return sorted;
  const filled = [];
  for (let ms = start; ms <= end; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    filled.push(byDay.get(day) || empty(day));
  }
  return filled;
}

/** [{day, cost}] с нулями в пропущенных днях покрытого диапазона. */
export function fillCalendarDays(days) {
  return fillDates(days, day => ({ day, cost: 0 }));
}

/** [{day, hit, miss, out, total}] с нулями в пропущенных днях. */
export function fillCalendarTokens(days) {
  return fillDates(days, day => ({ day, hit: 0, miss: 0, out: 0, total: 0 }));
}

/** Сколько дней прошло от последней записи до сегодня (по местной дате). */
export function dayAge(lastDay, today) {
  const from = Date.parse(`${lastDay}T00:00:00Z`);
  const to = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

/**
 * Прогноз по темпу расхода: recent = среднее по последним 3 завершённым
 * календарным дням, history = по последним 7. runway = ceil(balance / pace).
 */
export function computeRunway(balanceCny, dayCosts, today, options = {}) {
  const recentWindow = Number(options.recentWindow) || 3;
  const historyWindow = Number(options.historyWindow) || 7;
  const completed = fillCalendarDays(dayCosts).filter(d => d.day < today);
  if (!completed.length) {
    return { recentPerDay: null, historyPerDay: null, recentDays: null, historyDays: null };
  }
  const tail = window => completed.slice(-Math.min(window, completed.length)).map(d => d.cost);
  const recentPerDay = decimalMean(tail(recentWindow));
  const historyPerDay = decimalMean(tail(historyWindow));
  return {
    recentPerDay,
    historyPerDay,
    recentDays: decimalCeilRatio(balanceCny, recentPerDay),
    historyDays: decimalCeilRatio(balanceCny, historyPerDay),
  };
}

const TOKEN_TYPES = ['hit', 'miss', 'out'];

/**
 * day,model,key,type,price,amount → [{day, hit, miss, out, total}].
 * `hit` — попадания в кэш, `miss` — обычный вход, `out` — вывод; `req` в расход
 * токенов не входит, но нужен для «сколько запросов». Токены — целые, суммы
 * копятся BigInt: 4 миллиарда токенов в double теряют единицы, а это ровно та
 * точность, с которой цена считается деньгами.
 */
export function aggregateTokenHistory(text) {
  const byDay = new Map();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.toLowerCase().startsWith('day')) continue;
    const cols = line.split(',');
    if (cols.length < 6) continue;
    const day = cols[0].trim();
    const type = cols[3].trim();
    const amount = Number(cols[5]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !TOKEN_TYPES.includes(type) || !Number.isFinite(amount)) continue;
    const entry = byDay.get(day) || { hit: 0n, miss: 0n, out: 0n };
    entry[type] += BigInt(Math.round(amount));
    byDay.set(day, entry);
  }
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, t]) => ({
    day,
    hit: Number(t.hit),
    miss: Number(t.miss),
    out: Number(t.out),
    total: Number(t.hit + t.miss + t.out),
  }));
}

/** Токены в день по последним завершённым календарным дням (окно — как у денег). */
export function computeTokenPace(tokenDays, today, window = 3) {
  const completed = fillCalendarTokens(tokenDays).filter(d => d.day < today);
  if (!completed.length) return null;
  const tail = completed.slice(-Math.min(window, completed.length));
  const mean = key => Math.round(tail.reduce((sum, d) => sum + d[key], 0) / tail.length);
  return { days: tail.length, hit: mean('hit'), miss: mean('miss'), out: mean('out'), total: mean('total') };
}

/**
 * Факт по последнему месяцу, который есть в данных: сумма денег и токенов с
 * первого числа по последний записанный день. «За месяц» на экране — это факт,
 * а не экстраполяция; она отдельно, в прогнозе по темпу.
 */
export function monthFacts(costDays, tokenDays) {
  const last = costDays.length ? costDays[costDays.length - 1].day
    : (tokenDays.length ? tokenDays[tokenDays.length - 1].day : null);
  if (!last) return null;
  const key = last.slice(0, 7);
  const costPart = fillCalendarDays(costDays).filter(d => d.day.startsWith(key));
  const tokenPart = fillCalendarTokens(tokenDays).filter(d => d.day.startsWith(key));
  const sumTokens = field => tokenPart.reduce((sum, d) => sum + d[field], 0);
  const cny = costPart.length ? costPart.map(d => d.cost).reduce(decimalAdd, 0) : null;
  return {
    key,
    from: costPart.length ? costPart[0].day : tokenPart[0].day,
    to: last,
    days: costPart.length || tokenPart.length,
    tokens: sumTokens('total'),
    hit: sumTokens('hit'),
    miss: sumTokens('miss'),
    out: sumTokens('out'),
    cny,
  };
}

/** XML ЦБ РФ (XML_daily.asp) → { USD: ₽, CNY: ₽ } с учётом Nominal. */
export function parseCbrRates(xml) {
  const pick = (code) => {
    const inner = String(xml || '')
      .split('</Valute>')
      .find(block => block.includes(`<CharCode>${code}</CharCode>`));
    if (!inner) return null;
    const nominal = Number((/<Nominal>([^<]+)<\/Nominal>/u.exec(inner)?.[1] || '').replace(',', '.'));
    const value = Number((/<Value>([^<]+)<\/Value>/u.exec(inner)?.[1] || '').replace(',', '.'));
    if (!(nominal > 0) || !(value > 0)) return null;
    return value / nominal;
  };
  const usd = pick('USD');
  const cny = pick('CNY');
  if (!usd || !cny) return null;
  return { usdRub: usd, cnyRub: cny };
}

/** Вытаскивает баланс из ответа /user/balance (новый и старый форматы). */
export function parseBalance(payload) {
  const infos = payload?.balance_infos || payload?.balance_amounts;
  if (!Array.isArray(infos)) return null;
  const balance = {};
  for (const item of infos) {
    const currency = String(item?.currency || '').toUpperCase();
    const raw = item?.total_balance;
    if (raw == null || String(raw).trim() === '') continue;
    const value = Number(raw);
    if (currency && Number.isFinite(value)) balance[currency] = value;
  }
  return Object.keys(balance).length ? balance : null;
}

// ---------------------------------------------------------------------------
// Чтение с кэшем
// ---------------------------------------------------------------------------

const DEFAULT_BALANCE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_RATES_TTL_MS = 12 * 60 * 60 * 1000;

const cache = {
  balance: { at: 0, value: null, inFlight: null },
  rates: { at: 0, value: null, inFlight: null },
  lastResult: null,
};

function localDate(date) {
  const pad = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function resolveApiKey(deepseekConfig, env) {
  // Пустая строка/отсутствие — тоже дефолт, чтобы config.example.json не
  // таскал "ключ" даже в виде ссылки на env (check-secrets).
  const raw = String(deepseekConfig?.apiKey || '$DEEPSEEK_API_KEY');
  if (raw.startsWith('$')) return env?.[raw.slice(1)] || null;
  return raw || null;
}

function fetchBody(callerFetch, url, options, timeoutMs, asText) {
  return callerFetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return asText ? response.text() : response.json();
  });
}

const fetchJson = (...args) => fetchBody(...args, false);
const fetchText = (...args) => fetchBody(...args, true);

async function fetchBalance(deepseekConfig, env, options) {
  const apiKey = resolveApiKey(deepseekConfig, env);
  if (!apiKey) return { available: false, reason: 'no-key' };
  const baseUrl = String(deepseekConfig?.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const payload = await fetchJson(options?.fetch || fetch, `${baseUrl}/user/balance`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, options?.timeoutMs || 10000);
  const balance = parseBalance(payload);
  if (!balance) throw new Error('unexpected balance payload');
  return { available: true, balance };
}

async function fetchRates(deepseekConfig, options) {
  const override = deepseekConfig?.rates || {};
  if (Number(override.usdRub) > 0 && Number(override.cnyRub) > 0) {
    return {
      usdRub: Number(override.usdRub),
      cnyRub: Number(override.cnyRub),
      source: 'config',
    };
  }
  const xml = await fetchText(options?.fetch || fetch, String(deepseekConfig?.ratesUrl || 'https://www.cbr.ru/scripts/XML_daily.asp'), {}, options?.timeoutMs || 10000);
  const rates = parseCbrRates(xml);
  if (!rates) throw new Error('CBR rates not parsed');
  return { ...rates, source: 'cbr' };
}

/**
 * Баланс DeepSeek + прогноз. Никогда не бросает: любая ошибка —
 * { available: false, reason }, чтобы /api/info продолжал работать.
 * Результат кэшируется на cacheMs (по умолчанию 10 минут): панель
 * опрашивает /api/info каждые 4 секунды.
 */
export async function readDeepseekCost(deepseekConfig = {}, options = {}) {
  const now = Date.now();
  const cacheMs = Number(deepseekConfig.cacheMs || DEFAULT_BALANCE_TTL_MS);
  const balanceTtl = Number(deepseekConfig.balanceCacheMs || cacheMs);
  const errorTtl = Number(deepseekConfig.errorCacheMs || 30000);
  const env = options.env || process.env;
  const apiKey = resolveApiKey(deepseekConfig, env);
  if (!apiKey) return { available: false, reason: 'no-key' };
  if (options.cacheOnly) {
    const entry = cache.lastResult;
    if (!entry || entry.key !== apiKey) return { available: false, reason: 'not-fetched' };
    return now - entry.at < 30 * 60_000 ? entry.value : { ...entry.value, stale: true };
  }
  // Кэш держит одну запись на ключ: смена аккаунта (или тест) не получает
  // чужой баланс. noCache — для тестов, чтобы не зависеть от порядка.
  const cached = options.noCache ? null
    : (cache.balance.value && cache.balance.value.key === apiKey ? cache.balance.value : null);
  const ttl = cached?.value?.available && !cached.value.stale ? balanceTtl : errorTtl;
  const balanceFresh = cached && now - cached.at < ttl;

  if (options.noCache || !balanceFresh) {
    if (!options.noCache && cache.balance.inFlight?.key === apiKey) {
      await cache.balance.inFlight.promise;
    } else {
      const request = (async () => {
        try {
          const value = await fetchBalance(deepseekConfig, env, options);
          cache.balance.value = { key: apiKey, at: Date.now(), fetchedAt: new Date().toISOString(), value };
        } catch (error) {
          const value = cached?.value?.available
            ? { ...cached.value, stale: true }
            : { available: false, reason: error?.message || String(error) };
          // Keep the original fetchedAt for stale data and negative-cache a
          // failure so the status poll cannot start a request every 2 seconds.
          cache.balance.value = { key: apiKey, at: Date.now(), fetchedAt: cached?.fetchedAt || null, value };
        }
      })();
      if (!options.noCache) cache.balance.inFlight = { key: apiKey, promise: request };
      await request;
      if (!options.noCache && cache.balance.inFlight?.promise === request) cache.balance.inFlight = null;
    }
  }
  const balanceEntry = cache.balance.value;
  const balanceResult = balanceEntry.value;
  if (!balanceResult.available) {
    cache.lastResult = { key: apiKey, at: Date.now(), value: balanceResult };
    return balanceResult;
  }

  if (options.noCache || !cache.rates.value || now - cache.rates.at >= DEFAULT_RATES_TTL_MS) {
    if (!options.noCache && cache.rates.inFlight) {
      await cache.rates.inFlight;
    } else {
      const request = (async () => {
        try {
          const fetched = await fetchRates(deepseekConfig, options);
          cache.rates.value = { at: Date.now(), value: fetched };
          cache.rates.at = Date.now();
        } catch {
          cache.rates.at = Date.now();
          if (!cache.rates.value) cache.rates.value = { at: cache.rates.at, value: null };
        }
      })();
      if (!options.noCache) cache.rates.inFlight = request;
      await request;
      if (!options.noCache && cache.rates.inFlight === request) cache.rates.inFlight = null;
    }
  }
  const rates = cache.rates.value.value;

  const cfgUsdCny = Number(deepseekConfig.usdCnyRate);
  const usdCny = Number.isFinite(cfgUsdCny) && cfgUsdCny > 0
    ? cfgUsdCny
    : rates ? decimalRatio(rates.usdRub, rates.cnyRub) : null;

  const balance = balanceResult.balance;
  const cny = balance.CNY ?? 0;
  const usd = balance.USD ?? 0;
  const totalCny = usdCny != null ? decimalAdd(decimalMultiply(usd, usdCny), cny) : null;

  const today = localDate(options.now ? new Date(options.now) : new Date());
  let costHistory = null;
  let runway = { recentPerDay: null, historyPerDay: null, recentDays: null, historyDays: null };
  let tokenPace = null;
  let month = null;
  let costDays = [];
  let tokenDays = [];
  if (deepseekConfig.costHistoryPath) {
    try {
      costDays = aggregateCostHistory(await fs.readFile(deepseekConfig.costHistoryPath, 'utf8'));
    } catch {
      // нет истории — просто без прогноза
    }
  }
  if (deepseekConfig.tokenHistoryPath) {
    try {
      tokenDays = aggregateTokenHistory(await fs.readFile(deepseekConfig.tokenHistoryPath, 'utf8'));
    } catch {
      // нет истории токенов — останется без «сколько токенов в день»
    }
  }
  if (totalCny != null && costDays.length) {
    runway = computeRunway(totalCny, costDays, today);
  }
  if (costDays.length || tokenDays.length) {
    const lastDay = costDays.length ? costDays[costDays.length - 1].day : tokenDays[tokenDays.length - 1].day;
    const ageDays = dayAge(lastDay, today);
    // Прогноз по устаревшим данным — не прогноз: если последняя запись старше
    // двух дней, честнее сказать «данные до 21.09», чем показать сентябрьский пик
    // как текущий темп. Числа при этом остаются — они про свой период.
    costHistory = { lastDay, ageDays, stale: ageDays != null && ageDays > 2 };
    tokenPace = computeTokenPace(tokenDays, today);
    month = monthFacts(costDays, tokenDays);
  }

  const rub = rates
    ? {
        cny: decimalMultiply(cny, rates.cnyRub),
        usd: decimalMultiply(usd, rates.usdRub),
        total: decimalAdd(decimalMultiply(usd, rates.usdRub), decimalMultiply(cny, rates.cnyRub)),
      }
    : null;

  // Темп расхода записан в юанях (так его считает apicost из cost-*.csv), но
  // баланс лежит и в юанях, и в долларах: в рубли переводим по тому же
  // эффективному курсу, что и баланс, — тогда «темп × дни» совпадает с рублями
  // баланса, а не расходится с ними на разнице курсов.
  const effRubPerCny = rates ? (totalCny > 0 ? decimalRatio(rub.total, totalCny) : rates.cnyRub) : null;
  const rubPerDay = (value) => (value != null && effRubPerCny != null ? decimalMultiply(value, effRubPerCny) : null);
  const historyPerDayRub = rubPerDay(runway.historyPerDay);
  // «Сейчас» — трёхдневное окно: оно отзывается на смену модели за день, а
  // семидневное сглаживает выбросы и остаётся для «хватит на N дн.».
  const recentPerDayRub = rubPerDay(runway.recentPerDay);
  // «₽/мес» считается по тому же темпу, что и «примерно на N дн.»: два разных
  // темпа в одной строке противоречили друг другу (дни × ₽/мес ≠ баланс).
  const monthlyRub = recentPerDayRub == null ? null : decimalMultiply(recentPerDayRub, 30);

  const result = {
    available: true,
    stale: Boolean(balanceResult.stale),
    asOf: balanceEntry.fetchedAt || new Date().toISOString(),
    balance: { cny, usd },
    rates: rates ? { ...rates, usdCny, effectiveRubPerCny: effRubPerCny } : (usdCny != null ? { usdCny } : null),
    rub,
    totalCny,
    pace: {
      recentPerDay: runway.recentPerDay,
      historyPerDay: runway.historyPerDay,
      recentPerDayRub,
      historyPerDayRub,
      monthlyRub,
      windowDays: 3,
    },
    runway: { recentDays: runway.recentDays, historyDays: runway.historyDays },
    tokens: tokenPace ? {
      windowDays: tokenPace.days,
      tokensPerDay: tokenPace.total,
      hitPerDay: tokenPace.hit,
      missPerDay: tokenPace.miss,
      outPerDay: tokenPace.out,
      cnyPerDay: runway.recentPerDay,
      rubPerDay: recentPerDayRub,
    } : null,
    month: month ? {
      ...month,
      rub: month.cny != null && effRubPerCny != null ? decimalMultiply(month.cny, effRubPerCny) : null,
    } : null,
    costHistory,
  };
  cache.lastResult = { key: apiKey, at: Date.now(), value: result };
  return result;
}
