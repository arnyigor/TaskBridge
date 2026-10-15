import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryIndex, ftsQuery, queryTerms } from '../src/memory/memory-index.mjs';

// Этап M1 плана (§1.5): FTS5-индекс вместо ручного скоринга по файлам. Индекс —
// кэш: удаление файла БД ничего не теряет, следующий прогон соберёт его заново.

async function index(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-memory-index-'));
  const db = new MemoryIndex({ dbPath: path.join(dir, 'memory-index.db') });
  t.after(async () => {
    db.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return db;
}

const note = (over = {}) => ({
  noteId: 'n1', scope: 'project', projectKey: 'taskbridge-1f86f591', category: 'decision',
  relPath: 'core/project/queue.md', description: 'Очередь сообщений', tags: 'очередь, доставка',
  body: 'Сообщение ждёт своей очереди, пока модель занята другим запросом.',
  mtimeMs: 1000, sizeBytes: 200, ...over,
});

test('cyrillic search finds a note by body, description and tags', async t => {
  const db = await index(t);
  db.upsertNote(note());
  db.upsertNote(note({ noteId: 'n2', relPath: 'core/project/ui.md', description: 'Кнопка STOP', tags: 'ui', body: 'Кнопка отмены живёт в композере.' }));

  assert.equal(db.search('очередь')[0].noteId, 'n1');
  assert.equal(db.search('доставка')[0].noteId, 'n1', 'теги тоже ищутся');
  assert.equal(db.search('кнопка')[0].noteId, 'n2');
  assert.equal(db.search('отмены')[0].noteId, 'n2', 'падеж ищется по основе слова');
  assert.deepEqual(db.search('ничего-подобного'), []);
});

test('a prefix finds the note, and operator punctuation cannot break the query', async t => {
  const db = await index(t);
  db.upsertNote(note());
  assert.equal(db.search('очер')[0].noteId, 'n1', 'старый скоринг искал по началу слова');
  // Скобки, кавычки, звёздочки и AND — синтаксис FTS5: запрос оператора не должен
  // приводить к ошибке вместо поиска.
  for (const query of ['очередь "доставка"', 'AND OR NOT', 'очередь*', '(очередь)', 'message-delivery']) {
    assert.doesNotThrow(() => db.search(query), `запрос «${query}» не должен падать`);
  }
  assert.equal(ftsQuery('a и'), null, 'однобуквенные термины не превращаются в запрос');
  assert.deepEqual(queryTerms('Очередь, доставка!'), ['очередь', 'доставка']);
});

test('invalidation is by mtime and size: an unchanged file is not reindexed', async t => {
  const db = await index(t);
  assert.equal(db.upsertNote(note()), 'inserted');
  assert.equal(db.upsertNote(note()), 'unchanged', 'те же метки — работы нет');
  assert.equal(db.upsertNote(note({ mtimeMs: 1001 })), 'updated');
  assert.equal(db.upsertNote(note({ mtimeMs: 1001, sizeBytes: 201 })), 'updated');
  // Тот же размер и время, но другое содержимое: метки — это контракт с вызывающим,
  // который читает файл; индекс не перечитывает диск сам.
  assert.equal(db.upsertNote(note({ mtimeMs: 1001, sizeBytes: 201, body: 'другое' })), 'unchanged');
  assert.equal(db.search('другое').length, 0, 'индекс не выдумывает содержимое');
});

test('a deleted file leaves the index, and scopes and projects do not mix', async t => {
  const db = await index(t);
  db.upsertNote(note());
  db.upsertNote(note({
    noteId: 'g1', scope: 'global', projectKey: 'global', relPath: '_global/decision/prefs.md',
    description: 'Предпочтения оператора', tags: 'стиль', body: 'Оператор предпочитает короткие ответы.',
  }));
  db.upsertNote(note({
    noteId: 'other', projectKey: 'blender-9a1b2c3d', relPath: 'core/проект.md',
    description: 'Порядок рендера', tags: 'рендер', body: 'Очередь рендера устроена иначе.',
  }));

  assert.equal(db.search('очередь').length, 2, 'поиск по всем проектам — режим cross-project');
  assert.equal(db.search('очередь', { projectKey: 'taskbridge-1f86f591' }).length, 1);
  assert.equal(db.search('ответы', { scope: 'global' })[0].noteId, 'g1', 'глобальный скоуп ищется отдельно');

  assert.equal(db.pruneMissing('taskbridge-1f86f591', ['n1']), 0, 'заметка на месте');
  assert.equal(db.pruneMissing('taskbridge-1f86f591', []), 1, 'файл исчез — строка уходит');
  assert.equal(db.indexedCount(), 2, 'и из FTS-таблицы тоже');
  assert.deepEqual(db.search('доставка'), [], 'исчезнувшее знание не находится');
});

test('usage counters are what decay and consolidation will stand on', async t => {
  const db = await index(t);
  db.upsertNote(note());
  assert.deepEqual({ notes: db.stats().notes, uses: db.stats().uses }, { notes: 1, uses: 0 });
  assert.equal(db.markUsed(['n1', 'n1', 'нет-такой'], '2026-10-14T00:00:00.000Z'), 1, 'отмечается один раз');
  const stats = db.stats();
  assert.equal(stats.uses, 1);
  assert.equal(stats.lastUsedAt, '2026-10-14T00:00:00.000Z');
  assert.ok(stats.approxTokens > 0);
  assert.equal(db.stats({ projectKey: 'чужой' }).notes, 0);
});

test('search over 500 notes stays inside the plan budget (best of 5 < 5 ms)', async t => {
  const db = await index(t);
  const words = ['очередь', 'доставка', 'модель', 'событие', 'кнопка', 'память', 'индекс', 'контекст'];
  for (let i = 0; i < 500; i++) {
    db.upsertNote(note({
      noteId: `bulk-${i}`,
      relPath: `core/project/note-${i}.md`,
      description: `Заметка ${i} про ${words[i % words.length]}`,
      tags: `${words[(i + 3) % words.length]}, ${words[(i + 5) % words.length]}`,
      body: `Тело заметки ${i}: ${Array.from({ length: 40 }, (_, k) => words[(i + k) % words.length]).join(' ')}.`,
      mtimeMs: 2000 + i,
      sizeBytes: 500 + i,
    }));
  }
  assert.equal(db.indexedCount(), 500);

  const timings = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const started = performance.now();
    const hits = db.search('очередь доставка', { limit: 8 });
    timings.push(performance.now() - started);
    assert.ok(hits.length > 0);
  }
  const best = Math.min(...timings);
  assert.ok(best < 5, `лучший поиск по 500 заметкам: ${best.toFixed(2)} мс (${timings.map(x => x.toFixed(1)).join('/')})`);
});

test('an existing database is reused, not rebuilt (the index is a cache)', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-memory-index-reuse-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const dbPath = path.join(dir, 'memory-index.db');
  const first = new MemoryIndex({ dbPath });
  first.upsertNote(note());
  first.close();
  const second = new MemoryIndex({ dbPath });
  t.after(() => second.close());
  assert.equal(second.indexedCount(), 1, 'индекс переживает перезапуск');
  assert.equal(second.upsertNote(note()), 'unchanged', 'и не переиндексирует то же самое');
});

