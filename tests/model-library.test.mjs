import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ModelLibrary } from '../src/model-library.mjs';

async function tempRoot(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `taskbridge-lib-${label}-`));
}

test('ModelLibrary registers a model from a finished download job and checks file presence', async () => {
  const root = await tempRoot('job');
  try {
    const library = new ModelLibrary(root);
    const entry = library.addFromJob({
      id: 'dl-1', repo: 'org/Qwen3.8-27B-GGUF', revision: 'abc123def', label: 'Qwen3.8-27B',
      dir: root, files: [
        { path: 'Model-Q4_K_M.gguf', size: 100 },
        { path: 'mmproj-f16.gguf', size: 50 }
      ]
    });
    assert.equal(entry.id, 'hf:org/qwen3.8-27b-gguf@abc123def:q4km');
    assert.equal(entry.quant, 'Q4_K_M');
    assert.equal(entry.vision, true); // mmproj в задании — модель vision
    assert.equal(entry.source.repo, 'org/Qwen3.8-27B-GGUF');
    assert.equal(entry.source.revision, 'abc123def');
    assert.equal(entry.format, 'gguf');

    // Файлы не существуют — честный filesPresent: false, а не «установлена».
    const status = await library.list({ fresh: true });
    assert.equal(status.length, 1);
    assert.equal(status[0].filesPresent, false);
    assert.deepEqual(status[0].missingFiles, ['Model-Q4_K_M.gguf', 'mmproj-f16.gguf']);

    // Файлы появились — запись стала правдивой.
    await fs.writeFile(path.join(root, 'Model-Q4_K_M.gguf'), Buffer.alloc(100));
    await fs.writeFile(path.join(root, 'mmproj-f16.gguf'), Buffer.alloc(50));
    const after = await library.list({ fresh: true });
    assert.equal(after[0].filesPresent, true);

    // Реестр переживает перезапуск.
    const reopened = new ModelLibrary(root);
    assert.equal(reopened.list && true, true);
    const persisted = await reopened.list({ fresh: true });
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, entry.id);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ModelLibrary.scan indexes standalone gguf files and skips registered ones', async () => {
  const root = await tempRoot('scan');
  try {
    await fs.mkdir(path.join(root, 'sub'), { recursive: true });
    await fs.writeFile(path.join(root, 'Standalone-Q8_0.gguf'), Buffer.alloc(10));
    await fs.writeFile(path.join(root, 'sub', 'Other-IQ3_M.gguf'), Buffer.alloc(10));
    await fs.writeFile(path.join(root, 'notes.txt'), 'not a model');
    await fs.mkdir(path.join(root, '.taskbridge-part'), { recursive: true });
    await fs.writeFile(path.join(root, '.taskbridge-part', 'partial.gguf'), Buffer.alloc(10));

    const library = new ModelLibrary(root);
    const standalone = await library.scan(root);
    const names = standalone.map(s => path.basename(s.path)).sort();
    // partial.gguf из служебной директории и notes.txt в индекс не попадают.
    assert.deepEqual(names, ['Other-IQ3_M.gguf', 'Standalone-Q8_0.gguf']);
    const q8 = standalone.find(s => s.quant === 'Q8_0');
    assert.equal(q8.format, 'gguf');
    assert.equal(q8.source.type, 'standalone');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ModelLibrary uses the libraryId computed at download time', async () => {
  const root = await tempRoot('jobid');
  try {
    const library = new ModelLibrary(root);
    const entry = library.addFromJob({
      id: 'dl-3', repo: 'org/model', revision: 'main', dir: root,
      libraryId: 'model-main-q4km',
      files: [{ path: 'w-Q4_K_M.gguf', size: 1 }]
    });
    assert.equal(entry.id, 'model-main-q4km', 'id из задания обязателен: UI знал его заранее');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ModelLibrary.remove forgets a registered model but keeps files on disk', async () => {
  const root = await tempRoot('remove');
  try {
    const library = new ModelLibrary(root);
    const entry = library.addFromJob({
      id: 'dl-2', repo: 'org/model', revision: 'main', dir: root,
      files: [{ path: 'm.gguf', size: 1 }]
    });
    await fs.writeFile(path.join(root, 'm.gguf'), 'x');
    const removed = library.remove(entry.id);
    assert.equal(removed.id, entry.id);
    assert.equal(library.remove(entry.id), null);
    await fs.access(path.join(root, 'm.gguf')); // файл не тронут
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
