#!/usr/bin/env node
// Refuses a commit or a push that would record files TaskBridge has no business
// carrying.
//
//   node scripts/repo-policy.mjs --staged      what `git commit` is about to record
//   node scripts/repo-policy.mjs --outgoing    every commit a `git push` would send
//   node scripts/repo-policy.mjs --paths a b   explicit paths (used by tests)
//
// Three questions, in this order:
//   1. is the path allowed at all?        (allowlist — the control that holds)
//   2. does the name look like scratch?   (denylist — the names that burned us)
//   3. does the content name something   (security.local.json — local only,
//      corporate that must not leave)     never committed, so the list itself
//                                          does not leak)
//
// Exits non-zero on the first violation it finds. Never prints the matched term
// in full.
//
// `--root` exists so tests can run this against a fixture repository.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describeAllowlist, isAllowedPath, normalizePath, riskyRule } from './repo-paths.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SCANNED_BYTES = 4 * 1024 * 1024;

function rootArg() {
  const index = process.argv.indexOf('--root');
  if (index === -1) return REPO_ROOT;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? path.resolve(value) : REPO_ROOT;
}
const ROOT = rootArg();

// pre-push feeds one line per ref: <local ref> <local sha> <remote ref> <remote sha>.
// Using it makes the scan cover exactly what this push sends. Without it we fall
// back to the conservative superset below, which also reports files carried by
// long-lived local-only branches.
const pushRefsIndex = process.argv.indexOf('--push-refs');
const pushRefs = pushRefsIndex === -1 ? null : (process.argv[pushRefsIndex + 1] ?? '');

const MODE = process.argv.includes('--outgoing') || pushRefs !== null
  ? 'outgoing'
  : process.argv.includes('--paths')
    ? 'paths'
    : 'staged';

const problems = [];
const notes = [];

async function git(args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '' };
  }
}

function block(message, hint) {
  problems.push(hint ? `${message}\n    ${hint}` : message);
}

// 1 + 2. Names -----------------------------------------------------------------
function checkNames(relative, { where }) {
  const clean = normalizePath(relative);
  const risky = riskyRule(clean);
  if (risky) {
    block(`${clean} is a risky path (${risky.name}) in ${where}`, 'scratch, backups and other projects\' state do not belong in this repository');
    return;
  }
  if (!isAllowedPath(clean)) {
    block(`${clean} is not an allowed path in TaskBridge (${where})`, `allowed roots: ${describeAllowlist()}. If it really belongs here, add its root to ALLOWED_ROOTS in scripts/repo-paths.mjs`);
  }
}

// 3. Corporate terms -----------------------------------------------------------------
async function loadForbiddenTerms() {
  const file = path.join(ROOT, 'security.local.json');
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    const terms = Array.isArray(parsed.forbiddenTerms) ? parsed.forbiddenTerms : [];
    return terms.filter(term => typeof term === 'string' && term.trim().length >= 4).map(term => term.trim().toLowerCase());
  } catch {
    return null;
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

// Each group is an argument list for `git log`: keeping them apart avoids the
// `--not` toggle problem when one push mixes new and existing refs.
function outgoingGroups() {
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

function scanText(relative, text, terms, where) {
  if (!text) return;
  const lower = text.toLowerCase();
  for (const term of terms) {
    if (lower.includes(term)) {
      // Never echo the term: this output lands in terminals and CI logs.
      block(`${relative} contains a locally forbidden term (${where}, term #${terms.indexOf(term) + 1} of ${terms.length})`, 'see security.local.json; this list is intentionally not in the repository');
      return;
    }
  }
}

// ---------------------------------------------------------------------------------

const terms = await loadForbiddenTerms();
if (terms) notes.push(`loaded ${terms.length} locally forbidden term(s) from security.local.json`);
else notes.push('no security.local.json — the corporate-term scan is off (copy security.local.example.json to enable it)');

if (MODE === 'paths') {
  const index = process.argv.indexOf('--paths');
  const paths = process.argv.slice(index + 1).filter(arg => !arg.startsWith('--'));
  for (const relative of paths) {
    const clean = normalizePath(relative);
    checkNames(clean, { where: 'argument' });
    if (terms) scanText(clean, await readIfText(path.join(ROOT, clean)), terms, 'working tree');
  }
} else if (MODE === 'staged') {
  const { ok, stdout } = await git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
  if (!ok) {
    notes.push('not a git repository — nothing staged to check');
  } else {
    const staged = stdout.split(String.fromCharCode(0)).filter(Boolean);
    notes.push(`staged files: ${staged.length}`);
    for (const relative of staged) {
      const clean = normalizePath(relative);
      checkNames(clean, { where: 'index' });
      if (terms) scanText(clean, await readStagedBlob(clean), terms, 'staged content');
    }
  }
} else {
  // pre-commit guards the commit being made; this guards the outgoing range. A
  // file added in commit A and deleted in commit B is still inside A, and A
  // travels to GitHub whatever the working tree looks like now.
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
  notes.push(`paths added in outgoing commits: ${added.size}`);
  for (const relative of added) checkNames(relative, { where: 'outgoing history' });

  if (terms) {
    for (const term of terms) {
      for (const revs of groups) {
        // -S finds the commits that introduce the term, so this covers content in
        // outgoing history even if the file was deleted again before the push.
        const found = await git(['log', ...revs, '-S', term, '--oneline']);
        if (found.ok && found.stdout.trim()) {
          block('outgoing history contains a locally forbidden term', `term #${terms.indexOf(term) + 1} of ${terms.length}; see security.local.json`);
          break;
        }
      }
    }
  }
}

console.log('TaskBridge repo policy\n──────────────────────');
for (const note of notes) console.log(`· ${note}`);
if (problems.length) {
  console.error('');
  for (const problem of problems) console.error(`✖ ${problem}`);
  console.error(`\n${problems.length} problem(s). Nothing is committed or pushed until they are gone.`);
  process.exitCode = 1;
} else {
  console.log('✔ every path has a right to be here');
}
