import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeExternalReadProject, resolveExternalRoot, reviseExternalReadProject, externalReadRevision } from '../src/external-files/config.mjs';

async function fixture(t) {
  await fs.mkdir('.local', { recursive: true });
  const base = await fs.mkdtemp(path.resolve('.local/external-read-policy-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'Downloads');
  await fs.mkdir(directory);
  const root = { id: 'downloads', path: directory, enabled: true, extensions: ['.png', '.txt'] };
  const project = { id: 'allowed', externalReadDirectories: [root] };
  return { base, directory, root, project };
}

test('legacy projects remain unchanged and cannot resolve a root from another project', async t => {
  const { project } = await fixture(t);
  const legacy = { id: 'legacy' };
  assert.equal(await normalizeExternalReadProject(legacy), legacy);
  assert.equal(Object.hasOwn(legacy, 'externalReadDirectories'), false);
  const allowed = await normalizeExternalReadProject(project);
  assert.equal(resolveExternalRoot(allowed, 'downloads').id, 'downloads');
  assert.throws(() => resolveExternalRoot(legacy, 'downloads'), { code: 'FILE_FORBIDDEN' });
  assert.throws(() => resolveExternalRoot(allowed, 'unknown'), { code: 'FILE_FORBIDDEN' });
});

test('roots are canonicalized without mutating configuration or granting other capabilities', async t => {
  const { project, directory } = await fixture(t);
  const before = structuredClone(project);
  const result = await normalizeExternalReadProject(project);
  assert.deepEqual(project, before);
  assert.equal(result.externalReadDirectories[0].path, await fs.realpath(directory));
  assert.equal(result.externalReadDirectories[0].canBrowse, false);
  assert.equal(result.externalReadDirectories[0].canPreview, false);
  assert.equal(result.externalReadDirectories[0].canAttach, false);
  assert.equal(result.externalReadDirectories[0].allowModelTransfer, false);
  assert.deepEqual(result.externalReadDirectories[0].extensions, ['.png', '.txt']);
});

test('missing or disabled enabled flag never grants access', async t => {
  const { project, root } = await fixture(t);
  for (const enabled of [undefined, false]) {
    const normalized = await normalizeExternalReadProject({ ...project, externalReadDirectories: [{ ...root, enabled }] });
    assert.throws(() => resolveExternalRoot(normalized, 'downloads'), { code: 'FILE_FORBIDDEN' });
  }
  await assert.rejects(normalizeExternalReadProject({ ...project, externalReadDirectories: [{ ...root, enabled: 'true' }] }), { code: 'INPUT_INVALID' });
});

test('root ids are unique, bounded and safe', async t => {
  const { root } = await fixture(t);
  for (const id of ['', '../downloads', 'a/b', 'a:b', 'a'.repeat(65), 12, null]) {
    await assert.rejects(normalizeExternalReadProject({ externalReadDirectories: [{ ...root, id }] }), { code: 'INPUT_INVALID' });
  }
  await assert.rejects(normalizeExternalReadProject({ externalReadDirectories: [root, root] }), { code: 'INPUT_INVALID' });
  for (const externalReadDirectories of [null, {}, Array(33).fill(root)]) {
    await assert.rejects(normalizeExternalReadProject({ externalReadDirectories }), { code: 'INPUT_INVALID' });
  }
});

test('only bounded image/text extension allowlists are accepted', async t => {
  const { root } = await fixture(t);
  for (const extensions of [[], ['*'], ['.exe'], ['png'], ['.PNG'], '.png', [null]]) {
    await assert.rejects(normalizeExternalReadProject({ externalReadDirectories: [{ ...root, extensions }] }), { code: 'INPUT_INVALID' });
  }
  const result = await normalizeExternalReadProject({ externalReadDirectories: [{ ...root, extensions: undefined }] });
  assert.deepEqual(result.externalReadDirectories[0].extensions, ['.png', '.jpg', '.jpeg', '.webp', '.txt', '.md', '.json']);
});

test('relative, UNC, device, ADS and ambiguous Windows roots are rejected', async t => {
  const { root, directory } = await fixture(t);
  for (const value of ['relative/path', '\\\\server\\share', '//server/share', '\\\\?\\C:\\Assets', '\\\\.\\C:', `${directory}:stream`, `${directory}.`, `${directory} `, `${directory}\u0000`, path.join(directory, 'NUL.txt')]) {
    await assert.rejects(normalizeExternalReadProject({ externalReadDirectories: [{ ...root, path: value }] }), { code: 'INPUT_INVALID' });
  }
});

test('disk roots, whole profiles and sensitive trees are denied before reading them', async t => {
  const { root, base } = await fixture(t);
  for (const value of [path.parse(base).root, os.homedir(), path.dirname(os.homedir()), ...['.ssh', '.aws', '.pi', 'AppData', 'Windows', 'Program Files', 'ProgramData', 'secrets'].map(name => path.join(base, name))]) {
    await assert.rejects(normalizeExternalReadProject({ externalReadDirectories: [{ ...root, path: value }] }), { code: 'FILE_FORBIDDEN' });
  }
});

test('nonexistent paths and files are not registered; fs errors do not expose paths', async t => {
  const { root, base } = await fixture(t);
  const file = path.join(base, 'file.txt');
  await fs.writeFile(file, 'hello');
  await assert.rejects(normalizeExternalReadProject({ externalReadDirectories: [{ ...root, path: file }] }), { code: 'INPUT_INVALID' });
  await assert.rejects(normalizeExternalReadProject({ externalReadDirectories: [{ ...root, path: path.join(base, 'absent') }] }), error => error.code === 'NOT_FOUND' && !error.message.includes(base));
});

test('aliases are canonicalized and cannot bypass sensitive-root policy', async t => {
  const { root, base, directory } = await fixture(t);
  const sensitive = path.join(base, '.ssh');
  await fs.mkdir(sensitive);
  const alias = path.join(base, 'alias');
  const forbiddenAlias = path.join(base, 'forbidden-alias');
  // Directory junctions do not require Developer Mode on Windows.
  await fs.symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.symlink(sensitive, forbiddenAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const normalized = await normalizeExternalReadProject({ externalReadDirectories: [{ ...root, path: alias }] });
  assert.equal(normalized.externalReadDirectories[0].path, await fs.realpath(directory));
  await assert.rejects(normalizeExternalReadProject({ externalReadDirectories: [{ ...root, path: forbiddenAlias }] }), { code: 'FILE_FORBIDDEN' });
});

test('TaskManager validates grants before session recovery and keeps legacy projects unchanged', async t => {
  const { TaskManager } = await import('../src/task-manager.mjs');
  const { project, directory } = await fixture(t);
  const legacy = { id: 'legacy' };
  const stop = new Error('stop before session recovery');
  let cleaned = false;
  // Stop at the store boundary: no real Pi processes or recovery timers needed.
  const manager = Object.assign(Object.create(TaskManager.prototype), {
    projects: new Map([[project.id, project], [legacy.id, legacy]]),
    config: { projects: [project, legacy] },
    uploads: { async cleanup() { cleaned = true; } },
    mcp: { async ensureReady() {} },
    store: { async list() { throw stop; } },
  });
  await assert.rejects(manager.init(), error => error === stop);
  assert.equal(cleaned, true);
  assert.equal(manager.projects.get('legacy'), legacy);
  assert.equal(manager.projects.get('allowed').externalReadDirectories[0].path, await fs.realpath(directory));
  assert.equal(manager.config.projects[0], manager.projects.get('allowed'));

  cleaned = false;
  const invalid = { ...project, externalReadDirectories: [{ ...project.externalReadDirectories[0], path: 'relative' }] };
  manager.projects.set(project.id, invalid);
  await assert.rejects(manager.init(), { code: 'INPUT_INVALID' });
  assert.equal(cleaned, false, 'invalid grants fail before starting services');
  assert.equal(manager.projects.get(project.id), invalid, 'validation failure publishes no replacement');
});

test('revision is validated, incremented on changes and preserved on no-op', async t => {
  const { project, root } = await fixture(t);
  const normalized = await normalizeExternalReadProject(project);
  assert.equal(externalReadRevision(normalized), 0);
  assert.equal(await reviseExternalReadProject(normalized, normalized.externalReadDirectories, 0), normalized);
  const changed = await reviseExternalReadProject(normalized, [{ ...root, enabled: false }], 0);
  assert.equal(changed.externalReadRevision, 1);
  assert.throws(() => resolveExternalRoot(changed, 'downloads'), { code: 'FILE_FORBIDDEN' });
  assert.equal(resolveExternalRoot(normalized, 'downloads').enabled, true, 'caller publishes the new configuration explicitly');
  await assert.rejects(reviseExternalReadProject(changed, [root], 0), { code: 'REVISION_CONFLICT' });
  for (const externalReadRevision of [-1, 1.2, '1', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(normalizeExternalReadProject({ ...project, externalReadRevision }), { code: 'INPUT_INVALID' });
  }
});
