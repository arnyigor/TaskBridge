import { humanizeError } from './errors.mjs';

/** Bounded, public activity only: never render system prompts, thinking or tool output. */
export function subagentProgress(result, args) {
  const compact = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
  const results = result?.details?.results;
  const entries = Array.isArray(results) && results.length ? results
    : args?.agent ? [args] : Array.isArray(args?.tasks) ? args.tasks : Array.isArray(args?.chain) ? args.chain : [];
  // What a call is about: «read src/app.js», «bash npm test» — the name alone said nothing.
  const call = x => {
    const a = x?.arguments || {};
    const target = [a.command, a.path, a.file_path, a.pattern, a.query, a.url].find(v => typeof v === 'string' && v.trim());
    return [compact(x?.name), target ? compact(target).slice(0, 80) : ''].filter(Boolean).join(' ');
  };
  return entries.slice(0, 8).map(entry => {
    const messages = Array.isArray(entry?.messages) ? entry.messages : [];
    let activity = '';
    for (let i = messages.length - 1; i >= 0 && !activity; i--) {
      const message = messages[i];
      if (message?.role === 'toolResult') activity = `получен результат: ${compact(message.toolName) || 'инструмент'}`;
      if (message?.role === 'assistant' && Array.isArray(message.content)) {
        const calls = message.content.filter(x => x?.type === 'toolCall').map(call).filter(Boolean);
        if (calls.length) activity = `вызов: ${calls.slice(0, 3).join(', ')}`;
        else activity = compact(message.content.filter(x => x?.type === 'text').map(x => x.text).filter(x => typeof x === 'string').join(' '));
      }
    }
    // How far it got: the number of tool results so far.
    const steps = messages.filter(m => m?.role === 'toolResult').length;
    return [compact(entry?.agent) || 'subagent', activity || 'ожидание обновления', steps ? `действий: ${steps}` : '', compact(entry?.task)].filter(Boolean).join(' · ');
  }).join('\n') || null;
}

export const ACTIVE_STATUSES = new Set(['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING']);

// The server refuses to hand out files that live under its own private paths
// (`isPrivatePath` in src/files.mjs): `data/` holds the database, session logs
// and LAN secrets, `.git`/`.pi`/`node_modules` are noise, and secret-looking
// names are off limits too. A tool call that names such a path must therefore
// NOT be advertised as a viewable image — otherwise the chat builds an <img>
// against `/workspace-file`, gets a 403 and paints a broken picture.
//
// The rule is mirrored here because this module is served to the browser as a
// plain ES module and cannot import the Node-side original. The parity is not
// left to discipline: tests/chat-image-paths.test.mjs fails if the two ever
// disagree on any of its sample paths.
const PRIVATE_PART_RE = /^(?:\.git|\.pi|\.ssh|\.aws|\.codex|node_modules|data)$/i;
const SECRET_PART_RE = /^(?:\.env(?:\..*)?|secret(?:s)?(?:\..*)?|credentials(?:\..*)?|config\.json|server-auth\.json|auth\.json)$/i;
const SECRET_EXT_RE = /\.(?:pem|key|p12|pfx|jks|keystore)$/i;

