import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

// Interactive tool approval (§52–§57).
//
// The important property: the cloud request that carries the user's decision is
// completely independent from the request that reported the approval. The local
// side simply holds a promise until a later APPROVAL_RESPONSE command arrives,
// so no Vercel function ever stays alive waiting for a human.
//
// NOTE: Pi RPC in this repository has no approval callback yet, so nothing calls
// request() automatically. The manager is wired to the command path and covered
// by tests; hooking it into the Pi tool pipeline is a follow-up (see
// docs/cloud-transport.md).

export const APPROVAL_DECISIONS = ['ALLOW_ONCE', 'DENY'];

function approvalId() {
  return `approval_${crypto.randomBytes(9).toString('hex')}`;
}

export class ApprovalManager extends EventEmitter {
  constructor({ timeoutMinutes = 1440, timeoutPolicy = 'KEEP_WAITING', now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super();
    this.timeoutMs = Math.max(0, Number(timeoutMinutes) || 0) * 60000;
    this.timeoutPolicy = ['DENY', 'ABORT_TASK', 'KEEP_WAITING'].includes(timeoutPolicy) ? timeoutPolicy : 'KEEP_WAITING';
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pendingApprovals = new Map();
    this.resolved = new Set();
    this.stats = { requested: 0, allowed: 0, denied: 0, timedOut: 0 };
  }

  request({ taskId, toolCallId = null, toolName = null, args = {}, risk = 'unknown' }) {
    if (!taskId) throw Object.assign(new Error('approval request requires taskId'), { code: 'INPUT_INVALID' });
    const id = approvalId();
    const record = {
      approvalId: id,
      taskId,
      toolCallId,
      toolName,
      args,
      risk,
      status: 'PENDING',
      createdAt: new Date(this.now()).toISOString(),
      resolvedAt: null,
      decision: null
    };
    const promise = new Promise(resolve => { record.resolve = resolve; });
    this.pendingApprovals.set(id, record);
    this.stats.requested += 1;

    if (this.timeoutMs > 0 && this.timeoutPolicy !== 'KEEP_WAITING') {
      record.timer = this.setTimer(() => {
        this.stats.timedOut += 1;
        this.resolve(id, this.timeoutPolicy === 'DENY' ? 'DENY' : 'DENY', { reason: 'timeout', policy: this.timeoutPolicy });
      }, this.timeoutMs);
      record.timer?.unref?.();
    }

    this.emit('requested', this.#public(record));
    return { approvalId: id, promise: promise.then(decision => ({ approvalId: id, decision })), record: this.#public(record) };
  }

  // Returns true when the decision was applied, false for an unknown or already
  // resolved approval (so a replayed APPROVAL_RESPONSE is harmless).
  resolve(id, decision, extra = {}) {
    const record = this.pendingApprovals.get(id);
    if (!record) return false;
    if (!APPROVAL_DECISIONS.includes(decision)) return false;
    this.pendingApprovals.delete(id);
    this.resolved.add(id);
    if (record.timer) this.clearTimer(record.timer);
    record.status = decision === 'ALLOW_ONCE' ? 'APPROVED' : 'DENIED';
    record.decision = decision;
    record.resolvedAt = new Date(this.now()).toISOString();
    if (decision === 'ALLOW_ONCE') this.stats.allowed += 1;
    else this.stats.denied += 1;
    record.resolve(decision);
    this.emit('resolved', { ...this.#public(record), ...extra });
    return true;
  }

  isPending(id) {
    return this.pendingApprovals.has(id);
  }

  list() {
    return [...this.pendingApprovals.values()].map(record => this.#public(record));
  }

  // Aborting a task must not leave a dangling promise (§53).
  cancelTask(taskId, decision = 'DENY') {
    let cancelled = 0;
    for (const [id, record] of [...this.pendingApprovals]) {
      if (record.taskId !== taskId) continue;
      this.resolve(id, decision, { reason: 'task_aborted' });
      cancelled += 1;
    }
    return cancelled;
  }

  stop() {
    for (const [id] of [...this.pendingApprovals]) this.resolve(id, 'DENY', { reason: 'shutdown' });
  }

  #public(record) {
    const { resolve, timer, ...safe } = record;
    return safe;
  }

  snapshot() {
    return { pending: this.pendingApprovals.size, ...this.stats };
  }
}
