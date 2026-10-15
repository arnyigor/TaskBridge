// Автоматический перезапуск сервера (запрос оператора 2026-10-14: «чтобы можно было
// автоматом перезапускать сервер, без моего участия, типа таймер ставишь —
// перезапускается и самовосстанавливается»).
//
// Здесь только РЕШЕНИЕ: когда перезапускать. Само перезапускание — существующий путь
// POST /api/server/restart (отделённый воркер scripts/restart-and-verify.mjs или
// scripts/restart-lan-now.mjs), который уже умеет поднять сервер и проверить, что он
// жив. Своего «второго способа перезапуска» здесь нет намеренно: два механизма
// разошлись бы в поведении.
//
// Почему решение вынесено в чистые функции: таймер, стреляющий по расписанию, —
// самый неудобный для тестов зверь. Проверяются правила (расписание, минимальный
// аптайм, занятость), а не ожидание часов.

export const AUTO_RESTART_DEFAULTS = Object.freeze({
  /** По умолчанию выключено: автоперезапуск — выбор оператора, а не поведение по умолчанию. */
  enabled: false,
  /** Интервал от старта сервера (часы). 0 — не использовать. */
  everyHours: 0,
  /** Ежедневно в это локальное время, 'HH:MM'. null — не использовать. */
  at: null,
  /** Не перезапускаться раньше этого аптайма: защита от цикла «упал — поднялся — упал». */
  minUptimeMinutes: 10,
  /** Не прерывать живую работу: ждать, пока сессии освободятся. */
  onlyWhenIdle: true,
  /** Как часто проверять расписание. Секунды. */
  tickSec: 60,
});

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function normalizeAutoRestart(config = {}) {
  const raw = config && typeof config === 'object' ? config : {};
  const at = typeof raw.at === 'string' && HHMM.test(raw.at.trim()) ? raw.at.trim() : null;
  const everyHours = Number(raw.everyHours);
  const minUptimeMinutes = Number(raw.minUptimeMinutes);
  const tickSec = Number(raw.tickSec);
  return {
    enabled: raw.enabled === true,
    everyHours: Number.isFinite(everyHours) && everyHours > 0 ? everyHours : 0,
    at,
    minUptimeMinutes: Number.isFinite(minUptimeMinutes) && minUptimeMinutes >= 0
      ? minUptimeMinutes
      : AUTO_RESTART_DEFAULTS.minUptimeMinutes,
    onlyWhenIdle: raw.onlyWhenIdle !== false,
    tickSec: Number.isFinite(tickSec) && tickSec >= 5 ? tickSec : AUTO_RESTART_DEFAULTS.tickSec,
  };
}

/** Правило задано? Без расписания (ни `everyHours`, ни `at`) перезапускать нечего. */
export function autoRestartConfigured(config) {
  const settings = normalizeAutoRestart(config);
  return settings.enabled && (settings.everyHours > 0 || settings.at !== null);
}

function dailyAt(now, hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  const moment = new Date(now);
  moment.setHours(hours, minutes, 0, 0);
  return moment;
}

/**
 * Момент следующего перезапуска (или null, если расписание не задано).
 *
 * `at` считается от ближайшего наступления времени: если оно уже прошло сегодня —
 * значит завтра (иначе сервер, поднятый в 05:00 при `at: 04:00`, перезапускался бы
 * бесконечно).
 */
export function nextRestartAt(config, { now = Date.now(), startedAt = now } = {}) {
  const settings = normalizeAutoRestart(config);
  if (!settings.enabled) return null;
  const candidates = [];
  if (settings.at) {
    let moment = dailyAt(now, settings.at).getTime();
    if (moment <= now) moment = dailyAt(now + 24 * 60 * 60 * 1000, settings.at).getTime();
    candidates.push(moment);
  }
  if (settings.everyHours > 0) {
    candidates.push(startedAt + settings.everyHours * 60 * 60 * 1000);
  }
  if (!candidates.length) return null;
  return new Date(Math.min(...candidates));
}

/**
 * Ближайший ПРОШЕДШИЙ момент расписания (или null).
 *
 * Зачем отдельно от [nextRestartAt]: «следующий» момент после наступления сегодняшнего
 * уезжает на завтра, и проверка «пора?» через него не сработала бы никогда — сервер
 * оставался бы в состоянии «not-due» вечно (это и показала живая приёмка 2026-10-14).
 * Здесь считается именно наступление, которое уже случилось.
 */
export function previousRestartMoment(config, { now = Date.now(), startedAt = now } = {}) {
  const settings = normalizeAutoRestart(config);
  if (!settings.enabled) return null;
  let latest = null;
  if (settings.at) latest = dailyAt(now, settings.at).getTime() > now
    ? dailyAt(now, settings.at).getTime() - 24 * 60 * 60 * 1000
    : dailyAt(now, settings.at).getTime();
  if (settings.everyHours > 0) {
    const interval = settings.everyHours * 60 * 60 * 1000;
    const ticks = Math.floor((now - startedAt) / interval);
    if (ticks >= 1) latest = Math.max(latest ?? Number.NEGATIVE_INFINITY, startedAt + ticks * interval);
  }
  return latest;
}

/**
 * Пора ли перезапускаться. Возвращает решение с причиной — чтобы в логе было видно
 * не только «перезапускаюсь», но и «почему не сейчас».
 *
 * [active] — есть ли живая работа: при `onlyWhenIdle` перезапуск откладывается, а не
 * обрывает ход. Оператор ставит таймер, чтобы сервер сам поднялся свежим, а не чтобы
 * потерять ответ модели.
 *
 * Наступление считается «съеденным», если оно раньше старта этого процесса или раньше
 * прошлого перезапуска — поэтому после перезапуска тот же момент не повторяется.
 */
export function autoRestartDecision(config, { now = Date.now(), startedAt = now, lastRestartAt = null, active = false } = {}) {
  const settings = normalizeAutoRestart(config);
  if (!settings.enabled) return { restart: false, reason: 'disabled' };
  if (!settings.everyHours && !settings.at) return { restart: false, reason: 'no-schedule' };
  const uptimeMs = now - startedAt;
  if (uptimeMs < settings.minUptimeMinutes * 60 * 1000) {
    return { restart: false, reason: 'too-young', settings, uptimeMs };
  }
  const since = lastRestartAt ?? startedAt;
  const moment = previousRestartMoment(settings, { now, startedAt });
  if (moment === null || moment <= since) {
    return { restart: false, reason: 'not-due', settings, nextAt: nextRestartAt(settings, { now, startedAt }) };
  }
  if (settings.onlyWhenIdle && active) return { restart: false, reason: 'busy', settings, deferred: true };
  return { restart: true, reason: 'due', settings, dueAt: new Date(moment) };
}
