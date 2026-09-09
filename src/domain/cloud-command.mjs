// Cloud → machine command envelope (§15) plus validation and priority (§85).

export const COMMAND_TYPES = [
  'START_TASK',
  'ABORT_TASK',
  'FOLLOW_UP',
  'COMPACT',
  'SET_MODEL',
  'SET_THINKING',
  'APPROVAL_RESPONSE'
];

const TYPE_SET = new Set(COMMAND_TYPES);

// Lower number = delivered first (§85). The machine still applies commands in
// sequence order inside a priority class, so correctness never depends on it.
export const COMMAND_PRIORITY = {
  ABORT_TASK: 1,
  APPROVAL_RESPONSE: 2,
  FOLLOW_UP: 3,
  COMPACT: 4,
  SET_MODEL: 5,
  SET_THINKING: 5,
  START_TASK: 6
};

export const ACK_STATUSES = ['ACCEPTED', 'REJECTED', 'DUPLICATE', 'FAILED'];

export function commandPriority(type) {
  return COMMAND_PRIORITY[type] ?? 99;
}

export function compareCommands(a, b) {
  const byPriority = commandPriority(a.type) - commandPriority(b.type);
  if (byPriority !== 0) return byPriority;
  return Number(a.seq || 0) - Number(b.seq || 0);
}

function invalid(message) {
  return Object.assign(new Error(message), { code: 'COMMAND_REJECTED' });
}

export function parseCommand(raw) {
  if (!raw || typeof raw !== 'object') throw invalid('Command must be an object');
  const { commandId, machineId, taskId, seq, type, payload, createdAt } = raw;
  if (typeof commandId !== 'string' || !commandId) throw invalid('commandId is required');
  if (typeof machineId !== 'string' || !machineId) throw invalid('machineId is required');
  if (!Number.isSafeInteger(Number(seq)) || Number(seq) <= 0) throw invalid('seq must be a positive integer');
  if (!TYPE_SET.has(type)) throw invalid(`Unknown command type: ${type}`);
  if (taskId != null && (typeof taskId !== 'string' || !taskId)) throw invalid('taskId must be a non-empty string when present');
  return {
    commandId,
    machineId,
    taskId: taskId ?? null,
    seq: Number(seq),
    type,
    payload: payload && typeof payload === 'object' ? payload : {},
    createdAt: typeof createdAt === 'string' ? createdAt : new Date().toISOString()
  };
}

export function buildCommand({ commandId, machineId, taskId = null, seq, type, payload = {}, createdAt }) {
  return parseCommand({ commandId, machineId, taskId, seq, type, payload, createdAt });
}
