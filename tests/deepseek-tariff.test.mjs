// Тариф DeepSeek: часы пика и стоимость ответа.
//
// Тест держит три внешних факта, на которых всё построено:
//  1) расписание пика (01:00–04:00 и 06:00–10:00 UTC, Пн–Пт по UTC) — сверено с
//     официальной страницей цен и с часовыми выгрузками биллинга: в 11:00, 12:00
//     и 14:00 местного (+05:00) биллинг выставил двойную ставку, в 09:00, 10:00,
//     15:00, 16:00, 17:00, 00:00, 01:00 и 02:00 — базовую;
//  2) юаневая таблица — ровно то, что списывал биллинг: реальные токены дня
//     2026-09-13, умноженные на неё, дают выставленную сумму;
//  3) долларовая таблица — официальный прайс, и она же соответствует тому, из
//     какого кошелька списывают деньги сейчас.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEEPSEEK_PEAK,
  DEEPSEEK_RATES_CNY,
  DEEPSEEK_RATES_USD,
  DEEPSEEK_TARIFF_SOURCE,
  canonicalModel,
  deepseekCost,
  deepseekTariff,
  isPeak,
  ratesFor,
  walletCurrency,
} from '../src/deepseek-tariff.mjs';

// День 2026-09-13 (воскресенье, непик весь день), модель deepseek-flash.
// Токены — из history.csv, суммы — из cost_history.csv и официального прайса.
const SUNDAY = { model: 'deepseek-flash', hit: 501_671_680, miss: 4_152_408, out: 1_795_616 };

test('пик: границы окон в UTC, конец окна уже непик', () => {
  // Среда, 2026-09-16.
  assert.equal(isPeak('2026-09-16T00:59:00Z'), false);
  assert.equal(isPeak('2026-09-16T01:00:00Z'), true);
  assert.equal(isPeak('2026-09-16T03:59:59Z'), true);
  assert.equal(isPeak('2026-09-16T04:00:00Z'), false);
  assert.equal(isPeak('2026-09-16T05:59:00Z'), false);
  assert.equal(isPeak('2026-09-16T06:00:00Z'), true);
  assert.equal(isPeak('2026-09-16T09:59:00Z'), true);
  assert.equal(isPeak('2026-09-16T10:00:00Z'), false);
  assert.equal(isPeak('2026-09-16T23:30:00Z'), false);
});

test('пик: выходные и праздники КНР — непик весь день', () => {
  assert.equal(isPeak('2026-09-19T07:00:00Z'), false, 'суббота');
  assert.equal(isPeak('2026-09-20T02:00:00Z'), false, 'воскресенье');
  assert.equal(isPeak('2026-10-01T07:00:00Z'), true, 'четверг без праздника');
  assert.equal(isPeak('2026-10-01T07:00:00Z', { holidays: ['2026-10-01'] }), false);
});

test('пик: день недели и час считаются по UTC, не по местному', () => {
  // Часовые выгрузки биллинга 2026-08-21 (+05:00 = местное время машины):
  // 11:00/12:00/14:00 — двойная ставка, остальные часы — базовая.
  assert.equal(isPeak('2026-08-21T11:00:00+05:00'), true);
  assert.equal(isPeak('2026-08-21T12:00:00+05:00'), true);
  assert.equal(isPeak('2026-08-21T14:00:00+05:00'), true);
  for (const hour of ['00', '01', '02', '09', '10', '15', '16', '17']) {
    assert.equal(isPeak(`2026-08-21T${hour}:00:00+05:00`), false, `${hour}:00 местного`);
  }
  // Момент до начала отсчёта времени и мусор — непик, а не исключение.
  assert.equal(isPeak(null), false);
  assert.equal(isPeak(''), false);
  assert.equal(isPeak('не дата'), false);
});

test('ставки: id модели, алиас биллинга и провайдерный префикс — одна запись', () => {
  assert.equal(canonicalModel('deepseek/deepseek-flash'), 'deepseek-flash');
  assert.equal(canonicalModel('flash'), 'deepseek-v4-flash');
  assert.equal(canonicalModel('deepseek-v4.1-flash-expires-on-0910'), 'deepseek-v4-flash');
  assert.deepEqual(ratesFor('deepseek-flash'), DEEPSEEK_RATES_USD['deepseek-flash']);
  assert.deepEqual(ratesFor('deepseek-flash', 'CNY'), DEEPSEEK_RATES_CNY['deepseek-flash']);
  assert.deepEqual(ratesFor('pro'), DEEPSEEK_RATES_USD['deepseek-v4-pro']);
  // Локальная модель и чужой провайдер цены в этом тарифе не имеют.
  assert.equal(ratesFor('llama.cpp/local'), null);
  assert.equal(ratesFor(null), null);
});

