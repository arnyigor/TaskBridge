import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'repo-policy.mjs');
const ZERO = '0'.repeat(40);

// Built at runtime so this file does not itself contain the literal the audit
// looks for — otherwise the repository would fail its own policy.
const FAKE_TERM = 'secret-' + 'internal-domain';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-policy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(root, relative, content = 'x') {
  const absolute = path.join(root, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf8');
  return absolute;
}

async function git(root, args) {
  return execFileAsync('git', args, { cwd: root });
}

async function commit(root, message) {
  return git(root, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', message]);
}

async function policy(root, args = []) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, '--root', root, ...args], { cwd: root });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test('an unknown top-level directory is refused even though no rule ever named it', async t => {
  const root = await tempDir(t);
  await write(root, 'notes-company/plan.md', 'notes about something else');
  await git(root, ['init', '-q']);
  await git(root, ['add', 'notes-company/plan.md']);

  const result = await policy(root, ['--staged']);
  assert.equal(result.code, 1);
  assert.match(result.output, /notes-company\/plan\.md is not an allowed path/);
  assert.match(result.output, /ALLOWED_ROOTS/);
});

test('files inside allowed roots pass', async t => {
  const root = await tempDir(t);
  await write(root, 'src/server.mjs');
  await write(root, 'docs/notes.md');
  await write(root, 'package.json', '{}');
  await git(root, ['init', '-q']);
  await git(root, ['add', '-A']);

  const result = await policy(root, ['--staged']);
  assert.equal(result.code, 0, result.output);
});

test('a risky name is refused even inside an allowed root', async t => {
  const root = await tempDir(t);
  await write(root, 'docs/persistent-memory.bak');
  await git(root, ['init', '-q']);
  await git(root, ['add', '-A']);

  const result = await policy(root, ['--staged']);
  assert.equal(result.code, 1);
  assert.match(result.output, /risky path \(backup file\)/);
});

test('a locally forbidden term in staged content is refused and never echoed', async t => {
  const root = await tempDir(t);
  await write(root, 'security.local.json', JSON.stringify({ forbiddenTerms: [FAKE_TERM] }));
  await write(root, 'docs/build-notes.md', `host: ${FAKE_TERM}\n`);
  await git(root, ['init', '-q']);
  await git(root, ['add', 'docs/build-notes.md']);

  const result = await policy(root, ['--staged']);
  assert.equal(result.code, 1);
  assert.match(result.output, /contains a locally forbidden term/);
  assert.ok(!result.output.includes(FAKE_TERM), 'the audit must not print the term');
});

test('a file added and then deleted in outgoing commits is still refused', async t => {
  const root = await tempDir(t);
  await git(root, ['init', '-q']);
  await write(root, 'src/keep.mjs');
  await git(root, ['add', '-A']);
  await commit(root, 'first');

  await write(root, 'analysis-old-project/report.md', 'belongs to another project');
  await git(root, ['add', '-A']);
  await commit(root, 'add the file by accident');
  await git(root, ['rm', '-rq', 'analysis-old-project']);
  await commit(root, 'remove it again');

  const { stdout: tip } = await git(root, ['rev-parse', 'HEAD']);
  const pushing = `refs/heads/master ${tip.trim()} refs/heads/master ${ZERO}`;

  // The working tree is clean and the file is gone — only the outgoing commits know.
  const result = await policy(root, ['--push-refs', pushing]);
  assert.equal(result.code, 1);
  assert.match(result.output, /analysis-old-project\/report\.md/);
});

test('this repository passes the policy with a clean index', async t => {
  const result = await policy(REPO_ROOT, ['--staged']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /every path has a right to be here/);
});
