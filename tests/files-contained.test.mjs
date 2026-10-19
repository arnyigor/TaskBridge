import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { containedExistingAncestor, containedFile, stageFiles, validateFiles } from '../src/files.mjs';

async function withWorkspace(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-files-'));
  try { await fn(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('missing workspace files report a clean not-found message', async () => {
  await withWorkspace(async root => {
    await fs.mkdir(path.join(root, 'day26-local-llm', 'video-frames'), { recursive: true });
    await assert.rejects(
      containedFile(root, 'day26-local-llm/video-frames/check/t22.jpg'),
      error => {
        assert.equal(error.code, 'NOT_FOUND');
        assert.match(error.message, /не найден/i);
        assert.doesNotMatch(error.message, /ENOENT|realpath|[A-Za-z]:\\/);
        return true;
      },
    );
  });
});

test('nearest existing ancestor stays inside the workspace and respects private paths', async () => {
  await withWorkspace(async root => {
    const frames = path.join(root, 'day26-local-llm', 'video-frames');
    await fs.mkdir(frames, { recursive: true });
    assert.equal(await containedExistingAncestor(root, 'day26-local-llm/video-frames/check/t22.jpg'), await fs.realpath(frames));

    await assert.rejects(containedExistingAncestor(root, '../outside.jpg'), { code: 'INPUT_INVALID' });
    await assert.rejects(containedExistingAncestor(root, 'data/runtime/phone.png'), { code: 'FILE_FORBIDDEN' });
  });
});

test('a file named the way bash names a drive is served, not reported missing', { skip: process.platform !== 'win32' && 'bash drive letters are a Windows convention' }, async () => {
  await withWorkspace(async root => {
    await fs.writeFile(path.join(root, 'shot.png'), 'frame');
    // Pi runs bash, so the argument that reaches the chat is «/c/Users/…/shot.png»
    // while the file is «C:\Users\…\shot.png». Resolved literally, it pointed at
    // «C:\c\Users\…» and the viewer answered «файл не найден в рабочей папке».
    const bashRoot = `/${root[0].toLowerCase()}${root.slice(2).replaceAll('\\', '/')}`;
    assert.equal(await containedFile(root, `${bashRoot}/shot.png`), await fs.realpath(path.join(root, 'shot.png')));
    // The second reading is not a hole in containment: bounds and private names still apply.
    await assert.rejects(containedFile(root, '/c/Windows/win.ini'), { code: 'INPUT_INVALID' });
    await fs.mkdir(path.join(root, 'data', 'runtime'), { recursive: true });
    await fs.writeFile(path.join(root, 'data', 'runtime', 'phone.png'), 'png');
    await assert.rejects(containedFile(root, `${bashRoot}/data/runtime/phone.png`), { code: 'FILE_FORBIDDEN' });
  });
});

test('attachment metadata stays workspace-relative through a junction or directory alias', async () => {
  await withWorkspace(async root => {
    const workspace = path.join(root, 'canonical');
    const alias = path.join(root, 'workspace-alias');
    await fs.mkdir(workspace);
    await fs.symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const files = validateFiles([{ name: 'sample.txt', base64: Buffer.from('attachment').toString('base64') }]);
    const staged = await stageFiles({ id: 'session', workspacePath: alias }, path.join(root, 'task'), files);
    assert.equal(staged[0].path, `.taskbridge-input/session/${files[0].id}/sample.txt`);
    assert.equal(await fs.readFile(path.join(alias, staged[0].path), 'utf8'), 'attachment');
  });
});
