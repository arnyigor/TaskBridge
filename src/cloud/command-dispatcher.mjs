import { parseCommand } from '../domain/cloud-command.mjs';

// Idempotency ledger (§16). The cloud may deliver the same command twice
// (polling overlap, retry after a lost ack). Persisting both the highest
// processed seq and a bounded set of command ids makes redelivery harmless
// across restarts.

const SEQ_KEY = 'cloud.commandSeq';
const IDS_KEY = 'cloud.commandIds';
const MAX_IDS = 1000;

export class CommandLedger {
  constructor({ store = null, maxIds = MAX_IDS } = {}) {
    this.store = store;
    this.maxIds = maxIds;
    this.ids = [];
    this.seq = 0;
    if (store?.getMeta) {
      this.seq = Number(store.getMeta(SEQ_KEY) || 0) || 0;
      try {
        const parsed = JSON.parse(store.getMeta(IDS_KEY) || '[]');
        if (Array.isArray(parsed)) this.ids = parsed.filter(id => typeof id === 'string');
      } catch { this.ids = []; }
    }
  }

  get lastSeq() { return this.seq; }

  seen(commandId) {
    return this.ids.includes(commandId);
  }

  // Returns true when the command was already processed. `seq <= lastSeq` is
  // also a duplicate: the ledger only remembers the newest ids, but a seq that
  // was already passed can never be new.
  isDuplicate(command) {
    if (this.seen(command.commandId)) return true;
    return Number(command.seq) <= this.seq && !this.seen(command.commandId) && this.ids.length >= this.maxIds;
  }

  record(command) {
    if (!this.seen(command.commandId)) this.ids.push(command.commandId);
    if (this.ids.length > this.maxIds) this.ids = this.ids.slice(-this.maxIds);
    this.seq = Math.max(this.seq, Number(command.seq) || 0);
    this.store?.setMeta?.(SEQ_KEY, String(this.seq));
    this.store?.setMeta?.(IDS_KEY, JSON.stringify(this.ids));
    return this;
  }

  forget() {
    this.ids = [];
    this.seq = 0;
    this.store?.setMeta?.(SEQ_KEY, '0');
    this.store?.setMeta?.(IDS_KEY, '[]');
  }
}

function reject(code, message) {
  return { status: 'REJECTED', error: { code, message } };
}

// Executes cloud commands against the local TaskManager (§15, §48–§51, §84).
// This class is the only place where cloud commands turn into local actions;
// TaskManager itself stays transport-independent.
export class CommandDispatcher {
  constructor({ manager, approvals = null, ledger = null, logger = null, now = () => new Date().toISOString() }) {
    this.manager = manager;
    this.approvals = approvals;
    this.ledger = ledger || new CommandLedger();
    this.logger = logger;
    this.now = now;
    this.stats = { received: 0, accepted: 0, rejected: 0, duplicates: 0, failed: 0 };
  }

  get lastSeq() { return this.ledger.lastSeq; }

  async handle(raw) {
    let command;
    try {
      command = parseCommand(raw);
    } catch (error) {
      this.stats.rejected += 1;
      return reject(error.code || 'COMMAND_REJECTED', error.message);
    }
    this.stats.received += 1;

    if (this.ledger.isDuplicate(command)) {
      this.stats.duplicates += 1;
      this.logger?.('info', { component: 'CommandDispatcher', event: 'duplicate_command', commandId: command.commandId, type: command.type });
      return { status: 'DUPLICATE', detail: 'Command already processed' };
    }

    let result;
    try {
      result = await this.#dispatch(command);
    } catch (error) {
      result = { status: 'FAILED', error: { code: error?.code || 'INTERNAL_ERROR', message: error?.message || String(error) } };
    }

    if (result.status === 'ACCEPTED') {
      this.stats.accepted += 1;
      this.ledger.record(command);
    } else if (result.status === 'REJECTED') {
      this.stats.rejected += 1;
      // Rejected commands are recorded too: redelivery must not retry a command
      // the machine already decided not to run.
      this.ledger.record(command);
    } else if (result.status === 'FAILED') {
      this.stats.failed += 1;
      // Not recorded: a transient local failure may succeed on redelivery.
    }

    this.logger?.('info', {
      component: 'CommandDispatcher',
      event: 'command_handled',
      commandId: command.commandId,
      type: command.type,
      status: result.status
    });
    return result;
  }

