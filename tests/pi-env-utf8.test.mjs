// PYTHONUTF8 в env запуска Pi: сессии порождали Python-потомков, которые под
// Windows писали кириллицу в cp1251, и tool-логи декодировались в U+FFFD.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('#piEnv sets PYTHONUTF8=1 and respects an explicit config value', async () => {
  // #piEnv приватен; проверяем через shape-заглушку, повторяющую логику?
  // Нет — честнее вызвать через инстанс нельзя без тяжёлых зависимостей, поэтому
  // фиксируем контракт на минимальном фасаде: та же функция-логика вынесена в
  // task-manager как приватный метод, здесь проверяем инвариант интеграции,
  // читая исходник на наличие дефолта ПОСЛЕ копирования config.pi.env.
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/task-manager.mjs', import.meta.url), 'utf8');
  const m = src.match(/#piEnv\(launch = null\) \{[\s\S]*?\n  \}/);
  assert.ok(m, '#piEnv найден');
  const body = m[0];
  const copyIdx = body.indexOf('...(this.config.pi?.env || {})');
  const utf8Idx = body.indexOf("!env.PYTHONUTF8");
  assert.ok(utf8Idx > copyIdx, 'PYTHONUTF8 задаётся после копирования config.pi.env (явное значение приоритетно)');
  assert.match(body, /env\.PYTHONUTF8 = '1'/);
});
