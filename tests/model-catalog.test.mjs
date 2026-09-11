import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModels } from '../src/model-catalog.mjs';

test('normalizeModels projects Pi models to a safe, sorted shape', () => {
  const models = normalizeModels([
    { provider: 'ollama', id: 'glm-5', name: 'GLM 5', contextWindow: 200000, maxTokens: 8000, reasoning: true, input: ['text'] },
    { provider: 'llamacpp', id: 'qwen', input: ['text', 'image'] },
    { provider: 'ollama', id: 'aaa' }
  ]);
  assert.deepEqual(models.map(m => `${m.provider}/${m.id}`), ['llamacpp/qwen', 'ollama/aaa', 'ollama/glm-5']);
  const glm = models.find(m => m.id === 'glm-5');
  assert.equal(glm.name, 'GLM 5');
  assert.equal(glm.contextWindow, 200000);
  assert.equal(glm.maxTokens, 8000);
  assert.equal(glm.reasoning, true);
  assert.equal(glm.images, false);
  const qwen = models.find(m => m.id === 'qwen');
  assert.equal(qwen.images, true);
  assert.equal(qwen.reasoning, false);
  assert.equal(qwen.contextWindow, null);
});

test('normalizeModels tolerates junk and never throws', () => {
  assert.deepEqual(normalizeModels(null), []);
  assert.deepEqual(normalizeModels([null, {}, { id: '' }, { provider: 'p' }]), []);
  assert.equal(normalizeModels([{ provider: 'p', id: 'x', input: 'image' }])[0].images, false);
});
