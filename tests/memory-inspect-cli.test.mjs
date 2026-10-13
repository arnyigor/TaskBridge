import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../src/task-store.mjs';

const exec = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// MEM-09: инспектор памяти в терминале. Проверяется не «скрипт запустился», а то,
// что оператор видит в выводе правду: живые записи, устаревшие (по объявленным
// путям, включая шаблоны), результаты поиска, очередь предложений и — главное —
// какие записи попадут в Resume задачи и почему.

test('the CLI inspector shows what the project remembers and what a resume would pick', { timeout: 120000 }, async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-cli-'));
  t.after(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try { await fs.rm(parent, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt >= 9 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  });
  const repo = path.join(parent, 'CliProject');
  await fs.mkdir(path.join(repo, 'src', 'deep'), { recursive: true });
  await exec('git', ['init', '-q'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'app.mjs'), 'export const app = 1;\n', 'utf8');
  await fs.writeFile(path.join(repo, 'src', 'deep', 'cursor.mjs'), 'export const cursor = 1;\n', 'utf8');

  const memoryRoot = path.join(parent, 'memory');
  const core = path.join(memoryRoot, 'CliProject', 'core', 'project');
  await fs.mkdir(core, { recursive: true });
  await fs.writeFile(path.join(core, 'cursor.md'), '---\ndescription: "Курсор"\ncategory: constraint\npaths: src/**/*.mjs\n---\nКурсор событий остаётся монотонным.\n', 'utf8');
  await fs.writeFile(path.join(core, 'dead.md'), '---\ndescription: "Старое"\npaths: src/gone/**/*.mjs\n---\nЧто-то про исчезнувший модуль.\n', 'utf8');
  // Очередь предложений: одно готово, одно заведомо не примут.
  const proposalsDir = path.join(memoryRoot, 'CliProject', '.memory-proposals');
  await fs.mkdir(proposalsDir, { recursive: true });
  await fs.writeFile(path.join(proposalsDir, 'mp-ok.md'), '---\nid: mp-ok\nstatus: proposed\ncreatedAt: 2026-10-12T10:00:00.000Z\ncategory: constraint\nreason: важно\n---\nПравило живое.\n', 'utf8');
  await fs.writeFile(path.join(proposalsDir, 'mp-bad.md'), '---\nid: mp-bad\nstatus: proposed\ncreatedAt: 2026-10-12T10:00:01.000Z\ncategory: architecture\npaths: src/vanished.mjs\n---\nПравило про исчезнувшее.\n', 'utf8');

  const dataRoot = path.join(parent, 'data');
  const store = new TaskStore(dataRoot);
  const now = new Date().toISOString();
  store.createWorkItem({
    // Формулировка задачи решает, что найдётся: выборка идёт по её словам.
    id: 'wi-cli', projectId: 'cli', title: 'Проверка инспектора', goal: 'Убедиться, что курсор событий описан в брифе',
    status: 'IN_PROGRESS', acceptanceCriteria: ['выдержки видны'], tags: [], priority: null,
    createdAt: now, updatedAt: now, completedAt: null,
  });
  await store.create({
    id: 'sess-1', createdAt: now, updatedAt: now, status: 'SUCCEEDED', projectId: 'cli',
    prompt: 'работали с курсором', files: [], git: { changedFiles: ['src/deep/cursor.mjs'] },
    compaction: { count: 0 }, assistantText: '', thinkingText: '',
  });
  store.linkWorkItemSession('wi-cli', 'sess-1', 'implementation');
  // Recap кладётся туда, где его ищет TaskBridge — через сам store, а не по
  // угаданному пути (иначе тест проверял бы свою же ошибку).
  const artifacts = path.join(store.taskDir('sess-1'), 'artifacts');
  store.close();
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'recap.json'), JSON.stringify({
    source: 'saved', updatedAt: now, objective: 'разобраться с курсором событий',
    accomplished: [], decisions: [], changedFiles: [], verification: [], remaining: ['проверить монотонность на устройстве'], blockers: [],
  }), 'utf8');

  await fs.writeFile(path.join(parent, 'config.json'), JSON.stringify({
    memory: { projectMemoryRoot: memoryRoot },
    projects: [{ id: 'cli', name: 'CliProject', path: repo, verification: [] }],
  }), 'utf8');

  const { stdout } = await exec(process.execPath, [
    'scripts/memory-inspect.mjs', '--project', 'cli', '--query', 'курсор', '--work-item', 'wi-cli', '--root', parent,
  ], { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024, windowsHide: true });

  assert.match(stdout, /Провайдер\s+: pi-memory-md · available · запись: SAVE_DISABLED/);
  assert.match(stdout, /записей 2 \(живых 1\)/);
  // Устаревшая запись названа вместе с причиной, живая — показана содержимым.
  assert.match(stdout, /Устаревшие записи[\s\S]*dead\.md — нет ни одного из: src\/gone\/\*\*\/\*\.mjs/);
  assert.match(stdout, /\[constraint\] core\/project\/cursor\.md/);
  assert.match(stdout, /Курсор событий остаётся монотонным\./);
  // Поиск: находится то, что живо, и не отдаётся то, что устарело.
  assert.match(stdout, /Поиск: курсор[\s\S]*core\/project\/cursor\.md/);
  assert.ok(!/Поиск: курсор[\s\S]*dead\.md/.test(stdout));
  // Очередь предложений: видно, какое примут, а какое нет — и почему.
  assert.match(stdout, /ожидают 2 · принято 0 · отклонено 0/);
  assert.match(stdout, /mp-ok \[constraint\] готова к принятию/);
  assert.match(stdout, /mp-bad \[architecture\] ПРИНЯТЬ НЕЛЬЗЯ: MISSING_PATHS/);
  // Resume: запросы строятся из задачи, выдержка объясняет своё попадание.
  assert.match(stdout, /Что попадёт в Resume задачи wi-cli/);
  assert.match(stdout, /Цель\s+: Убедиться, что курсор событий описан в брифе/);
  assert.match(stdout, /Связи\s+: sess-1 \(implementation\)/);
  assert.match(stdout, /проверить монотонность на устройстве/, 'remaining из recap попал в поисковые запросы');
  assert.match(stdout, /Выбрано\s+: 1 записей, ~\d+ токенов/);
  assert.match(stdout, /✓ core\/project\/cursor\.md — matched: /);
});
