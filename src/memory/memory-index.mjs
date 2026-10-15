// Индекс памяти проекта (этап M1 плана улучшений, §1.5).
//
// Файлы .md остаются единственным источником правды: индекс — перестраиваемый
// кэш для быстрого поиска и для метаданных использования (useCount, lastUsedAt).
// Если его удалить, следующий прогон соберёт его заново; ничего не теряется.
//
// Почему FTS5: раньше поиск обходил файлы и скорил вхождения вручную
// («startsWith-трюк»), а на сотнях заметок это и медленнее, и хуже по качеству.
// FTS5 в node:sqlite есть (проверено: `SELECT fts5_source_id()`, токенизатор
// unicode61 корректно режет кириллицу) — нативных зависимостей не добавляется.
//
// Инвалидация — по `mtime` + `size` при чтении каталога: файловая система
// сообщает свои метки, а fs-watcher на Windows и ненадёжен, и не нужен.

import path from 'node:path';
import fs from 'node:fs';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  throw new Error('TaskBridge requires Node.js 22.13 or newer: the built-in node:sqlite module is unavailable.');
}

export const INDEX_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  noteId TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  projectKey TEXT NOT NULL,
  category TEXT NOT NULL,
  relPath TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  -- Заметка, которую эта заменяет (frontmatter supersedes: путь): заменённое
  -- выпадает из инъекции, но остаётся в поиске с пометкой (этап M3).
  supersedes TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  mtimeMs REAL NOT NULL DEFAULT 0,
  sizeBytes INTEGER NOT NULL DEFAULT 0,
  contentHash TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT '',
  useCount INTEGER NOT NULL DEFAULT 0,
  lastUsedAt TEXT
);
CREATE INDEX IF NOT EXISTS notes_project ON notes (projectKey, scope);
-- Содержимое для поиска живёт отдельной FTS5-таблицей: строку проще удалить и
-- вставить заново, чем поддерживать синхронизацию contentless-таблицы.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  noteId UNINDEXED, description, tags, body, tokenize = 'unicode61'
);
CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Термы запроса: буквы и цифры (включая кириллицу), остальное — разделители. */
export function queryTerms(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(term => term.length >= 2)
    .slice(0, 12);
}

/**
 * Строка MATCH для FTS5. Термы кавычатся (иначе `a-b`, `AND`, `*` в запросе
 * оператора — это синтаксис FTS5 и ошибка вместо поиска) и получают префикс `*`:
 * «памя» должна находить «память», как это делал старый скоринг по startsWith.
 */
export function ftsQuery(text) {
  const terms = queryTerms(text);
  if (!terms.length) return null;
  return terms.map(term => `"${term.replaceAll('"', '""')}"*`).join(' OR ');
}

/** Заметка не менялась: те же метки файла — переиндексация не нужна. */
function unchanged(row, note) {
  if (!row) return false;
  return Number(row.mtimeMs) === Number(note.mtimeMs) && Number(row.sizeBytes) === Number(note.sizeBytes);
}

export class MemoryIndex {
  #db;

  constructor({ dbPath }) {
    if (!dbPath) throw new Error('MemoryIndex needs a dbPath');
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    // Индекс — кэш, поэтому смена схемы не миграция, а пересборка: старые таблицы
    // сносятся и создаются заново (версия лежит в memory_meta). Иначе добавленная
    // колонка ломала бы upsert на базе, оставшейся от прошлой сборки.
    this.#recreateIfStale();
    // Журнал по умолчанию (не WAL): WAL держит рядом файлы -shm/-wal, а на Windows
    // их открытые хендлы мешают удалить каталог данных (тесты и «удалить сессию»
    // спотыкались о EBUSY). Для кэша размером в сотни заметок WAL не нужен.
    this.#db.exec(SCHEMA);
    this.#db.prepare('INSERT INTO memory_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('indexVersion', String(INDEX_VERSION));
  }