export function isPrivateFilePath(value) {
  const parts = String(value || '').replaceAll('\\', '/').split('/');
  return parts.some(part => PRIVATE_PART_RE.test(part) || SECRET_PART_RE.test(part) || SECRET_EXT_RE.test(part));
}

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
    // exchange key (0 = the session's own first prompt, else the seq of its
    // USER_MESSAGE) → { ids: [assistant turn ids], selected }: a regenerated
    // answer is another variant of the same exchange, and all of them stay in
    // the log, so this is what tells the view which one to show.
    this.variants = new Map();
    this.messageTurn = null;
    this.messageOpen = false;
    this.orphanMessage = null;
    this.executionTurn = null;
    // The detached placeholder of a mid-turn window (see below), kept so a
    // history backfill can tell which content belongs to a turn whose
    // USER_MESSAGE is not in the batch.
    this.windowStart = null;
    if (seedInitial) this.addUser(task.prompt, task.files || [], 'initial');
    // A window that does not reach the session start (seedInitial:false) can
    // still open mid-turn: the server's size cap cuts at an arbitrary event, so
    // the first events may belong to a turn whose USER_MESSAGE was dropped.
    // Live reducer state (finish/snapshot/streaming handlers) writes through
    // `this.current`; with none it dereferenced undefined and the whole session
    // failed to load. A detached placeholder gives that state a sink — the first
    // real USER_MESSAGE replaces it, and, being outside `turns`, it is never
    // rendered.
    else this.current = { id: 'assistant-window-start', role: 'assistant', text: '', thinking: '', tools: [], active: false, status: '', error: null, variantKey: 0, at: null, endedAt: null, userAt: null };
    this.windowStart = seedInitial ? null : this.current;
  }

  // Replays an older, already-settled batch of events in an isolated scratch
  // reducer and splices the resulting turns onto the front of this one.
  // Never touches this.current/messageTurn/executionTurn/cursor — those track
  // the live tail, which a history-backfill must never disturb.
  prependOlder(task, events, reachedStart) {
    const scratch = new ChatState(task, { seedInitial: reachedStart });
    for (const event of events) scratch.apply(event);
    const turns = [...scratch.turns];
    // A page cut by size opens mid-turn: its events belong to a turn whose
    // USER_MESSAGE is not in the page, so everything lands on the detached
    // window-start placeholder and the page rendered as NOTHING — the "load
    // older" button appeared dead on a session with one huge turn. That content
    // is real (a tool run, part of an answer) and the neighbouring pages carry
    // the rest of the same turn, so it becomes a partial turn of its own.
    const partial = scratch.windowStart;
    if (partial && !turns.includes(partial) && (partial.text || partial.thinking || partial.tools.length)) {
      partial.id = `assistant-partial-${events[0].seq}`;
      partial.partial = true;
      // A settle that never arrives in this page must not leave a typing
      // animation or a running chip in a historical turn.
      partial.active = false;
      partial.final = true;
      for (const tool of partial.tools) if (tool.state === 'run') tool.state = 'interrupted';
      turns.unshift(partial);
    }
    this.turns.unshift(...turns);
    for (const [id, tool] of scratch.tools) if (!this.tools.has(id)) this.tools.set(id, tool);
    for (const [key, entry] of scratch.variants) if (!this.variants.has(key)) this.variants.set(key, entry);
    return turns;
  }

  addUser(text, files, id, at = null, preservePrevious = false) {
    // If the previous turn was not marked final, close it cleanly:
    if (!preservePrevious && this.current && this.current.role === 'assistant' && !this.current.final) {
      this.current.active = false;
      this.current.superseded = true;
      if (!this.current.status) {
        this.current.status = String(this.current.text || '').trim().length ? 'DONE' : 'CANCELLED';
      }
      if (!this.current.endedAt && at) {
        this.current.endedAt = at;
      }
      this.current.final = true;
    }
    // Older logs embedded upload instructions in the visible message.
    const marker = '\n\nAdditional files from the phone are in .taskbridge-input/:\n';
    const split = String(text || '').split(marker);
    if (!files.length && split[1]) files = split[1].split('\n').filter(x => x.startsWith('- ')).map(x => ({ name: x.slice(2) }));
    // `at` — when the message was sent/recorded; the answer gets its own start
    // (`at`) and end (`endedAt`) without touching it.
    this.turns.push({ id: `user-${id}`, role: 'user', text: split[0], files, at });
    const key = id === 'initial' ? 0 : Number(id);
    this.current = { id: `assistant-${id}`, role: 'assistant', text: '', thinking: '', tools: [], active: false, status: '', error: null, variantKey: key, at: null, endedAt: null, userAt: at };
    this.turns.push(this.current);
    this.variants.set(key, { ids: [`assistant-${id}`], selected: `assistant-${id}` });
  }

  finish(status, error = null, at = null) {
    // Every terminal path funnels through here — a TASK_FAILED event carries the
    // server's stored message, which may be a provider JSON body (older events
    // kept it verbatim). Flatten once so no caller can put raw JSON on screen.
    error = error ? humanizeError(error) : null;
    const answered = (turn) => String(turn.text || '').trim().length > 0;
    const cutOff = (turn) => !answered(turn) && (turn.superseded || status === 'CANCELLED');
    const labelFor = (turn) => (turn.error || cutOff(turn) ? 'FAILED' : status);

    // A late cancel or settlement that predates the CURRENT user prompt belongs to
    // the PREVIOUS assistant turn, never to the fresh active answer!
    const currentStart = this.current?.at || this.current?.userAt;
    if (at && currentStart && Date.parse(at) < Date.parse(currentStart)) {
      const prev = [...this.turns].reverse().find(t => t.role === 'assistant' && t !== this.current);
      if (prev) {
        prev.status = (error || prev.error || cutOff(prev)) ? 'FAILED' : status;
        if (error) prev.error = error;
        prev.endedAt = prev.endedAt || at;
        prev.final = true;
        for (const tool of prev.tools) if (tool.state === 'run') tool.state = 'interrupted';
      }
      return;
    }

    const running = this.turns.filter(turn => turn.role === 'assistant' && (turn.active || !turn.status));
    for (const turn of this.turns) {
      if (turn.role !== 'assistant') continue;
      // `DONE` (from agent_settled) is an INTERIM label: when the run's real
      // terminal event arrives afterwards — cancelled by the operator, failed —
      // it must replace it. Otherwise a stop showed DONE, because Pi settles
      // before TaskBridge records TASK_CANCELLED.
      const interim = !turn.status || turn.status === 'DONE';
      if (turn.active || (interim && !turn.superseded)) turn.status = labelFor(turn);
      turn.active = false;
      // `final` is the turn's own "the answer is as complete as it will get":
      // an empty final turn really was not answered, while a turn that has not
      // finished yet shows the typing animation. Consulting the TASK status for
      // that (it arrives a poll later) is what made the placeholder flash.
      turn.final = true;
      for (const tool of turn.tools) if (tool.state === 'run') tool.state = 'interrupted';
    }
    this.current.status = (error || this.current.error || cutOff(this.current)) ? 'FAILED' : status;
    this.current.final = true;
    if (error) this.current.error = error;
    // The answer that just ended gets its end time — only that one: older turns
    // were finished by their own event. A marker that predates the turn it would
    // close (an overlapping cancel finalizing after the next message started) is
    // ignored: it produced ranges like «15:39:34–15:39:31».
    if (at) for (const turn of (running.length ? running : [this.current])) {
      if (turn.at && Date.parse(at) < Date.parse(turn.at)) continue;
      turn.endedAt = turn.endedAt || at;
    }
  }

  // The failed exchange was permanently removed from history by the server
  // (repeat/resend). Turns produced by events at or after fromSeq — the
  // retracted user bubble, its error reply and any notes — disappear from the
  // chat too; `current` rolls back to the previous assistant turn.
  //
  // `keepUser` is the regeneration case: only the ANSWER is rewritten, so the
  // operator's own line stays exactly where it was and gets a fresh (empty,
  // active) assistant turn to stream into. Rebuilding it from a new
  // USER_MESSAGE would have looked like "my message was erased and duplicated".
  // A regenerated answer: the exchange keeps every answer it ever had, and the
  // new one becomes the visible one. The incoming frames are bound to the new
  // turn object, which is why a sibling is created rather than the existing
  // answer being emptied — the view uses that identity to throw away what
  // belonged to the answer that just went out of view.
  #startVariant(data) {
    const key = Number(data?.turnSeq) || 0;
    const variantId = String(data?.variantId || '');
    if (!variantId) return;
    const turnId = `assistant-${variantId}`;
    const entry = this.variants.get(key) || { ids: [], selected: null };
    if (!entry.ids.includes(turnId)) entry.ids.push(turnId);
    this.variants.set(key, entry);
    const turn = { id: turnId, role: 'assistant', text: '', thinking: '', tools: [], active: true, status: '', error: null, variantKey: key };
    // An edited answer branching into a variant arrives with its text ready; a
    // regeneration does not (the text comes from the model).
    if (typeof data?.editedText === 'string') turn.text = data.editedText;
    const previousId = entry.ids.at(-2);
    const at = previousId ? this.turns.findIndex(item => item.id === previousId) : -1;
    if (at >= 0) this.turns.splice(at + 1, 0, turn);
    else this.turns.push(turn);
    this.current = turn;
    this.#selectVariant(key, turnId);
  }

  #selectVariant(key, turnId) {
    const entry = this.variants.get(key);
    if (!entry || !entry.ids.includes(turnId)) return;
    entry.selected = turnId;
    for (const turn of this.turns) {
      if (turn.role !== 'assistant' || turn.variantKey !== key) continue;
      turn.hidden = turn.id !== turnId;
    }
  }

  // The variant switcher's data for one answer, or null when the exchange has a
  // single answer (then there is no ‹ n/m › to show).
  variantsOf(turn) {
    if (!turn || turn.role !== 'assistant' || turn.variantKey == null) return null;
    const entry = this.variants.get(turn.variantKey);
    if (!entry || entry.ids.length < 2) return null;
    const index = entry.ids.indexOf(turn.id);
    if (index < 0) return null;
    const selectedId = entry.selected && entry.ids.includes(entry.selected) ? entry.selected : entry.ids.at(-1);
    return { key: turn.variantKey, index, total: entry.ids.length, ids: [...entry.ids], selectedId };
  }

  #truncateTurns(fromSeq, { dropInitial = false, keepUser = false } = {}) {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) return;
    const seqOf = (turn) => {
      const prefix = turn.role === 'user' ? 'user-' : turn.role === 'note' ? 'note-' : 'assistant-';
      const value = Number(String(turn.id || '').slice(prefix.length));
      return String(turn.id || '').startsWith(prefix) && Number.isSafeInteger(value) ? value : null;
    };
    // A dropped turn takes its tools out of the shared index as well: a stale
    // entry would later swallow a tool result that belongs to the new answer.
    const forget = (turn) => { for (const tool of turn.tools || []) this.tools.delete(tool.id); };
    this.turns = this.turns.filter(turn => {
      // A regenerated answer (assistant-<variantId>) carries no seq in its id:
      // it belongs to the exchange its marker named, and that key decides.
      const seq = turn.variantKey != null ? turn.variantKey : seqOf(turn);
      // seq === null / 0: the exchange synthesized from task.prompt, which has
      // no event of its own. Regeneration keeps it (the trailing answer is
      // dropped by the loop below); a retry drops the whole log.
      if (seq === null || seq === 0) {
        if (keepUser) return true;
        if (dropInitial) { forget(turn); return false; }
        return true;
      }
      if (seq < fromSeq) return true;
      forget(turn);
      return false;
    });
    if (keepUser) {
      // Drop the answer (and anything trailing after it), then hand the incoming
      // stream a fresh turn to land on. The turn OBJECT is replaced, not just
      // emptied — the view uses that identity to throw away what belonged to the
      // previous answer (its tool chips above all).
      while (this.turns.length && this.turns.at(-1).role !== 'user') forget(this.turns.pop());
      const seed = this.turns.length ? (seqOf(this.turns.at(-1)) ?? 'initial') : 'initial';
      this.current = { id: `assistant-${seed}`, role: 'assistant', text: '', thinking: '', tools: [], active: true, status: '', error: null };
      this.turns.push(this.current);
    } else {
      const lastAssistant = [...this.turns].reverse().find(turn => turn.role === 'assistant');
      if (lastAssistant) {
        this.current = lastAssistant;
      } else {
        // The window began with the retracted exchange: keep a detached
        // placeholder so live streaming state has somewhere to land until the
        // resent message creates the real turn.
        this.current = { id: `assistant-truncated-${fromSeq}`, role: 'assistant', text: '', thinking: '', tools: [], active: false, status: '', error: null };
      }
    }
    // Variant bookkeeping follows the turns: an exchange whose answers were all
    // dropped disappears, the remaining ones keep only the answers still here.
    const alive = new Set(this.turns.map(turn => turn.id));
    if (keepUser && this.current) {
      const key = this.current.variantKey ?? 0;
      this.current.variantKey = key;
      this.variants.set(key, { ids: [this.current.id], selected: this.current.id });
    }
    for (const [key, entry] of [...this.variants]) {
      entry.ids = entry.ids.filter(id => alive.has(id));
      if (!entry.ids.length) { this.variants.delete(key); continue; }
      if (!entry.ids.includes(entry.selected)) entry.selected = entry.ids.at(-1);
    }
    this.messageTurn = null;
    this.messageOpen = false;
    this.orphanMessage = null;
    this.textSeparator = '';
    this.separatorApplied = false;
  }

  apply(event) {
    if (event.taskId && event.taskId !== this.taskId) return false;
    if (event.seq <= this.cursor) return false;
    if (Number.isSafeInteger(event.seq)) this.cursor = event.seq;
    const frame = event.data?.pi;
    if (event.type === 'USER_MESSAGE') {
      // A steer is accepted while Pi still owns the current message/tools.
      // Receipt of that instruction does not mean the previous work stopped.
      const preservePrevious = ['steer', 'follow_up'].includes(event.data?.mode);
      // A message that arrives while an answer is still streaming SUPERSEDES it:
      // Pi ends that assistant message and answers the new one. Close the
      // previous turn here, at the moment it was pushed aside — otherwise it
      // stayed "active" and was closed much later by the run's settle event,
      // which gave it the end time of a whole different answer (a range that
      // looked wrong next to the message that replaced it).
      const superseded = this.current;
      if (!preservePrevious && superseded && !superseded.id.startsWith('assistant-pending-') && superseded.role === 'assistant' && superseded.active) {
        superseded.active = false;
        superseded.final = true;
        // Its own answer was cut off, so it never got a verdict of its own: it
        // must not be relabelled as SUCCEEDED when the SESSION finishes later.
        superseded.superseded = true;
        if (!superseded.status) {
          superseded.status = superseded.error || !String(superseded.text || '').trim() ? 'FAILED' : 'DONE';
        }
        superseded.final = true;
        superseded.endedAt = superseded.endedAt || event.at || null;
        for (const tool of superseded.tools) if (tool.state === 'run') tool.state = 'interrupted';
      }
      // Reconcile optimistic user turns: several may sit queued at once, so the
      // OLDEST pending one is matched with this event's seq — its id is
      // upgraded in place instead of a duplicate bubble being added.
      const pendingOptIndex = this.turns.findIndex(t => t.id.startsWith('user-pending-') && t.role === 'user');
      if (pendingOptIndex >= 0) {
        const optTurn = this.turns[pendingOptIndex];
        // The server's receipt time is authoritative (it survives a reload); the
        // optimistic turn only carried the client's send time until now.
        if (event.at) optTurn.at = event.at;
        const optAssistant = this.turns.find(t => t.id === optTurn.id.replace('user-pending-', 'assistant-pending-'));
        const seqId = event.seq;
        optTurn.id = `user-${seqId}`;
        const key = Number(seqId);
        if (optAssistant) {
          optAssistant.id = `assistant-${seqId}`;
          optAssistant.variantKey = key;
          optAssistant.active = true;
          this.current = optAssistant;
          this.variants.set(key, { ids: [`assistant-${seqId}`], selected: `assistant-${seqId}` });
        } else {
          this.addUser(event.data?.text ?? event.message, event.data?.files || [], seqId, event.at || null, preservePrevious);
          this.current.active = true;
        }
      } else {
        this.addUser(event.data?.text ?? event.message, event.data?.files || [], event.seq, event.at || null, preservePrevious);
        this.current.active = true;
      }
    } else if (event.type === 'TURN_TRUNCATED') {
      this.#truncateTurns(Number(event.data?.fromSeq), {
        dropInitial: event.data?.dropInitial === true,
        keepUser: event.data?.keepUser === true
      });
    } else if (event.type === 'TURN_EDITED') {
      // An already settled message was corrected in place: the record is what
      // the server stored, so a reload shows the corrected text too.
      const edited = this.turns.find(turn => turn.id === event.data?.id);
      if (edited) edited.text = String(event.data?.text ?? '');
    } else if (event.type === 'TURN_VARIANT_START') {
      this.#startVariant(event.data);
    } else if (event.type === 'TURN_VARIANT_SELECTED') {
      this.#selectVariant(Number(event.data?.turnSeq) || 0, `assistant-${event.data?.variantId}`);
    } else if (event.type === 'STATUS') {
      if (ACTIVE_STATUSES.has(event.data?.status)) {
        this.current.active = true;
        this.current.status = event.data.status;
      } else this.finish(event.data?.status || 'DONE');
    } else if (['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_CANCELLED'].includes(event.type)) {
      this.finish(event.type.slice(5), event.type === 'TASK_FAILED' ? event.message : null, event.at);
    }
    if (!frame) return true;
    if (frame.type === 'agent_start') {
      this.current.active = true;
      this.current.status = 'RUNNING';
    }
    if (frame.type === 'message_start' && frame.message?.role === 'assistant') {
      // A previous answer left open by an interrupt: its own end arrives LATE,
      // after this new answer started, and must not be attributed to it.
      if (this.messageOpen && this.messageTurn && this.messageTurn !== this.current) {
        this.orphanMessage = { turn: this.messageTurn, textPrefix: this.textPrefix, thinkingPrefix: this.thinkingPrefix, textSeparator: this.textSeparator };
      }
      if (!this.current.at) this.current.at = event.at || null;
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
      const sink = this.messageTurn || this.current;
      const aborted = frame.message.stopReason === 'aborted' || /abort/i.test(String(frame.message.errorMessage || ''));
      let orphan = this.orphanMessage && this.orphanMessage.turn !== sink && aborted ? this.orphanMessage : null;
      // An aborted end belonging to the previous turn (its timestamp or event.at
      // predates the current user turn) must route to that previous assistant turn:
      if (!orphan && aborted && this.current?.userAt && event.at && Date.parse(event.at) < Date.parse(this.current.userAt)) {
        const prev = [...this.turns].reverse().find(t => t.role === 'assistant' && t !== this.current);
        if (prev) orphan = { turn: prev, textPrefix: prev.text, thinkingPrefix: prev.thinking, textSeparator: '' };
      }
      const turn = orphan?.turn || sink;
      const context = orphan || this;
      const content = frame.message.content;
      if (Array.isArray(content)) {
        const text = content.filter(x => x.type === 'text').map(x => x.text || '').join('');
        const thinking = content.filter(x => x.type === 'thinking').map(x => x.thinking || '').join('');
        // The message text is rebuilt from the prefix, so the paragraph break
        // must be part of it — whether or not a delta already inserted it for
        // the streaming view.
        turn.text = (orphan || this.messageTurn ? context.textPrefix + (context.textSeparator || '') : turn.text) + text;
        turn.thinking = (orphan || this.messageTurn ? context.thinkingPrefix : turn.thinking) + thinking;
      }
      if (typeof frame.message.stopReason === 'string') turn.stopReason = frame.message.stopReason;
      // Pi forwards the provider's error body verbatim; a JSON envelope is not a
      // message a human can read, so it is flattened to one line here.
      if (frame.message.errorMessage || aborted) turn.error = humanizeError(frame.message.errorMessage) || 'Request was aborted';
      if (orphan) {
        // Route the WHOLE late end to its original message. In particular, do
        // not overwrite the fresh answer's deltas or close its streaming sink.
        turn.status = 'FAILED';
        turn.active = false;
        turn.final = true;
        turn.endedAt = turn.endedAt || event.at || null;
        this.orphanMessage = null;
        return true;
      }
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
        const named = frame.args?.path || frame.args?.file_path || frame.args?.filePath;
        const tool = { id, name: frame.toolName || 'tool', label: arg ? String(arg) : event.message, state: 'run', imagePath: isPrivateFilePath(named) ? undefined : named };
        if (tool.name === 'subagent') tool.progress = subagentProgress(null, frame.args);
        turn.tools.push(tool);
        this.tools.set(id, tool);
      }
    }
    if (frame.type === 'tool_execution_update') {
      const tool = this.tools.get(frame.toolCallId);
      if (tool?.name === 'subagent' && tool.state === 'run') {
        const progress = subagentProgress(frame.partialResult, null);
        if (progress) tool.progress = progress;
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
      if (tool.name === 'subagent') tool.progress = subagentProgress(frame.result, null) || tool.progress;
    }
    if (frame.type === 'agent_settled') this.finish('DONE', null, event.at);
    if (['compaction_end', 'auto_compaction_end'].includes(frame.type)) {
      const note = humanizeError(frame.errorMessage) || (frame.result ? 'Контекст сжат.' : null);
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
    // A task that is working must not revive an ALREADY finished turn: the last
    // answer may have been interrupted, and marking it active again is what made
    // an empty turn flip from «Ответ не был получен.» to the typing animation.
    else if (initial && !this.current.final) this.current.active = true;
    // The task's status describes the SESSION, not one turn: an interrupted
    // answer must keep saying it was cancelled (its own text even reads
    // «Request aborted»), instead of being relabelled SUCCEEDED when the
    // session as a whole finishes.
    if (!this.current.final) this.current.status = task.status;
  }
}