  async #dispatch(command) {
    const { type, taskId, payload } = command;
    switch (type) {
      case 'START_TASK': return this.#startTask(command);
      case 'ABORT_TASK': return this.#abortTask(taskId);
      case 'FOLLOW_UP': return this.#followUp(taskId, payload);
      case 'COMPACT': return this.#compact(taskId, payload);
      case 'APPROVAL_RESPONSE': return this.#approval(payload);
      case 'SET_MODEL': return this.#setModel(taskId, payload);
      case 'SET_THINKING': return this.#setThinking(taskId, payload);
      default: return reject('COMMAND_REJECTED', `Unsupported command: ${type}`);
    }
  }

  async #startTask(command) {
    const { taskId, payload } = command;
    const projectId = String(payload.projectId || '');
    const prompt = String(payload.prompt || '').trim();
    if (!projectId) return reject('COMMAND_REJECTED', 'START_TASK requires projectId');
    if (!prompt && !(payload.files || []).length) return reject('COMMAND_REJECTED', 'START_TASK requires a prompt or files');
    if (!taskId) return reject('COMMAND_REJECTED', 'START_TASK requires taskId');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) return reject('COMMAND_REJECTED', 'taskId contains unsupported characters');
    if (this.manager.getTask(taskId)) {
      // Already known locally: treat as an idempotent start, not a second task.
      return { status: 'DUPLICATE', detail: 'Task already exists locally' };
    }
    const task = await this.manager.createTask({
      id: taskId,
      projectId,
      prompt,
      files: Array.isArray(payload.files) ? payload.files : [],
      uploadToken: payload.uploadToken || null
    });
    return { status: 'ACCEPTED', detail: { taskId: task.id } };
  }

  async #abortTask(taskId) {
    if (!taskId) return reject('COMMAND_REJECTED', 'ABORT_TASK requires taskId');
    if (!this.manager.getTask(taskId)) return reject('TASK_NOT_FOUND', `Unknown task ${taskId}`);
    await this.manager.cancel(taskId);
    return { status: 'ACCEPTED', detail: { taskId } };
  }

  async #followUp(taskId, payload) {
    if (!taskId) return reject('COMMAND_REJECTED', 'FOLLOW_UP requires taskId');
    if (!this.manager.getTask(taskId)) return reject('TASK_NOT_FOUND', `Unknown task ${taskId}`);
    const text = String(payload.text || '').trim();
    if (!text && !(payload.files || []).length) return reject('COMMAND_REJECTED', 'FOLLOW_UP requires text or files');
    const mode = ['auto', 'prompt', 'steer', 'follow_up'].includes(payload.mode) ? payload.mode : 'auto';
    await this.manager.message(taskId, text, mode, Array.isArray(payload.files) ? payload.files : [], payload.uploadToken || null);
    return { status: 'ACCEPTED', detail: { taskId, mode } };
  }

  async #compact(taskId, payload) {
    if (!taskId) return reject('COMMAND_REJECTED', 'COMPACT requires taskId');
    if (!this.manager.getTask(taskId)) return reject('TASK_NOT_FOUND', `Unknown task ${taskId}`);
    const result = await this.manager.compact(taskId, String(payload.instructions || ''));
    return { status: 'ACCEPTED', detail: { taskId, result: result ?? null } };
  }

  async #approval(payload) {
    if (!this.approvals) return reject('COMMAND_REJECTED', 'Approvals are not enabled on this machine');
    const approvalId = String(payload.approvalId || '');
    const decision = String(payload.decision || '');
    if (!approvalId) return reject('COMMAND_REJECTED', 'APPROVAL_RESPONSE requires approvalId');
    if (!['ALLOW_ONCE', 'DENY'].includes(decision)) return reject('COMMAND_REJECTED', `Unsupported approval decision: ${decision}`);
    const resolved = this.approvals.resolve(approvalId, decision);
    if (!resolved) return reject('APPROVAL_NOT_FOUND', `Unknown or already resolved approval ${approvalId}`);
    return { status: 'ACCEPTED', detail: { approvalId, decision } };
  }

  async #setModel(taskId, payload) {
    if (typeof this.manager.setModel !== 'function') {
      return reject('COMMAND_REJECTED', 'SET_MODEL is not supported by this TaskBridge build');
    }
    if (!taskId || !this.manager.getTask(taskId)) return reject('TASK_NOT_FOUND', `Unknown task ${taskId}`);
    await this.manager.setModel(taskId, payload.model ?? null);
    return { status: 'ACCEPTED', detail: { taskId, model: payload.model ?? null } };
  }

  async #setThinking(taskId, payload) {
    if (typeof this.manager.setThinking !== 'function') {
      return reject('COMMAND_REJECTED', 'SET_THINKING is not supported by this TaskBridge build');
    }
    if (!taskId || !this.manager.getTask(taskId)) return reject('TASK_NOT_FOUND', `Unknown task ${taskId}`);
    await this.manager.setThinking(taskId, payload.level ?? null);
    return { status: 'ACCEPTED', detail: { taskId, level: payload.level ?? null } };
  }
}