  /**
   * Пересборка кэша при смене схемы. Порядок важен: версия читается ДО создания
   * таблиц (иначе IF NOT EXISTS оставит старую), а старая база иначе падала бы на
   * первой же записи из-за новой колонки.
   */
  #recreateIfStale() {
    this.#db.exec('CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const version = this.#db.prepare('SELECT value FROM memory_meta WHERE key = ?').get('indexVersion')?.value ?? null;
    if (version === null || String(version) === String(INDEX_VERSION)) return;
    // Первый вариант схемы хранил версию 1; всё остальное — тоже кэш, терять нечего.
    this.#db.exec('DROP TABLE IF EXISTS notes_fts');
    this.#db.exec('DROP TABLE IF EXISTS notes');
  }

  close() {
    try { this.#db.close(); } catch { /* уже закрыт */ }
  }

  /** Заметка не менялась: те же метки файла — переиндексация не нужна. */
  needsUpdate(noteId, { mtimeMs = 0, sizeBytes = 0 } = {}) {
    const row = this.#db.prepare('SELECT mtimeMs, sizeBytes FROM notes WHERE noteId = ?').get(String(noteId));
    return !unchanged(row, { mtimeMs, sizeBytes });
  }

  /**
   * Запись заметки. Возвращает 'unchanged' | 'inserted' | 'updated': вызывающий
   * (провайдер) по этому значению видит, понадобилась ли работа.
   */
  upsertNote(note = {}) {
    const noteId = String(note.noteId || '').trim();
    if (!noteId) throw new Error('upsertNote needs noteId');
    const row = this.#db.prepare('SELECT mtimeMs, sizeBytes FROM notes WHERE noteId = ?').get(noteId);
    if (unchanged(row, note)) return 'unchanged';
    const values = {
      noteId,
      scope: String(note.scope || 'project'),
      projectKey: String(note.projectKey || ''),
      category: String(note.category || 'other'),
      relPath: String(note.relPath || ''),
      description: String(note.description || ''),
      tags: String(note.tags || ''),
      supersedes: String(note.supersedes || ''),
      body: String(note.body || ''),
      mtimeMs: Number(note.mtimeMs || 0),
      sizeBytes: Number(note.sizeBytes || 0),
      contentHash: String(note.contentHash || ''),
      updatedAt: String(note.updatedAt || new Date().toISOString()),
    };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare(`
        INSERT INTO notes (noteId, scope, projectKey, category, relPath, description, tags, supersedes, body, mtimeMs, sizeBytes, contentHash, updatedAt)
        VALUES (:noteId, :scope, :projectKey, :category, :relPath, :description, :tags, :supersedes, :body, :mtimeMs, :sizeBytes, :contentHash, :updatedAt)
        ON CONFLICT(noteId) DO UPDATE SET
          scope = excluded.scope, projectKey = excluded.projectKey, category = excluded.category,
          relPath = excluded.relPath, description = excluded.description, tags = excluded.tags,
          supersedes = excluded.supersedes,
          body = excluded.body, mtimeMs = excluded.mtimeMs, sizeBytes = excluded.sizeBytes,
          contentHash = excluded.contentHash, updatedAt = excluded.updatedAt
      `).run(values);
      this.#db.prepare('DELETE FROM notes_fts WHERE noteId = ?').run(noteId);
      this.#db.prepare('INSERT INTO notes_fts (noteId, description, tags, body) VALUES (?, ?, ?, ?)')
        .run(noteId, values.description, values.tags, values.body);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return row ? 'updated' : 'inserted';
  }

  /** Файл исчез с диска: убираем и из индекса (индекс — отражение, не хранилище). */
  pruneMissing(projectKey, seenNoteIds = []) {
    const seen = new Set(seenNoteIds.map(String));
    const rows = this.#db.prepare('SELECT noteId FROM notes WHERE projectKey = ?').all(String(projectKey));
    let removed = 0;
    for (const row of rows) {
      if (seen.has(row.noteId)) continue;
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        this.#db.prepare('DELETE FROM notes WHERE noteId = ?').run(row.noteId);
        this.#db.prepare('DELETE FROM notes_fts WHERE noteId = ?').run(row.noteId);
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
      removed += 1;
    }
    return removed;
  }

  /**
   * Поиск. BM25 (меньше — лучше) плюс тай-брейкеры, чтобы порядок был
   * предсказуемым: категория (не `other` выше), свежесть, имя файла.
   */
  search(query, { projectKey = null, scope = null, limit = 8, includeSuperseded = false } = {}) {
    const match = ftsQuery(query);
    if (!match) return [];
    const where = [];
    const params = { match, limit: Math.max(1, Math.min(50, Number(limit) || 8)) };
    if (projectKey) { where.push('n.projectKey = :projectKey'); params.projectKey = String(projectKey); }
    if (scope) { where.push('n.scope = :scope'); params.scope = String(scope); }
    void includeSuperseded;
    const rows = this.#db.prepare(`
      SELECT n.noteId, n.scope, n.projectKey, n.category, n.relPath, n.description, n.tags,
             n.updatedAt, n.useCount, n.lastUsedAt, bm25(notes_fts) AS score
      FROM notes_fts
      JOIN notes n ON n.noteId = notes_fts.noteId
      WHERE notes_fts MATCH :match
      ${where.length ? `AND ${where.join(' AND ')}` : ''}
      ORDER BY score, CASE WHEN n.category = 'other' THEN 1 ELSE 0 END, n.updatedAt DESC, n.relPath
      LIMIT :limit
    `).all(params);
    return rows.map(row => ({ ...row, score: Number(row.score) }));
  }

  /** Заметка попала в выдачу или в инъекцию: основа для давности и консолидации. */
  markUsed(noteIds = [], at = new Date().toISOString()) {
    const ids = [...new Set(noteIds.map(String))];
    if (!ids.length) return 0;
    const statement = this.#db.prepare('UPDATE notes SET useCount = useCount + 1, lastUsedAt = ? WHERE noteId = ?');
    let updated = 0;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) updated += Number(statement.run(String(at), id).changes || 0);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return updated;
  }

  /**
   * Кто кого заменяет в этом скоупе: список путей-целей из `supersedes`.
   * Нужен, чтобы пометить заменённые заметки без чтения всего каталога (M3).
   */
  supersedesTargets(projectKey) {
    const rows = this.#db.prepare("SELECT supersedes FROM notes WHERE projectKey = ? AND supersedes <> ''").all(String(projectKey || ''));
    return rows.map(row => String(row.supersedes));
  }

  /** Использование заметок проекта: relPath → { useCount, lastUsedAt } (для ранжирования). */
  usage(projectKey) {
    const rows = this.#db.prepare('SELECT relPath, useCount, lastUsedAt, category FROM notes WHERE projectKey = ?').all(String(projectKey || ''));
    const map = new Map();
    for (const row of rows) map.set(row.relPath, { useCount: Number(row.useCount || 0), lastUsedAt: row.lastUsedAt ?? null, category: row.category });
    return map;
  }

  /** Метаданные для UI и метрик: сколько заметок, когда последний раз использовались. */
  stats({ projectKey = null } = {}) {
    const where = projectKey ? 'WHERE projectKey = ?' : '';
    const params = projectKey ? [String(projectKey)] : [];
    const totals = this.#db.prepare(`
      SELECT COUNT(*) AS notes, COALESCE(SUM(useCount), 0) AS uses, MAX(lastUsedAt) AS lastUsedAt,
             COALESCE(SUM(LENGTH(description) + LENGTH(tags) + LENGTH(body)), 0) AS chars
      FROM notes ${where}
    `).get(...params);
    return {
      notes: Number(totals.notes || 0),
      uses: Number(totals.uses || 0),
      lastUsedAt: totals.lastUsedAt ?? null,
      approxTokens: Math.ceil(Number(totals.chars || 0) / 4),
    };
  }

  /** Для тестов и диагностики: сколько строк реально в FTS-таблице. */
  indexedCount() {
    return Number(this.#db.prepare('SELECT COUNT(*) AS c FROM notes_fts').get().c || 0);
  }
}
