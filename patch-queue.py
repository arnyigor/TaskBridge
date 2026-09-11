import io

p = 'src/task-manager.mjs'
s = open(p, encoding='utf-8').read()

def sub(old, new, count=1):
    global s
    assert old in s, 'not found: ' + old[:70]
    s = s.replace(old, new, count)

# 1) constructor: queue poll state
sub("""    this.queue = [];
    this.activeTaskId = null;""",
"""    this.queue = [];
    this.activeTaskId = null;
    // capacity 1: a task that cannot start yet (local model busy) is kept in
    // the queue and retried, instead of rejecting the operator's prompt.
    this.queuePollMs = Number(config.queue?.pollMs) > 0 ? Number(config.queue.pollMs) : 1000;
    this.pumpTimer = null;""")

# 2) init(): a queued task survives a restart, an interrupted one does not
sub("""      if (['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING'].includes(task.status)) {
        task.status = 'FAILED';
        task.errorCode = 'FAILED_RECOVERY';
        task.error = 'TaskBridge restarted while this task was active.';
        task.updatedAt = now();
        await this.store.save(task);
      }""",
"""      // A queued task is restored: nothing was sent to Pi yet, so the prompt is
      // still exactly what the operator asked for. A task that was already
      // running (or preparing) cannot be resumed — its Pi process is gone.
      const queuedNotStarted = task.status === 'QUEUED' && !task.workspacePath;
      const queuedPrompt = task.status === 'QUEUED' && Boolean(task.pendingPrompt);
      if (queuedNotStarted || queuedPrompt) {
        task.queueReason = 'RESTORED';
        task.current = 'В очереди после перезапуска TaskBridge';
        task.updatedAt = now();
        await this.store.save(task);
        this.queue.push(task.id);
      } else if (['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING'].includes(task.status)) {
        task.status = 'FAILED';
        task.errorCode = 'FAILED_RECOVERY';
        task.error = 'TaskBridge restarted while this task was active.';
        task.updatedAt = now();
        await this.store.save(task);
      }""")

# 3) createTask: a busy model queues the task instead of rejecting it
sub("""    if (this.#selectionUsesLocalRuntime(requestedModel)) {
      const busy = await this.local.getBusyStatus();
      if (busy.busy) throw Object.assign(new Error('Локальная модель сейчас занята другим запросом. Повторите чуть позже.'), { code: 'MODEL_BUSY' });
      if (!this.#localAutostart() && !(await this.local.isReady())) throw Object.assign(new Error('Локальная модель недоступна.'), { code: 'LOCAL_RUNTIME_FAILED' });
    }""",
"""    // A busy local model no longer rejects the request: the task is accepted and
    // starts as soon as the model is free (queue, capacity 1). Losing an
    // operator's prompt to a timing race is never acceptable.
    let waitingForModel = false;
    if (this.#selectionUsesLocalRuntime(requestedModel)) {
      if (!this.#localAutostart() && !(await this.local.isReady())) throw Object.assign(new Error('Локальная модель недоступна.'), { code: 'LOCAL_RUNTIME_FAILED' });
      waitingForModel = Boolean((await this.local.getBusyStatus()).busy);
    }""")

sub("""      status: 'QUEUED',
      projectId,
      prompt,
      workspacePath: null,""",
"""      status: 'QUEUED',
      queueReason: waitingForModel ? 'MODEL_BUSY' : null,
      projectId,
      prompt,
      workspacePath: null,""")

sub("""      current: 'Queued',""",
"""      current: waitingForModel ? 'Ждёт освобождения локальной модели' : 'Queued',""")

sub("""    await this.#event(task, 'TASK_QUEUED', 'Task queued');""",
"""    await this.#event(task, waitingForModel ? 'QUEUE_WAITING' : 'TASK_QUEUED',
      waitingForModel ? 'Ждёт освобождения локальной модели' : 'Task queued', waitingForModel ? { reason: 'MODEL_BUSY' } : {});""")

