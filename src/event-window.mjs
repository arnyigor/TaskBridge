// Turn-aligned windowing for paginated history: a USER_MESSAGE event always
// marks the start of a turn, so slicing at those boundaries never splits a
// turn (a tool call, a multi-part assistant message) across pages.
//
// A task's very first prompt has no USER_MESSAGE event of its own — it only
// lives in task.prompt, since #createTask never emits one for it (only
// follow-ups and imported native sessions do, see task-manager.mjs and
// native-sessions.mjs). So "reachedStart: true" means the caller should seed
// that first turn from task.prompt; it does not mean the window is empty.
export function windowByTurns(events, count, before) {
  const scoped = before != null ? events.filter(e => e.seq < before) : events;
  if (!Number.isSafeInteger(count) || count <= 0) return { events: scoped, reachedStart: true };
  const boundaries = [];
  for (let i = 0; i < scoped.length; i++) if (scoped[i].type === 'USER_MESSAGE') boundaries.push(i);
  if (boundaries.length <= count) return { events: scoped, reachedStart: true };
  return { events: scoped.slice(boundaries[boundaries.length - count]), reachedStart: false };
}
