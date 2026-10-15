import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { TaskStore } from '../src/task-store.mjs';

// Этап M2 плана: память становится видимой — поиск по индексу со скоупами,
// инспектор с использованием записей и бюджетом, и факт инъекции в ленте сессии.

async function writeNotes(root, projectDir, notes) {
  const dir = path.join(root, 'memory-md', projectDir, 'core', 'project');
  await fs.mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(notes)) await fs.writeFile(path.join(dir, name), body, 'utf8');
}

test('memory search answers per scope and refuses an empty query', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, root } = fixture;

  // Проект фикстуры называется по basename своего временного корня.
  const projectName = path.basename(root);
  await writeNotes(root, projectName, {
    'queue.md': '---\ndescription: Очередь сообщений\n---\nСообщение ждёт очереди, пока модель занята.\n',
  });
  await fs.mkdir(path.join(root, 'memory-md', '_global', 'decision'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'memory-md', '_global', 'decision', 'prefs.md'),
    '---\ndescription: Предпочтения оператора\n---\nНикогда не запускай длинные команды без вывода: оператор считает это зависанием.\n',
    'utf8',
  );

  const all = await api('/api/memory/search?q=очередь&scope=all&projectId=fixture');
  assert.equal(all.scope, 'all');
  assert.ok(all.hits.length >= 1, JSON.stringify(all.hits));
  assert.equal(all.counts.project, all.hits.filter(hit => hit.scope === 'project').length);

  const global = await api('/api/memory/search?q=зависанием&scope=global');
  assert.equal(global.hits.length, 1, JSON.stringify(global.hits.map(hit => hit.source)));
  assert.equal(global.hits[0].scope, 'global');
  assert.match(global.hits[0].text, /длинные команды/);

  // Пустой запрос — это ошибка ввода, а не «вся память»: иначе один клик
  // показывал бы сотни заметок как «результат поиска».
  await assert.rejects(api('/api/memory/search?q=&scope=all'), { code: 'INPUT_INVALID' });
  await assert.rejects(api('/api/memory/search?q=очередь&scope=чепуха'), { code: 'INPUT_INVALID' });
});

test('the inspector carries indexed usage, budget and global counts', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, root } = fixture;
  const projectName = path.basename(root);
  await writeNotes(root, projectName, {
    'queue.md': '---\ndescription: Очередь сообщений\n---\nСообщение ждёт очереди.\n',
    'ui.md': '---\ndescription: Кнопка STOP\n---\nКнопка отмены всегда доступна.\n',
  });
  await fs.mkdir(path.join(root, 'memory-md', '_global'), { recursive: true });
  await fs.writeFile(path.join(root, 'memory-md', '_global', 'prefs.md'), '---\ndescription: Предпочтения\n---\nКороткие ответы.\n', 'utf8');

  const memory = await api('/api/projects/fixture/memory');
  assert.equal(memory.status, 'available');
  assert.equal(memory.notes.length, 2, JSON.stringify(memory.notes));
  for (const note of memory.notes) {
    assert.ok('useCount' in note && 'lastUsedAt' in note, `использование не отдано: ${JSON.stringify(note)}`);
    assert.ok(note.category);
    assert.ok(note.updatedAt);
  }
  assert.equal(memory.budget.indexTokens, 2000, 'бюджет из конфига');
  assert.equal(memory.budget.globalTokens, 400);
  assert.equal(typeof memory.budget.overBudget, 'boolean');
  assert.equal(memory.global.entries, 1, 'глобальные заметки посчитаны отдельно');
  assert.ok(memory.global.approxTokens > 0);

  // Поиск в инспекторе остаётся прежним (rich hits) — его не ломаем.
  const searched = await api('/api/projects/fixture/memory?q=очередь');
  assert.equal(searched.hits.length, 1);
  assert.equal(searched.hits[0].source, 'core/project/queue.md');
  assert.match(searched.hits[0].text, /ждёт очереди/);
});

test('the proposals queue is visible across projects, with the project named', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, root } = fixture;
  const projectName = path.basename(root);
  await fs.mkdir(path.join(root, 'memory-md', projectName, 'core', 'project'), { recursive: true });

  // Очередь по всем проектам пуста — это тоже ответ, а не ошибка.
  const empty = await api('/api/memory/proposals');
  assert.deepEqual(empty.proposals, []);
  assert.equal(empty.counts.pending, 0);

  // Предложение создатся тем же гейтом, что и раньше.
  const created = await api('/api/projects/fixture/memory/proposals', {
    text: 'Очередь сообщений проверяется тестом до релиза',
    category: 'pattern',
    reason: 'оператор просил видеть очередь',
  });
  assert.ok(created.id || created.proposal?.id, JSON.stringify(created));

  const all = await api('/api/memory/proposals');
  assert.equal(all.proposals.length, 1, JSON.stringify(all.proposals));
  assert.equal(all.proposals[0].projectId, 'fixture', 'видно, чей это проект');
  assert.equal(all.counts.pending, 1);

  const narrowed = await api('/api/memory/proposals?projectId=fixture');
  assert.equal(narrowed.proposals.length, 1);
  await assert.rejects(api('/api/memory/proposals?projectId=нет-такого'), { code: 'PROJECT_NOT_FOUND' });
});

