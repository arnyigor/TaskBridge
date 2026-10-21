// Экран автоматизаций (AUTO-02): проверяются чистые помощники, а не DOM. Именно
// они ошибаются молча — подпись расписания, проверка формы и объяснение статуса.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONCURRENCY_LABELS, INVOCATION_LABELS, MISFIRE_LABELS, NOTIFY_LABELS,
  invocationText, recipePayload, schedulePayload, scheduleStateText, scheduleText,
} from '../web/automations-view.mjs';

test('расписание описывается словами на всех трёх видах', () => {
  assert.equal(scheduleText({ spec: { kind: 'daily', at: '09:00' } }), 'каждый день в 09:00');
  assert.equal(scheduleText({ spec: { kind: 'weekly', at: '10:30', weekday: 'mon' } }), 'по понедельникам в 10:30');
  assert.equal(scheduleText({ spec: { kind: 'interval', everyMinutes: 120 } }), 'каждые 120 мин');
  assert.equal(scheduleText({}), 'расписание не задано');
  // Словари не должны терять ключи: их выбирают в форме, а не запоминают.
  assert.deepEqual(Object.keys(MISFIRE_LABELS), ['RUN_ONCE', 'SKIP', 'CATCH_UP']);
  assert.deepEqual(Object.keys(CONCURRENCY_LABELS), ['SKIP_IF_RUNNING', 'QUEUE', 'PARALLEL', 'REPLACE']);
  assert.deepEqual(Object.keys(NOTIFY_LABELS), ['action-required', 'always', 'errors-only', 'never']);
});

test('состояние автоматизации: пауза важнее следующего запуска', () => {
  assert.equal(scheduleStateText(null), 'нет расписания');
  assert.equal(scheduleStateText({ enabled: false, nextRunAt: '2026-10-22T04:00:00.000Z' }), 'на паузе');
  assert.match(scheduleStateText({ enabled: true, nextRunAt: '2026-10-22T04:00:00.000Z' }), /^следующий запуск: \d\d\.\d\d\.\d{4} \d\d:\d\d$/);
  assert.equal(scheduleStateText({ enabled: true, nextRunAt: null }), 'ожидает расчёта');
  assert.equal(scheduleStateText({ enabled: true, nextRunAt: 'не дата' }), 'следующий запуск: —');
});

test('статус запуска печатает причину и проверку, а не только слово', () => {
  assert.equal(INVOCATION_LABELS.RUNNING, 'выполняется');
  const ok = invocationText({ status: 'SUCCEEDED', startedAt: '2026-10-21T09:00:00.000Z', verification: 'PASSED' });
  assert.match(ok, /^успешно · \d\d\.\d\d\.\d{4} \d\d:\d\d · проверка: пройдена$/);
  const failed = invocationText({ status: 'FAILED', reason: 'проверка не завершилась за 10 мин: итог неизвестен' });
  assert.match(failed, /^ошибка/);
  assert.match(failed, /итог неизвестен/, 'причина видна оператору');
  assert.match(invocationText({ status: 'SKIPPED', reason: 'предыдущий запуск ещё идёт' }), /пропущено.*предыдущий запуск/);
  assert.match(invocationText({}), /^неизвестно/, 'пустой статус не молчит');
  assert.equal(invocationText({ status: 'SUCCEEDED', verification: 'NOT_CONFIGURED' }).includes('проверка'), false, 'без проверки о ней не пишут');
});

test('форма расписания проверяется до запроса и объясняет отказ', () => {
  const base = { recipeId: 'rc-1', kind: 'daily', at: '9:05', notify: 'never' };
  assert.deepEqual(schedulePayload(base).spec, { kind: 'daily', at: '09:05' }, 'время нормализуется');
  // «9:5» сервер не примет: формат тот же, что у parseClock — минуты двумя цифрами.
  assert.throws(() => schedulePayload({ ...base, at: '9:5' }), /ЧЧ:ММ/);
  assert.throws(() => schedulePayload({ ...base, at: '25:99' }), /ЧЧ:ММ/);
  assert.throws(() => schedulePayload({ ...base, at: '' }), /ЧЧ:ММ/);
  assert.throws(() => schedulePayload({ ...base, recipeId: '' }), /Сначала сохраните промпт/);
  assert.throws(() => schedulePayload({ ...base, kind: 'hourly' }), /daily, weekly или interval/);
  assert.throws(() => schedulePayload({ ...base, kind: 'weekly', weekday: 'среда' }), /День недели/);
  assert.deepEqual(
    schedulePayload({ ...base, kind: 'weekly', weekday: 'WED', at: '10:30' }).spec,
    { kind: 'weekly', at: '10:30', weekday: 'wed' },
    'день недели принимается в любом регистре и приводится к нижнему',
  );
  assert.throws(() => schedulePayload({ ...base, kind: 'interval', everyMinutes: 1 }), /от 5 до 10080/);
  const interval = schedulePayload({ ...base, kind: 'interval', everyMinutes: '120' });
  assert.deepEqual(interval.spec, { kind: 'interval', everyMinutes: 120 });
  // Политики по умолчанию — безопасные: не догонять всё и не запускать параллельно.
  assert.equal(schedulePayload(base).misfirePolicy, 'RUN_ONCE');
  assert.equal(schedulePayload(base).concurrencyPolicy, 'SKIP_IF_RUNNING');
  assert.equal(schedulePayload(base).enabled, true);
});

test('форма рецепта не отправляет того, что сервер не исполняет', () => {
  const body = recipePayload({ name: '  Аудит ', promptTemplate: 'Проверь сборку', projectId: 'p1', model: 'deepseek/deepseek-flash' });
  assert.deepEqual(body, {
    name: 'Аудит', promptTemplate: 'Проверь сборку', projectId: 'p1',
    runtime: { id: 'pi', model: 'deepseek/deepseek-flash' },
  });
  assert.equal('workspace' in body, false);
  assert.equal('context' in body, false);
  assert.equal('limits' in body, false);
  assert.throws(() => recipePayload({ name: '', promptTemplate: 'x' }), /имя/);
  assert.throws(() => recipePayload({ name: 'x', promptTemplate: '   ' }), /Промпт/);
});

test('страница автоматизаций и её модули отдаются сервером', { timeout: 60000 }, async t => {
  const { startFixture } = await import('./server-fixture.mjs');
  const fixture = await startFixture();
  t.after(() => fixture.close());

  for (const [route, expected] of [
    ['/automations.html', /^text\/html/],
    ['/automations.js', /^text\/javascript/],
    ['/automations-view.mjs', /^text\/javascript/],
  ]) {
    const response = await fetch(fixture.base + route);
    assert.equal(response.status, 200, `${route} → ${response.status}`);
    assert.match(response.headers.get('content-type') || '', expected, route);
  }

  // Форма на странице содержит все поля, с которыми работает automations.js:
  // опечатка в id ломала бы экран без единой ошибки в консоли сервера.
  const html = await (await fetch(`${fixture.base}/automations.html`)).text();
  for (const id of ['automation-form', 'project', 'items', 'history', 'name', 'prompt', 'model', 'kind', 'at', 'weekday', 'everyMinutes', 'misfirePolicy', 'concurrencyPolicy', 'notify', 'enabled', 'save', 'run', 'pause', 'delete']) {
    assert.match(html, new RegExp(`id="${id}"`), `на странице нет поля ${id}`);
  }

  // И вход в раздел есть в основном интерфейсе.
  const index = await (await fetch(`${fixture.base}/`)).text();
  assert.match(index, /id="automationsButton"/, 'кнопка раздела в шапке');
});
