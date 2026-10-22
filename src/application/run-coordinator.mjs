import crypto from 'node:crypto';

// One execution identity per active turn, including waits for user approval.
// The store commits terminal records with their task snapshot and event.
export class RunCoordinator {
  constructor(store) {
    this.store = store;
    this.open = new Map();
  }

  start(taskId) {
    if (this.open.has(taskId)) return this.open.get(taskId);
    const id = crypto.randomUUID();
    this.store.recordRun({ id, taskId, sessionId: taskId, kind: 'prompt', status: 'RUNNING', startedAt: new Date().toISOString() });
    this.open.set(taskId, id);
    return id;
  }

  /** Текущий (незакрытый) запуск сессии — для корреляции в API и диагностике. */
  current(taskId) {
    return this.open.get(taskId) || null;
  }

  recover() { return this.store.interruptRuns(new Date().toISOString()); }

  terminal(taskId, status, finishedAt) {
    const id = this.open.get(taskId);
    return id ? { id, taskId, sessionId: taskId, kind: 'prompt', status, finishedAt } : null;
  }

  committed(taskId, runId) {
    if (this.open.get(taskId) === runId) this.open.delete(taskId);
  }
}
