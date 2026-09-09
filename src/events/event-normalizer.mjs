// Translates raw Pi RPC frames and TaskBridge local events into the stable
// cloud protocol (§23). The cloud must never depend on the exact Pi
// implementation, so every Pi-specific field is resolved here.
//
// Snapshot policy (§31) lives in event-snapshot.mjs; this class only decides
// *what* each frame means and carries the per-message text needed to build a
// durable snapshot.

const MAX_MESSAGE_BYTES = 512 * 1024;

const LOCAL_STATUS_TO_STATE = {
  QUEUED: 'QUEUED',
  PREPARING: 'STARTING',
  PREFLIGHT: 'STARTING',
  RUNNING: 'RUNNING',
  VERIFYING: 'RUNNING',
  CANCELLING: 'STOPPING',
  SUCCEEDED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'ABORTED'
};

export function taskStateFromLocalStatus(status) {
  return LOCAL_STATUS_TO_STATE[status] || null;
}

function tailUtf8(text, maxBytes) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  // Keep the end of the message; the beginning of a very long message is
  // recoverable from the tool/assistant deltas that were already uploaded.
  return value.slice(-Math.floor(maxBytes / 2));
}

export class EventNormalizer {
  constructor({ now = () => new Date().toISOString() } = {}) {
    this.now = now;
    this.tasks = new Map();
  }

