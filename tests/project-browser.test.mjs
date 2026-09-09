import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDirectory, resolveBrowsablePath } from '../src/project-browser.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-project-browser-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed');
  await fs.mkdir(path.join(allowed, 'sub-a'), { recursive: true });
  await fs.mkdir(path.join(allowed, 'sub-b'));
  await fs.mkdir(path.join(allowed, '.git'));
  await fs.mkdir(path.join(allowed, 'node_modules'));
  await fs.writeFile(path.join(allowed, 'readme.txt'), 'not a directory');
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  return { root, allowed, outside, config: { projectBrowser: { roots: [allowed] } } };
}

test('with no roots configured, listing and resolving fail clearly', async () => {
  await assert.rejects(listDirectory({}, null), { code: 'NOT_CONFIGURED' });
  await assert.rejects(resolveBrowsablePath({}, 'C:\\anything'), { code: 'NOT_CONFIGURED' });
});

test('listing the empty path shows configured roots themselves', async t => {
  const f = await fixture(t);
  const result = await listDirectory(f.config, null);
  assert.equal(result.path, null);
  assert.equal(result.parent, null);
  assert.deepEqual(result.entries.map(e => e.name), ['allowed']);
  assert.equal(result.entries[0].path, await fs.realpath(f.allowed));
});

test('listing a root shows only real subdirectories, hides dotfiles/build noise/files, sorted', async t => {
  const f = await fixture(t);
  const result = await listDirectory(f.config, f.allowed);
  assert.equal(result.parent, null); // the root itself has no browsable parent
  assert.deepEqual(result.entries.map(e => e.name), ['sub-a', 'sub-b']);
});

test('a subdirectory reports its parent for going back up', async t => {
  const f = await fixture(t);
  const result = await listDirectory(f.config, path.join(f.allowed, 'sub-a'));
  assert.equal(result.parent, await fs.realpath(f.allowed));
});

test('paths outside every configured root are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveBrowsablePath(f.config, f.outside), { code: 'FILE_FORBIDDEN' });
  await assert.rejects(listDirectory(f.config, f.outside), { code: 'FILE_FORBIDDEN' });
});

test('relative paths and missing directories are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveBrowsablePath(f.config, 'relative/path'), { code: 'INPUT_INVALID' });
  await assert.rejects(resolveBrowsablePath(f.config, path.join(f.allowed, 'missing')), { code: 'NOT_FOUND' });
});

test('a symlink escaping the root is rejected even if it resolves back inside another root', async t => {
  const f = await fixture(t);
  const link = path.join(f.allowed, 'escape');
  try { await fs.symlink(f.outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Symlink creation unavailable'); return; }
    throw error;
  }
  await assert.rejects(resolveBrowsablePath(f.config, link), { code: 'FILE_FORBIDDEN' });
  const result = await listDirectory(f.config, f.allowed);
  assert.ok(!result.entries.some(e => e.name === 'escape'));
});
