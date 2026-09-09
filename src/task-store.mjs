import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// node:sqlite ships with Node itself (no native build step). It was added in
// v22.5.0 and is usable without --experimental-sqlite since v22.13.0 / v23.4.0.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  throw new Error('TaskBridge requires Node.js 22.13 or newer: the built-in node:sqlite module is unavailable.');
}

const notFound = () => Object.assign(new Error('Session deleted'), { code: 'NOT_FOUND' });

// tasks keeps the whole task document as JSON: the HTTP layer already treats it
// as an opaque record, so the schema stays stable while fields evolve. events
// stores the full event JSON in payload for the same reason; only task_id/seq
// are projected into columns because they drive ordering and cursors.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks (created_at DESC);
CREATE TABLE IF NOT EXISTS events (
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
) WITHOUT ROWID;
`;

function readJsonSync(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

export class TaskStore {
  constructor(dataRoot) {
    this.root = path.join(dataRoot, 'tasks');
    this.dbPath = path.join(dataRoot, 'taskbridge.db');
    this.removed = new Set();
    this.fileWrites = new Map();
    fs.mkdirSync(this.root, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    // WAL keeps readers (SSE replay, list) from blocking the streaming writer.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    // A second TaskBridge instance (or a test fixture) must wait for the writer
    // instead of failing immediately with SQLITE_BUSY.
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.#importLegacy();
  }

  taskDir(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw Object.assign(new Error('Invalid session id'), { code: 'INPUT_INVALID' });
    }
    const target = path.resolve(this.root, id);
    if (!target.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Path escapes task store');
    return target;
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } finally { this.db = null; }
  }

  #meta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  #setMeta(key, value) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // One-time import of the pre-SQLite layout (data/tasks/<id>/task.json and
  // events.jsonl). The marker keeps deleted sessions from being resurrected by
  // the stale files still on disk after a later remove().
  #importLegacy() {
    if (this.#meta('file_store_imported')) return;
    const insertTask = this.db.prepare('INSERT OR IGNORE INTO tasks (id, created_at, updated_at, data) VALUES (?, ?, ?, ?)');
    const insertEvent = this.db.prepare('INSERT OR IGNORE INTO events (task_id, seq, payload) VALUES (?, ?, ?)');
    let entries = [];
    try { entries = fs.readdirSync(this.root, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
      const id = entry.name;
      const dir = path.join(this.root, id);
      const task = readJsonSync(path.join(dir, 'task.json'));
      if (task && typeof task === 'object') {
        const created = String(task.createdAt || '');
        insertTask.run(id, created, String(task.updatedAt || created), JSON.stringify({ ...task, id }));
      }
      let text = '';
      try { text = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'); } catch { /* no legacy events */ }
      let seq = 0;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        seq += 1;
        let event;
        try { event = JSON.parse(line); } catch { continue; } // torn tail line: skip but keep the counter
        seq = Math.max(seq, Number(event.seq) || 0);
        insertEvent.run(id, seq, JSON.stringify({ ...event, seq }));
      }
    }
    this.#setMeta('file_store_imported', new Date().toISOString());
  }

  #upsert(task) {
    const created = String(task.createdAt || new Date().toISOString());
    const updated = String(task.updatedAt || created);
    this.db.prepare(`
      INSERT INTO tasks (id, created_at, updated_at, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, updated_at = excluded.updated_at, data = excluded.data
    `).run(task.id, created, updated, JSON.stringify(task));
  }

  #nextSeq(id) {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE task_id = ?').get(id).seq);
  }

  // Allocate the next cursor and insert under one write transaction. BEGIN
  // IMMEDIATE takes the write lock up front, so a second process waits on
  // busy_timeout instead of racing MAX(seq) and colliding on the primary key.
  #appendRow(id, event) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const seq = this.#nextSeq(id);
      event.seq = seq; // callers emit the same object, which must carry its cursor
      this.db.prepare('INSERT INTO events (task_id, seq, payload) VALUES (?, ?, ?)').run(id, seq, JSON.stringify(event));
      this.db.exec('COMMIT');
      return seq;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already aborted */ }
      throw error;
    }
  }

  // Serializes file-backed artifact writes per task. Database writes are
  // synchronous, so call order already defines their order.
  #fileWrite(id, action) {
    if (this.removed.has(id)) return Promise.reject(notFound());
    const next = (this.fileWrites.get(id) || Promise.resolve()).then(action);
    const settled = next.catch(() => {});
    this.fileWrites.set(id, settled);
    settled.then(() => { if (this.fileWrites.get(id) === settled) this.fileWrites.delete(id); });
    return next;
  }

  async create(task) {
    if (this.removed.has(task.id)) throw notFound();
    const dir = this.taskDir(task.id);
    await fsp.mkdir(dir, { recursive: true });
    this.#upsert(task);
    return task;
  }

  async save(task) {
    if (this.removed.has(task.id)) throw notFound();
    const dir = this.taskDir(task.id);
    // Upsert before the first await so concurrent saves apply in call order.
    this.#upsert(task);
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    return task;
  }

  async appendEvent(id, event) {
    if (this.removed.has(id)) throw notFound();
    const dir = this.taskDir(id);
    this.#appendRow(id, event);
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    return event;
  }

  async appendRaw(id, name, content) {
    const dir = path.join(this.taskDir(id), 'artifacts');
    return this.#fileWrite(id, async () => {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.appendFile(path.join(dir, path.basename(name)), content, 'utf8');
    });
  }

  async writeArtifact(id, name, content) {
    const dir = path.join(this.taskDir(id), 'artifacts');
    return this.#fileWrite(id, async () => {
      await fsp.mkdir(dir, { recursive: true });
      const safe = path.basename(name);
      const target = path.join(dir, safe);
      await fsp.writeFile(target, content);
      return target;
    });
  }

  async remove(id) {
    const dir = this.taskDir(id);
    this.removed.add(id);
    await this.fileWrites.get(id);
    this.db.prepare('DELETE FROM events WHERE task_id = ?').run(id);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    await fsp.rm(dir, { recursive: true, force: true });
  }

  async read(id) {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id);
    if (!row) throw Object.assign(new Error(`Unknown session: ${id}`), { code: 'NOT_FOUND' });
    return JSON.parse(row.data);
  }

  async list() {
    return this.db.prepare('SELECT data FROM tasks ORDER BY created_at DESC').all().map(row => JSON.parse(row.data));
  }

  async readEvents(id, limit = 500, after = 0) {
    this.taskDir(id); // keep the id validation of the previous file store
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(after) || after < 0) {
      throw Object.assign(new Error('Invalid event cursor or limit'), { code: 'INPUT_INVALID' });
    }
    // Same contract as before: events after the cursor, then the last `limit`.
    const toEvent = row => ({ ...JSON.parse(row.payload), seq: Number(row.seq) });
    if (!limit) {
      return this.db.prepare('SELECT seq, payload FROM events WHERE task_id = ? AND seq > ? ORDER BY seq').all(id, after).map(toEvent);
    }
    const rows = this.db.prepare('SELECT seq, payload FROM events WHERE task_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?').all(id, after, limit);
    rows.reverse();
    return rows.map(toEvent);
  }
}
