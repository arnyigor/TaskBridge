import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeScheduleSpec, normalizeSchedule, nextRunAfter, occurrencesBetween, resolveMisfire, describeSchedule,
} from '../src/scheduler/schedule.mjs';

// MR-06: математика расписаний. Проверяется здесь, а не ожиданием настоящих часов:
// именно эти правила решают, запустится ли ночной аудит и не запустится ли он трижды.

const at = (iso) => new Date(iso);
const local = (year, month, day, hours, minutes) => new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString();

test('a daily schedule fires at the next occurrence, not today if the time has passed', () => {
  const spec = normalizeScheduleSpec({ kind: 'daily', at: '09:00' });
  const morning = local(2026, 10, 11, 8, 0);
  const next = nextRunAfter(spec, morning);
  assert.equal(next, local(2026, 10, 11, 9, 0), 'утром — сегодня');
  const evening = local(2026, 10, 11, 10, 0);
  assert.equal(nextRunAfter(spec, evening), local(2026, 10, 12, 9, 0), 'после девяти — завтра');
  // Exactly at the moment: the next one, not the same instant again.
  assert.equal(nextRunAfter(spec, local(2026, 10, 11, 9, 0)), local(2026, 10, 12, 9, 0));
});

test('a weekly schedule keeps its weekday across a month boundary', () => {
  const spec = normalizeScheduleSpec({ kind: 'weekly', at: '10:30', weekday: 'mon' });
  // 2026-10-11 is a Sunday; the next Monday is the 12th.
  assert.equal(nextRunAfter(spec, local(2026, 10, 11, 12, 0)), local(2026, 10, 12, 10, 30));
  assert.equal(nextRunAfter(spec, local(2026, 10, 12, 11, 0)), local(2026, 10, 19, 10, 30), 'после понедельничного запуска — следующий понедельник');
  assert.equal(nextRunAfter(spec, local(2026, 10, 31, 23, 0)), local(2026, 11, 2, 10, 30), 'через границу месяца');
});

test('an interval keeps its phase after the machine was asleep', () => {
  const spec = normalizeScheduleSpec({ kind: 'interval', everyMinutes: 60 });
  const anchor = local(2026, 10, 11, 9, 0);
  assert.equal(nextRunAfter(spec, local(2026, 10, 11, 9, 30), { anchor }), local(2026, 10, 11, 10, 0));
  // The machine slept through three slots: the phase does not drift with it.
  assert.equal(nextRunAfter(spec, local(2026, 10, 11, 12, 10), { anchor }), local(2026, 10, 11, 13, 0), 'не «через час от пробуждения»');
});

test('occurrences between two moments are bounded and inclusive of the start', () => {
  const spec = normalizeScheduleSpec({ kind: 'daily', at: '09:00' });
  const found = occurrencesBetween(spec, local(2026, 10, 9, 8, 0), local(2026, 10, 12, 9, 0));
  assert.deepEqual(found, [
    local(2026, 10, 9, 9, 0), local(2026, 10, 10, 9, 0), local(2026, 10, 11, 9, 0),
  ], 'три прошедших момента, четвёртый — уже за границей');
  assert.equal(occurrencesBetween(spec, local(2026, 1, 1, 0, 0), local(2026, 12, 31, 0, 0), { limit: 10 }).length, 10, 'потолок соблюдён');
});

test('a missed run is handled by the policy, and RUN_ONCE is the default', () => {
  const base = { spec: normalizeScheduleSpec({ kind: 'daily', at: '09:00' }), nextRunAt: local(2026, 10, 9, 9, 0) };
  const now = local(2026, 10, 12, 12, 0); // три дня спустя

  // Four 09:00 moments passed between the due time and now (9, 10, 11 and 12 Oct).
  const once = resolveMisfire({ ...base, misfirePolicy: 'RUN_ONCE' }, now);
  assert.deepEqual(once.runs, [local(2026, 10, 12, 9, 0)], 'по умолчанию — один запуск, самый свежий пропущенный');
  assert.equal(once.missed, 3, 'и видно, сколько более старых моментов пропущено');
  assert.equal(once.nextRunAt, local(2026, 10, 13, 9, 0), 'следующий — завтра в девять');

  const skip = resolveMisfire({ ...base, misfirePolicy: 'SKIP' }, now);
  assert.deepEqual(skip.runs, [], 'пропустить — значит ничего не запускать');
  assert.equal(skip.missed, 4, 'все прошедшие моменты остаются пропущенными');
  assert.equal(skip.nextRunAt, local(2026, 10, 13, 9, 0));

  const catchUp = resolveMisfire({ ...base, misfirePolicy: 'CATCH_UP' }, now);
  assert.deepEqual(catchUp.runs, [local(2026, 10, 9, 9, 0), local(2026, 10, 10, 9, 0), local(2026, 10, 11, 9, 0), local(2026, 10, 12, 9, 0)]);
  assert.equal(catchUp.missed, 0);

  // A schedule that is not due yet does nothing at all.
  const future = resolveMisfire({ ...base, misfirePolicy: 'CATCH_UP', nextRunAt: local(2026, 10, 13, 9, 0) }, now);
  assert.deepEqual(future.runs, []);
  assert.equal(future.nextRunAt, local(2026, 10, 13, 9, 0), 'момент не сдвигается');
  // A schedule that never ran has no due moment to miss.
  assert.deepEqual(resolveMisfire({ ...base, nextRunAt: null }, now).runs, []);
});

