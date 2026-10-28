// Pi repeats whole turns inside its own frames: `agent_end` carries the
// conversation so far (42 messages with base64 images weighed 16.3 MB in
// data/taskbridge.db), `turn_end` repeats the answer, and a tool result comes
// back as a `toolResult` message of its own. No client reads those copies: the
// KMP client deletes exactly these fields in `lightenEvent` (pinned by
// ChatEventLighteningTest) and the browser reducer never looks at them. They are
// what makes a page unreadable, though: the byte budget in server.mjs always
// keeps the NEWEST event, so one such frame goes out whole and a phone refuses a
// body over 16 MB with «Ответ сервера слишком большой (16 МБ)» — the session then
// never opens (2026-10-13). What clients DO read is kept: assistant text, tool
// names and arguments, and a subagent's own result, which the progress line
// shows.
export function lightenEvent(event) {
  const frame = event?.data?.pi;
  if (!frame || typeof frame !== 'object') return event;
  const without = (...keys) => {
    const copy = { ...frame };
    for (const key of keys) delete copy[key];
    return copy;
  };
  let light;
  switch (frame.type) {
    // The whole turn again, message by message.
    case 'agent_end': light = frame.messages ? without('messages') : frame; break;
    case 'turn_end': light = (frame.message || frame.toolResults) ? without('message', 'toolResults') : frame; break;
    // A tool result is echoed as a message of its own, content and all.
    case 'message_start':
    case 'message_end': light = frame.message?.role === 'toolResult' ? without('message') : frame; break;
    // Read only for the subagent progress line; other results are megabytes.
    case 'tool_execution_end': light = frame.toolName === 'subagent' || !('result' in frame) ? frame : without('result'); break;
    case 'tool_execution_update': light = frame.toolName === 'subagent' || !('partialResult' in frame) ? frame : without('partialResult'); break;
    // `write` puts the whole file into args.content; only the label is used.
    case 'tool_execution_start': {
      if (!frame.args || !('content' in frame.args)) { light = frame; break; }
      const args = { ...frame.args };
      delete args.content;
      light = { ...frame, args };
      break;
    }
    default: light = frame;
  }
  return light === frame ? event : { ...event, data: { ...event.data, pi: light } };
}

// message_end carries a message's full final content, so every
// message_update (streaming delta) between a message_start and its closing
// message_end is fully superseded once that pair is complete — replaying
// them is pure waste for a bulk/history fetch. A long session can have
// thousands of tiny deltas; dropping the closed ones is what makes loading
// a large history usable instead of shipping megabytes of dead events to
// the browser. Deltas for a message still in progress (no closing
// message_end yet in this batch) are left untouched, so live/in-progress
// text is never lost.
export function trimStreamingDeltas(events) {
  let openSince = -1;
  let hasCompaction = false;
  const closedRanges = [];
  for (let i = 0; i < events.length; i++) {
    const frame = events[i].data?.pi;
    if (!frame) continue;
    if (frame.type === 'message_start') { openSince = i; hasCompaction = false; }
    else if (openSince >= 0 && ['compaction_end', 'auto_compaction_end'].includes(frame.type) && frame.result && !frame.errorMessage && !frame.aborted && !frame.cancelled) hasCompaction = true;
    else if (frame.type === 'message_end') {
      if (openSince >= 0 && !hasCompaction) closedRanges.push([openSince, i]);
      openSince = -1;
    }
  }
  if (!closedRanges.length) return events;
  const drop = new Set();
  for (const [start, end] of closedRanges) {
    for (let i = start; i < end; i++) {
      if (events[i].data?.pi?.type === 'message_update') drop.add(i);
    }
  }
  return drop.size ? events.filter((_, i) => !drop.has(i)) : events;
}
