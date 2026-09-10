const SECRET_KEY = /(authorization|password|passwd|secret|token|api[_-]?key|cookie)/i;
const ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))\s*=\s*([^\s"']+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;

function cleanString(value, secret, maxString) {
  let text = value;
  if (secret) text = text.split(secret).join('[REDACTED]');
  text = text.replace(BEARER, 'Bearer [REDACTED]').replace(ASSIGNMENT, '$1=[REDACTED]');
  return text.length > maxString ? `${text.slice(0, maxString)}\n[truncated ${text.length - maxString} chars]` : text;
}

function clean(value, options, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return cleanString(value, options.secret, options.maxString);
  if (value == null || typeof value !== 'object') return value;
  if (depth >= options.maxDepth) return '[truncated depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, options.maxArray).map(item => clean(item, options, depth + 1, seen));
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, options.maxKeys)) {
    result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : clean(item, options, depth + 1, seen);
  }
  return result;
}

export function sanitizeEvent(event, { secret = '', maxBytes = 256 * 1024, maxString = 32 * 1024 } = {}) {
  const sanitized = clean(event, { secret, maxString, maxDepth: 12, maxArray: 500, maxKeys: 500 });
  if (Buffer.byteLength(JSON.stringify(sanitized)) <= maxBytes) return sanitized;
  return {
    taskId: sanitized.taskId, seq: sanitized.seq, at: sanitized.at, type: sanitized.type,
    message: typeof sanitized.message === 'string' ? cleanString(sanitized.message, secret, 4096) : sanitized.message,
    data: { truncated: true, reason: `Cloud event exceeded ${maxBytes} bytes` }
  };
}
