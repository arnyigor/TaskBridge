// Human-readable text for provider / agent errors.
//
// Providers behind an OpenAI-compatible API (OpenAI, Hugging Face Inference
// Providers, Anthropic's compat layer, …) report failures as a JSON envelope,
// and Pi forwards that text verbatim. Without this the chat showed the raw body:
//
//   400: {"code":"422","error_type":"UNSUPPORTED_OPENAI_PARAMS",
//         "message":"The following parameters are not supported for this model: tools",
//         "param":"tools"}
//
// We keep the provider's own sentence, add its stable error name (e.g.
// UNSUPPORTED_OPENAI_PARAMS) and drop the transport noise: the numeric `code` is
// just the HTTP status echoed in the body, and `param` is usually already spelled
// out in the message. Plain (non-JSON) text is returned unchanged, so this is
// safe to apply to every error string.
//
// It lives under web/ because both the server (src/task-manager.mjs) and the
// browser (web/chat-state.mjs) must share exactly one implementation, and only
// web/ is reachable from a page.

const MAX_LENGTH = 600;

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parseEnvelope(text) {
  // Providers sometimes prefix the body with a status ("400: {…}" or
  // "HTTP 400: {…}"), so scan for the outermost object instead of requiring the
  // whole string to be JSON.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const body = JSON.parse(text.slice(start, end + 1));
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

function clip(text) {
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text;
}

export function humanizeError(value) {
  const raw = typeof value === 'string'
    ? value
    : value == null ? '' : (value.message || value.error || String(value));
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const body = parseEnvelope(text);
  if (!body) return clip(text);

  const nested = body.error && typeof body.error === 'object' ? body.error : null;
  const message = pickString(
    body.message, nested?.message, typeof body.error === 'string' ? body.error : '',
    body.detail, body.reason, body.description
  );
  // A numeric or HTTP-ish "code" is the status echoed in the body, not an error
  // name — only keep identifier-looking values.
  const rawCode = pickString(body.error_type, body.type, nested?.type, nested?.code, body.errorCode, body.code);
  const named = /^[A-Za-z][\w-]*$/.test(rawCode) ? rawCode : '';
  const param = pickString(body.param, nested?.param);

  let human = message || named;
  if (!human) return clip(text);

  const suffix = [];
  if (param && !human.toLowerCase().includes(param.toLowerCase())) suffix.push(`param: ${param}`);
  if (named && !human.includes(named)) suffix.push(named);
  return clip(suffix.length ? `${human} (${suffix.join(' · ')})` : human);
}
