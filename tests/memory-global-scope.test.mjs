import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiMemoryMdProvider } from '../src/memory/project-memory-provider.mjs';

// MEM-05A/05B: глобальные заметки — это ХРАНИЛИЩЕ, а не выдача.
//
// Что было сломано до этих тестов:
//   * `globalEntries({limit: 0})` возвращал пустой список, и TaskManager считал
//     по нему «сколько глобальных заметок доступно» — всегда 0;
//   * `searchScope(scope: 'global')` смотрел только первые 200 файлов каталога
//     в алфавитном порядке, поэтому 201-я заметка не находилась вообще.
//
// Каталог памяти здесь синтетический: реальный `~/.pi/memory-md` не читается.

async function memoryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-global-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
  return root;
}

async function writeNotes(dir, count, body) {
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const name = `${String(i).padStart(4, '0')}.md`;
    await fs.writeFile(path.join(dir, name), `---\ndescription: Заметка ${i}\n---\n${body(i)}\n`, 'utf8');
  }
}

function provider(root, t) {
  const p = new PiMemoryMdProvider({ root, indexPath: path.join(root, 'index', 'memory-index.db') });
  t.after(() => p.closeIndex());
  return p;
}

const project = { id: 'p', name: 'taskbridge-1f86f591', path: null };

test('the 201st and the 1000th global note are found, not just the first 200 files', { timeout: 120000 }, async t => {
  const root = await memoryRoot(t);
  await writeNotes(path.join(root, '_global', 'project'), 1000, i => (i === 200 ? 'уникумсигнал на двухсотой' : i === 999 ? 'уникумсигнал на тысячной' : `рядовое содержимое ${i}`));
  const p = provider(root, t);

  const hits = await p.searchScope('уникумсигнал', { scope: 'global', limit: 20 });
  const sources = hits.map(hit => hit.source).sort();
  assert.deepEqual(sources, ['_global/project/0200.md', '_global/project/0999.md'], `201-я и 1000-я заметки обязаны находиться: ${sources}`);

  // Старый путь (первые 200 файлов) их не видел — это и был дефект.
  const firstTwoHundred = await p.globalEntries({ limit: 200 });
  assert.equal(firstTwoHundred.some(entry => entry.source === '_global/project/0999.md'), false);
});

test('the count of stored global notes does not depend on the page size', { timeout: 120000 }, async t => {
  const root = await memoryRoot(t);
  await writeNotes(path.join(root, '_global', 'project'), 1000, i => `содержимое ${i}`);
  const p = provider(root, t);

  const stats = await p.globalStats();
  assert.equal(stats.stored, 1000, 'счётчик хранилища считается без чтения содержимого');
  assert.equal(stats.indexed, null, 'пока индекс не открыт, indexed честно null');

  const page = await p.searchScopePage('содержимое', { scope: 'global', limit: 20 });
  assert.equal(page.total, 1000, 'total — все совпадения, а не размер страницы');
  assert.equal(page.hits.length, 20);
  assert.equal(page.counts.globalTotal, 1000);
  assert.equal((await p.globalStats()).indexed, 1000, 'после поиска индекс знает все заметки');
});

test('pages are disjoint, ordered the same way and cover every match', { timeout: 120000 }, async t => {
  const root = await memoryRoot(t);
  await writeNotes(path.join(root, '_global', 'project'), 60, i => `общий маркер ${i}`);
  const p = provider(root, t);

  const first = await p.searchScopePage('маркер', { scope: 'global', limit: 25 });
  const second = await p.searchScopePage('маркер', { scope: 'global', limit: 25, offset: 25 });
  const third = await p.searchScopePage('маркер', { scope: 'global', limit: 25, offset: 50 });

  assert.equal(first.total, 60);
  assert.equal(first.hits.length, 25);
  assert.equal(second.hits.length, 25);
  assert.equal(third.hits.length, 10, 'последняя страница короче, но непустая');

  const seen = new Set();
  for (const hit of [...first.hits, ...second.hits, ...third.hits]) {
    assert.equal(seen.has(hit.source), false, `страницы не пересекаются: ${hit.source}`);
    seen.add(hit.source);
  }
  assert.equal(seen.size, 60, 'сумма страниц покрывает все совпадения');

  const again = await p.searchScopePage('маркер', { scope: 'global', limit: 25 });
  assert.deepEqual(again.hits.map(hit => hit.source), first.hits.map(hit => hit.source), 'порядок стабилен между вызовами');
});

test('a global note with a project-only leak attempt stays out of the global scope', { timeout: 60000 }, async t => {
  const root = await memoryRoot(t);
  await writeNotes(path.join(root, '_global', 'project'), 3, i => `маркеризоляции ${i}`);
  const dir = path.join(root, 'taskbridge-1f86f591', 'core', 'project');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'own.md'), '---\ndescription: Заметка проекта\n---\nмаркеризоляции проектное\n', 'utf8');
  const p = provider(root, t);

  const global = await p.searchScope('маркеризоляции', { scope: 'global', limit: 20 });
  assert.deepEqual(global.map(hit => hit.scope), ['global', 'global', 'global']);
  assert.equal(global.some(hit => String(hit.source).startsWith('core/')), false);

  const own = await p.searchScope('маркеризоляции', { scope: 'project', project, limit: 20 });
  assert.equal(own.every(hit => hit.scope === 'project'), true, JSON.stringify(own.map(hit => hit.scope)));
  assert.equal(own.some(hit => String(hit.source).startsWith('_global/')), false);

  const stats = await p.globalStats();
  assert.equal(stats.stored, 3, 'проектная заметка не попала в глобальный счётчик');
});

