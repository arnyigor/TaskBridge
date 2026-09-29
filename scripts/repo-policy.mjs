#!/usr/bin/env node
// Refuses a commit or a push that would record files TaskBridge has no business
// carrying — by path or by content.
//
//   node scripts/repo-policy.mjs --staged      what `git commit` is about to record
//   node scripts/repo-policy.mjs --outgoing    every commit a `git push` would send
//   node scripts/repo-policy.mjs --history     every commit reachable from any ref
//   node scripts/repo-policy.mjs --paths a b   explicit paths (used by tests)
//
// Checks, in this order:
//   1. is the path allowed at all?      (allowlist — the control that holds)
//   2. does the name look like scratch? (denylist — the names that burned us)
//   3. does the content carry a secret or a corporate term?
//      Staged content is read from the INDEX (`git show :path`), never from the
//      working tree: `git add secret.mjs` followed by an edit leaves the secret
//      in the commit while the file on disk looks clean.
//      Outgoing content is read from the commits being pushed, so a file added
//      in commit A and deleted in commit B is still caught.
//   4. is a change to this policy accompanied by other new files? (self-defence)
//
// Exits non-zero on the first violation. Never prints a matched secret or term.
//
// `--root` exists so tests can run this against a fixture repository.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createSecretScanner, describeAllowlist, findSecretShape, isAllowedPath, normalizePath, POLICY_FILES, riskyRule } from './repo-paths.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SCANNED_BYTES = 4 * 1024 * 1024;

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

const ROOT = valueOf('--root') ? path.resolve(valueOf('--root')) : REPO_ROOT;

// pre-push feeds one line per ref: <local ref> <local sha> <remote ref> <remote sha>.
// Using it makes the scan cover exactly what this push sends. Without it we fall
// back to the conservative superset below, which also reports files carried by
// long-lived local-only branches.
const pushRefs = valueOf('--push-refs');

const MODE = process.argv.includes('--history')
  ? 'history'
  : process.argv.includes('--outgoing') || pushRefs !== null
    ? 'outgoing'
    : process.argv.includes('--paths')
      ? 'paths'
      : 'staged';

const problems = [];
const warnings = [];
const notes = [];
const scanSecret = createSecretScanner();

async function git(args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: ROOT, maxBuffer: 96 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '' };
  }
}

function block(message, hint) {
  problems.push(hint ? `${message}\n    ${hint}` : message);
}

// 1 + 2. Names -----------------------------------------------------------------
// `allowlist` is off for paths that are already published history: the allowlist
// answers "may this kind of file be added now?", and a root document that was
// legitimate last month and is gone today is not a finding. The denylist still
// applies — a memory snapshot is a memory snapshot whenever it was added.
function checkNames(relative, where, { allowlist = true } = {}) {
  const clean = normalizePath(relative);
  const risky = riskyRule(clean);
  if (risky) {
    block(`${clean} is a risky path (${risky.name}) in ${where}`, 'scratch, backups and other projects\' state do not belong in this repository');
    return;
  }
  if (allowlist && !isAllowedPath(clean)) {
    block(`${clean} is not an allowed path in TaskBridge (${where})`, `allowed roots: ${describeAllowlist()}. If it really belongs here, add its root to ALLOWED_ROOTS in scripts/repo-paths.mjs`);
  }
}

// 3. Content -------------------------------------------------------------------
const terms = await loadForbiddenTerms();
if (terms) notes.push(`loaded ${terms.length} locally forbidden term(s) from security.local.json`);
else {
  const message = 'security.local.json is missing — the corporate-term blocklist is not installed on this machine (copy security.local.example.json)';
  // On the machine this list lives on, an absent file is a silent downgrade, so
  // pre-push sets the variable below and refuses instead of warning.
  if (process.env.TASKBRIDGE_REQUIRE_LOCAL_POLICY === '1') problems.push(`${message}\n    TASKBRIDGE_REQUIRE_LOCAL_POLICY=1 is set, so this is fatal`);
  else warnings.push(message);
}

async function loadForbiddenTerms() {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(ROOT, 'security.local.json'), 'utf8'));
    const list = Array.isArray(parsed.forbiddenTerms) ? parsed.forbiddenTerms : [];
    return list.filter(term => typeof term === 'string' && term.trim().length >= 4).map(term => term.trim().toLowerCase());
  } catch {
    return null;
  }
}

// Returns the 1-based index of the first matching term, or null. The index is
// what gets reported — the term itself must never reach a terminal or a CI log.
function termIn(text) {
  if (!terms) return null;
  const lower = text.toLowerCase();
  for (let index = 0; index < terms.length; index += 1) {
    if (lower.includes(terms[index])) return index + 1;
  }
  return null;
}

function scanContent(relative, text, where) {
  if (!text) return;
  const term = termIn(text);
  if (term !== null) {
    block(`${relative} contains a locally forbidden term (${where}, term #${term} of ${terms.length})`, 'see security.local.json; that list is intentionally not in the repository');
    return;
  }
  const shape = findSecretShape(text);
  if (shape) {
    block(`${relative} contains a secret-shaped literal (${where}, ${shape})`, 'the index is what actually lands in the commit, whatever the working tree shows now');
  }
}

async function readIfText(absolute) {
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > MAX_SCANNED_BYTES) return null;
    return await fs.readFile(absolute, 'utf8');
  } catch {
    return null;
  }
}

async function readStagedBlob(relative) {
  const { ok, stdout } = await git(['show', `:${relative}`]);
  return ok && stdout.length <= MAX_SCANNED_BYTES ? stdout : null;
}

