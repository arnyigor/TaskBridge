import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, collectGitState, prepareProjectWorkspace, applyTaskPatch, removeWorktree } from '../src/git.mjs';

async function repository(t, { unborn = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-git-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^taskbridge-git-test-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await git(['init', directory], os.tmpdir());
  await git(['config', 'user.name', 'Test'], directory);
  await git(['config', 'user.email', 'test@example.invalid'], directory);
  await git(['config', 'core.autocrlf', 'false'], directory);
  if (!unborn) await git(['commit', '--allow-empty', '-m', 'Initial'], directory);
  return directory;
}

test('result patch contains staged, unstaged, new text and binary changes without modifying the index', async t => {
  const repo = await repository(t);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'initial\n');
  await fs.writeFile(path.join(repo, 'removed.txt'), 'remove me\n');
  await git(['add', '.'], repo);
  await git(['commit', '-m', 'Baseline'], repo);
  const head = (await git(['rev-parse', 'HEAD'], repo)).stdout;
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'staged\n');
  await git(['add', 'tracked.txt'], repo);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'staged\nunstaged\n');
  await git(['rm', 'removed.txt'], repo);
  await fs.writeFile(path.join(repo, 'staged-only.txt'), 'staged-only addition\n');
  await git(['add', 'staged-only.txt'], repo);
  await fs.writeFile(path.join(repo, 'новый файл.txt'), 'Привет\n');
  await fs.writeFile(path.join(repo, '[literal].txt'), 'literal path\n');
  const binary = Buffer.from([0, 1, 2, 3, 0, 255]);
  await fs.writeFile(path.join(repo, 'output.bin'), binary);
  const indexPath = path.join(repo, '.git', 'index');
  const indexBefore = await fs.readFile(indexPath);
  const state = await collectGitState(repo);
  assert.equal(state.isGit, true);
  assert.deepEqual(new Set(state.changedFiles), new Set(['tracked.txt', 'removed.txt', 'staged-only.txt', 'новый файл.txt', '[literal].txt', 'output.bin']));
  assert.match(state.diff, /\+staged\n\+unstaged/);
  assert.match(state.diff, /\+staged-only addition/);
  assert.match(state.diff, /GIT binary patch/);
  assert.match(state.diff, /deleted file mode/);
  assert.match(state.status, /новый файл\.txt/);
  assert.deepEqual(await fs.readFile(indexPath), indexBefore);
  assert.equal((await git(['rev-parse', 'HEAD'], repo)).stdout, head);
  assert.deepEqual(await fs.readFile(path.join(repo, 'output.bin')), binary);
  const patch = path.join(repo, '.git', 'result.patch');
  await fs.writeFile(patch, state.diff);
  await git(['apply', '--reverse', '--check', patch], repo);
});

test('ignored and private files are omitted, including tracked private modifications', async t => {
  const repo = await repository(t);
  await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(repo, 'config.json'), 'original secret');
  await git(['add', '.'], repo);
  await git(['commit', '-m', 'Baseline'], repo);
  await fs.writeFile(path.join(repo, 'config.json'), 'tracked credential value');
  await fs.writeFile(path.join(repo, '.env'), 'untracked credential value');
  await fs.writeFile(path.join(repo, 'ignored.txt'), 'ignored value');
  await fs.mkdir(path.join(repo, '.taskbridge-input'));
  await fs.writeFile(path.join(repo, '.taskbridge-input', 'input.txt'), 'attachment');
  await fs.writeFile(path.join(repo, 'visible.txt'), 'visible value');
  const state = await collectGitState(repo);
  assert.deepEqual(state.changedFiles, ['visible.txt']);
  assert.doesNotMatch(state.diff, /credential|ignored value|attachment/);
  assert.doesNotMatch(state.status, /config\.json|\.env|taskbridge-input|ignored\.txt/);
});

test('staged unicode rename keeps both paths intact in changedFiles', async t => {
  const repo = await repository(t);
  await fs.writeFile(path.join(repo, 'старое имя.txt'), 'rename content\n');
  await git(['add', '.'], repo);
  await git(['commit', '-m', 'Baseline'], repo);
  await git(['mv', 'старое имя.txt', 'новое имя.txt'], repo);
  const state = await collectGitState(repo);
  assert.deepEqual(new Set(state.changedFiles), new Set(['старое имя.txt', 'новое имя.txt']));
  assert.match(state.status, /старое имя\.txt.* -> .*новое имя\.txt/);
  assert.match(state.diff, /rename from/);
});

