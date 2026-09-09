import { ToolOutputWindow, DEFAULT_ROLLING_KB, DEFAULT_TAIL_KB, DEFAULT_SNAPSHOT_MS } from '../tool-output.mjs';

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
  constructor({ now = () => new Date().toISOString(), toolOutput = {} } = {}) {
    this.now = now;
    this.tasks = new Map();
    this.toolOutput = {
      rollingBytes: (toolOutput.rollingKb ?? DEFAULT_ROLLING_KB) * 1024,
      tailBytes: (toolOutput.tailKb ?? DEFAULT_TAIL_KB) * 1024,
      snapshotMs: toolOutput.snapshotMs ?? DEFAULT_SNAPSHOT_MS
    };
    this.toolWindows = new Map();
  }

  #toolWindow(taskId, toolCallId) {
    const key = `${taskId}:${toolCallId}`;
    let window = this.toolWindows.get(key);
    if (!window) {
      window = new ToolOutputWindow(this.toolOutput);
      this.toolWindows.set(key, window);
    }
    return window;
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
    for (const key of [...this.toolWindows.keys()]) if (key.startsWith(`${taskId}:`)) this.toolWindows.delete(key);
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
      case 'APPROVAL_REQUIRED':
        out.push({ type: 'approval_required', payload: data, timestamp: at });
        break;
      case 'APPROVAL_RESOLVED':
        out.push({ type: 'approval_resolved', payload: data, timestamp: at });
        break;
      case 'TOOL_OUTPUT':
        // Explicit "load full output" response (§38): one bounded, redacted
        // payload instead of a permanent multi-megabyte event stream.
        out.push({ type: 'tool_output_full', payload: data, timestamp: at });
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
        this.#toolWindow(taskId, toolCallId).reset();
        out.push({
          type: 'tool_started',
          payload: { toolCallId, toolName: frame.toolName ?? null, args: frame.args ?? {} },
          timestamp: at
        });
        break;
      }
      case 'tool_execution_update': {
        const toolCallId = frame.toolCallId || null;
        if (!toolCallId) break;
        const output = frame.output ?? frame.partialResult ?? frame.delta ?? '';
        // A bounded rolling window: under the limit the chunk is a delta, over
        // it the client gets periodic snapshots and intermediate progress may
        // be dropped (§38, §118).
        const bounded = this.#toolWindow(taskId, toolCallId).append(output);
        if (bounded) out.push({ type: 'tool_updated', payload: { toolCallId, ...bounded }, timestamp: at });
        break;
      }
      case 'tool_execution_end': {
        const toolCallId = frame.toolCallId || null;
        const started = state.toolStarts.get(toolCallId);
        state.toolStarts.delete(toolCallId);
        const durationMs = started ? Math.max(0, Date.parse(at) - Date.parse(started.startedAt)) : null;
        const isError = Boolean(frame.isError);
        const summary = toolCallId ? this.#toolWindow(taskId, toolCallId).final() : null;
        const bounded = summary
          ? { tail: summary.tail, outputBytes: summary.outputBytes, truncated: summary.truncated, fullLogAvailable: summary.fullLogAvailable, localLogId: toolCallId }
          : {};
        out.push({
          type: isError ? 'tool_failed' : 'tool_finished',
          payload: isError
            ? { toolCallId, toolName: frame.toolName ?? started?.toolName ?? null, durationMs, ...bounded, error: { code: 'TOOL_ERROR', message: frame.errorMessage || frame.result?.errorMessage || 'Tool reported an error' } }
            : { toolCallId, toolName: frame.toolName ?? started?.toolName ?? null, durationMs, ...bounded, exitCode: frame.exitCode ?? 0, summary: frame.summary ?? null },
          timestamp: at
        });
        if (toolCallId) this.toolWindows.delete(`${taskId}:${toolCallId}`);
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