test('deep project/all pages cover every eligible match without foreign-project leaks', async t => {
  const root = await memoryRoot(t);
  await writeNotes(path.join(root, project.name, 'core', 'project'), 80, i => `deepmarker own ${i}`);
  await writeNotes(path.join(root, '_global', 'project'), 70, i => `deepmarker global ${i}`);
  await writeNotes(path.join(root, 'foreign', 'core', 'project'), 10, i => `deepmarker foreign ${i}`);
  const p = provider(root, t);
  const deepProject = await p.searchScopePage('deepmarker', { scope: 'project', project, limit: 20, offset: 60 });
  assert.equal(deepProject.hits.length, 20);
  assert.equal(deepProject.total, 80);
  const seen = new Set();
  for (const offset of [0, 50, 100]) {
    const page = await p.searchScopePage('deepmarker', { scope: 'all', project, limit: 50, offset });
    assert.equal(page.total, 150);
    assert.equal(page.hits.length, 50);
    assert.ok(page.hits.every(hit => !hit.text.includes('foreign')));
    for (const hit of page.hits) {
      const key = `${hit.scope}:${hit.source}`;
      assert.equal(seen.has(key), false, key);
      seen.add(key);
    }
  }
  assert.equal(seen.size, 150);
});

test('totals and page boundaries are calculated after stale filtering and deduplication', async t => {
  const root = await memoryRoot(t);
  const dir = path.join(root, '_global');
  await fs.mkdir(dir);
  for (const name of ['duplicate-a', 'duplicate-b']) {
    await fs.writeFile(path.join(dir, `${name}.md`), '---\ndescription: countmarker\n---\ncountmarker duplicate\n');
  }
  await fs.writeFile(path.join(dir, 'unique.md'), '---\ndescription: countmarker\n---\ncountmarker unique\n');
  await fs.writeFile(path.join(dir, 'stale.md'), '---\ndescription: countmarker\npaths: [missing-fixture-file]\n---\ncountmarker stale\n');
  const p = provider(root, t);
  const first = await p.searchScopePage('countmarker', { scope: 'global', limit: 1 });
  const second = await p.searchScopePage('countmarker', { scope: 'global', limit: 1, offset: 1 });
  assert.equal(first.total, 2);
  assert.equal(second.total, 2);
  assert.equal(first.hits.length, 1);
  assert.equal(second.hits.length, 1);
  assert.notEqual(first.hits[0].text, second.hits[0].text);
  assert.equal((await p.searchScopePage('countmarker', { scope: 'global', offset: 2 })).hits.length, 0);
  p.closeIndex(); p.indexPath = null;
  const fallback = await p.searchScopePage('countmarker', { scope: 'global', limit: 1, offset: 1 });
  assert.equal(fallback.total, 2);
  assert.equal(fallback.hits.length, 1);
  assert.equal(fallback.source, 'files');
});

test('a big global store does not grow the injected context', { timeout: 120000 }, async t => {
  const root = await memoryRoot(t);
  await writeNotes(path.join(root, '_global', 'project'), 1000, i => `правило оператора про длинные команды и очередь ${i}`);
  const dir = path.join(root, 'taskbridge-1f86f591', 'core', 'project');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'queue.md'), '---\ndescription: Очередь\n---\nОчередь сообщений ждёт подтверждения.\n', 'utf8');
  const p = provider(root, t);

  const result = await p.relevant(project, { queries: ['очередь подтверждение'], budgetTokens: 2000, globalBudgetTokens: 400, limit: 8 });
  const injectedGlobal = result.hits.filter(hit => hit.scope === 'global');
  assert.ok(result.globalTokens <= 400, `бюджет инъекции не растёт вместе с хранилищем: ${result.globalTokens}`);
  // Потолок инъекции — число кандидатов на запрос (12), а не размер хранилища.
  assert.ok(injectedGlobal.length <= 12, `в контекст идут единицы, а не тысячи: ${injectedGlobal.length}`);

  // Жёсткий мини-бюджет: ничего глобального не влезает, это видно и это не удаляет заметки.
  const tight = await p.relevant(project, { queries: ['очередь подтверждение'], budgetTokens: 2000, globalBudgetTokens: 1, limit: 8 });
  assert.equal(tight.hits.filter(hit => hit.scope === 'global').length, 0);
  assert.ok(tight.overflow, 'отброшенное по бюджету видно в overflow');

  // Отброшенное по бюджету остаётся доступным поиском — это и есть смысл разделения.
  const found = await p.searchScopePage('правило оператора', { scope: 'global', limit: 5 });
  assert.equal(found.total, 1000);
});
