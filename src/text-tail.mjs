// The task record is persisted on every status/turn save and returned to
// clients on every metadata read, so accumulated model text must stay bounded.
// Full history lives in events and in the native Pi session file, which is what
// recovery replays; the task row only needs a tail for result.md and for the
// "very early versions" UI fallback.
export const TEXT_TAIL = 64 * 1024;
export const THINKING_TAIL = 16 * 1024;

const marker = length => `…[первые ${length} символов опущены]…\n`;

export function tailText(text, max) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= max) return value;
  const keep = Math.max(0, max - 40);
  return marker(value.length - keep) + value.slice(-keep);
}

export function appendTail(current, delta, max) {
  const next = `${current || ''}${delta || ''}`;
  return next.length <= max ? next : tailText(next, max);
}
