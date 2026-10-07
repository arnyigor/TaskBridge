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

// Pi's MCP adapter prints its config warnings into the model's message text
// ("...mcp.json: Ignored settings (details in /mcp-adapter): ..."). The line is
// session noise, not the answer, and it arrives as one unbreakable token that
// renders as a huge bubble in every client. Root cause is fixed at the source:
// the adapter-only settings moved from ~/.pi/agent/mcp.json into mcp-adapter.json,
// so a fresh Pi no longer emits the line. This strip stays as a defense for any
// other warning Pi prints into message text: the whole line holding the marker
// is cut. Trade-off: if a delta boundary merges answer text into the noise line,
// that shared line is lost with it — rarer and cheaper than showing the wall.
export const MCP_ADAPTER_NOISE_MARKER = 'Ignored settings (details in /mcp-adapter)';

export function stripMcpAdapterNoise(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value.includes(MCP_ADAPTER_NOISE_MARKER)) return value;
  return value
    .split('\n')
    .filter(line => !line.includes(MCP_ADAPTER_NOISE_MARKER))
    .join('\n')
    .replace(/^\n+/, '');
}
