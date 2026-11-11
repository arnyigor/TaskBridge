import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskModelFromCatalog } from '../src/task-manager.mjs';

// Регрессия 2026-11-11: модель задачи обогащалась каталогом только при «свежем»
// кэше (peek() живёт TTL), поэтому у идущей сессии в базе оставалась голая
// provider/id, и выбор уровней размышлений показывал один «None». Теперь
// вызывающий передаёт каталог, а TTL решает вызывающая сторона (lastKnown()).
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const catalog = {
  models: [
    { provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: true, thinkingLevels: levels, contextWindow: 1000000, maxTokens: 384000 },
    { provider: 'strata', id: 'qwen3.8-flash-next-iq3_s', reasoning: false, thinkingLevels: ['off'] },
  ],
};

test('модель из каталога получает reasoning и уровни размышлений', () => {
  const model = taskModelFromCatalog({ provider: 'deepseek', id: 'deepseek-flash' }, catalog);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevels, levels);
  assert.equal(model.contextWindow, 1000000, 'окно по-прежнему из каталога');
});

test('окно и лимит задачи перебивают каталожные', () => {
  const model = taskModelFromCatalog({ provider: 'deepseek', id: 'deepseek-flash', contextWindow: 256000, maxTokens: 8000 }, catalog);
  assert.equal(model.contextWindow, 256000);
  assert.equal(model.maxTokens, 8000);
});

test('модель без размышлений честно остаётся с одним уровнем', () => {
  const model = taskModelFromCatalog({ provider: 'strata', id: 'qwen3.8-flash-next-iq3_s' }, catalog);
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.thinkingLevels, ['off']);
});

test('модели нет в каталоге — остаётся голая запись, без выдуманных уровней', () => {
  const model = taskModelFromCatalog({ provider: 'nowhere', id: 'ghost' }, catalog);
  assert.deepEqual(model, { id: 'ghost', provider: 'nowhere', contextWindow: null, maxTokens: null });
});

test('пустой каталог и пустая модель не ломают вызов', () => {
  assert.equal(taskModelFromCatalog(null, catalog), null);
  assert.equal(taskModelFromCatalog({}, catalog), null);
  assert.deepEqual(taskModelFromCatalog({ id: 'x' }, null), { id: 'x', provider: null, contextWindow: null, maxTokens: null });
});
