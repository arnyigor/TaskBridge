// Pi reports provider/model failures as free-form text: message_end.errorMessage,
// RPC rejections, or stderr. Map them to stable codes so the UI can tell
// "wait and retry" apart from "fix the model/provider configuration", and so
// quota/rate-limit conditions do not look like generic internal errors.
//
// Order matters: the first matching rule wins.
const RULES = [
  {
    // RPC-layer failures: a slow acknowledgement is worth another try, a hung
    // process must be stopped rather than retried, and an exited process is
    // retryable because a fresh session will be spawned.
    code: 'PI_RPC_SLOW',
    retryable: true,
    patterns: [/Pi RPC slow response/i]
  },
  {
    code: 'PI_RPC_EXITED',
    retryable: true,
    patterns: [/Pi RPC process is not running/i]
  },
  {
    code: 'PI_RPC_HUNG',
    retryable: false,
    patterns: [/no output from the Pi process/i, /looks hung/i]
  },
  {
    code: 'QUOTA_EXCEEDED',
    retryable: false,
    patterns: [
      /insufficient (?:funds|credits|balance|quota)/i,
      /exceeded your current quota/i,
      /quota (?:exceeded|exhausted|reached)/i,
      /billing (?:hard )?limit/i,
      /out of credits/i,
      /payment required/i,
      /\b402\b/
    ]
  },
  {
    code: 'RATE_LIMITED',
    retryable: true,
    patterns: [
      /rate limit/i,
      /too many requests/i,
      /\b429\b/,
      /resource[ _]exhausted/i
    ]
  },
  {
    code: 'CONTEXT_OVERFLOW',
    retryable: false,
    patterns: [
      /context (?:length|window|size)/i,
      /maximum context/i,
      /too many tokens/i,
      /token (?:limit|budget) exceeded/i,
      /prompt is too long/i,
      /reduce the length of the messages/i
    ]
  },
  {
    code: 'ENGINE_AUTH',
    retryable: false,
    patterns: [
      /invalid api key/i,
      /incorrect api key/i,
      /authentication (?:error|failed)/i,
      /unauthorized/i,
      /\b401\b/
    ]
  },
  {
    code: 'MODEL_UNAVAILABLE',
    retryable: true,
    patterns: [
      /model (?:not found|unavailable|is not available|does not exist)/i,
      /no such model/i,
      /unknown model/i,
      /model_not_found/i,
      /\b404\b/
    ]
  },
  {
    code: 'ENGINE_OVERLOADED',
    retryable: true,
    patterns: [
      /overloaded/i,
      /service unavailable/i,
      /\b503\b/,
      /temporarily unavailable/i
    ]
  },
  {
    code: 'ENGINE_UNREACHABLE',
    retryable: true,
    patterns: [
      /ECONNREFUSED/i,
      /ECONNRESET/i,
      /ENOTFOUND/i,
      /fetch failed/i,
      /network error/i,
      /socket hang up/i,
      /connection (?:refused|error|reset)/i
    ]
  }
];

function messageOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return [value.message, value.code, value.errorCode, value.error, value.cause?.message]
    .filter(part => typeof part === 'string')
    .join(' ');
}

// Providers often say "retry after 20s" / "Retry-After: 30". Return a bounded
// millisecond hint or null when the text carries no usable number.
export function parseRetryAfterMs(value) {
  const text = messageOf(value);
  const match = /retry[-\s]?after[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?)?/i.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = (match[2] || 's').toLowerCase();
  const factor = unit.startsWith('ms') ? 1
    : unit.startsWith('m') && !unit.startsWith('ms') ? 60000
      : unit.startsWith('h') ? 3600000
        : 1000;
  return Math.min(Math.round(amount * factor), 24 * 60 * 60 * 1000);
}

export function classifyEngineError(value) {
  const text = messageOf(value);
  if (!text.trim()) return null;
  for (const rule of RULES) {
    if (rule.patterns.some(pattern => pattern.test(text))) {
      return { code: rule.code, retryable: rule.retryable, retryAfterMs: parseRetryAfterMs(text) };
    }
  }
  return null;
}
