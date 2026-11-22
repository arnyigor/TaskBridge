// Opt-in, in-memory STOP diagnostics. Never retain prompts, output, paths or tokens.
// elapsedMs is local to this Node process; it cannot be subtracted from a phone clock.
const spans = new Map();
const rows = [];
const LIMIT = 256;
export const lifecycleTraceEnabled = () => process.env.TASKBRIDGE_LIFECYCLE_TRACE === '1';

export function beginStopTrace(taskId, commandId, turn) {
  if (!lifecycleTraceEnabled() || spans.has(taskId)) return null;
  const span = { taskId, commandId: commandId || null, turn: Number.isFinite(turn) ? turn : null, started: performance.now() };
  spans.set(taskId, span);
  recordStopTrace(taskId, 'stop-received');
  return span;
}

export function recordStopTrace(taskId, phase, fields = {}) {
  const span = spans.get(taskId);
  if (!span || !lifecycleTraceEnabled()) return;
  rows.push({
    taskId, commandId: span.commandId, turn: span.turn, phase,
    component: 'server', elapsedMs: Math.max(0, performance.now() - span.started),
    eventSeq: Number.isFinite(fields.eventSeq) ? fields.eventSeq : null,
    runId: fields.runId || null, status: fields.status || null,
  });
  if (rows.length > LIMIT) rows.splice(0, rows.length - LIMIT);
}

export function stopTraceCommandId(taskId) {
  return lifecycleTraceEnabled() ? spans.get(taskId)?.commandId ?? null : null;
}

export function endStopTrace(taskId, span) {
  if (!span || spans.get(taskId) !== span) return;
  recordStopTrace(taskId, 'stop-handler-finished');
  spans.delete(taskId);
}

export function lifecycleTraceSnapshot() {
  return { enabled: lifecycleTraceEnabled(), records: lifecycleTraceEnabled() ? rows.map(row => ({ ...row })) : [] };
}
