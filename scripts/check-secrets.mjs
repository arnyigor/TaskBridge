#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { auditUploadSet, formatAudit, parseIgnoreFile, SENSITIVE_LOCAL_FILES } from '../cloud/lib/upload-set.mjs';
import { matchesIgnore } from '../cloud/lib/deploy.mjs';
import { createSecretScanner, RISKY_ALLOWED, RISKY_PATHS, riskyRule, SECRET_SHAPES } from './repo-paths.mjs';

// Two sources, because they differ exactly when it matters: the working tree is
// what you see, the index is what the next commit records.
const GIT_SOURCES = [
  ['working tree', []],
  ['staged content', ['--cached']]
];

// Audits that no secret can leave this machine — neither through a `vercel
// deploy` (which ignores .gitignore) nor through a `git push`.
//
//   npm run check:secrets          # run it before every deploy/push
//   npm run check:secrets -- -v    # list every file that would be uploaded
//
// Exits non-zero on any finding. It never prints a secret value.

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

// --root exists so the audit itself can be tested against a fixture that
// contains a deliberate leak.
function rootArg() {
  const index = process.argv.indexOf('--root');
  if (index === -1) return REPO_ROOT;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? path.resolve(value) : REPO_ROOT;
}
const ROOT = rootArg();

const problems = [];
const notes = [];

async function git(args, options = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: ROOT, maxBuffer: 32 * 1024 * 1024, ...options });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) };
  }
}

// 1. What would `vercel deploy` upload? ---------------------------------------
const vercelIgnoreText = await fs.readFile(path.join(ROOT, '.vercelignore'), 'utf8').catch(() => null);
const audit = await auditUploadSet({ root: ROOT, vercelIgnoreText });
if (!audit.coverage.ok) problems.push(`.vercelignore is missing entries: ${audit.coverage.missing.join(', ')}`);
for (const finding of audit.findings) problems.push(`vercel upload would include ${finding.path} (${finding.rule})`);
notes.push(...formatAudit(audit).split(String.fromCharCode(10)));
if (VERBOSE) for (const candidate of audit.candidates) notes.push(`  ${candidate}`);

// 2. Are the sensitive local files ignored by git? ----------------------------
const gitignoreText = await fs.readFile(path.join(ROOT, '.gitignore'), 'utf8').catch(() => '');
const gitignoreLines = parseIgnoreFile(gitignoreText);
const inGitRepo = (await git(['rev-parse', '--is-inside-work-tree'])).ok;

for (const { path: relative, probe } of SENSITIVE_LOCAL_FILES) {
  let exists = false;
  try { await fs.access(path.join(ROOT, relative)); exists = true; } catch { exists = false; }
  if (!exists) continue;
  const ignored = matchesIgnore(probe, gitignoreLines);
  if (!ignored) problems.push(`${relative} exists and is NOT covered by .gitignore`);
  if (inGitRepo) {
    const check = await git(['check-ignore', '-q', probe]);
    if (!check.ok) problems.push(`${relative} exists but git does not ignore its contents (git check-ignore ${probe})`);
  }
  notes.push(`local sensitive path present: ${relative}${ignored ? ' (ignored)' : ''}`);
}

// 3. Do the working tree and the index contain the actual config values? ------
// Both, because they are different things: `git add config.mjs`, then edit the
// secret out of the file on disk, and the commit still carries the old content.
const configText = await fs.readFile(path.join(ROOT, 'config.json'), 'utf8').catch(() => null);
if (configText && inGitRepo) {
  let config = null;
  try { config = JSON.parse(configText); } catch { problems.push('config.json is not valid JSON'); }
  const secrets = [];
  const collect = (value, keyPath) => {
    if (typeof value === 'string' && value.length >= 16 && /(secret|token|password|key)$/i.test(keyPath)) secrets.push({ value, keyPath });
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) collect(child, key);
  };
  collect(config, '');
  for (const { value, keyPath } of secrets) {
    for (const [source, args] of GIT_SOURCES) {
      const found = await git(['grep', ...args, '-F', '--', value]);
      if (found.ok && found.stdout.trim()) problems.push(`config.json ${keyPath} value appears in the ${source}`);
    }
  }
  if (secrets.length) notes.push(`checked ${secrets.length} secret value(s) from config.json against the working tree and the index`);
  if (config?.cloud?.enabled) notes.push(`cloud is enabled locally (url: ${config.cloud.url ?? 'unset'})`);
}

// 4. Any secret-shaped literal in the working tree or the index? ---------------
// The rules live in repo-paths.mjs so this file, repo-policy --staged and
// repo-policy --history cannot drift apart.
if (inGitRepo) {
  const scanSecret = createSecretScanner();
  for (const { pattern } of SECRET_SHAPES) {
    for (const [source, args] of GIT_SOURCES) {
      const found = await git(['grep', ...args, '-nE', '--', pattern]);
      if (!found.ok) continue;
      for (const line of found.stdout.split(/\r?\n/).filter(Boolean)) {
        const shape = scanSecret(line);
        if (shape) problems.push(`${source} contains a ${shape}: ${line.split(':').slice(0, 2).join(':')}`);
      }
    }
  }
  notes.push(`scanned the working tree and the index for ${SECRET_SHAPES.length} secret shapes`);
}

// 5. Risky path names (backups, memory snapshots, dumps, archives) ------------
// The value-based checks above cannot see a leak whose value is prose: a memory
// snapshot of another project, a config backup, a source dump. Those are caught
// by name instead, using the same rules scripts/repo-policy.mjs enforces before
// every commit. A tracked file with such a name is a leak waiting for a push; an
// untracked one that .gitignore does not cover is one `git add -A` away.
if (inGitRepo) {
  const listings = [
    ['tracked', 'tracked by git — remove it from the repo', await git(['ls-files', '-z'])],
    ['untracked and not ignored', 'one `git add -A` away from being committed', await git(['ls-files', '--others', '--exclude-standard', '-z'])]
  ];
  for (const [, hint, listing] of listings) {
    for (const relative of String(listing.stdout ?? '').split(String.fromCharCode(0)).filter(Boolean)) {
      if (RISKY_ALLOWED.has(relative)) continue;
      const rule = riskyRule(relative);
      if (rule) problems.push(`${relative} is a risky path (${rule.name}) — ${hint}`);
    }
  }
  notes.push(`checked ${RISKY_PATHS.length} risky path shapes against tracked and unignored files`);
}

// 6. Is a risky path already in history? .gitignore cannot undo a push ---------
if (inGitRepo) {
  const added = await git(['log', '--all', '--diff-filter=A', '--name-only', '--pretty=format:']);
  for (const relative of new Set(String(added.stdout ?? '').split(/\r?\n/).filter(Boolean))) {
    if (RISKY_ALLOWED.has(relative)) continue;
    const rule = riskyRule(relative);
    if (rule) problems.push(`history contains a risky path (${rule.name}): ${relative} — rewrite it with git filter-branch`);
  }
  notes.push('scanned every commit for risky path names');
}

// Report ---------------------------------------------------------------------
console.log('TaskBridge secret audit\n───────────────────────');
for (const note of notes) console.log(`• ${note}`);
console.log('');
if (problems.length) {
  for (const problem of problems) console.error(`✖ ${problem}`);
  console.error(`\n${problems.length} problem(s). Do not deploy or push until they are fixed.`);
  process.exitCode = 1;
} else {
  console.log('✔ no secret would leave this machine (vercel upload set + tracked files)');
}