test('an old schema is rebuilt, not migrated (the index is a cache)', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-memory-index-stale-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const dbPath = path.join(dir, 'memory-index.db');
  // База «прошлой сборки»: схема без колонки supersedes и с версией 1.
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec('CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  old.exec('CREATE TABLE notes (noteId TEXT PRIMARY KEY, scope TEXT, projectKey TEXT, category TEXT, relPath TEXT, description TEXT, tags TEXT, body TEXT, mtimeMs REAL, sizeBytes INTEGER, contentHash TEXT, updatedAt TEXT, useCount INTEGER DEFAULT 0, lastUsedAt TEXT)');
  old.prepare('INSERT INTO memory_meta(key, value) VALUES (?, ?)').run('indexVersion', '1');
  old.prepare('INSERT INTO notes(noteId, scope, projectKey, category, relPath, description, tags, body, mtimeMs, sizeBytes) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('старый:note', 'project', 'p', 'other', 'core/project/old.md', 'старое', '', 'тело', 1, 1);
  old.close();

  // Открытие новой сборкой: старая база сносится, новая принимает записи с supersedes.
  const db = new MemoryIndex({ dbPath });
  t.after(() => db.close());
  assert.equal(db.indexedCount(), 0, 'старые строки не переносятся');
  assert.equal(db.upsertNote(note({ supersedes: 'core/project/old.md' })), 'inserted');
  assert.deepEqual(db.supersedesTargets('taskbridge-1f86f591'), ['core/project/old.md']);
  assert.equal(db.search('очередь').length, 1, 'поиск работает после пересборки');
});