test('memory metrics are visible in /api/metrics (M3)', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, root } = fixture;
  const projectName = path.basename(root);
  const dir = path.join(root, 'memory-md', projectName, 'core', 'project');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'queue.md'), '---\ndescription: Очередь\n---\nСообщения ждут очереди.\n', 'utf8');

  // Инспектор и поиск — это запросы к памяти: после них метрики обязаны быть.
  await api('/api/projects/fixture/memory');
  await api('/api/projects/fixture/memory?q=очередь');
  await api('/api/memory/search?q=очередь&scope=all&projectId=fixture');
  await api('/api/projects/fixture/memory/proposals', { text: 'Проверять очередь тестом', category: 'pattern' });

  const metrics = await api('/api/metrics');
  assert.ok(metrics.memory, 'секция memory в /api/metrics');
  assert.ok(metrics.memory.searches >= 2, `запросы к памяти посчитаны: ${JSON.stringify(metrics.memory)}`);
  assert.ok(metrics.memory.search_ms_max >= 0, 'задержка поиска измеряется');
  // Показания-датчики снимаются при обращении к памяти: после создания предложения
  // инспектор нужно прочитать ещё раз, иначе в метриках останется старое значение.
  await api('/api/projects/fixture/memory');
  const after = await api('/api/metrics');
  assert.equal(after.memory.notes_total, 1, `число заметок памяти: ${JSON.stringify(after.memory)}`);
  assert.equal(after.memory.proposals_pending, 1, `предложения, ждущие человека: ${JSON.stringify(after.memory)}`);
});

test('the consolidator offers merge candidates and only proposes (M3)', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, root } = fixture;
  const name = path.basename(root);
  const dir = path.join(root, 'memory-md', name, 'core', 'project');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'queue-1.md'), '---\ndescription: Очередь сообщений\n---\nСообщение ждёт своей очереди, пока модель занята другим запросом. Курсор двигается после подтверждения.\n', 'utf8');
  await fs.writeFile(path.join(dir, 'queue-2.md'), '---\ndescription: Очередь сообщений\n---\nСообщение ждёт очереди, пока модель занята другим запросом. Курсор меняется после подтверждения.\n', 'utf8');
  await fs.writeFile(path.join(dir, 'render.md'), '---\ndescription: Рендер\n---\nBlender собирает сцену отдельным процессом, текстуры пекутся в своей папке.\n', 'utf8');

  const view = await api('/api/projects/fixture/memory/consolidation');
  assert.equal(view.action, 'propose', 'консолидатор ничего не меняет сам');
  assert.equal(view.notes, 3);
  assert.equal(view.candidates.length, 1, JSON.stringify(view.candidates));
  const pair = view.candidates[0];
  assert.deepEqual(pair.notes.map(note => note.source).sort(), ['core/project/queue-1.md', 'core/project/queue-2.md']);
  assert.ok(pair.score > 0.5);

  // Оформление предложением: пара становится предложением, память не меняется.
  const created = await api('/api/projects/fixture/memory/consolidation', { first: 'core/project/queue-1.md', second: 'core/project/queue-2.md' });
  assert.ok(created.id || created.proposal?.id, JSON.stringify(created));
  const repeated = await api('/api/projects/fixture/memory/consolidation', { first: 'core/project/queue-2.md', second: 'core/project/queue-1.md' });
  assert.equal(repeated.existing, true, 'повтор той же пары возвращает pending-предложение, а не создаёт дубль');
  const proposals = await api('/api/projects/fixture/memory/proposals');
  assert.equal(proposals.proposals.length, 1, 'предложение создано, но не принято и не задублировано');
  assert.equal(proposals.counts.pending, 1);

  // Непохожие заметки предложением не оформляются: это была бы правка ради правки.
  await assert.rejects(
    api('/api/projects/fixture/memory/consolidation', { first: 'core/project/queue-1.md', second: 'core/project/render.md' }),
    { code: 'NOT_SIMILAR' },
  );
  await assert.rejects(api('/api/projects/fixture/memory/consolidation', { first: 'core/project/queue-1.md' }), { code: 'INPUT_INVALID' });
});

test('scheduled memory consolidator creates proposals once and never edits core memory', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-memory-scheduler-'));
  const store = new TaskStore(root);
  const manager = new TaskManager({
    memory: { projectMemoryRoot: path.join(root, 'memory-md'), consolidation: { enabled: false, maxProposalsPerRun: 5, maxProposalsPerProject: 2 } },
    localRuntime: {},
    projects: [{ id: 'fixture', name: 'Fixture', path: root, useWorktree: false }],
  }, root, store);
  t.after(async () => { await manager.close(); store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const projectDir = path.basename(root);
  const dir = path.join(root, 'memory-md', projectDir, 'core', 'project');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'queue-1.md'), '---\ndescription: Очередь сообщений\n---\nСообщение ждёт своей очереди, пока модель занята другим запросом. Курсор двигается после подтверждения.\n', 'utf8');
  await fs.writeFile(path.join(dir, 'queue-2.md'), '---\ndescription: Очередь сообщений\n---\nСообщение ждёт очереди, пока модель занята другим запросом. Курсор меняется после подтверждения.\n', 'utf8');

  const first = await manager.runMemoryConsolidationSchedule();
  assert.equal(first.projects, 1);
  assert.equal(first.proposals, 1, JSON.stringify(first));
  const second = await manager.runMemoryConsolidationSchedule();
  assert.equal(second.proposals, 0, JSON.stringify(second));
  assert.equal(second.existing, 1, 'повторный scheduler видит pending-предложение и не плодит дубль');

  const proposals = await manager.listMemoryProposals('fixture');
  assert.equal(proposals.proposals.length, 1);
  assert.equal(proposals.proposals[0].status, 'proposed');
  const coreFiles = await fs.readdir(dir);
  assert.deepEqual(coreFiles.sort(), ['queue-1.md', 'queue-2.md'], 'core память не редактируется scheduler-ом');
});
