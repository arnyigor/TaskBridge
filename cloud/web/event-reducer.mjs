// Pure client-side event reducer (no DOM), so the tricky streaming semantics
// are testable: seq-driven ordering (§77), delta append vs snapshot replace
// (§35), coalesced batches (§29) and replay dedupe (§42).

export function createViewState() {
  return {
    lastSeq: 0,
    seen: new Set(),
    order: [],
    messages: new Map(),
    toolOrder: [],
    tools: new Map(),
    approvals: new Map(),
    activity: [],
    status: null,
    current: null,
    error: null
  };
}

const SEEN_LIMIT = 5000;

function markSeen(state, from, to) {
  for (let seq = from; seq <= to; seq++) {
    state.seen.add(seq);
    if (state.seen.size > SEEN_LIMIT) state.seen.delete(state.seen.values().next().value);
  }
}

function touch(state, key) {
  if (!state.order.includes(key)) state.order.push(key);
  state.order.sort((a, b) => (state.messages.get(a)?.seq ?? 0) - (state.messages.get(b)?.seq ?? 0));
}

function message(state, key, { role = 'assistant', thinking = false, seq = Number.MAX_SAFE_INTEGER } = {}) {
  let record = state.messages.get(key);
  if (!record) {
    record = { key, role, thinking, text: '', status: 'STREAMING', seq };
    state.messages.set(key, record);
    touch(state, key);
  }
  if (seq < record.seq) { record.seq = seq; touch(state, key); }
  return record;
}

function tool(state, toolCallId, seq) {
  let record = state.tools.get(toolCallId);
  if (!record) {
    record = { toolCallId, toolName: null, args: null, output: '', mode: 'delta', status: 'running', durationMs: null, summary: null, error: null, seq: seq ?? Number.MAX_SAFE_INTEGER };
    state.tools.set(toolCallId, record);
    state.toolOrder.push(toolCallId);
  }
  return record;
}

function log(state, line) {
  state.activity.push(line);
  if (state.activity.length > 500) state.activity = state.activity.slice(-500);
}

const TERMINAL = new Set(['task_finished', 'task_failed', 'task_aborted']);

// Returns true when the event changed the view (so the caller can re-render).
export function applyEvent(state, event) {
  if (!event || typeof event !== 'object') return false;
  const seq = Number(event.seq) || 0;
  const endSeq = Number(event.seqTo) || seq;

  // Every event carries its own cursor: a seq already applied is a no-op, which
  // makes replay and an SSE/polling race idempotent (§42, §77). Rendering order
  // is derived from seq, never from arrival order.
  if (seq && state.seen.has(seq)) return false;
  if (seq) {
    markSeen(state, Number(event.seqFrom) || seq, endSeq);
    state.lastSeq = Math.max(state.lastSeq, endSeq);
  }

  const payload = event.payload || {};
  switch (event.type) {
    case 'assistant_delta':
    case 'assistant_delta_batch': {
      const record = message(state, payload.messageId || 'assistant', { seq: Number(event.seqFrom) || seq });
      record.text += payload.text || '';
      record.status = 'STREAMING';
      break;
    }
    case 'assistant_snapshot': {
      const record = message(state, payload.messageId || 'assistant', { seq });
      record.text = payload.text || '';
      break;
    }
    case 'assistant_end': {
      const record = message(state, payload.messageId || 'assistant', { seq });
      record.text = payload.text ?? record.text;
      record.status = payload.stopReason === 'error' ? 'INTERRUPTED' : 'COMPLETE';
      break;
    }
    case 'thinking_delta': {
      const record = message(state, `thinking:${payload.messageId || 'assistant'}`, { thinking: true, seq });
      record.text += payload.text || '';
      break;
    }
    case 'thinking_snapshot': {
      const record = message(state, `thinking:${payload.messageId || 'assistant'}`, { thinking: true, seq });
      record.text = payload.text || '';
      break;
    }
    case 'user_message': {
      const record = message(state, `user:${seq}`, { role: 'user', seq });
      record.text = payload.text || '';
      record.status = 'COMPLETE';
      break;
    }
    case 'tool_started': {
      const record = tool(state, payload.toolCallId || `tool:${seq}`, seq);
      record.toolName = payload.toolName || record.toolName;
      record.args = payload.args ?? null;
      record.status = 'running';
      break;
    }
    case 'tool_updated': {
      const record = tool(state, payload.toolCallId || `tool:${seq}`, seq);
      record.mode = payload.mode === 'snapshot' ? 'snapshot' : 'delta';
      record.output = record.mode === 'snapshot' ? String(payload.output || '') : record.output + String(payload.output || '');
      break;
    }
    case 'tool_finished': {
      const record = tool(state, payload.toolCallId || `tool:${seq}`, seq);
      record.status = 'ok';
      record.durationMs = payload.durationMs ?? null;
      record.summary = payload.summary ?? null;
      if (payload.exitCode != null) record.exitCode = payload.exitCode;
      break;
    }
    case 'tool_failed': {
      const record = tool(state, payload.toolCallId || `tool:${seq}`, seq);
      record.status = 'err';
      record.durationMs = payload.durationMs ?? null;
      record.error = payload.error?.message || 'tool failed';
      break;
    }
    case 'approval_required':
      state.approvals.set(payload.approvalId, { ...payload, status: 'PENDING' });
      log(state, `approval required: ${payload.toolName || 'tool'} (${payload.risk || 'unknown'})`);
      break;
    case 'approval_resolved': {
      const approval = state.approvals.get(payload.approvalId);
      if (approval) {
        approval.status = payload.status || (payload.decision === 'DENY' ? 'DENIED' : 'APPROVED');
        approval.decision = payload.decision ?? approval.decision;
      }
      log(state, `approval ${payload.decision || payload.status || 'resolved'}`);
      break;
    }
    case 'task_created':
    case 'task_state':
      if (payload.status) state.status = payload.status;
      if (payload.current != null) state.current = payload.current;
      log(state, `state: ${payload.status || ''}${payload.current ? ` — ${payload.current}` : ''}`);
      break;
    case 'task_finished':
    case 'task_failed':
    case 'task_aborted': {
      state.status = payload.status || (event.type === 'task_failed' ? 'FAILED' : event.type === 'task_aborted' ? 'ABORTED' : 'COMPLETED');
      state.current = payload.current ?? state.status;
      state.error = payload.error ?? null;
      for (const record of state.messages.values()) if (record.status === 'STREAMING') record.status = 'COMPLETE';
      for (const record of state.tools.values()) if (record.status === 'running') record.status = 'err';
      log(state, `${event.type}: ${state.status}`);
      break;
    }
    default:
      if (payload.message || payload.current) log(state, `${event.type}: ${payload.message || payload.current}`);
      break;
  }
  return true;
}

export function applyEvents(state, events) {
  let changed = false;
  for (const event of events || []) changed = applyEvent(state, event) || changed;
  return changed;
}

// Serialized form used to persist the resume cursor (§42).
export function cursorKey(taskId) {
  return `taskbridge.lastSeq.${taskId}`;
}