# 4) message(): a busy model queues the prompt for the session instead of failing
sub("""    if (!streaming && this.#usesLocalRuntime(task) && (await this.local.getBusyStatus()).busy) throw Object.assign(new Error('Локальная модель сейчас занята другим запросом. Повторите чуть позже.'), { code: 'MODEL_BUSY' });""",
"""    if (!streaming && this.#usesLocalRuntime(task) && (await this.local.getBusyStatus()).busy) {
      // The model is held by another consumer (a second client, a stale slot,
      // another session): record the prompt and deliver it when the model is
      // free. Attachments are staged now, so the queued entry stays valid even
      // across a restart.
      const attached = await stageFiles(task, this.store.taskDir(id), incomingFiles);
      if (attached.length) task.attachments = [...(task.attachments || []), ...attached];
      task.files = [...(task.files || []), ...attached.map(metadata)];
      if (uploadToken) await this.uploads.discard(uploadToken).catch(() => {});
      const note = attached.length
        ? '\\n\\nAdditional files from the phone are in .taskbridge-input/:\\n' + attached.map(f => `- ${f.path}`).join('\\n')
        : '';
      task.pendingPrompt = { text: userText + note, mode };
      task.updatedAt = now();
      await this.#markWaiting(task, 'MODEL_BUSY');
      if (!this.queue.includes(id)) this.queue.push(id);
      this.#schedulePump();
      return this.#publicTask(task);
    }""")

# 5) pump helpers + queue-aware pump
sub("""  async #pump() {
    if (this.activeTaskId || this.queue.length === 0) return;
    const id = this.queue.shift();
    const task = this.tasks.get(id);
    if (!task) return this.#pump();
    this.activeTaskId = id;
    try {
      await this.#executeInitial(task);
    } finally {""",
"""  // Retry the queue later instead of spinning: the model is owned by someone
  // else for an unknown time.
  #schedulePump() {
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      setImmediate(() => this.#pump());
    }, this.queuePollMs);
    this.pumpTimer.unref?.();
  }

  // One event per transition, so the UI (and the cloud) can explain why nothing
  // is happening yet.
  async #markWaiting(task, reason) {
    if (task.queueReason === reason && task.status === 'QUEUED') return;
    task.status = 'QUEUED';
    task.queueReason = reason;
    task.current = reason === 'MODEL_BUSY' ? 'Ждёт освобождения локальной модели' : 'В очереди';
    task.updatedAt = now();
    await this.store.save(this.#publicTask(task));
    await this.#event(task, 'QUEUE_WAITING', task.current, { reason });
  }

  // A prompt accepted while the model was busy is sent here, unchanged.
  async #deliverPending(task) {
    const pending = task.pendingPrompt;
    task.pendingPrompt = null;
    await this.store.save(this.#publicTask(task));
    await this.#message(task.id, pending.text, pending.mode || 'auto', [], null);
  }

  async #pump() {
    if (this.activeTaskId || this.queue.length === 0) return;
    const id = this.queue[0];
    const task = this.tasks.get(id);
    if (!task || task.status === 'CANCELLED') { this.queue.shift(); return this.#pump(); }
    // capacity 1: never start a request the local runtime would refuse.
    if (!task.pendingPrompt && this.#usesLocalRuntime(task) && (await this.local.getBusyStatus()).busy) {
      await this.#markWaiting(task, 'MODEL_BUSY');
      this.#schedulePump();
      return;
    }
    this.queue.shift();
    this.activeTaskId = id;
    task.queueReason = null;
    try {
      if (task.pendingPrompt) await this.#deliverPending(task);
      else await this.#executeInitial(task);
    } finally {""")

# 7) cancel: a queued prompt is dropped with the task
sub("""    if (!runtime) {
      task.status = 'CANCELLED';
      task.current = 'Cancelled';
      this.queue = this.queue.filter(x => x !== id);""",
"""    if (!runtime) {
      task.status = 'CANCELLED';
      task.current = 'Cancelled';
      task.pendingPrompt = null;
      task.queueReason = null;
      this.queue = this.queue.filter(x => x !== id);""")

open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('task-manager patched')
