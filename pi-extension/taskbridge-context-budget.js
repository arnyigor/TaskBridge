// TaskBridge context budget for Pi (loaded with `pi --extension <this file>`).
//
// Why this exists: a session's context is dominated by tool output that will
// never be read again — `gradle`, `adb logcat`, `grep -r`, whole-file `read`
// results. Anthropic calls clearing those results «the safest, lightest form of
// compaction» (Effective context engineering for AI agents), and Claude Code /
// Codex / OpenCode all do it before they ever summarize. Pi has no such
// default: raw tool output stays in the model's context until it is compacted,
// and compaction costs a model call and loses detail.
//
// This extension does exactly one thing, on every model call:
//   * the newest `keepRecentToolTokens` tokens of the transcript are untouched;
//   * tool results older than that, and longer than `minChars`, are replaced by
//     a one-line reference that says how big the original was and how to get it
//     back (re-run the command, read the file).
// Everything else — the tool call, the arguments, errors, the whole persisted
// history and the visible chat — is left as it was. The replacement is applied
// per request (`context` event), so the file on disk and the transcript the user
// reads stay complete, and disabling the extension restores the raw output.
//
// Cost of the trade: the first archived result breaks the provider prompt cache
// for that prefix. That is why the boundary is a token budget (default 40k)
// rather than «everything except the last two messages», and why small results
// (`minChars`) are left alone.
//
// Environment (set by TaskBridge when it spawns Pi):
//   TASKBRIDGE_CONTEXT_BUDGET=0        disable the extension entirely
//   TASKBRIDGE_CONTEXT_KEEP_TOKENS     recent tokens left untouched (default 40000)
//   TASKBRIDGE_CONTEXT_MIN_CHARS       smallest tool result worth archiving (default 2000)
//   TASKBRIDGE_CONTEXT_LOG             JSONL file: what was archived on each request
//   TASKBRIDGE_CONTEXT_DEBUG=1         log every request, not only the changed ones
//
// This file is intentionally dependency-free: it runs inside the Pi process.

export const DEFAULT_POLICY = Object.freeze({
  keepRecentToolTokens: 40_000,
  minChars: 2_000,
});

const positive = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

/** Pi's own estimate heuristic (chars/4, rounded up) — the same one compaction uses. */
export function estimateTokens(chars) {
  return Number.isFinite(chars) && chars > 0 ? Math.ceil(chars / 4) : 0;
}

const textOf = (part) => {
  if (!part) return '';
  if (typeof part === 'string') return part;
  if (part.type === 'text') return String(part.text ?? '');
  if (part.type === 'thinking') return String(part.thinking ?? '');
  return '';
};

/** Characters a message contributes to the request, by Pi's own accounting. */
export function messageChars(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => sum + textOf(part).length, 0);
}

/** Tool results are the only thing archived: they carry the bulky, re-fetchable output. */
export function isArchivable(message) {
  return message?.role === 'toolResult' && Array.isArray(message.content);
}

export function archivedText(name, chars) {
  const label = name ? `${name}` : 'инструмент';
  return `[результат ${label} архивирован: ${chars} символов. `
    + 'Исходный вывод остался в истории сессии; при необходимости повторите команду или прочитайте файл заново.]';
}

/**
 * Decide what this request should carry.
 *
 * Returns `{ messages, changed, archived, savedChars, keptTokens }`. `messages`
 * is the array to send; it is the same array when nothing was archived.
 */
export function planArchival(messages, policy = {}) {
  const keepRecentTokens = positive(policy.keepRecentToolTokens, DEFAULT_POLICY.keepRecentToolTokens);
  const minChars = positive(policy.minChars, DEFAULT_POLICY.minChars);
  const list = Array.isArray(messages) ? messages : [];
  const result = { messages: list, changed: false, archived: 0, savedChars: 0, keptTokens: 0 };
  if (!list.length) return result;

  // Boundary: walk back until the budget is spent; everything before it is old.
  let accumulated = 0;
  let boundary = 0;
  for (let index = list.length - 1; index >= 0; index--) {
    accumulated += estimateTokens(messageChars(list[index]));
    if (accumulated >= keepRecentTokens) {
      // A message bigger than the whole recent budget is not «recent»: keeping it
      // would make the boundary depend on one unlucky tool result. It is exactly
      // the kind of message this extension exists for.
      boundary = estimateTokens(messageChars(list[index])) > keepRecentTokens ? index + 1 : index;
      break;
    }
  }
  if (boundary > 0) {
    accumulated = 0;
    for (let index = boundary; index < list.length; index++) accumulated += estimateTokens(messageChars(list[index]));
  }
  result.keptTokens = accumulated;
  if (boundary <= 0) return result;

  const next = [...list];
  for (let index = 0; index < boundary; index++) {
    const message = next[index];
    if (!isArchivable(message)) continue;
    const chars = messageChars(message);
    if (chars < minChars) continue;
    // Images and other binary parts are the media policy's business: keep them
    // where they are and archive only the text of this result.
    const content = message.content.map(part => (textOf(part).length ? { type: 'text', text: archivedText(message.toolName, chars) } : part));
    const kept = content.filter(part => textOf(part).length);
    next[index] = { ...message, content: kept.length ? content : [{ type: 'text', text: archivedText(message.toolName, chars) }] };
    result.archived += 1;
    result.savedChars += chars;
    result.changed = true;
  }
  if (!result.changed) return result;
  result.messages = next;
  return result;
}

export default function contextBudgetExtension(pi) {
  if (String(process.env.TASKBRIDGE_CONTEXT_BUDGET ?? '') === '0') return;
  const policy = {
    keepRecentToolTokens: positive(process.env.TASKBRIDGE_CONTEXT_KEEP_TOKENS, DEFAULT_POLICY.keepRecentToolTokens),
    minChars: positive(process.env.TASKBRIDGE_CONTEXT_MIN_CHARS, DEFAULT_POLICY.minChars),
  };
  const logPath = process.env.TASKBRIDGE_CONTEXT_LOG || '';
  const debug = String(process.env.TASKBRIDGE_CONTEXT_DEBUG ?? '') === '1';
  let requests = 0;

  pi.on('context', async (event) => {
    requests += 1;
    const plan = planArchival(event.messages, policy);
    if (!plan.changed && !debug) return undefined;
    if (logPath) {
      const record = JSON.stringify({
        at: new Date().toISOString(), request: requests, changed: plan.changed,
        archived: plan.archived, savedChars: plan.savedChars,
        savedTokens: estimateTokens(plan.savedChars), keptTokens: plan.keptTokens,
      });
      import('node:fs/promises')
        .then(fs => fs.appendFile(logPath, `${record}\n`, 'utf8'))
        .catch(() => {});
    }
    return plan.changed ? { messages: plan.messages } : undefined;
  });
}
