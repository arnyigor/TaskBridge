// Schedules and their policies (ROADMAP_FULL.md, MR-06).
//
// The scheduler runs on the PC, not on the phone and not in the relay: the machine
// is the source of truth, and a phone that is off or offline changes nothing about
// whether 09:00 happens. This module is the pure half — when a schedule is due,
// what to do about a run that was missed while the machine was off, and which
// concurrency policy applies. Keeping it pure is what makes those rules testable
// without waiting for a real clock.

export const SCHEDULE_KINDS = Object.freeze(['daily', 'weekly', 'interval']);

/** What to do when the machine was off or the scheduler did not run. */
export const MISFIRE_POLICIES = Object.freeze(['SKIP', 'RUN_ONCE', 'CATCH_UP']);

/**
 * What to do when the previous run of the SAME schedule is still working.
 * `PARALLEL` is only safe with independent worktrees (the machinery enforces one
 * session per directory anyway); `REPLACE` stops the running one first.
 */
export const CONCURRENCY_POLICIES = Object.freeze(['SKIP_IF_RUNNING', 'QUEUE', 'PARALLEL', 'REPLACE']);

/** What deserves a notification: the phone is not a log file. */
export const NOTIFY_POLICIES = Object.freeze(['action-required', 'always', 'errors-only', 'never']);

/** How a run behaves when the agent asks for an approval while nobody is watching. */
export const APPROVAL_MODES = Object.freeze(['pause']);

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const invalid = (message) => Object.assign(new Error(message), { code: 'INPUT_INVALID' });

/** A parameter whose value is a secret must not be stored in a recipe at all. */
const SECRET_PARAMETER = /(token|password|passwd|secret|api[_-]?key|private[_-]?key|credential)/i;

/** `HH:MM` in the machine's local time (the scheduler lives on that machine). */
function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) throw invalid('Время запуска — в виде ЧЧ:ММ.');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw invalid('Время запуска — в виде ЧЧ:ММ (00:00..23:59).');
  return { hours, minutes };
}

/** Validates a schedule spec and returns it in its stored shape. */
export function normalizeScheduleSpec(input = {}) {
  const kind = String(input.kind ?? '').trim().toLowerCase();
  if (!SCHEDULE_KINDS.includes(kind)) throw invalid(`Вид расписания — один из: ${SCHEDULE_KINDS.join(', ')}.`);
  if (kind === 'interval') {
    const everyMinutes = Number(input.everyMinutes);
    if (!Number.isSafeInteger(everyMinutes) || everyMinutes < 5 || everyMinutes > 7 * 24 * 60) {
      throw invalid('Интервал — целое число минут от 5 до 10080.');
    }
    return { kind, everyMinutes };
  }
  const { hours, minutes } = parseClock(input.at);
  if (kind === 'daily') return { kind, at: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` };
  // Names only: a number would need a convention (0 = Sunday? Monday?) and picking
  // one silently is how an off-by-one day appears in production.
  const day = String(input.weekday ?? '').trim().toLowerCase();
  if (!WEEKDAYS.includes(day)) throw invalid(`День недели — один из: ${WEEKDAYS.join(', ')}.`);
  return { kind, at: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`, weekday: day };
}

/** Local midnight of the day that contains [date]. */
function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/**
 * The first moment strictly after [after] at which the spec fires.
 * Daily/weekly times are local (the machine's clock), intervals are pure arithmetic
 * from the anchor, so a machine that slept does not shift the phase.
 */
export function nextRunAfter(spec, after, { anchor = null } = {}) {
  const from = new Date(after);
  if (Number.isNaN(from.getTime())) throw invalid('Некорректное время отсчёта.');
  if (spec.kind === 'interval') {
    const step = spec.everyMinutes * MINUTE_MS;
    const base = anchor ? new Date(anchor).getTime() : from.getTime();
    if (!Number.isFinite(base)) throw invalid('Некорректный якорь интервала.');
    if (base > from.getTime()) return new Date(base).toISOString();
    const periods = Math.floor((from.getTime() - base) / step) + 1;
    return new Date(base + periods * step).toISOString();
  }
  const { hours, minutes } = parseClock(spec.at);
  const candidate = startOfDay(from);
  candidate.setHours(hours, minutes, 0, 0);
  if (spec.kind === 'weekly') {
    const target = WEEKDAYS.indexOf(spec.weekday);
    const current = (candidate.getDay() + 6) % 7; // Monday = 0
    let shift = (target - current + 7) % 7;
    if (shift === 0 && candidate.getTime() <= from.getTime()) shift = 7;
    return new Date(candidate.getTime() + shift * DAY_MS).toISOString();
  }
  if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate.toISOString();
}

