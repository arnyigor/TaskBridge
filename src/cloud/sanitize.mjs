// Redaction before any payload leaves the machine (§67–§69).
//
// This is a best-effort safety net, not a guarantee: the cloud must never be
// given a secret in the first place. Patterns intentionally stay conservative
// so ordinary assistant text is not mangled.

const SECRET_PATTERNS = [
  // Authorization: Bearer … / Basic …
  { re: /\b(authorization\s*:\s*)(bearer|basic|token)\s+[^\s"'`]+/gi, replace: '$1$2 [REDACTED]' },
  // key=value style secrets
  { re: /\b(password|passwd|pwd|token|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}"']+)/gi, replace: '$1$2[REDACTED]' },
  // Well-known token shapes
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: '[REDACTED_KEY]' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: '[REDACTED_TOKEN]' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: '[REDACTED_TOKEN]' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: '[REDACTED_JWT]' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: '[REDACTED_PRIVATE_KEY]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: '[REDACTED_KEY]' }
];

export function redactText(text) {
  let value = String(text ?? '');
  for (const { re, replace } of SECRET_PATTERNS) value = value.replace(re, replace);
  return value;
}

// `${PROJECT_ROOT}` style aliases for absolute local paths (§69). Only exact
// path prefixes are replaced, so `G:\Work` does not rewrite `G:\Workspace`.
export function buildPathAliases(paths = {}) {
  const aliases = [];
  for (const [alias, target] of Object.entries(paths)) {
    if (!target) continue;
    aliases.push({ alias, target: String(target).replace(/[\\/]+$/, '') });
  }
  // Longest first: a nested root must win over its parent.
  return aliases.sort((a, b) => b.target.length - a.target.length);
}

export function redactPaths(text, aliases = []) {
  let value = String(text ?? '');
  for (const { alias, target } of aliases) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value.replace(new RegExp(`${escaped}(?![A-Za-z0-9_-])`, 'gi'), `\${${alias}}`);
  }
  return value;
}

export function sanitizeForCloud(value, options = {}) {
  const { redactPaths: doRedactPaths = true, aliases = [], maxDepth = 12, maxString = 256 * 1024 } = options;
  const seen = new WeakSet();

  const walk = (input, depth) => {
    if (typeof input === 'string') {
      let text = input.length > maxString ? input.slice(0, maxString) : input;
      text = redactText(text);
      if (doRedactPaths && aliases.length) text = redactPaths(text, aliases);
      return text;
    }
    if (input == null || typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input === 'bigint') return input.toString();
    if (depth >= maxDepth) return '[TRUNCATED_DEPTH]';
    if (Array.isArray(input)) return input.slice(0, 5000).map(item => walk(item, depth + 1));
    if (typeof input === 'object') {
      if (seen.has(input)) return '[CIRCULAR]';
      seen.add(input);
      const out = {};
      for (const [key, item] of Object.entries(input)) {
        if (/^(machineSecret|password|token|apiKey|secret|privateKey)$/i.test(key)) { out[key] = '[REDACTED]'; continue; }
        out[key] = walk(item, depth + 1);
      }
      return out;
    }
    return null;
  };

  return walk(value, 0);
}
