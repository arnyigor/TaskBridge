// Public metadata must not announce completion ahead of the durable terminal
// event. Weak keys keep this coordination state out of persisted task JSON.
export class TerminalPublication {
  #snapshots = new WeakMap();

  hold(task, snapshot) {
    if (!this.#snapshots.has(task)) this.#snapshots.set(task, snapshot);
  }

  snapshot(task) { return this.#snapshots.get(task); }
  release(task) { this.#snapshots.delete(task); }
}
