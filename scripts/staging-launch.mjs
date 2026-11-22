// Fail-closed staging launcher (REL-01C-A): a staging TaskBridge must never
// inherit production TASKBRIDGE_* wiring (ports, data dirs, tokens, media
// policy). The child environment is built from an explicit allowlist; anything
// production-shaped is refused BEFORE the app server, its store or a Pi
// process exists.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// Values a developer's shell legitimately carries from a production session.
// A staging child must not see any of them, and the launcher refuses to start
// rather than silently guessing what else might leak.
const PRODUCTION_KEYS = [
  'TASKBRIDGE_PORT', 'TASKBRIDGE_PUBLIC_PORT', 'TASKBRIDGE_BIND_HOST',
  'TASKBRIDGE_DATA_DIR', 'TASKBRIDGE_CONFIG_DIR', 'TASKBRIDGE_PROJECT_MEMORY_ROOT',
  'TASKBRIDGE_MACHINE_SECRET', 'TASKBRIDGE_WEB_SECRET', 'TASKBRIDGE_EXTERNAL_TOKEN',
  'TASKBRIDGE_EXTERNAL_URL', 'TASKBRIDGE_EXTERNAL_TASK', 'TASKBRIDGE_MEDIA_ROOT',
  'TASKBRIDGE_MEDIA_IMAGE_BUDGET_MB', 'TASKBRIDGE_MEDIA_REQUEST_BUDGET_MB',
  'TASKBRIDGE_MEDIA_KEEP_IMAGES', 'TASKBRIDGE_MEDIA_NOTIFY',
  'TASKBRIDGE_CONTEXT_BUDGET', 'TASKBRIDGE_CONTEXT_KEEP_TOKENS', 'TASKBRIDGE_CONTEXT_LOG',
  'TASKBRIDGE_DISABLE_TLS', 'TASKBRIDGE_LIFECYCLE_OWNER', 'TASKBRIDGE_LIFECYCLE_SUPERVISOR',
  'TASKBRIDGE_RESTART_ORPHAN', 'PI_SESSION_FILE', 'PROJECT_DIR',
];
// Child allowlist: plumbing a Node child needs, plus the explicit staging
// overrides. Everything else (secrets, schedulers, model autostart) stays out.
const ALLOWED_KEYS = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'OS', 'WINDIR', 'LANG', 'TERM', 'ProgramFiles', 'ProgramFiles(x86)',
  'PROGRAMDATA', 'ALLUSERSPROFILE', 'COMPUTERNAME', 'USERNAME', 'USERDOMAIN', 'PUBLIC',
  'NODE_OPTIONS', 'NO_COLOR', 'FORCE_COLOR', 'FAKE_PI_GATE_DIR', 'FAKE_PI_VERSION', 'FAKE_PI_DUMP_ARGS'];

/**
 * Pure, so the refusal is testable without spawning anything.
 * @returns {{ ok: true, env: Record<string,string>, dataDir: string, port: number } |
 *            { ok: false, reason: string }}
 */
export function buildStagingEnv(parentEnv, { dataDir, port, extraEnv = {} } = {}) {
  const carried = PRODUCTION_KEYS.filter(key => parentEnv[key] != null && parentEnv[key] !== '');
  const target = path.resolve(dataDir || '');
  if (!dataDir) return { ok: false, reason: 'staging requires an explicit dataDir' };
  if (!Number.isSafeInteger(port) || port <= 0) return { ok: false, reason: 'staging requires an explicit port' };
  // Production wiring is refused even when the value points somewhere else: a
  // value that only LOOKS harmless today is the leak of tomorrow.
  if (carried.length) return { ok: false, reason: `production environment present: ${carried.join(', ')}` };
  const repoRoot = path.resolve(import.meta.dirname, '..');
  if (target === repoRoot || target.startsWith(repoRoot + path.sep)) {
    return { ok: false, reason: `dataDir overlaps the production checkout: ${target}` };
  }
  const env = {};
  for (const key of ALLOWED_KEYS) if (parentEnv[key] != null) env[key] = parentEnv[key];
  Object.assign(env, extraEnv, {
    TASKBRIDGE_DATA_DIR: target,
    TASKBRIDGE_PORT: String(port),
    TASKBRIDGE_PROJECT_MEMORY_ROOT: path.join(target, 'memory-md'),
  });
  return { ok: true, env, dataDir: target, port };
}

/** CLI: `node scripts/staging-launch.mjs <dataDir> <port> [-- server args…]`. */
export async function main(argv, { spawn: launch = spawn } = {}) {
  const [dataDir, portArg, ...rest] = argv;
  const serverArgs = rest[0] === '--' ? rest.slice(1) : ['src/server.mjs'];
  const plan = buildStagingEnv(process.env, { dataDir, port: Number(portArg) });
  if (!plan.ok) {
    process.stderr.write(`staging refused: ${plan.reason}\n`);
    return 2;
  }
  await fs.mkdir(plan.dataDir, { recursive: true });
  const child = launch(process.execPath, serverArgs, {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: plan.env,
    stdio: 'inherit',
  });
  child.on('exit', code => process.exitCode = code ?? 1);
  return undefined;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('staging-launch.mjs');
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  if (code != null) process.exit(code);
}
