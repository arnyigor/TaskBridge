import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshotWorkspace, captureOutputs } from '../src/files.mjs';

test('files git ignores (build output) are not results of an answer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-outputs-'));
  const workspace = path.join(root, 'ws');
  await fs.mkdir(path.join(workspace, 'build'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  await fs.writeFile(path.join(workspace, '.gitignore'), 'build/\n');
  const baseline = await snapshotWorkspace(workspace);
  await fs.writeFile(path.join(workspace, 'report.md'), 'result');
  await fs.writeFile(path.join(workspace, 'build', 'app.jar'), 'binary');
  const output = await captureOutputs({ workspacePath: workspace }, path.join(root, 'task'), baseline);
  assert.deepEqual(output.files.map(file => file.path), ['report.md']);
  await fs.rm(root, { recursive: true, force: true });
});

test('a workspace that is not a repository keeps every changed file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-outputs-'));
  const workspace = path.join(root, 'ws');
  await fs.mkdir(path.join(workspace, 'build'), { recursive: true });
  const baseline = await snapshotWorkspace(workspace);
  await fs.writeFile(path.join(workspace, 'build', 'app.jar'), 'binary');
  const output = await captureOutputs({ workspacePath: workspace }, path.join(root, 'task'), baseline);
  assert.deepEqual(output.files.map(file => file.path), ['build/app.jar']);
  await fs.rm(root, { recursive: true, force: true });
});
