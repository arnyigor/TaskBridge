import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isPrivatePath } from './files.mjs';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const MAX_SNAPSHOT_PATHS = 256;
const MAX_STATUS_LINES = 512;

export async function git(args, cwd, timeout = 30000, env = {}) {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
    timeout,
    maxBuffer: 20 * 1024 * 1024
  });
  return { stdout: stdout ?? '', stderr: stderr ?? '' };
}

export async function prepareProjectWorkspace(project, taskId, dataRoot, defaults = {}) {
  const sourcePath = path.resolve(project.path);
  await fs.access(sourcePath);

  const useWorktree = project.useWorktree ?? defaults.useGitWorktreeByDefault ?? true;
  if (!useWorktree) {
    return { workspacePath: sourcePath, sourcePath, worktree: false, baseCommit: null };
  }

  const root = (await git(['rev-parse', '--show-toplevel'], sourcePath)).stdout.trim();
  const baseCommit = (await git(['rev-parse', '--verify', 'HEAD'], root)).stdout.trim();
  const requireClean = project.requireCleanSource ?? defaults.requireCleanSource ?? true;
  if (requireClean) {
    const dirty = (await git(['status', '--porcelain'], root)).stdout.trim();
    if (dirty) {
      const error = new Error('Source repository has uncommitted changes');
      error.code = 'PROJECT_DIRTY';
      throw error;
    }
  }

  const worktreeRoot = path.resolve(dataRoot, 'worktrees');
  const worktreePath = path.resolve(worktreeRoot, taskId);
  const relative = path.relative(worktreeRoot, worktreePath);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || /[/\\]/.test(taskId)) {
    throw Object.assign(new Error('Invalid worktree task id'), { code: 'INPUT_INVALID' });
  }
  await fs.mkdir(worktreeRoot, { recursive: true });
  try {
    await fs.lstat(worktreePath);
    throw Object.assign(new Error('Worktree path already exists'), { code: 'WORKTREE_EXISTS' });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await git(['worktree', 'add', '--detach', worktreePath, 'HEAD'], root, 120000);
  return { workspacePath: worktreePath, sourcePath: root, worktree: true, baseCommit };
}

