import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

// Тесты не должны трогать данные за пределами своего временного корня.
//
// 2026-10-14: в архиве памяти оператора (~/.pi/memory-md) накопился 121 каталог
// `taskbridge-http-test-*` — сервер фикстуры писал туда предложения памяти, потому
// что каталог памяти по умолчанию лежит в домашнем каталоге. Теперь фикстура
// направляет его внутрь себя, и это проверяется здесь.

const DEFAULT_ROOT = path.join(os.homedir(), '.pi', 'memory-md');

async function dirNames(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch {
    return [];
  }
}

async function terminal(api, id, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (!['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'VERIFYING', 'CANCELLING'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('task stayed active');
}

test('the fixture keeps project memory inside its own root', { timeout: 60000 }, async t => {
  const before = await dirNames(DEFAULT_ROOT);
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const memory = await api('/api/projects/fixture/memory');
  assert.ok(memory.memoryDir, 'проект отвечает путём памяти');
  assert.ok(
    path.resolve(memory.memoryDir).startsWith(path.resolve(fixture.root)),
    `память проекта должна лежать внутри фикстуры: ${memory.memoryDir}`,
  );

  // Сессия до конца: именно её завершение писалo предложения памяти.
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'память проекта' });
  assert.equal((await terminal(api, task.id)).status, 'SUCCEEDED', fixture.logs());

  const after = await dirNames(DEFAULT_ROOT);
  assert.deepEqual(after, before, 'архив оператора не должен меняться от прогона тестов');
});
