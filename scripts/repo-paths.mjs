// Single source of truth for one question: does this path have a right to be in
// TaskBridge at all?
//
// The denylist below is the second layer. The first — and the one that actually
// holds — is `isAllowedPath`. A denylist only knows the names that already burned
// us; the next unrelated file (`analysis-old-project/`, `notes-company.md`,
// `dump2/`) has a name nobody has thought of yet. An allowlist does not care what
// the file is called: an unknown top-level path is refused by default.
//
// Both layers are used by scripts/repo-policy.mjs (pre-commit and pre-push) and
// the risky-name layer also by scripts/check-secrets.mjs.
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