test('стоимость: миллион токенов по каждой ставке и множитель пика', () => {
  const offPeak = '2026-09-16T12:00:00Z'; // среда, вне окон
  const peak = '2026-09-16T07:00:00Z'; // среда, второе окно

  const cost = (hit, miss, out, at) => deepseekCost({ model: 'deepseek-flash', hit, miss, out }, at);
  assert.equal(cost(1_000_000, 0, 0, offPeak).usd, 0.003);
  assert.equal(cost(1_000_000, 0, 0, peak).usd, 0.006);
  assert.equal(cost(0, 1_000_000, 0, offPeak).usd, 0.15);
  assert.equal(cost(0, 0, 1_000_000, offPeak).usd, 0.6);
  // Та же тысяча токенов в юанях — по юаневой таблице, а не по курсу.
  assert.equal(cost(1_000_000, 0, 0, offPeak).cny, 0.02);
  assert.equal(cost(0, 0, 1_000_000, offPeak).cny, 4);

  const answer = cost(2_350_000, 24_100, 5_300, offPeak);
  assert.equal(answer.peak, false);
  assert.ok(Math.abs(answer.usd - 0.013845) < 1e-12, 'кэш 0.00705 + miss 0.003615 + вывод 0.00318');
  assert.equal(deepseekCost({ model: 'unknown', hit: 1 }, offPeak), null);
});

test('сверка с биллингом: реальные токены дня × тариф = выставленная сумма', () => {
  const day = deepseekCost(SUNDAY, '2026-09-13T12:00:00Z');
  assert.equal(day.peak, false);
  // Юаневая сумма совпадает с cost_history.csv того дня до последнего знака.
  assert.equal(day.cny, 21.3683056);
  // Долларовая — по официальному прайсу; юаневая к ней относится как 20/3:
  // у DeepSeek два своих ровных прайса, а не один пересчёт по курсу ЦБ.
  assert.equal(day.usd, 3.20524584);
  assert.ok(Math.abs(day.cny / day.usd - 20 / 3) < 1e-9);
});

test('тариф для клиента содержит валюту, расписание, источник и дату сверки', () => {
  const tariff = deepseekTariff({ holidays: ['2026-10-01'] });
  assert.equal(tariff.currency, 'USD');
  assert.equal(tariff.unit, 'per_1m_tokens');
  assert.equal(tariff.multiplier, DEEPSEEK_PEAK.multiplier);
  assert.deepEqual(tariff.peak.weekdaysUtc, [1, 2, 3, 4, 5]);
  assert.deepEqual(tariff.peak.windowsUtc, [{ from: '01:00', to: '04:00' }, { from: '06:00', to: '10:00' }]);
  assert.deepEqual(tariff.peak.holidays, ['2026-10-01']);
  assert.equal(tariff.peak.timeZoneRule, 'utc');
  assert.equal(tariff.source, DEEPSEEK_TARIFF_SOURCE);
  assert.equal(tariff.rates['deepseek-flash'].miss, 0.15);
  assert.equal(tariff.ratesCny['deepseek-flash'].miss, 1);
  // Кошелёк юаневый (или так решил конфиг) — тариф это сообщает клиенту.
  assert.equal(deepseekTariff({ currency: 'cny' }).currency, 'CNY');
  // Без конфига тариф всё равно отдаётся целиком — праздников просто нет.
  assert.deepEqual(deepseekTariff().peak.holidays, []);
});

test('валюта тарифа: решает кошелёк, в котором есть деньги, и явная настройка', () => {
  // Сейчас у аккаунта юаневый кошелёк пуст (даже минус), деньги в долларовом.
  assert.equal(walletCurrency({ cny: -1.45, usd: 6.47 }), 'USD');
  // Юаневый период истории — и тариф говорит в юанях.
  assert.equal(walletCurrency({ cny: 22.62, usd: 0 }), 'CNY');
  // Оба или ничего — официальный прайс, то есть доллары.
  assert.equal(walletCurrency({ cny: 5, usd: 6.47 }), 'USD');
  assert.equal(walletCurrency(null), 'USD');
  // Явная настройка важнее баланса.
  assert.equal(walletCurrency({ cny: 22.62, usd: 0 }, { currency: 'usd' }), 'USD');
  assert.equal(walletCurrency({ cny: -1.45, usd: 6.47 }, { currency: 'CNY' }), 'CNY');
});