/**
 * How many times the spec fired between [from] and [to] (exclusive of `to`).
 * Bounded: a schedule that fired every five minutes for a month is not a reason to
 * start ten thousand sessions.
 */
export function occurrencesBetween(spec, from, to, { anchor = null, limit = 100 } = {}) {
  const out = [];
  let cursor = new Date(from);
  if (Number.isNaN(cursor.getTime())) throw invalid('Некорректное время отсчёта.');
  let next = nextRunAfter(spec, cursor, { anchor });
  while (new Date(next).getTime() < new Date(to).getTime() && out.length < limit) {
    out.push(next);
    cursor = new Date(new Date(next).getTime() + 1);
    next = nextRunAfter(spec, cursor, { anchor });
  }
  return out;
}

/**
 * What to do about a schedule whose due moment has passed.
 *
 * The default is RUN_ONCE on purpose: a machine that was off for three days must
 * not start three independent audits, and CATCH_UP would do exactly that.
 */
export function resolveMisfire(schedule, now, { anchor = null, limit = 100 } = {}) {
  const due = schedule.nextRunAt ? new Date(schedule.nextRunAt) : null;
  if (!due || Number.isNaN(due.getTime())) return { policy: schedule.misfirePolicy ?? 'RUN_ONCE', runs: [], missed: 0, nextRunAt: null };
  if (due.getTime() > new Date(now).getTime()) return { policy: schedule.misfirePolicy ?? 'RUN_ONCE', runs: [], missed: 0, nextRunAt: schedule.nextRunAt };

  const policy = MISFIRE_POLICIES.includes(schedule.misfirePolicy) ? schedule.misfirePolicy : 'RUN_ONCE';
  // Everything that fired between the due moment and now, including it.
  const missed = occurrencesBetween(schedule.spec, new Date(due.getTime() - 1).toISOString(), now, { anchor, limit });
  const runs = policy === 'SKIP' ? []
    : policy === 'CATCH_UP' ? missed
      : missed.slice(-1); // RUN_ONCE: only the newest missed moment
  const after = missed.at(-1) ?? due.toISOString();
  return {
    policy,
    runs,
    missed: Math.max(0, missed.length - runs.length),
    nextRunAt: nextRunAfter(schedule.spec, after, { anchor }),
  };
}

/** Validates the whole schedule (spec + policies + parameters) before it is stored. */
export function normalizeSchedule(input = {}, { recipe = null } = {}) {
  const spec = normalizeScheduleSpec(input.spec ?? input);
  const misfirePolicy = String(input.misfirePolicy ?? 'RUN_ONCE').toUpperCase();
  if (!MISFIRE_POLICIES.includes(misfirePolicy)) throw invalid(`Политика пропусков — одна из: ${MISFIRE_POLICIES.join(', ')}.`);
  const concurrencyPolicy = String(input.concurrencyPolicy ?? 'SKIP_IF_RUNNING').toUpperCase();
  if (!CONCURRENCY_POLICIES.includes(concurrencyPolicy)) throw invalid(`Политика параллелизма — одна из: ${CONCURRENCY_POLICIES.join(', ')}.`);
  const notify = String(input.notify ?? 'action-required').toLowerCase();
  if (!NOTIFY_POLICIES.includes(notify)) throw invalid(`Уведомления — одна из: ${NOTIFY_POLICIES.join(', ')}.`);
  const approvalMode = String(input.approvalMode ?? 'pause').toLowerCase();
  if (!APPROVAL_MODES.includes(approvalMode)) throw invalid(`Режим подтверждений — один из: ${APPROVAL_MODES.join(', ')}.`);

  const parameters = input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters) ? input.parameters : {};
  // A secret in a schedule would be stored and later printed in the prompt, the
  // recap and the history — exactly what the roadmap forbids.
  const suspect = Object.keys(parameters).filter(name => SECRET_PARAMETER.test(name));
  if (suspect.length) {
    throw invalid(`Секреты не хранятся в расписании (${suspect.join(', ')}): используйте secretRef, а не значение.`);
  }
  return {
    enabled: input.enabled !== false,
    spec,
    misfirePolicy,
    concurrencyPolicy,
    notify,
    approvalMode,
    parameters,
    ...(recipe ? { recipeId: recipe.id } : {}),
  };
}

/** «Каждый день в 09:00», «по понедельникам в 10:30», «каждые 120 минут» — для UI и логов. */
export function describeSchedule(schedule) {
  const spec = schedule?.spec ?? {};
  if (spec.kind === 'interval') return `каждые ${spec.everyMinutes} мин`;
  const day = spec.kind === 'weekly' ? `по ${spec.weekday}` : 'каждый день';
  return `${day} в ${spec.at}`;
}
