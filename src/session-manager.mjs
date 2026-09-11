// SessionManager — a read-only session view over the existing TaskManager
// (TZ stage 2), plus capability-aware runner resolution.
//
// Stage 2 splits the old "one Task = one live process" model into Session /
// Run / Command concepts. This module introduces the Session identity and the
// runner-facing view additively: it does NOT move execution, change storage or
// alter any command response. The MVP rule is one Task = one Session, so the
// session id is the task id unless a task carries its own `sessionId`.
//
// Once the split is fully done, this becomes the owner of live sessions; for
// now it is a thin adapter so the UI/cloud can already speak in session terms.

import { PiRunner } from './runners/pi-runner.mjs';

// Stable session id for a task (task->session map in the MVP is identity).
export function sessionIdForTask(task) {
  return (task && (task.sessionId || task.id)) || null;
}

export class SessionManager {
  constructor(manager) {
    if (!manager) throw new Error('SessionManager requires a TaskManager');
    this.manager = manager;
  }

  listSessions() {
    return this.manager.listTasks().map((t) => this.#view(t));
  }

  sessionForTask(taskId) {
    const task = this.manager.getTask(taskId);
    return task ? this.#view(task) : null;
  }

  // MVP: sessionId === taskId, so the reverse lookup is direct.
  taskForSession(sessionId) {
    return this.manager.getTask(sessionId) || null;
  }

  // Wrap the task's live Pi session in a runner, or null when there is no live
  // session (never started / already closed). The runner advertises what Pi
  // supports so the UI can hide unsupported controls.
  runnerFor(taskId) {
    const runtime = this.manager.runtimes && this.manager.runtimes.get(taskId);
    if (!runtime || !runtime.pi || runtime.pi.closed) return null;
    return new PiRunner(runtime.pi);
  }

  #view(task) {
    return {
      id: sessionIdForTask(task),
      taskId: task.id,
      runnerId: 'pi',
      state: task.status,
      title: task.title || null,
      projectId: task.projectId || null,
      workspaceRef: task.workspacePath || null,
      nativeSessionRef: task.piSessionFile || null,
      sessionAvailable: Boolean(task.sessionAvailable),
    };
  }
}