test('clean and unborn repositories produce accurate snapshots', async t => {
  const clean = await repository(t);
  assert.deepEqual(await collectGitState(clean), { isGit: true, status: '', diff: '', changedFiles: [] });
  const unborn = await repository(t, { unborn: true });
  await fs.writeFile(path.join(unborn, 'first.txt'), 'first\n');
  const state = await collectGitState(unborn);
  assert.deepEqual(state.changedFiles, ['first.txt']);
  assert.match(state.diff, /new file mode/);
  await assert.rejects(fs.access(path.join(unborn, '.git', 'index')), { code: 'ENOENT' });
});

test('a diff larger than the exec buffer (big untracked zip) is still collected', async t => {
  const repo = await repository(t);
  await fs.writeFile(path.join(repo, 'build.zip'), (await import('node:crypto')).randomBytes(24 * 1024 * 1024));
  const state = await collectGitState(repo);
  assert.deepEqual(state.changedFiles, ['build.zip']);
  assert.ok(state.diff.length > 20 * 1024 * 1024);
});

test('non-repository result remains empty', async () => {
  assert.deepEqual(await collectGitState(os.tmpdir()), { isGit: false, status: '', diff: '', changedFiles: [] });
});

test('worktree creation rejects traversal and existing directories without deleting their contents', async t => {
  const repo = await repository(t);
  const data = path.join(repo, '.git', 'taskbridge-data');
  const target = path.join(data, 'worktrees', 'existing');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'keep.txt'), 'keep this');
  await assert.rejects(prepareProjectWorkspace({ path: repo }, 'existing', data), { code: 'WORKTREE_EXISTS' });
  assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'keep this');
  for (const id of ['..', '../outside', '..\\outside', '']) {
    await assert.rejects(prepareProjectWorkspace({ path: repo }, id, data), { code: 'INPUT_INVALID' });
  }
  const created = await prepareProjectWorkspace({ path: repo }, 'new-task', data);
  assert.equal(created.worktree, true);
  assert.equal((await git(['rev-parse', 'HEAD'], created.workspacePath)).stdout, (await git(['rev-parse', 'HEAD'], repo)).stdout);
});

test('result patch applies to the source checkout and the worktree can be removed', async t => {
  const repo = await repository(t);
  await fs.writeFile(path.join(repo, 'file.txt'), 'base\n');
  await git(['add', '.'], repo);
  await git(['commit', '-m', 'Base'], repo);
  const data = path.join(repo, '.git', 'taskbridge-data');
  const created = await prepareProjectWorkspace({ path: repo }, 'task-apply', data);
  assert.equal(created.baseCommit, (await git(['rev-parse', 'HEAD'], repo)).stdout.trim());
  await fs.writeFile(path.join(created.workspacePath, 'file.txt'), 'base\nchanged\n');
  await fs.writeFile(path.join(created.workspacePath, 'new.txt'), 'new file\n');
  const state = await collectGitState(created.workspacePath);
  const result = await applyTaskPatch(repo, state.diff);
  assert.deepEqual(new Set(result.files), new Set(['file.txt', 'new.txt']));
  assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'base\nchanged\n');
  assert.equal(await fs.readFile(path.join(repo, 'new.txt'), 'utf8'), 'new file\n');
  // A patch that no longer applies must fail before touching the checkout.
  await assert.rejects(applyTaskPatch(repo, state.diff));
  await removeWorktree(created.workspacePath, repo, path.join(data, 'worktrees'));
  await assert.rejects(fs.access(created.workspacePath));
  assert.doesNotMatch((await git(['worktree', 'list'], repo)).stdout, /task-apply/);
});

test('worktree removal refuses paths outside the worktree root', async t => {
  const repo = await repository(t);
  const data = path.join(repo, '.git', 'taskbridge-data');
  await assert.rejects(removeWorktree(repo, repo, path.join(data, 'worktrees')), { code: 'INPUT_INVALID' });
});
