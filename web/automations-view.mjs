// Чистые помощники экрана «Автоматизации» (AUTO-02).
//
// Вынесены из automations.js, потому что ошибаются именно они: подпись расписания,
// сборка тела запроса и объяснение статуса запуска. Проверяются без DOM и сети —
// `tests/web-automations-view.test.mjs`.

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_LABELS = Object.freeze({
  mon: 'по понедельникам', tue: 'по вторникам', wed: 'по средам', thu: 'по четвергам',
  fri: 'по пятницам', sat: 'по субботам', sun: 'по воскресеньям',
});

/** Вид расписания по-человечески: «каждый день в 09:00», «каждые 120 мин». */
export function scheduleText(schedule) {
  const spec = schedule?.spec ?? {};
  if (spec.kind === 'interval') return `каждые ${Number(spec.everyMinutes) || '—'} мин`;
  if (spec.kind === 'weekly') return `${WEEKDAY_LABELS[spec.weekday] || 'по ?'} в ${spec.at || '—'}`;
  if (spec.kind === 'daily') return `каждый день в ${spec.at || '—'}`;
  return 'расписание не задано';
}

/** Политики — словами: их выбирают, а не запоминают. */
export const MISFIRE_LABELS = Object.freeze({
  RUN_ONCE: 'один запуск за пропущенное время',
  SKIP: 'пропустить, если время прошло',
  CATCH_UP: 'догнать все пропущенные запуски',
});

export const CONCURRENCY_LABELS = Object.freeze({
  SKIP_IF_RUNNING: 'пропустить, если предыдущий ещё идёт',
  QUEUE: 'поставить в очередь',
  PARALLEL: 'запускать параллельно',
  REPLACE: 'остановить предыдущий и запустить',
});

export const NOTIFY_LABELS = Object.freeze({
  'action-required': 'только когда нужно действие',
  always: 'о каждом запуске',
  'errors-only': 'только об ошибках',
  never: 'не уведомлять',
});

/** Состояние автоматизации: пауза важнее следующего запуска. */
export function scheduleStateText(schedule) {
  if (!schedule) return 'нет расписания';
  if (schedule.enabled === false) return 'на паузе';
  return schedule.nextRunAt ? `следующий запуск: ${formatMoment(schedule.nextRunAt)}` : 'ожидает расчёта';
}

export function formatMoment(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const INVOCATION_LABELS = Object.freeze({
  RUNNING: 'выполняется',
  SUCCEEDED: 'успешно',
  FAILED: 'ошибка',
  SKIPPED: 'пропущено',
  CANCELLED: 'отменено',
});

/** Статус запуска и причина одной строкой; причина печатается, когда она есть. */
export function invocationText(invocation) {
  const status = String(invocation?.status || '').toUpperCase();
  const label = INVOCATION_LABELS[status] || 'неизвестно';
  const parts = [label];
  const moment = invocation?.startedAt ? formatMoment(invocation.startedAt) : null;
  if (moment) parts.push(moment);
  if (invocation?.verification && invocation.verification !== 'NOT_CONFIGURED') {
    parts.push(`проверка: ${invocation.verification === 'PASSED' ? 'пройдена' : invocation.verification === 'RUNNING' ? 'идёт' : 'не пройдена'}`);
  }
  const reason = invocation?.reason ? String(invocation.reason).slice(0, 300) : null;
  return `${parts.join(' · ')}${reason ? ` — ${reason}` : ''}`;
}

const invalid = message => Object.assign(new Error(message), { code: 'INPUT_INVALID' });

/**
 * Тело `POST /api/schedules` из значений формы. Проверки те же, что на сервере,
 * но здесь они дают понятное сообщение до запроса: расписание «25:99» не должно
 * уезжать на сервер, чтобы вернуться сухим `INPUT_INVALID`.
 */
export function schedulePayload(form = {}) {
  const kind = String(form.kind || '').toLowerCase();
  if (!['daily', 'weekly', 'interval'].includes(kind)) throw invalid('Вид расписания — daily, weekly или interval.');
  const body = {
    recipeId: String(form.recipeId || '').trim(),
    misfirePolicy: String(form.misfirePolicy || 'RUN_ONCE').toUpperCase(),
    concurrencyPolicy: String(form.concurrencyPolicy || 'SKIP_IF_RUNNING').toUpperCase(),
    notify: String(form.notify || 'action-required').toLowerCase(),
    enabled: form.enabled !== false,
  };
  if (!body.recipeId) throw invalid('Сначала сохраните промпт: расписание привязано к рецепту.');
  if (kind === 'interval') {
    const everyMinutes = Number(form.everyMinutes);
    if (!Number.isSafeInteger(everyMinutes) || everyMinutes < 5 || everyMinutes > 10080) {
      throw invalid('Интервал — целое число минут от 5 до 10080.');
    }
    body.spec = { kind, everyMinutes };
    return body;
  }
  const at = String(form.at || '').trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw invalid('Время запуска — в виде ЧЧ:ММ (00:00..23:59).');
  const normalizedAt = `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
  if (kind === 'daily') {
    body.spec = { kind, at: normalizedAt };
    return body;
  }
  const weekday = String(form.weekday || '').toLowerCase();
  if (!WEEKDAYS.includes(weekday)) throw invalid(`День недели — один из: ${WEEKDAYS.join(', ')}.`);
  body.spec = { kind, at: normalizedAt, weekday };
  return body;
}

/**
 * Тело `POST /api/recipes` из формы. `workspace`/`context`/`limits` сюда не
 * попадают намеренно: сервер их не исполняет и отклоняет (AUTO-01A).
 */
export function recipePayload(form = {}) {
  const name = String(form.name || '').trim();
  const promptTemplate = String(form.promptTemplate || '').trim();
  if (!name) throw invalid('У автоматизации должно быть имя.');
  if (!promptTemplate) throw invalid('Промпт не может быть пустым.');
  const body = { name, promptTemplate };
  if (form.projectId) body.projectId = String(form.projectId);
  if (form.model) body.runtime = { id: 'pi', model: String(form.model) };
  return body;
}