  #state(taskId) {
    let state = this.tasks.get(taskId);
    if (!state) {
      state = {
        messageIndex: 0,
        currentMessageId: null,
        currentText: '',
        currentThinking: '',
        messageStartedAt: null,
        toolStarts: new Map()
      };
      this.tasks.set(taskId, state);
    }
    return state;
  }

  forget(taskId) {
    this.tasks.delete(taskId);
  }

  assistantText(taskId) {
    return this.#state(taskId).currentText;
  }

  // Local TaskBridge event (already produced by TaskManager) → task events.
  normalizeLocalEvent(taskId, event) {
    const state = this.#state(taskId);
    const data = event?.data || {};
    const message = event?.message ?? '';
    const at = event?.at || this.now();
    const out = [];

    switch (event?.type) {
      case 'TASK_QUEUED':
        out.push({ type: 'task_created', payload: { status: 'QUEUED' }, timestamp: at });
        break;
      case 'STATUS': {
        const mapped = taskStateFromLocalStatus(data.status) || data.status;
        out.push({ type: 'task_state', payload: { status: mapped, current: message }, timestamp: at });
        break;
      }
      case 'USER_MESSAGE':
        out.push({
          type: 'user_message',
          payload: { text: data.text ?? message, mode: data.mode ?? null, files: (data.files || []).map(f => ({ name: f.name, size: f.size ?? null })) },
          timestamp: at
        });
        break;
      case 'PI_EVENT':
        out.push(...this.normalizePiFrame(taskId, data.pi, at));
        break;
      case 'TASK_SUCCEEDED':
        out.push({ type: 'task_finished', payload: { status: 'COMPLETED', current: message }, timestamp: at });
        break;
      case 'TASK_FAILED':
        out.push({ type: 'task_failed', payload: { status: 'FAILED', errorCode: data.errorCode ?? null, error: message }, timestamp: at });
        break;
      case 'TASK_CANCELLED':
        out.push({ type: 'task_aborted', payload: { status: 'ABORTED' }, timestamp: at });
        break;
      case 'COMPACT_REQUESTED':
        out.push({ type: 'compaction_started', payload: { reason: 'manual' }, timestamp: at });
        break;
      case 'SESSION_RESTORED':
      case 'WORKSPACE_READY':
      case 'RUNTIME_READY':
      case 'ENGINE_SWITCH':
      case 'ABORT_TIMEOUT':
      case 'CHANGES_APPLIED':
      case 'WORKTREE_REMOVED':
      case 'OUTPUT_FILES':
      case 'PI_STDERR':
      case 'PI_PROTOCOL_ERROR':
        out.push({ type: 'task_log', payload: { source: event.type, message }, timestamp: at });
        break;
      default:
        if (event?.type) out.push({ type: 'task_log', payload: { source: event.type, message }, timestamp: at });
        break;
    }

    // Pi stderr can carry credentials from the local environment; the mux runs
    // sanitizeForCloud over every payload before upload (§68).
    return out;
  }

  // Raw Pi RPC frame → task events. `frame.tool_execution_update` is emitted by
  // newer Pi builds; when it is absent tool output simply arrives only in the
  // final event, which is still spec-conformant.
  normalizePiFrame(taskId, frame, at = this.now()) {
    if (!frame || typeof frame !== 'object') return [];
    const state = this.#state(taskId);
    const out = [];

    switch (frame.type) {
      case 'agent_start':
        state.currentMessageId = null;
        state.messageStartedAt = at;
        out.push({ type: 'turn_started', payload: {}, timestamp: at });
        break;
      case 'message_start': {
        const role = frame.message?.role;
        if (role === 'assistant') {
          state.messageIndex += 1;
          state.currentMessageId = `msg_${state.messageIndex}`;
          state.currentText = '';
          state.currentThinking = '';
          state.messageStartedAt = at;
        }
        break;
      }
      case 'message_update': {
        const delta = frame.assistantMessageEvent;
        if (!delta) break;
        if (delta.type === 'text_delta' && delta.delta) {
          state.currentText = tailUtf8(state.currentText + delta.delta, MAX_MESSAGE_BYTES);
          out.push({ type: 'assistant_delta', payload: { messageId: state.currentMessageId, text: delta.delta }, timestamp: at });
        }
        if (delta.type === 'thinking_delta' && delta.delta) {
          state.currentThinking = tailUtf8(state.currentThinking + delta.delta, MAX_MESSAGE_BYTES);
          out.push({ type: 'thinking_delta', payload: { messageId: state.currentMessageId, text: delta.delta }, timestamp: at });
        }
        break;
      }
      case 'message_end': {
        const role = frame.message?.role;
        if (role !== 'assistant') break;
        const text = frame.message?.content?.map?.(part => part?.text || '').join('') || state.currentText;
        state.currentText = tailUtf8(text || state.currentText, MAX_MESSAGE_BYTES);
        out.push({
          type: 'assistant_end',
          payload: {
            messageId: state.currentMessageId,
            text: state.currentText,
            stopReason: frame.message?.stopReason ?? null,
            usage: frame.message?.usage ?? null
          },
          timestamp: at
        });
        if (frame.message?.stopReason === 'error') {
          out.push({
            type: 'task_log',
            payload: { source: 'model_error', message: frame.message?.errorMessage || 'Model finished with an error.' },
            timestamp: at
          });
        }
        break;
      }
      case 'tool_execution_start': {
        const toolCallId = frame.toolCallId || `call_${state.messageIndex}_${state.toolStarts.size + 1}`;
        state.toolStarts.set(toolCallId, { toolName: frame.toolName ?? null, startedAt: at });
        out.push({
          type: 'tool_started',
          payload: { toolCallId, toolName: frame.toolName ?? null, args: frame.args ?? {} },
          timestamp: at
        });
        break;
      }
      case 'tool_execution_update': {
        const toolCallId = frame.toolCallId || null;
        // The protocol requires the frontend to know whether a chunk replaces
        // or extends the current output (§35); a missing flag means delta.
        const mode = frame.mode === 'snapshot' ? 'snapshot' : 'delta';
        const output = frame.output ?? frame.partialResult ?? frame.delta ?? '';
        out.push({ type: 'tool_updated', payload: { toolCallId, mode, output }, timestamp: at });
        break;
      }
      case 'tool_execution_end': {
        const toolCallId = frame.toolCallId || null;
        const started = state.toolStarts.get(toolCallId);
        state.toolStarts.delete(toolCallId);
        const durationMs = started ? Math.max(0, Date.parse(at) - Date.parse(started.startedAt)) : null;
        const isError = Boolean(frame.isError);
        out.push({
          type: isError ? 'tool_failed' : 'tool_finished',
          payload: isError
            ? { toolCallId, toolName: frame.toolName ?? started?.toolName ?? null, durationMs, error: { code: 'TOOL_ERROR', message: frame.errorMessage || frame.result?.errorMessage || 'Tool reported an error' } }
            : { toolCallId, toolName: frame.toolName ?? started?.toolName ?? null, durationMs, exitCode: frame.exitCode ?? 0, summary: frame.summary ?? null },
          timestamp: at
        });
        break;
      }
      case 'compaction_start':
        out.push({ type: 'compaction_started', payload: { reason: frame.reason ?? null }, timestamp: at });
        break;
      case 'compaction_end':
      case 'auto_compaction_end':
        out.push({
          type: 'compaction_finished',
          payload: {
            reason: frame.reason ?? null,
            beforeTokens: frame.result?.tokensBefore ?? null,
            afterTokens: frame.result?.estimatedTokensAfter ?? null,
            error: frame.errorMessage ?? null
          },
          timestamp: at
        });
        break;
      case 'agent_settled':
        out.push({ type: 'turn_finished', payload: {}, timestamp: at });
        break;
      case 'auto_retry_start':
        out.push({ type: 'task_log', payload: { source: 'auto_retry', message: `auto retry ${frame.attempt}/${frame.maxAttempts}` }, timestamp: at });
        break;
      case 'extension_error':
        out.push({ type: 'task_log', payload: { source: 'extension_error', message: frame.error || '' }, timestamp: at });
        break;
      default:
        break;
    }

    return out;
  }
}
