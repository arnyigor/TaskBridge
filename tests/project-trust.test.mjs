import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { trustProjectDirectory } from '../src/project-trust.mjs';

test('trustProjectDirectory preserves Pi trust decisions and trusts the canonical folder', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-project-trust-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent');
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.mkdir(agentDir);
  await fs.writeFile(path.join(agentDir, 'trust.json'), `${JSON.stringify({ [root]: false }, null, 2)}\n`);

  const result = await trustProjectDirectory(project, agentDir);
  const saved = JSON.parse(await fs.readFile(path.join(agentDir, 'trust.json'), 'utf8'));
  const canonical = await fs.realpath(project);

  assert.deepEqual(result, { path: canonical, trusted: true });
  assert.equal(saved[root], false, 'unrelated existing decisions are preserved');
  assert.equal(saved[canonical], true);
});

test('trustProjectDirectory refuses a missing workspace without creating trust.json', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-project-trust-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent');

  await assert.rejects(() => trustProjectDirectory(path.join(root, 'missing'), agentDir), { code: 'NOT_FOUND' });
  await assert.rejects(() => fs.access(path.join(agentDir, 'trust.json')));
});