// Outgoing scope -----------------------------------------------------------------
// Each group is an argument list for `git log`: keeping them apart avoids the
// `--not` toggle problem when one push mixes new and existing refs.
function outgoingGroups() {
  if (MODE === 'history') {
    // What the server has to ask: is anything forbidden anywhere in the history
    // that is about to be published? This is the check that would have caught
    // the .memory-backup directory when it first landed.
    notes.push('scope: every commit reachable from any ref');
    return [['--all']];
  }
  if (pushRefs === null) {
    notes.push('scope: every commit not on a remote (conservative; local-only branches count)');
    return [['--branches', '--tags', '--not', '--remotes']];
  }
  const groups = [];
  let refs = 0;
  for (const line of pushRefs.split(/\r?\n/)) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || /^0+$/.test(localSha)) continue; // the push deletes this ref
    refs += 1;
    if (!remoteSha || /^0+$/.test(remoteSha)) groups.push([localSha, '--not', '--remotes']);
    else groups.push([`${remoteSha}..${localSha}`]);
  }
  notes.push(`scope: exactly the ${refs} ref(s) this push sends`);
  return groups;
}

// Content of the commits being pushed, not of the working tree. A secret that
// arrived in commit A and was removed in commit B still reaches GitHub in A, and
// the patch is also the only place a deleted file's content survives.
async function scanOutgoingContent(groups) {
  let scanned = 0;
  for (const revs of groups) {
    const { ok, stdout } = await git(['log', ...revs, '-p', '--no-renames', '-U0', '--format=']);
    if (!ok) continue;
    let file = '(unknown)';
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith('+++ ')) {
        file = normalizePath(line.slice(4).replace(/^b\//, ''));
        continue;
      }
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const body = line.slice(1);
      scanned += 1;
      const term = termIn(body);
      if (term !== null) {
        block(`${file} carried a locally forbidden term into an outgoing commit (term #${term} of ${terms.length})`, 'see security.local.json');
        return;
      }
      const shape = scanSecret(body);
      if (shape) {
        block(`${file} carried a secret-shaped literal (${shape}) into an outgoing commit`, 'the file may already be gone from the working tree; the commit still travels');
        return;
      }
    }
  }
  notes.push(`scanned ${scanned} added line(s) in outgoing commits`);
}

// ---------------------------------------------------------------------------------

if (MODE === 'paths') {
  const index = process.argv.indexOf('--paths');
  const skip = new Set([valueOf('--root')].filter(Boolean));
  const paths = process.argv.slice(index + 1).filter(arg => !arg.startsWith('--') && !skip.has(arg));
  for (const relative of paths) {
    const clean = normalizePath(relative);
    checkNames(clean, 'argument');
    scanContent(clean, await readIfText(path.join(ROOT, clean)), 'working tree');
  }
} else if (MODE === 'staged') {
  const { ok, stdout } = await git(['diff', '--cached', '--name-status', '-z', '--diff-filter=ACMR']);
  if (!ok) {
    notes.push('not a git repository — nothing staged to check');
  } else {
    const fields = stdout.split(String.fromCharCode(0)).filter(Boolean);
    const entries = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      entries.push({ status: fields[index], relative: normalizePath(fields[index + 1]) });
    }
    notes.push(`staged files: ${entries.length}`);

    for (const { relative } of entries) {
      checkNames(relative, 'index');
      scanContent(relative, await readStagedBlob(relative), 'staged content');
    }

    // 4. Self-defence: a policy change must not carry other new files along.
    if (entries.some(({ relative }) => POLICY_FILES.has(relative))) {
      const companions = entries
        .filter(({ status, relative }) => status === 'A' && !POLICY_FILES.has(relative) && !relative.startsWith('tests/'))
        .map(({ relative }) => relative);
      if (companions.length) {
        block(`this commit changes the security policy and also adds ${companions.join(', ')}`, 'a policy change lands on its own, so widening the allowlist can never carry a payload with it');
      }
    }
  }
} else if (MODE === 'outgoing' || MODE === 'history') {
  const groups = outgoingGroups();
  const added = new Set();
  for (const revs of groups) {
    const { ok, stdout } = await git(['log', ...revs, '--diff-filter=A', '--no-renames', '--name-only', '--pretty=format:']);
    if (!ok) {
      notes.push('not a git repository — nothing to check');
      break;
    }
    for (const relative of stdout.split(/\r?\n/).filter(Boolean)) added.add(relative);
  }
  notes.push(`paths added in scope: ${added.size}`);
  const inHistory = MODE === 'history';
  for (const relative of added) checkNames(relative, inHistory ? 'history' : 'outgoing history', { allowlist: !inHistory });
  if (inHistory) {
    // The allowlist still guards what is published right now, not what was.
    const { ok, stdout } = await git(['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
    if (ok) {
      const present = stdout.split(String.fromCharCode(0)).filter(Boolean);
      notes.push(`files in the checked-out tree: ${present.length}`);
      for (const relative of present) checkNames(relative, 'checked-out tree');
    }
  }
  await scanOutgoingContent(groups);
}

console.log('TaskBridge repo policy\n──────────────────────');
for (const note of notes) console.log(`· ${note}`);
for (const warning of warnings) console.log(`⚠ ${warning}`);
if (problems.length) {
  console.error('');
  for (const problem of problems) console.error(`✖ ${problem}`);
  console.error(`\n${problems.length} problem(s). Nothing is committed or pushed until they are gone.`);
  process.exitCode = 1;
} else {
  console.log('✔ every path and every added line has a right to be here');
}
