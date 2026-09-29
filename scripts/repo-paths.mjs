// Single source of truth for one question: does this path have a right to be in
// TaskBridge at all — and if it does, may its content leave this machine?
//
// The denylist below is the second layer. The first — and the one that actually
// holds — is `isAllowedPath`. A denylist only knows the names that already burned
// us; the next unrelated file (`analysis-old-project/`, `notes-company.md`,
// `dump2/`) has a name nobody has thought of yet. An allowlist does not care what
// the file is called: an unknown top-level path is refused by default.
//
// Used by scripts/repo-policy.mjs (pre-commit and pre-push) and
// scripts/check-secrets.mjs.
//
// Adding a legitimate new top-level directory is a deliberate edit of
// ALLOWED_ROOTS, reviewed in the diff. That friction is the point.

// Directories TaskBridge is allowed to contain. Everything inside them is fine.
export const ALLOWED_ROOTS = [
  '.githooks',
  '.github',
  'api',
  'bench',
  'bin',
  'clients',
  'cloud',
  'deliverables',
  'docs',
  'pi-extension',
  'scripts',
  'src',
  'tests',
  'web'
];

// Files allowed directly in the repository root. Keep this list short: a root
// file is a decision, not a habit.
export const ALLOWED_ROOT_FILES = new Set([
  '.gitattributes',
  '.gitignore',
  '.vercelignore',
  'AGENTS.md',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'TEST_PLAN.md',
  'Tech_next_version.md',
  'config.example.json',
  'models.example.ini',
  'package-lock.json',
  'package.json',
  'security.local.example.json',
  'start.cmd',
  'vercel.json',
  // The only tracked file in data/: the directory itself is local runtime state.
  'data/.gitkeep'
]);

// Names that mean "scratch, backup or another project's state" whatever the
// content is. A file like this is a leak waiting for a push.
export const RISKY_PATHS = [
  { name: 'agent memory snapshot', pattern: /(^|\/)\.memory[-_]backup/ },
  { name: 'config.json backup', pattern: /(^|\/)config\.json\.(bak|backup|old)/ },
  { name: 'backup file', pattern: /\.(bak|orig|old)$/ },
  { name: 'source dump', pattern: /(^|\/)project-md\// },
  { name: 'archive', pattern: /\.(zip|7z|rar|tgz|tar|tar\.gz)$/ },
  { name: 'agent state', pattern: /^\.claude\// },
  { name: 'agent state', pattern: /^\.local\// },
  { name: 'security audit output', pattern: /^\.pi\/security-audit/ }
];

// Paths allowed to keep a risky name on purpose. Empty today.
export const RISKY_ALLOWED = new Set([]);

// The gate itself. Changing one of these in the same commit that adds other new
// paths is how an agent would "fix" a blocker by widening the allowlist and
// carrying the payload along — repo-policy refuses that combination.
export const POLICY_FILES = new Set([
  '.gitignore',
  '.githooks/pre-commit',
  '.githooks/pre-push',
  'scripts/repo-paths.mjs',
  'scripts/repo-policy.mjs',
  'scripts/check-secrets.mjs',
  'security.local.example.json'
]);

// Secret-shaped literals. Deliberately few and specific: a broad pattern that
// fires on honest code is worse than no pattern at all, because it teaches
// everyone to push with --no-verify.
//
// `min` is the length a match needs before it counts. The real values this
// project generates are 50+ characters; documentation shows `tb_machine_…` and
// the redaction test deliberately feeds fake keys to redactText(), so the
// thresholds sit above those fixtures instead of exempting the files that hold
// them. Verified against this repository — see tests/repo-policy.test.mjs.
export const SECRET_SHAPES = [
  { name: 'user token', pattern: 'tb_user_[A-Za-z0-9_-]{16,}', min: 32 },
  { name: 'machine secret', pattern: 'tb_machine_[A-Za-z0-9_-]{16,}', min: 32 },
  { name: 'postgres URL with credentials', pattern: 'postgres(ql)?://[^:/[:space:]]+:[^@[:space:]]+@', min: 32 },
  { name: 'openai-style key', pattern: 'sk-[A-Za-z0-9_-]{40,}', min: 0 },
  { name: 'github token', pattern: 'gh[pousr]_[A-Za-z0-9]{36,}', min: 0 },
  { name: 'google api key', pattern: 'AIza[0-9A-Za-z_-]{35}', min: 0 },
  { name: 'slack token', pattern: 'xox[baprs]-[0-9A-Za-z-]{10,}', min: 0 },
  { name: 'aws access key id', pattern: 'AKIA[0-9A-Z]{16}', min: 0 },
  { name: 'private key block', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----[^-]{40,}', min: 0 }
];

// Lines that show the shape of a secret on purpose. Without these the audit
// would fail on this repository's own documentation.
export const SAFE_SECRET_LINE = [
  /tb_user_\.\.\./,
  /tb_machine_\.\.\./,
  /tb_machine_…/,
  /postgres:\/\/…/,
  /postgres:\/\/user:pass@/
];

// A real secret is random; a hand-written example is not. Runs like these are
// what fixtures look like — `tb_machine_LEAKED_VALUE_1234567890ABCDEFGH` is a
// test value, and blocking it would make `--history` unusable on this repo.
// The chance of a random 32-character secret containing one of them is about
// 25 x 64^-8, so this is not a hole worth worrying about.
const PLACEHOLDER_RUNS = ['1234567890', '0123456789', 'abcdefgh', 'ABCDEFGH', 'qwerty', 'QWERTY', 'asdfgh'];

export function looksLikePlaceholder(literal) {
  return PLACEHOLDER_RUNS.some(run => literal.includes(run));
}

// `git` always speaks forward slashes; Windows callers may not.
export function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

export function riskyRule(relative) {
  return RISKY_PATHS.find(({ pattern }) => pattern.test(relative)) ?? null;
}

export function isAllowedPath(relative) {
  if (RISKY_ALLOWED.has(relative)) return true;
  if (ALLOWED_ROOT_FILES.has(relative)) return true;
  const [root] = relative.split('/');
  return ALLOWED_ROOTS.includes(root);
}

export function describeAllowlist() {
  return `${ALLOWED_ROOTS.join(', ')} (and ${ALLOWED_ROOT_FILES.size} named root files)`;
}

// Compiles the shapes once. `scan(line)` returns the name of the first secret
// shape on the line, or null. Line-based on purpose: it lets the safe-shape
// rules above look at the whole line, and it is what the git-grep paths use too.
export function createSecretScanner() {
  const compiled = SECRET_SHAPES.map(({ name, pattern, min }) => ({ name, re: new RegExp(pattern), min: min ?? 0 }));
  return function scan(line) {
    if (!line) return null;
    if (SAFE_SECRET_LINE.some(rule => rule.test(line))) return null;
    for (const { name, re, min } of compiled) {
      const literal = line.match(re)?.[0] ?? '';
      if (literal.length > min && !looksLikePlaceholder(literal)) return name;
    }
    return null;
  };
}

// Convenience wrapper for whole texts (a staged blob, a file).
export function findSecretShape(text) {
  const scan = createSecretScanner();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const hit = scan(line);
    if (hit) return hit;
  }
  return null;
}
