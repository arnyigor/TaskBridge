// Счётчики памяти для /api/metrics (план §1.5: «событие/метрика переполнения»).
//
// Почему счётчики, а не событие в ленте задачи: инъекция памяти происходит при
// сборке контекста Resume — это не ход сессии, и событие в чате было бы шумом.
// Оператору важно одно: «память работает» (сколько заметок и токенов ушло в
// контекст) и «память упирается в бюджет» (сколько раз не влезло).

class MemoryMetrics {
  #counters = new Map();
  #gauges = new Map();

  #bump(name, delta = 1) {
    this.#counters.set(name, (this.#counters.get(name) || 0) + delta);
  }

  /** Итог одной инъекции: сколько заметок и токенов ушло в контекст. */
  recordInjection({ notes = 0, tokens = 0, globalNotes = 0, globalTokens = 0 } = {}) {
    this.#bump('injections');
    this.#bump('injected_notes', Number(notes) || 0);
    this.#bump('injected_tokens', Number(tokens) || 0);
    this.#bump('injected_global_notes', Number(globalNotes) || 0);
    this.#bump('injected_global_tokens', Number(globalTokens) || 0);
  }

  /** Бюджет оказался жёстким: заметка осталась доступной поиском, но не в контексте. */
  recordOverflow({ dropped = 0, droppedTokens = 0, global = false } = {}) {
    this.#bump('budget_overflows');
    this.#bump('budget_dropped_notes', Number(dropped) || 0);
    this.#bump('budget_dropped_tokens', Number(droppedTokens) || 0);
    if (global) this.#bump('global_budget_overflows');
  }

  /**
   * Задержка поиска по индексу: count/sum/max. Среднее считается вызывающим —
   * счётчики здесь, потому что реестр метрик остаётся простым и предсказуемым.
   */
  recordSearch(durationMs) {
    const value = Number(durationMs);
    if (!Number.isFinite(value) || value < 0) return;
    this.#bump('searches');
    this.#bump('search_ms_total', value);
    const max = this.#gauges.get('search_ms_max') ?? 0;
    if (value > max) this.#gauges.set('search_ms_max', Math.round(value));
  }

  /** Текущее значение, а не накопленное: сколько заметок в памяти и сколько ждёт решения. */
  setGauge(name, value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    this.#gauges.set(String(name), number);
  }

  snapshot() {
    return {
      ...Object.fromEntries([...this.#counters.entries()].sort(([a], [b]) => a.localeCompare(b))),
      ...Object.fromEntries([...this.#gauges.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
  }

  reset() {
    this.#counters.clear();
    this.#gauges.clear();
  }
}

export const memoryMetrics = new MemoryMetrics();
