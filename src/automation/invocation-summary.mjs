// Компактная сводка одного запуска автоматизации (AUTO-03B).
//
// Читает уже существующие факты: инвокация (когда началось и кончилось, статус,
// проверка), сессия Pi (фактическая модель, usage последнего хода). Никакого
// второго учёта запусков не заводится.
//
// Честность важнее полноты: неизвестное значение — `null`, а не ноль, и у токенов
// явно указан масштаб (`scope`). Pi отдаёт usage ПОСЛЕДНЕГО хода, а не сумму по
// всем ходам сессии, поэтому суммарные токены запуска здесь не выдумываются.

const number = value => (Number.isFinite(Number(value)) ? Number(value) : null);

/** Разница двух моментов в мс; null, если хоть один неизвестен или порядок нарушен. */
export function betweenIso(fromIso, toIso) {
  const from = Date.parse(fromIso ?? '');
  const to = Date.parse(toIso ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return to - from;
}

/**
 * Сводка запуска.
 *
 * `invocation` — запись из `invocations`, `session` — задача сессии (может быть уже
 * удалена: тогда сводка всё равно отдаёт время и статус запуска).
 */
export function invocationSummary(invocation = {}, session = null) {
  if (!invocation || typeof invocation !== 'object') return null;
  const startedAt = invocation.startedAt ?? null;
  const finishedAt = invocation.finishedAt ?? null;
  const running = String(invocation.status ?? '').toUpperCase() === 'RUNNING';

  // Ожидание в очереди — это не работа модели: считаем только для запусков по
  // расписанию и только когда оба момента известны.
  const waitingMs = invocation.trigger === 'schedule' ? betweenIso(invocation.scheduledAt, startedAt) : null;

  const model = session?.model
    ? { provider: session.model.provider ?? null, id: session.model.id ?? null }
    : null;

  const usage = session?.lastUsage ?? null;
  const input = number(usage?.input);
  const output = number(usage?.output);
  const cacheRead = number(usage?.cacheRead);
  const total = number(usage?.totalTokens);
  const tokens = (input === null && output === null && total === null && cacheRead === null)
    ? null
    : {
      input,
      output,
      total,
      cacheRead,
      // Масштаб обязателен: иначе «18 420 токенов» читается как весь запуск.
      scope: 'last-turn',
    };

  return {
    id: invocation.id ?? null,
    recipeId: invocation.recipeId ?? null,
    scheduleId: invocation.scheduleId ?? null,
    trigger: invocation.trigger ?? null,
    status: invocation.status ?? null,
    reason: invocation.reason ? String(invocation.reason).slice(0, 500) : null,
    scheduledAt: invocation.scheduledAt ?? null,
    startedAt,
    finishedAt,
    // Пока запуск не завершён, длительности нет: «0 мс» было бы враньём.
    durationMs: running ? null : betweenIso(startedAt, finishedAt),
    waitingMs,
    model,
    tokens,
    verification: invocation.verification ?? null,
    sessionId: invocation.sessionId ?? null,
    sessionExists: Boolean(session),
    resultArtifact: invocation.resultArtifact ?? null,
    // Стоимость не считается: тарифов TaskBridge не знает, а «примерно» здесь
    // хуже, чем «нет данных».
    cost: null,
  };
}
