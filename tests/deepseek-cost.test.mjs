// Логика «остаток + на сколько хватит» для DeepSeek: чистые функции
// (парсинг CSV истории расходов, прогноз по темпу, курсы ЦБ, формат
// баланса) проверяются без сети. Сетевой readDeepseekCost — с injected fetch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  aggregateCostHistory,
  computeRunway,
  parseCbrRates,
  parseBalance,
  readDeepseekCost,
} from '../src/deepseek-cost.mjs';

test('aggregateCostHistory суммирует дни и сортирует по датам', () => {
  const csv = [
    'day,model,cost',
    '2026-09-20,deepseek-flash,12.6634744',
    '2026-09-20,pro,0.001125',
    '2026-09-21,deepseek-flash,12.6634744',
    '2026-09-19,deepseek-flash,3.00017332',
  ].join('\n');
  assert.deepEqual(aggregateCostHistory(csv), [
    { day: '2026-09-19', cost: 3.00017332 },
    { day: '2026-09-20', cost: 12.6645994 },
    { day: '2026-09-21', cost: 12.6634744 },
  ]);
  assert.deepEqual(aggregateCostHistory(''), []);
});

test('computeRunway повторяет логику apicost: ceil(баланс / темп)', () => {
  const days = [
    { day: '2026-09-22', cost: 10 }, // сегодняшний день — не завершён
    { day: '2026-09-23', cost: 100 }, // будущий — не учитывается
    { day: '2026-09-25', cost: 1 },
  ];
  // recent = 3 последних завершённых: 10, 3, 1 → 4.66(6); history = все 4
  const history = [
    { day: '2026-09-18', cost: 20 },
    { day: '2026-09-19', cost: 10 },
    { day: '2026-09-20', cost: 3 },
    { day: '2026-09-21', cost: 1 },
  ];
  const result = computeRunway(100, days.concat(history), '2026-09-26');
  // завершённые: 20,10,3,1,10,100,1 (09-18…09-25, включая 09-23)
  assert.equal(result.recentPerDay, (10 + 100 + 1) / 3);
  assert.equal(result.historyPerDay, 145 / 7);
  assert.equal(result.recentDays, 3);
  assert.equal(result.historyDays, 5);
});

test('computeRunway: нулевой темп, пустая история и неположительный баланс', () => {
  const none = computeRunway(100, [], '2026-09-26');
  assert.equal(none.historyDays, null);
  const zeroPace = computeRunway(100, [{ day: '2026-09-19', cost: 0 }], '2026-09-26');
  assert.equal(zeroPace.historyDays, null);
  const broke = computeRunway(-1.45, [{ day: '2026-09-19', cost: 12 }], '2026-09-26');
  assert.equal(broke.historyDays, 0);
});

test('parseCbrRates учитывает Nominal и запятую в Value', () => {
  const xml = '<?xml version="1.0"?><ValCurs><Valute><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Value>84,0954</Value></Valute><Valute><NumCode>156</NumCode><CharCode>CNY</CharCode><Nominal>1</Nominal><Value>11,8123</Value></Valute></ValCurs>';
  const rates = parseCbrRates(xml);
  assert.equal(rates.usdRub, 84.0954);
  assert.equal(rates.cnyRub, 11.8123);
  assert.equal(parseCbrRates('no rates here'), null);
});

test('parseBalance понимает оба формата ответа', () => {
  const balance = parseBalance({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '-1.45', granted_balance: '0.00', topped_up_balance: '-1.45' },
      { currency: 'USD', total_balance: '21.52', granted_balance: '0.00', topped_up_balance: '21.52' },
    ],
  });
  assert.deepEqual(balance, { CNY: -1.45, USD: 21.52 });
  const legacy = parseBalance({ balance_amounts: [{ currency: 'CNY', total_balance: '10.00' }] });
  assert.deepEqual(legacy, { CNY: 10 });
  assert.equal(parseBalance({ balance_infos: [{ currency: 'CNY', total_balance: null }] }), null);
  assert.equal(parseBalance({ balance_infos: [{ currency: 'CNY', total_balance: '' }] }), null);
  assert.equal(parseBalance({}), null);
});

