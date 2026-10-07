import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { TaskManager } from '../src/task-manager.mjs';
import { HuggingFaceService } from '../src/huggingface.mjs';

async function tempRoot(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `taskbridge-${label}-`));
}

test('hfDownload stores repos by owner/name/revision and auto-selects one projector', async () => {
  const root = await tempRoot('hf-download');
  try {
    const modelRoot = path.join(root, 'models');
    const manager = new TaskManager({ localRuntime: {}, modelLibrary: { root: modelRoot } }, root, {});
    const service = new HuggingFaceService({});
    const tree = [
      { path: 'Model-Q4_K_M.gguf', lfs: { size: 100, oid: 'sha256:' + 'a'.repeat(64) } },
      { path: 'mmproj-F16.gguf', lfs: { size: 180 } },
      { path: 'mmproj-Q5_K_M.gguf', lfs: { size: 62 } },
      { path: 'mmproj-Q8_0.gguf', lfs: { size: 98 } }
    ];
    manager.hf = { repoTree: async () => tree, plan: service.plan.bind(service) };
    let captured = null;
    manager.downloads = { start: async args => { captured = args; return args; } };

    await manager.hfDownload({ repo: 'authorA/Qwen-GGUF', revision: 'abc1234567890', files: ['Model-Q4_K_M.gguf'] });

    assert.deepEqual(captured.files.map(f => f.path), ['Model-Q4_K_M.gguf', 'mmproj-Q5_K_M.gguf']);
    assert.equal(captured.files[0].sha256, 'a'.repeat(64));
    assert.equal(captured.dir, path.join(modelRoot, 'authorA', 'Qwen-GGUF', 'abc1234567890'));
    assert.equal(captured.libraryId, 'hf:authora/qwen-gguf@abc123456789:q4km');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('hfDownload accepts an explicit projectorPath and validates it through the tree', async () => {
  const root = await tempRoot('hf-projector');
  try {
    const manager = new TaskManager({ localRuntime: {}, modelLibrary: { root: path.join(root, 'models') } }, root, {});
    const service = new HuggingFaceService({});
    const tree = [
      { path: 'Model-Q4_K_M.gguf', lfs: { size: 100 } },
      { path: 'mmproj-F16.gguf', lfs: { size: 180 } },
      { path: 'mmproj-Q5_K_M.gguf', lfs: { size: 62 } }
    ];
    manager.hf = { repoTree: async () => tree, plan: service.plan.bind(service) };
    let captured = null;
    manager.downloads = { start: async args => { captured = args; return args; } };

    await manager.hfDownload({ repo: 'authorA/Qwen-GGUF', files: ['Model-Q4_K_M.gguf'], projectorPath: 'mmproj-F16.gguf' });
    assert.deepEqual(captured.files.map(f => f.path), ['Model-Q4_K_M.gguf', 'mmproj-F16.gguf']);

    await assert.rejects(
      () => manager.hfDownload({ repo: 'authorA/Qwen-GGUF', files: ['Model-Q4_K_M.gguf'], projectorPath: 'missing-mmproj.gguf' }),
      /отсутствует в дереве/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