test('a schedule is validated where the operator can see it, secrets included', () => {
  assert.throws(() => normalizeScheduleSpec({ kind: 'hourly' }), { code: 'INPUT_INVALID' });
  assert.throws(() => normalizeScheduleSpec({ kind: 'daily', at: '25:00' }), { code: 'INPUT_INVALID' });
  assert.throws(() => normalizeScheduleSpec({ kind: 'daily', at: '9' }), { code: 'INPUT_INVALID' });
  assert.throws(() => normalizeScheduleSpec({ kind: 'weekly', at: '09:00', weekday: 'среда' }), { code: 'INPUT_INVALID' });
  assert.throws(() => normalizeScheduleSpec({ kind: 'interval', everyMinutes: 1 }), { code: 'INPUT_INVALID' });

  // Числовой день недели отклоняется: 0 — это воскресенье или понедельник? Молча
  // выбрать одну из конвенций — это ошибка на сутки в проде.
  assert.throws(() => normalizeScheduleSpec({ kind: 'weekly', at: '09:00', weekday: 1 }), /День недели/);
  const ok = normalizeSchedule({ spec: { kind: 'weekly', at: '08:05', weekday: 'mon' }, recipeId: 'rc-1' });
  assert.deepEqual(ok.spec, { kind: 'weekly', at: '08:05', weekday: 'mon' });
  assert.equal(ok.misfirePolicy, 'RUN_ONCE');
  assert.equal(ok.concurrencyPolicy, 'SKIP_IF_RUNNING');
  assert.equal(ok.notify, 'action-required');
  assert.equal(ok.approvalMode, 'pause');
  assert.equal(ok.enabled, true);

  assert.throws(() => normalizeSchedule({ spec: { kind: 'daily', at: '09:00' }, misfirePolicy: 'МОЖЕТ БЫТЬ' }), { code: 'INPUT_INVALID' });
  // Политики принимаются в любом регистре и приводятся к каноническому виду.
  assert.equal(normalizeSchedule({ spec: { kind: 'daily', at: '09:00' }, concurrencyPolicy: 'parallel' }).concurrencyPolicy, 'PARALLEL');
  assert.throws(() => normalizeSchedule({ spec: { kind: 'daily', at: '09:00' }, concurrencyPolicy: 'когда-нибудь' }), { code: 'INPUT_INVALID' });
  assert.throws(() => normalizeSchedule({ spec: { kind: 'daily', at: '09:00' }, notify: 'иногда' }), { code: 'INPUT_INVALID' });
  // A secret in the schedule would end up in the prompt, the recap and the history.
  assert.throws(() => normalizeSchedule({ spec: { kind: 'daily', at: '09:00' }, parameters: { github_token: 'ghp_x' } }), /secretRef/);
  assert.throws(() => normalizeSchedule({ spec: { kind: 'daily', at: '09:00' }, parameters: { API_KEY: 'x' } }), /secretRef/);
});

test('a schedule describes itself for the UI', () => {
  assert.equal(describeSchedule({ spec: { kind: 'daily', at: '09:00' } }), 'каждый день в 09:00');
  assert.equal(describeSchedule({ spec: { kind: 'weekly', at: '10:30', weekday: 'sun' } }), 'по sun в 10:30');
  assert.equal(describeSchedule({ spec: { kind: 'interval', everyMinutes: 120 } }), 'каждые 120 мин');
});
