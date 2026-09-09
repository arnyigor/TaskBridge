import path from 'node:path';

// Tool approval policy (§52). This is the single source of truth: the Pi
// extension does not decide anything, it just asks TaskBridge whether a tool
// call may proceed. That keeps rules testable and avoids duplicating logic in a
// module that runs inside the Pi process.

export const DEFAULT_DESTRUCTIVE_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+push\b[^\n]*--force/i,
  /\bgit\s+push\b[^\n]*-f\b/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bgit\s+checkout\s+--\s/i,
  /\bdel\s+\/[a-z]*[sqf]/i,
  /\brmdir\s+\/s/i,
  /\bformat\s+[a-z]:/i,
  /\b(shutdown|reboot|halt)\b/i,
  /\btaskkill\b[^\n]*\/f/i,
  /\bstop-process\b/i,
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\bchmod\s+777\b/i,
  /\bsudo\b/i,
  /\b(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b/i,
  /\b(iwr|invoke-webrequest)\b[^|\n]*\|\s*iex\b/i,
  /\bnpm\s+publish\b/i,
  /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /\breg\s+delete\b/i,
  /\bnetsh\s+firewall\b/i,
  /\b(rm|del|remove-item)\b[^\n]*(\.git\b|node_modules\b)/i
];

const WRITE_TOOLS = new Set(['write', 'edit', 'create', 'apply_patch', 'multiedit', 'notebookedit']);
const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'exec', 'run_command', 'terminal']);

export const DEFAULT_APPROVAL_CONFIG = {
  enabled: false,
  timeoutMinutes: 1440,
  timeoutPolicy: 'KEEP_WAITING', // DENY | ABORT_TASK
  failsafe: 'block',             // behaviour when the endpoint is unreachable
  extraPatterns: [],
  approveShell: true,            // match destructive shell patterns
  approveOutsideWorkspace: true, // writes outside the task workspace
  approveRead: false
};

export function resolveApprovalConfig(config = {}, env = process.env) {
  const raw = config.approvals || {};
  const bool = (value, fallback) => (value == null || value === '' ? fallback : !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase()));
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    ...DEFAULT_APPROVAL_CONFIG,
    ...raw,
    enabled: bool(env.TASKBRIDGE_APPROVALS_ENABLED ?? raw.enabled, DEFAULT_APPROVAL_CONFIG.enabled),
    timeoutMinutes: num(env.TASKBRIDGE_APPROVAL_TIMEOUT_MINUTES ?? raw.timeoutMinutes, DEFAULT_APPROVAL_CONFIG.timeoutMinutes),
    timeoutPolicy: String(env.TASKBRIDGE_APPROVAL_TIMEOUT_POLICY ?? raw.timeoutPolicy ?? DEFAULT_APPROVAL_CONFIG.timeoutPolicy).toUpperCase(),
    failsafe: String(env.TASKBRIDGE_APPROVAL_FAILSAFE ?? raw.failsafe ?? DEFAULT_APPROVAL_CONFIG.failsafe).toLowerCase(),
    extraPatterns: Array.isArray(raw.extraPatterns) ? raw.extraPatterns : [],
    approveShell: bool(raw.approveShell, DEFAULT_APPROVAL_CONFIG.approveShell),
    approveOutsideWorkspace: bool(raw.approveOutsideWorkspace, DEFAULT_APPROVAL_CONFIG.approveOutsideWorkspace),
    approveRead: bool(raw.approveRead, DEFAULT_APPROVAL_CONFIG.approveRead)
  };
}

function compileExtra(patterns = []) {
  const out = [];
  for (const pattern of patterns) {
    try { out.push(new RegExp(String(pattern), 'i')); }
    catch { /* an invalid operator pattern must not break every task */ }
  }
  return out;
}

// Returns null when no approval is required, otherwise { risk, detail }.
export function classifyToolCall({ toolName, input = {}, workspacePath = null, config = DEFAULT_APPROVAL_CONFIG } = {}) {
  const name = String(toolName || '').toLowerCase();
  const patterns = [...DEFAULT_DESTRUCTIVE_PATTERNS, ...compileExtra(config.extraPatterns)];

  if (SHELL_TOOLS.has(name)) {
    if (config.approveShell === false) return null;
    const command = String(input.command ?? input.cmd ?? input.script ?? '');
    for (const pattern of patterns) {
      if (pattern.test(command)) return { risk: 'destructive', detail: command.slice(0, 500) };
    }
    return null;
  }

  if (WRITE_TOOLS.has(name)) {
    const target = String(input.path ?? input.file_path ?? input.filePath ?? input.file ?? '');
    if (target && workspacePath) {
      const root = path.resolve(workspacePath);
      const resolved = path.resolve(root, target);
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        if (config.approveOutsideWorkspace === false) return null;
        return { risk: 'outside_workspace', detail: target };
      }
    }
    // Destructive patterns can also appear in a shell command embedded in an
    // edit payload (rare, but cheap to check).
    const text = JSON.stringify(input);
    for (const pattern of patterns) if (pattern.test(text)) return { risk: 'destructive', detail: text.slice(0, 500) };
    return null;
  }

  if (config.approveRead && name === 'read') return { risk: 'read', detail: String(input.path ?? '') };
  return null;
}
