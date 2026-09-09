// Machine identity and heartbeat payloads (§10, §20, §94, §95).

export const DEFAULT_CAPABILITIES = {
  pi: true,
  git: true,
  worktree: true,
  claude: false,
  codex: false
};

export const DEFAULT_COMMAND_CAPABILITIES = {
  followUp: true,
  abort: true,
  compact: true,
  approvals: true,
  setModel: false,
  setThinking: false,
  toolStreaming: true
};

export function buildMachineHeartbeat({ machineId, displayName = null, version = null, status = 'ONLINE', activeTaskId = null, queuedTasks = 0, capabilities = {}, commandCapabilities = {}, protocolVersion, timestamp = new Date().toISOString() }) {
  if (typeof machineId !== 'string' || !machineId) {
    throw Object.assign(new Error('machineId is required'), { code: 'INPUT_INVALID' });
  }
  return {
    machineId,
    displayName,
    timestamp,
    version,
    status,
    activeTaskId,
    queuedTasks,
    protocolVersion,
    capabilities: { ...DEFAULT_CAPABILITIES, ...capabilities },
    commandCapabilities: { ...DEFAULT_COMMAND_CAPABILITIES, ...commandCapabilities }
  };
}
