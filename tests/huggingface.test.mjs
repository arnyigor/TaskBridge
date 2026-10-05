import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGgufTree, quantFromFilename, HuggingFaceService } from '../src/huggingface.mjs';

const GB = 1e9;

function entry(path, sizeGb) {
  return { path, lfs: { size: Math.round(sizeGb * GB) } };
}

test('analyzeGgufTree groups quant variants, merges shards and detects projectors', () => {
  const analyzed = analyzeGgufTree([
    { path: 'README.md', size: 500 },
    { path: 'tokenizer.json', size: 7000 },
    entry('Model-Q2_K.gguf', 9.8),
    entry('Model-Q3_K_S.gguf', 13.4),
    entry('Model-Q4_K_M.gguf', 17.6),
    entry('Model-Q3_K_XL-00001-of-00002.gguf', 8.6),
    entry('Model-Q3_K_XL-00002-of-00002.gguf', 8.7),
    entry('mmproj-f16.gguf', 1.1)
  ]);

  const quants = analyzed.variants.map(v => v.quant);
  assert.deepEqual(quants, ['Q2_K', 'Q3_K_S', 'Q3_K_XL', 'Q4_K_M']); // по возрастанию размера
  const shards = analyzed.variants.find(v => v.quant === 'Q3_K_XL');
  assert.equal(shards.files.length, 2);
  assert.equal(shards.shards, 2);
  assert.equal(shards.complete, true);
  assert.ok(Math.abs(shards.totalBytes - 17.3 * GB) < GB);

  // Неполный набор шардов качать нельзя — вариант помечается incomplete.
  const broken = analyzeGgufTree([entry('M-Q4_K_M-00001-of-00003.gguf', 6)]);
  assert.equal(broken.variants[0].complete, false);

  assert.equal(analyzed.projectors.length, 1);
  assert.equal(analyzed.projectors[0].path, 'mmproj-f16.gguf');
  assert.equal(analyzed.other.length, 2); // README + tokenizer
});

test('quantFromFilename recognizes llama.cpp quants including imatrix suffixes', () => {
  assert.equal(quantFromFilename('Qwen3.8-27B-Q3_K_XL.gguf'), 'Q3_K_XL');
  assert.equal(quantFromFilename('Qwen3.8-27B-UD-IQ1_S.gguf'), 'IQ1_S');
  assert.equal(quantFromFilename('model-Q4_K_M-00001-of-00002.gguf'), 'Q4_K_M');
  assert.equal(quantFromFilename('weights-F16.gguf'), 'F16');
  assert.equal(quantFromFilename('model.gguf'), null);
  assert.equal(quantFromFilename(''), null);
});

test('plan takes sizes from the tree and rejects unknown paths', () => {
  const tree = [entry('a.gguf', 1), entry('b.gguf', 2)];
  const service = new HuggingFaceService({});
  const plan = service.plan(tree, ['a.gguf', 'b.gguf']);
  assert.equal(plan.totalBytes, 3 * GB);
  assert.deepEqual(plan.files.map(f => f.path), ['a.gguf', 'b.gguf']);
  assert.equal(service.plan(tree, ['missing.gguf']), null);
  assert.equal(service.plan(tree, []), null);
});
