// Шаг C-B плана улучшений: backpressure в SSE-фан-ауте.
//
// `res.write()` возвращает false, когда буфер сокета полон — медленный клиент
// (телефон в плохой сети, вкладка в фоне). Раньше результат игнорировался, и
// события продолжали литься в буферы Node и ядра без предела: память процесса
// росла, а заметить это было нечем. Теперь при переполнении клиент ставится на
// паузу до 'drain', а если он не разбирает очередь дольше лимита — стрим
// обрывается. Обрыв безопасен: события лежат в store, и клиент переподключится
// с `after=<свой курсор>`, получив хвост из истории (та же логика, что у
// перезапуска сервера).

export const SSE_PENDING_LIMIT = 1000;

export class SseWriter {
  #res;
  #limit;
  #onOverflow;

  /** Сокет не принимает данные: ждём 'drain'. */
  backedUp = false;
  /** События, ждущие 'drain', по порядку. */
  queued = [];
  /** Стрим оборван переполнением: писать больше нельзя. */
  dropped = false;

  constructor(res, { limit = SSE_PENDING_LIMIT, onOverflow = null } = {}) {
    this.#res = res;
    this.#limit = limit;
    this.#onOverflow = onOverflow;
  }

  /**
   * true — событие принято (в сокет или в очередь), false — стрим оборван
   * переполнением, вызывающий должен убрать клиента из фан-аута.
   */
  send(event) {
    if (this.dropped) return false;
    if (this.backedUp) {
      this.queued.push(event);
      if (this.queued.length > this.#limit) {
        this.drop();
        return false;
      }
      return true;
    }
    if (this.#write(event)) return true;
    this.backedUp = true;
    this.#res.once('drain', () => this.flush());
    return true;
  }

  /**
   * Ждёт, пока сокет примет накопленное.
   *
   * Нужен тому, кто отдаёт историю сам (реплей стрима): там очередь ограничена
   * не сокетом, а циклом, и вместо обрыва правильнее подождать. Проверка опросом,
   * а не через once('drain'): flush() уже слушает 'drain', и второе ожидание того
   * же события могло бы прождать до следующего, которого на простаивающем сокете
   * не будет. Шаг в 5 мс включается только при отставании.
   */
  async waitForDrain() {
    while (this.backedUp && !this.dropped) await new Promise(resolve => setTimeout(resolve, 5));
  }

  /** Сокет снова готов: отдаём накопленное в порядке поступления. */
  flush() {
    if (this.dropped) return;
    this.backedUp = false;
    while (this.queued.length) {
      const event = this.queued[0];
      if (!this.#write(event)) {
        this.backedUp = true;
        this.#res.once('drain', () => this.flush());
        return;
      }
      this.queued.shift();
    }
  }

  drop() {
    if (this.dropped) return;
    this.dropped = true;
    this.queued = [];
    this.#onOverflow?.(this);
    try { this.#res.end(); } catch { /* уже закрыт */ }
  }

  #write(event) {
    try {
      return this.#res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`) !== false;
    } catch {
      // Закрытый сокет не должен валить фан-аут: остальные клиенты живы.
      return true;
    }
  }
}
