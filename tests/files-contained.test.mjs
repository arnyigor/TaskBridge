import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { containedExistingAncestor, containedFile } from '../src/files.mjs';

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
