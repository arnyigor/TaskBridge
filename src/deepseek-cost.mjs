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
    byDay.set(day, (byDay.get(day) || 0) + cost);
  }
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, cost]) => ({ day, cost }));
}

/**
 * Прогноз по темпу расхода, как в apicost: recent = среднее по последним 3
 * завершённым дням, history = по последним 7. runway = ceil(balance / pace).
 */
export function computeRunway(balanceCny, dayCosts, today) {
  const all = [...dayCosts].sort((a, b) => (a.day < b.day ? -1 : 1));
  let completed = all.filter(d => d.day < today);
  if (!completed.length && all.length && all[all.length - 1].day < today) {
    completed = all;
  }
  if (!completed.length) {
    return { recentPerDay: null, historyPerDay: null, recentDays: null, historyDays: null };
  }
  const costs = completed.map(d => d.cost);
  const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
  const ceilDays = (balance, pace) => {
    if (!(pace > 0)) return null;
    if (!(balance > 0)) return 0;
    return Math.ceil(balance / pace);
  };
  const recentPerDay = mean(costs.slice(-Math.min(3, costs.length)));
  const historyPerDay = mean(costs.slice(-Math.min(7, costs.length)));
  return {
    recentPerDay,
    historyPerDay,
    recentDays: ceilDays(balanceCny, recentPerDay),
    historyDays: ceilDays(balanceCny, historyPerDay),
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
    : rates ? rates.usdRub / rates.cnyRub : null;

  const balance = balanceResult.balance;
  const cny = balance.CNY ?? 0;
  const usd = balance.USD ?? 0;
  const totalCny = usdCny != null ? cny + usd * usdCny : null;

  let costHistory = null;
  let runway = { recentPerDay: null, historyPerDay: null, recentDays: null, historyDays: null };
  if (totalCny != null && deepseekConfig.costHistoryPath) {
    try {
      const text = await fs.readFile(deepseekConfig.costHistoryPath, 'utf8');
      const days = aggregateCostHistory(text);
      costHistory = days.length ? { lastDay: days[days.length - 1].day } : null;
      runway = computeRunway(totalCny, days, localDate(options.now ? new Date(options.now) : new Date()));
    } catch {
      // нет истории — просто без прогноза
    }
  }

  const rub = rates
    ? {
        cny: cny * rates.cnyRub,
        usd: usd * rates.usdRub,
        total: cny * rates.cnyRub + usd * rates.usdRub,
      }
    : null;

  // Темп расхода записан в юанях (так его считает apicost из cost-*.csv), но
  // баланс лежит и в юанях, и в долларах: в рубли переводим по тому же
  // эффективному курсу, что и баланс, — тогда «темп × дни» совпадает с рублями
  // баланса, а не расходится с ними на разнице курсов.
  const effRubPerCny = rates ? (totalCny > 0 ? rub.total / totalCny : rates.cnyRub) : null;
  const rubPerDay = (value) => (value != null && effRubPerCny != null ? value * effRubPerCny : null);

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
      recentPerDayRub: rubPerDay(runway.recentPerDay),
      historyPerDayRub: rubPerDay(runway.historyPerDay),
    },
    runway: { recentDays: runway.recentDays, historyDays: runway.historyDays },
    costHistory,
  };
  cache.lastResult = { key: apiKey, at: Date.now(), value: result };
  return result;
}
