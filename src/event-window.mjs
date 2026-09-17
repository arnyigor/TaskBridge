// Turn-aligned windowing for paginated history: a USER_MESSAGE event always
// marks the start of a turn, so slicing at those boundaries never splits a
// turn (a tool call, a multi-part assistant message) across pages.
//
// A task's very first prompt has no USER_MESSAGE event of its own — it only
// lives in task.prompt, since #createTask never emits one for it (only
// follow-ups and imported native sessions do, see task-manager.mjs and
// native-sessions.mjs). So "reachedStart: true" means the caller should seed
// that first turn from task.prompt; it does not mean the window is empty.
// A window is bounded by turns, but a turn can be tens of megabytes (a long
// tool log, a big assistant message). Sending that to a browser freezes it while
// it parses, so the payload is also bounded by size: keep whole events from the
// end until the budget is reached. At least one event is always kept (a single
// event over the budget still shows something rather than an empty chat). The
// byte cut can land mid-turn, so the slice is then re-aligned forward to the
// first USER_MESSAGE still in it: a batch must open on a turn boundary, since
// the reducer expects a current turn from the start (a stray leading event from
// a dropped turn used to crash the chat). When nothing was dropped the window is
// returned untouched — a session's first turn has no USER_MESSAGE of its own, so
// aligning an uncut window would silently drop it. When no boundary survives the
// cut the slice is kept as-is: one event is always kept, so the chat is never
// blank.
export function capEventsByBytes(events, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return events;
  let total = 0;
  let start = events.length;
  for (let index = events.length - 1; index >= 0; index--) {
    const size = Buffer.byteLength(JSON.stringify(events[index]), 'utf8') + 1;
    if (total + size > maxBytes && start < events.length) break;
    total += size;
    start = index;
  }
  const boundary = events.findIndex((event, index) => index >= start && event.type === 'USER_MESSAGE');
  if (start > 0 && boundary > start) start = boundary;
  return events.slice(start);
}

export function windowByTurns(events, count, before) {
  const scoped = before != null ? events.filter(e => e.seq < before) : events;
  if (!Number.isSafeInteger(count) || count <= 0) return { events: scoped, reachedStart: true };
  const boundaries = [];
  for (let i = 0; i < scoped.length; i++) if (scoped[i].type === 'USER_MESSAGE') boundaries.push(i);
  if (boundaries.length <= count) return { events: scoped, reachedStart: true };
  return { events: scoped.slice(boundaries[boundaries.length - count]), reachedStart: false };
}
