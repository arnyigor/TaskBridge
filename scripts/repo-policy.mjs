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

import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ALLOWED_BINARY_EXTENSIONS, createSecretScanner, describeAllowlist, extensionOf, isAllowedPath, LARGE_BLOB_BYTES, normalizePath, POLICY_FILES, riskyRule } from './repo-paths.mjs';

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
  for (const line of text.split(/\r?\n/)) {
    const shape = scanSecret(line);
    if (shape) {
      block(`${relative} contains a secret-shaped literal (${where}, ${shape})`, 'the index is what actually lands in the commit, whatever the working tree shows now');
      return;
    }
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

// Reads real blob contents. A patch is not enough: for a binary file `git log -p`
// says only "Binary files differ", so anything that is not text would pass a
// patch-based scan unseen. Here every object introduced in the scope is read
// whole, and the type comes from git rather than from the file name.
function readObjects(oids) {
  const objects = new Map();
  if (!oids.length) return objects;
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd: ROOT,
    input: `${oids.join('\n')}\n`,
    maxBuffer: 512 * 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout) return objects;
  const out = result.stdout;
  let offset = 0;
  while (offset < out.length) {
    const newline = out.indexOf(10, offset);
    if (newline === -1) break;
    const [oid, type, sizeText] = out.subarray(offset, newline).toString('utf8').split(' ');
    offset = newline + 1;
    if (!oid || type === 'missing' || type === undefined) continue;
    const size = Number(sizeText);
    if (type !== 'blob' || !Number.isFinite(size)) continue;
    objects.set(oid, out.subarray(offset, offset + size));
    offset += size + 1;
  }
  return objects;
}
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

// Content of the commits in scope, read as blobs rather than as a patch. A
// secret that arrived in commit A and was removed in commit B still reaches
// GitHub in A; a PNG or a SQLite file never appears in a patch at all.
//
// Known gap, deliberate: commit messages are not scanned. The previous
// patch-based version discarded them too (--format=), so this is not a
// regression — it is an unclosed channel, recorded here rather than forgotten.
async function scanScopeContent(groups) {
  const paths = new Map(); // oid -> first path seen
  for (const revs of groups) {
    const { ok, stdout } = await git(['rev-list', '--objects', ...revs]);
    if (!ok) continue;
    for (const line of stdout.split(/\r?\n/)) {
      const space = line.indexOf(' ');
      if (space === -1) continue; // a commit has no path
      const oid = line.slice(0, space);
      const relative = normalizePath(line.slice(space + 1));
      if (oid.length !== 40 || !relative || paths.has(oid)) continue;
      paths.set(oid, relative);
    }
  }
  notes.push(`objects introduced in scope: ${paths.size}`);

  const contents = readObjects([...paths.keys()]);
  let text = 0;
  let binary = 0;
  for (const [oid, relative] of paths) {
    const buffer = contents.get(oid);
    if (!buffer) continue;
    if (buffer.length > LARGE_BLOB_BYTES) {
      warnings.push(`${relative} is ${(buffer.length / 1048576).toFixed(1)} MB — large enough to review by hand`);
    }
    if (buffer.includes(0)) {
      binary += 1;
      const extension = extensionOf(relative);
      if (!ALLOWED_BINARY_EXTENSIONS.includes(extension)) {
        block(`${relative} is a binary blob of an unrecognised type (${extension || 'no extension'})`, `if it belongs here, add the extension to ALLOWED_BINARY_EXTENSIONS in scripts/repo-paths.mjs in the same reviewed commit`);
      }
      continue; // a scanner cannot read inside it; the type policy is the check
    }
    text += 1;
    scanContent(relative, buffer.toString('utf8'), 'committed blob');
  }
  notes.push(`scanned ${text} text blob(s) and ${binary} binary blob(s)`);
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
    // `--all` is deliberately wider than branches and tags: anything in the object
    // store can be published by a plain `git push --mirror`, which bypasses the
    // hooks. Name the extra refs so a finding here is actionable rather than
    // mysterious — in this repository they are codex working-tree snapshots.
    const { ok: refsOk, stdout: refsOut } = await git(['for-each-ref', '--format=%(refname)']);
    if (refsOk) {
      const extra = refsOut.split(/\r?\n/).filter(ref => ref && !/^refs\/(heads|tags|remotes)\//.test(ref));
      if (extra.length) {
        notes.push(`${extra.length} ref(s) outside refs/heads, refs/tags and refs/remotes are in scope — nothing publishes them by default, but \`git push --mirror\` would:`);
        for (const ref of extra) notes.push(`    ${ref}`);
      }
    }
    // The allowlist still guards what is published right now, not what was.
    const { ok, stdout } = await git(['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
    if (ok) {
      const present = stdout.split(String.fromCharCode(0)).filter(Boolean);
      notes.push(`files in the checked-out tree: ${present.length}`);
      for (const relative of present) checkNames(relative, 'checked-out tree');
    }
  }
  await scanScopeContent(groups);
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
