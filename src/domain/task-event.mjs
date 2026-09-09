// Cloud event protocol (see Tech_next_version.md §23). The cloud API never
// sees raw Pi RPC frames: everything that leaves the machine is a TaskEvent.

export const PROTOCOL_VERSION = 1;

// Types defined by the specification. `task_log` and `user_message` are
// documented extensions: the remote UI needs to show operator messages and
// human-readable progress notes that have no place in the semantic list above.
export const TASK_EVENT_TYPES = [
  'task_created',
  'task_state',
  'task_log',
  'user_message',
  'turn_started',
  'assistant_delta',
  'assistant_delta_batch',
  'assistant_snapshot',
  'assistant_end',
  'thinking_delta',
  'thinking_snapshot',
  'tool_started',
  'tool_updated',
  'tool_finished',
  'tool_failed',
  'tool_output_full',
  'approval_required',
  'approval_resolved',
  'compaction_started',
  'compaction_finished',
  'turn_finished',
  'task_finished',
  'task_failed',
  'task_aborted'
];

const TYPE_SET = new Set(TASK_EVENT_TYPES);

// Durable events must always reach the cloud (§30). Everything else may be
// coalesced or dropped under backpressure (§47, §118).
export const DURABLE_EVENT_TYPES = new Set([
  'task_created',
  'task_state',
  'user_message',
  'assistant_end',
  'assistant_snapshot',
  'tool_started',
  'tool_finished',
  'tool_failed',
  'tool_output_full',
  'approval_required',
  'approval_resolved',
  'compaction_started',
  'compaction_finished',
  'turn_finished',
  'task_finished',
  'task_failed',
  'task_aborted'
]);

// HIGH priority events force an immediate flush (§39).
export const HIGH_PRIORITY_EVENT_TYPES = new Set([
  'task_created',
  'task_state',
  'task_finished',
  'task_failed',
  'task_aborted',
  'tool_started',
  'tool_finished',
  'tool_failed',
  'approval_required',
  'approval_resolved',
  'assistant_end'
]);

// Task lifecycle states (§13).
export const TASK_STATES = [
  'CREATED',
  'QUEUED',
  'WAITING_MACHINE',
  'STARTING',
  'RUNNING',
  'WAITING_USER',
  'COMPACTING',
  'STOPPING',
  'COMPLETED',
  'FAILED',
  'ABORTED',
  'PAUSED',
  'RECONNECTING',
  'RECOVERING'
];

const STATE_SET = new Set(TASK_STATES);

export function isTaskEventType(type) {
  return TYPE_SET.has(type);
}

export function isDurableEvent(type) {
  return DURABLE_EVENT_TYPES.has(type);
}

export function isHighPriorityEvent(type) {
  return HIGH_PRIORITY_EVENT_TYPES.has(type);
}

export function isTaskState(state) {
  return STATE_SET.has(state);
}

export function assertTaskState(state) {
  if (!isTaskState(state)) throw Object.assign(new Error(`Unknown task state: ${state}`), { code: 'INVALID_STATE' });
  return state;
}

// Explicit transition table (§13). Keeping it here (and not in the transport)
// means both the local mux and the cloud can reject an impossible transition
// with the same rule.
const TRANSITIONS = {
  CREATED: ['QUEUED', 'ABORTED', 'FAILED'],
  QUEUED: ['WAITING_MACHINE', 'STARTING', 'ABORTED', 'FAILED'],
  WAITING_MACHINE: ['STARTING', 'ABORTED', 'FAILED'],
  STARTING: ['RUNNING', 'WAITING_USER', 'ABORTED', 'FAILED'],
  RUNNING: ['WAITING_USER', 'COMPACTING', 'STOPPING', 'COMPLETED', 'FAILED', 'ABORTED', 'RECONNECTING', 'PAUSED'],
  WAITING_USER: ['RUNNING', 'STOPPING', 'ABORTED', 'FAILED'],
  COMPACTING: ['RUNNING', 'FAILED', 'ABORTED'],
  STOPPING: ['ABORTED', 'FAILED'],
  PAUSED: ['RUNNING', 'ABORTED', 'FAILED'],
  RECONNECTING: ['RUNNING', 'FAILED', 'ABORTED'],
  RECOVERING: ['RUNNING', 'FAILED', 'ABORTED'],
  COMPLETED: [],
  FAILED: [],
  ABORTED: []
};

export function canTransition(from, to) {
  if (from === to) return true;
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw Object.assign(new Error(`Illegal task transition ${from} → ${to}`), { code: 'INVALID_STATE' });
  }
  return to;
}

// Terminal states never move again (§13).
export const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'ABORTED']);

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

// Cloud machine states (§20).
export const MACHINE_STATES = ['ONLINE', 'BUSY', 'OFFLINE', 'ERROR'];
