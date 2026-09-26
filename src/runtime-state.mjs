// The runtime layer under a task's user-facing status (roadmap R3.1): what the
// Pi process of a session is doing, in one vocabulary shared by every client.
// The state is derived from facts TaskBridge already tracks — is a Pi alive, the
// task status, a pending UI request — so it cannot drift from them; the table
// below says which changes are expected, and an unexpected one is logged as a
// bug instead of being hidden.

export const RUNTIME_STATES = Object.freeze(['STARTING', 'IDLE', 'WORKING', 'WAITING_USER', 'ABORTING', 'SLEEPING', 'RESTORABLE', 'STOPPED']);

const ALLOWED = {
  STARTING: ['IDLE', 'WORKING', 'WAITING_USER', 'ABORTING', 'RESTORABLE', 'STOPPED'],
  IDLE: ['STARTING', 'WORKING', 'WAITING_USER', 'ABORTING', 'SLEEPING', 'RESTORABLE', 'STOPPED'],
  WORKING: ['IDLE', 'WAITING_USER', 'ABORTING', 'RESTORABLE', 'STOPPED', 'STARTING'],
  WAITING_USER: ['WORKING', 'IDLE', 'ABORTING', 'RESTORABLE', 'STOPPED'],
  ABORTING: ['IDLE', 'STOPPED', 'RESTORABLE', 'WORKING'],
  SLEEPING: ['STARTING', 'WORKING', 'STOPPED', 'RESTORABLE'],
  RESTORABLE: ['STARTING', 'WORKING', 'STOPPED', 'SLEEPING', 'IDLE'],
  STOPPED: ['STARTING', 'WORKING', 'RESTORABLE', 'IDLE'],
};

export function transitionAllowed(from, to) {
  if (!from || from === to) return true;
  return Boolean(ALLOWED[from]?.includes(to));
}

const ACTIVE_STATUSES = new Set(['PREPARING', 'PREFLIGHT', 'RUNNING', 'VERIFYING']);

/**
 * @param {object} facts
 * @param {string} facts.status      the task's user-facing status
 * @param {boolean} facts.live        a Pi process of this task is running
 * @param {boolean} facts.starting    a Pi process is being started
 * @param {boolean} facts.sleeping    stopped by the idle timeout
 * @param {boolean} facts.hasSession  a session file exists to resume from
 * @param {boolean} facts.compacting
 * @param {number}  facts.toolsRunning
 * @returns {{state: string, activity: string|null}}
 */
export function deriveRuntimeState({ status, live = false, starting = false, sleeping = false, hasSession = false, compacting = false, toolsRunning = 0 }) {
  const working = activity => ({ state: 'WORKING', activity });
  if (starting) return { state: 'STARTING', activity: null };
  // A prompt waiting for the model (or for its turn in the queue) counts as
  // work: it will run without anyone doing anything.
  if (status === 'QUEUED') return working('waiting_model');
  if (live) {
    if (status === 'CANCELLING') return { state: 'ABORTING', activity: null };
    if (status === 'WAITING_USER') return { state: 'WAITING_USER', activity: null };
    if (ACTIVE_STATUSES.has(status)) return working(compacting ? 'compacting' : toolsRunning > 0 ? 'tool' : 'streaming');
    return { state: 'IDLE', activity: compacting ? 'compacting' : null };
  }
  if (status === 'PREPARING' || status === 'PREFLIGHT') return { state: 'STARTING', activity: null };
  if (status === 'CANCELLING') return { state: 'ABORTING', activity: null };
  if (sleeping) return { state: 'SLEEPING', activity: null };
  if (status === 'CANCELLED') return { state: 'STOPPED', activity: null };
  return { state: hasSession ? 'RESTORABLE' : 'STOPPED', activity: null };
}