test('readDeepseekCost: cache-only poll never touches the provider', async () => {
  const env = { DEEPSEEK_API_KEY: 'ds-cacheonly-test' };
  let calls = 0;
  const config = { rates: { usdRub: 80, cnyRub: 12 } };
  const fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '7' }] }) };
  };
  assert.equal((await readDeepseekCost(config, { env, fetch, cacheOnly: true })).reason, 'not-fetched');
  assert.equal(calls, 0);
  const refreshed = await readDeepseekCost(config, { env, fetch, noCache: true });
  assert.equal(refreshed.balance.cny, 7);
  assert.deepEqual(await readDeepseekCost(config, { env, fetch, cacheOnly: true }), refreshed);
  assert.equal(calls, 1, 'poll must not fetch again');
});

test('readDeepseekCost: баланс, курсы и прогноз без сети', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ds-'));
  const costPath = path.join(dir, 'cost_history.csv');
  fs.writeFileSync(costPath, [
    'day,model,cost',
    '2026-09-19,deepseek-flash,3.00017332',
    '2026-09-20,deepseek-flash,6.00000000',
    '2026-09-21,deepseek-flash,12.00000000',
  ].join('\n'));


  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/user/balance')) {
      return {
        ok: true,
        json: async () => ({
          is_available: true,
          balance_infos: [
            { currency: 'CNY', total_balance: '-1.45' },
            { currency: 'USD', total_balance: '21.52' },
          ],
        }),
      };
    }
    return { ok: true, json: async () => 'xml' };
  };
  const rates = { usdRub: 84.0954, cnyRub: 11.8123 };
  const result = await readDeepseekCost(
    { apiKey: '$DEEPSEEK_API_KEY', costHistoryPath: costPath, rates },
    { env: { DEEPSEEK_API_KEY: 'sk-test' }, now: '2026-09-26T12:00:00', fetch: fakeFetch, noCache: true },
  );
  assert.equal(result.available, true);
  assert.deepEqual(result.balance, { cny: -1.45, usd: 21.52 });
  assert.equal(result.rates.usdCny, 84.0954 / 11.8123);
  assert.ok(Math.abs(result.rub.total - (-1.45 * 11.8123 + 21.52 * 84.0954)) < 1e-6);
  assert.equal(result.costHistory.lastDay, '2026-09-21');
  assert.ok(result.pace.historyPerDay > 0);
  assert.ok(result.runway.historyDays > 0);
  // Темп в рублях — по тому же эффективному курсу, что и баланс.
  const effRubPerCny = result.rub.total / result.totalCny;
  assert.equal(result.rates.effectiveRubPerCny, effRubPerCny);
  assert.ok(Math.abs(result.pace.historyPerDayRub - result.pace.historyPerDay * effRubPerCny) < 1e-9);
  // Инвариант: рублёвый темп × дни ≈ рубли баланса.
  const rubTotal = result.pace.historyPerDayRub * result.runway.historyDays;
  assert.ok(rubTotal >= result.rub.total, `${rubTotal} должно покрывать баланс ${result.rub.total}`);
  assert.ok(rubTotal < result.rub.total * 1.5, 'но не завышать его вдвое (ceil, а не выдумка)');
  assert.ok(calls.some(u => u.includes('user/balance')));
});

test('readDeepseekCost: без ключа — available: false, без исключения', async () => {
  const result = await readDeepseekCost(
    { apiKey: '$DEEPSEEK_API_KEY' },
    { env: {}, fetch: async () => { throw new Error('must not be called'); }, noCache: true },
  );
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no-key');
});

test('readDeepseekCost: сетевая ошибка не бросает исключение', async () => {
  const result = await readDeepseekCost(
    { apiKey: '$DEEPSEEK_API_KEY' },
    { env: { DEEPSEEK_API_KEY: 'sk-test' }, fetch: async () => { throw new Error('network down'); }, noCache: true },
  );
  assert.equal(result.available, false);
  assert.equal(result.reason, 'network down');
});

test('readDeepseekCost: при ошибке возвращает старый баланс как stale с исходным asOf', async () => {
  let fail = false;
  const config = {
    apiKey: '$DEEPSEEK_API_KEY', balanceCacheMs: 1, errorCacheMs: 1000,
    rates: { usdRub: 80, cnyRub: 10 },
  };
  const options = {
    env: { DEEPSEEK_API_KEY: 'sk-stale-test' },
    fetch: async () => {
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '100' }] }) };
    },
  };
  const fresh = await readDeepseekCost(config, options);
  await new Promise(resolve => setTimeout(resolve, 5));
  fail = true;
  const stale = await readDeepseekCost(config, options);
  assert.equal(stale.available, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.asOf, fresh.asOf);
  assert.equal(stale.balance.cny, 100);
});
