import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export async function git(args, cwd, timeout = 30000) {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
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
    return { workspacePath: sourcePath, sourcePath, worktree: false };
  }

  const root = (await git(['rev-parse', '--show-toplevel'], sourcePath)).stdout.trim();
  const requireClean = project.requireCleanSource ?? defaults.requireCleanSource ?? true;
  if (requireClean) {
    const dirty = (await git(['status', '--porcelain'], root)).stdout.trim();
    if (dirty) {
      const error = new Error('Source repository has uncommitted changes');
      error.code = 'PROJECT_DIRTY';
      throw error;
    }
  }

  const worktreePath = path.join(dataRoot, 'worktrees', taskId);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await fs.rm(worktreePath, { recursive: true, force: true });

  await git(['worktree', 'add', '--detach', worktreePath, 'HEAD'], root, 120000);
  return { workspacePath: worktreePath, sourcePath: root, worktree: true };
}

export async function createScratchWorkspace(taskId, dataRoot) {
  const workspacePath = path.join(dataRoot, 'workspaces', taskId);
  await fs.mkdir(workspacePath, { recursive: true });
  return { workspacePath, sourcePath: null, worktree: false };
}

export async function collectGitState(workspacePath) {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], workspacePath);
  } catch {
    return { isGit: false, status: '', diff: '', changedFiles: [] };
  }

  const status = (await git(['status', '--porcelain'], workspacePath)).stdout;
  const diff = (await git(['diff', '--no-ext-diff', '--binary'], workspacePath, 120000)).stdout;
  const changedFiles = status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  return { isGit: true, status, diff, changedFiles };
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
