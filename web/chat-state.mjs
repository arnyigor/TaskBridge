export const ACTIVE_STATUSES = new Set(['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'CANCELLING']);

// Both disk replay and live delivery use the same reducer. Polling never replaces
// a turn with slices of the session-wide accumulated text.
// Assistant messages are concatenated into one turn, so the continuation after a
// tool round keeps a paragraph break instead of running into the previous text.
function paragraphSeparator(text) {
  const trimmed = String(text || '').trimEnd();
  if (!trimmed) return '';
  return trimmed.endsWith('\n') ? '\n' : '\n\n';
}

export class ChatState {
  // seedInitial: false when constructing from a paginated *tail* window that
  // doesn't reach the task's original prompt — that first turn has no
  // USER_MESSAGE event of its own (only follow-ups and imported sessions get
  // one), so it can only be synthesized here, and only once the window
  // actually reaches back that far.
  constructor(task, { seedInitial = true } = {}) {
    this.taskId = task.id;
    this.cursor = 0;
    this.turns = [];
    this.tools = new Map();
    this.notes = new Set();
    this.messageTurn = null;
    this.messageOpen = false;
    this.executionTurn = null;
    if (seedInitial) this.addUser(task.prompt, task.files || [], 'initial');
  }

  // Replays an older, already-settled batch of events in an isolated scratch
  // reducer and splices the resulting turns onto the front of this one.
  // Never touches this.current/messageTurn/executionTurn/cursor — those track
  // the live tail, which a history-backfill must never disturb.
  prependOlder(task, events, reachedStart) {
    const scratch = new ChatState(task, { seedInitial: reachedStart });
    for (const event of events) scratch.apply(event);
    this.turns.unshift(...scratch.turns);
    for (const [id, tool] of scratch.tools) if (!this.tools.has(id)) this.tools.set(id, tool);
    return scratch.turns;
  }

  addUser(text, files, id) {
    // Older logs embedded upload instructions in the visible message.
    const marker = '\n\nAdditional files from the phone are in .taskbridge-input/:\n';
    const split = String(text || '').split(marker);
    if (!files.length && split[1]) files = split[1].split('\n').filter(x => x.startsWith('- ')).map(x => ({ name: x.slice(2) }));
    this.turns.push({ id: `user-${id}`, role: 'user', text: split[0], files });
    this.current = { id: `assistant-${id}`, role: 'assistant', text: '', thinking: '', tools: [], active: false, status: '', error: null };
    this.turns.push(this.current);
  }

  finish(status, error = null) {
    for (const turn of this.turns) {
      if (turn.role !== 'assistant') continue;
      if (turn.active || !turn.status) turn.status = status;
      turn.active = false;
      for (const tool of turn.tools) if (tool.state === 'run') tool.state = 'interrupted';
    }
    this.current.status = status;
    if (error) this.current.error = error;
  }

  apply(event) {
    if (event.taskId && event.taskId !== this.taskId) return false;
    if (event.seq <= this.cursor) return false;
    if (Number.isSafeInteger(event.seq)) this.cursor = event.seq;
    const frame = event.data?.pi;
    if (event.type === 'USER_MESSAGE') {
      this.addUser(event.data?.text ?? event.message, event.data?.files || [], event.seq);
      this.current.active = true;
    } else if (event.type === 'STATUS') {
      if (ACTIVE_STATUSES.has(event.data?.status)) {
        this.current.active = true;
        this.current.status = event.data.status;
      } else this.finish(event.data?.status || 'DONE');
    } else if (['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_CANCELLED'].includes(event.type)) {
      this.finish(event.type.slice(5), event.type === 'TASK_FAILED' ? event.message : null);
    }
    if (!frame) return true;
    if (frame.type === 'agent_start') {
      this.current.active = true;
      this.current.status = 'RUNNING';
    }
    if (frame.type === 'message_start' && frame.message?.role === 'assistant') {
      this.messageTurn = this.current;
      this.executionTurn = this.current;
      this.textPrefix = this.current.text;
      this.thinkingPrefix = this.current.thinking;
      this.textSeparator = paragraphSeparator(this.current.text);
      this.separatorApplied = false;
      this.current.active = true;
      this.messageOpen = true;
    }
    if (frame.type === 'message_update') {
      if (!this.messageOpen) {
        // Deltas without a message_start continue the current message (steering
        // mid-answer): only a real message_start starts a new paragraph.
        this.messageTurn = this.current;
        this.textPrefix = this.current.text;
        this.thinkingPrefix = this.current.thinking;
        this.messageOpen = true;
      }
      const turn = this.messageTurn || this.current;
      const delta = frame.assistantMessageEvent;
      if (delta?.type === 'text_delta') {
        if (this.textSeparator && !this.separatorApplied) { turn.text += this.textSeparator; this.separatorApplied = true; }
        turn.text += delta.delta || '';
      }
      if (delta?.type === 'thinking_delta') turn.thinking += delta.delta || '';
    }
    if (frame.type === 'message_end' && frame.message?.role === 'assistant') {
      const turn = this.messageTurn || this.current;
      const content = frame.message.content;
      if (Array.isArray(content)) {
        const text = content.filter(x => x.type === 'text').map(x => x.text || '').join('');
        const thinking = content.filter(x => x.type === 'thinking').map(x => x.thinking || '').join('');
        // The message text is rebuilt from the prefix, so the paragraph break
        // must be part of it — whether or not a delta already inserted it for
        // the streaming view.
        turn.text = (this.messageTurn ? this.textPrefix + (this.textSeparator || '') : turn.text) + text;
        turn.thinking = (this.messageTurn ? this.thinkingPrefix : turn.thinking) + thinking;
      }
      if (frame.message.errorMessage) turn.error = frame.message.errorMessage;
      this.textSeparator = '';
      this.separatorApplied = false;
      this.messageTurn = null;
      this.messageOpen = false;
    }
    if (frame.type === 'tool_execution_start') {
      const id = frame.toolCallId || `tool-${event.seq}`;
      if (!this.tools.has(id)) {
        const turn = this.executionTurn || this.current;
        const arg = frame.args?.command || frame.args?.path || frame.args?.file_path || frame.args?.filePath || '';
        const tool = { id, name: frame.toolName || 'tool', label: arg ? String(arg) : event.message, state: 'run', imagePath: frame.args?.path || frame.args?.file_path || frame.args?.filePath };
        turn.tools.push(tool);
        this.tools.set(id, tool);
      }
    }
    if (frame.type === 'tool_execution_end') {
      let tool = frame.toolCallId ? this.tools.get(frame.toolCallId) : [...this.tools.values()].reverse().find(x => x.state === 'run' && x.name === frame.toolName);
      if (!tool) {
        tool = { id: frame.toolCallId || `tool-${event.seq}`, name: frame.toolName || 'tool', label: event.message };
        (this.executionTurn || this.current).tools.push(tool);
        this.tools.set(tool.id, tool);
      }
      tool.state = frame.isError ? 'error' : 'done';
    }
    if (frame.type === 'agent_settled') this.finish('DONE');
    if (['compaction_end', 'auto_compaction_end'].includes(frame.type)) {
      const note = frame.errorMessage || (frame.result ? 'Контекст сжат.' : null);
      if (note && !this.notes.has(event.seq)) {
        this.notes.add(event.seq);
        this.turns.push({ id: `note-${event.seq}`, role: 'note', text: note });
      }
    }
    return true;
  }

  snapshot(task, initial = false) {
    if (initial && !this.turns.some(x => x.role === 'assistant' && (x.text || x.thinking))) {
      // Very early versions have only session-wide saved text.
      if (this.turns.filter(x => x.role === 'assistant').length === 1) {
        this.current.text = task.assistantText || '';
        this.current.thinking = task.thinkingText || '';
      }
    }
    if (!ACTIVE_STATUSES.has(task.status)) this.finish(task.status, task.error);
    else if (initial) this.current.active = true;
    this.current.status = task.status;
  }
}