// Applies a TaskBridge result patch to the source checkout. --check runs first
// so a conflicting patch fails before anything on disk is touched.
export async function applyTaskPatch(sourcePath, patch) {
  if (typeof patch !== 'string' || !patch.trim()) return { empty: true, files: [] };
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-apply-'));
  const file = path.join(temporary, 'change.patch');
  try {
    await fs.writeFile(file, patch, 'utf8');
    await git(['apply', '--check', '--whitespace=nowarn', file], sourcePath);
    const numstat = (await git(['apply', '--numstat', file], sourcePath)).stdout;
    const files = numstat.split('\n').filter(Boolean).map(line => line.split('\t').slice(2).join('\t')).filter(Boolean);
    await git(['apply', '--whitespace=nowarn', file], sourcePath);
    return { empty: false, files };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

// Only removes directories that really are TaskBridge worktrees under dataRoot,
// never an arbitrary workspace path a task might point at.
export async function removeWorktree(workspacePath, sourcePath, worktreeRoot) {
  if (typeof workspacePath !== 'string' || !workspacePath) {
    throw Object.assign(new Error('Not a TaskBridge worktree'), { code: 'INPUT_INVALID' });
  }
  const root = path.resolve(worktreeRoot);
  const target = path.resolve(workspacePath);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Not a TaskBridge worktree'), { code: 'INPUT_INVALID' });
  }
  if (sourcePath) {
    await git(['worktree', 'remove', '--force', target], sourcePath).catch(() => null);
    await git(['worktree', 'prune'], sourcePath).catch(() => null);
  }
  await fs.rm(target, { recursive: true, force: true });
}

export async function createScratchWorkspace(taskId, dataRoot) {
  const workspacePath = path.join(dataRoot, 'workspaces', taskId);
  await fs.mkdir(workspacePath, { recursive: true });
  return { workspacePath, sourcePath: null, worktree: false };
}

export async function collectGitState(workspacePath) {
  let root;
  try {
    root = (await git(['rev-parse', '--show-toplevel'], workspacePath)).stdout.trim();
  } catch {
    return { isGit: false, status: '', diff: '', changedFiles: [] };
  }

  const publishable = name => !isPrivatePath(name) && !name.split('/').includes('.taskbridge-input');
  const records = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root)).stdout.split('\0');
  const changes = [];
  const displayPath = name => /[\s"\\]/.test(name) ? JSON.stringify(name) : name;
  for (let i = 0; i < records.length && records[i]; i++) {
    const code = records[i].slice(0, 2);
    const name = records[i].slice(3);
    const previous = /[RC]/.test(code) ? records[++i] : null;
    if (publishable(name) && (!previous || publishable(previous))) {
      changes.push({ code, name, previous });
    }
  }
  if (!changes.length) return { isGit: true, status: '', diff: '', changedFiles: [] };

  // An imported project can have tens of thousands of untracked assets. Git
  // status can describe them cheaply, but adding every file to a disposable
  // index can run for minutes and leave index.lock behind on Windows. Prefer
  // tracked edits and bound the snapshot; expose the omitted count explicitly.
  const ordered = [
    ...changes.filter(change => change.code !== '??'),
    ...changes.filter(change => change.code === '??'),
  ];
  const selected = ordered.slice(0, MAX_SNAPSHOT_PATHS);
  const candidates = [...new Set(selected.flatMap(change => [change.name, change.previous].filter(Boolean)))];
  const omitted = changes.length - selected.length;
  const status = changes.slice(0, MAX_STATUS_LINES)
    .map(({ code, name, previous }) => `${code} ${previous ? displayPath(previous) + ' -> ' : ''}${displayPath(name)}\n`)
    .join('') + (changes.length > MAX_STATUS_LINES ? `… ${changes.length - MAX_STATUS_LINES} more files omitted from status\n` : '')
    + (omitted ? `… ${omitted} files omitted from diff snapshot\n` : '');

  // Build a snapshot of the working files in a disposable index. Neither the
  // user's staged changes nor their index metadata are touched by collection.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-git-'));
  const indexFile = path.join(temporary, 'index');
  const pathspecFile = path.join(temporary, 'paths');
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    let head;
    try { head = (await git(['rev-parse', '--verify', 'HEAD'], root)).stdout.trim(); }
    catch { head = null; }
    await git(head ? ['read-tree', head] : ['read-tree', '--empty'], root, 30000, env);
    if (candidates.length) {
      await fs.writeFile(pathspecFile, [...new Set(candidates)].map(name => `:(literal)${name}\0`).join(''));
      await git(['add', '-A', `--pathspec-from-file=${pathspecFile}`, '--pathspec-file-nul'], root, 30000, env);
    }
    const baseArgs = ['diff', '--cached', ...(head ? [head] : []), '--no-ext-diff'];
    // Written by git straight to a file: a binary diff of a large untracked file
    // (a zip in the worktree) overflowed execFile's maxBuffer and failed the task.
    const diffFile = path.join(temporary, 'diff');
    await git([...baseArgs, '--binary', '--no-textconv', `--output=${diffFile}`], root, 120000, env);
    const diff = await fs.readFile(diffFile, 'utf8');
    const changedFiles = (await git([...baseArgs, '--name-only', '--no-renames', '-z'], root, 30000, env)).stdout.split('\0').filter(Boolean);
    return { isGit: true, status, diff, changedFiles, ...(omitted ? { truncated: true } : {}) };
  } finally {
    // Only remove the known files we created; never recursively remove a repo.
    for (const name of [indexFile, indexFile + '.lock', pathspecFile, path.join(temporary, 'diff')]) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await fs.unlink(name); break; }
        catch (error) {
          if (error.code === 'ENOENT') break;
          if (attempt === 3 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) {
            console.warn(`Git snapshot cleanup deferred for ${name}: ${error.message}`);
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
    await fs.rmdir(temporary).catch(error => {
      if (error.code !== 'ENOENT') console.warn(`Git snapshot cleanup deferred for ${temporary}: ${error.message}`);
    });
  }
}

/** An optional diff must never turn a completed model answer into a failed task. */
export async function collectGitStateForCompletion(workspacePath, collector = collectGitState) {
  try { return await collector(workspacePath); }
  catch (error) {
    return {
      isGit: false, status: '', diff: '', changedFiles: [],
      warning: `Git snapshot unavailable: ${error.message}`,
    };
  }
}

export async function runVerification(commands, cwd, onOutput = () => {}) {
  const results = [];
  for (const command of commands || []) {
    const startedAt = Date.now();
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        windowsHide: true,
        timeout: 30 * 60 * 1000,
        maxBuffer: 50 * 1024 * 1024,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
      });
      const result = { command, ok: true, exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '', durationMs: Date.now() - startedAt };
      results.push(result);
      onOutput(result);
    } catch (error) {
      const result = {
        command,
        ok: false,
        exitCode: error.code ?? 1,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? error.message,
        durationMs: Date.now() - startedAt
      };
      results.push(result);
      onOutput(result);
      break;
    }
  }
  return results;
}
