import crypto from 'node:crypto';
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
CREATE TABLE IF NOT EXISTS commands (
  command_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  at INTEGER NOT NULL,
  client_id TEXT,
  status TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS runs_task ON runs (task_id, started_at DESC);
CREATE TABLE IF NOT EXISTS project_view_preferences (
  project_id TEXT PRIMARY KEY,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
-- Work Items (MR-02): the semantic state of the work, not a container for
-- everything else. A prompt, a chat history, a diff, tool output or a
-- resumeContext do NOT belong here (see docs/api-contract.md); the session that
-- did the work is linked in work_item_sessions (MR-03).
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT,
  status TEXT NOT NULL,
  priority INTEGER,
  acceptance_json TEXT,
  tags_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS work_items_project ON work_items (project_id, status);
-- One work item is done over several INDEPENDENT sessions (MR-03). This is a
-- different hierarchy from runs, which belong to a single session: a work item
-- groups sessions, a session groups runs. Rows disappear with either side.
CREATE TABLE IF NOT EXISTS work_item_sessions (
  work_item_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'implementation',
  created_at TEXT NOT NULL,
  PRIMARY KEY (work_item_id, session_id)
);
CREATE INDEX IF NOT EXISTS work_item_sessions_session ON work_item_sessions (session_id);
-- Run recipes (MR-05): HOW to do a recurring piece of work — parameters, runtime,
-- context, workspace, verification. WHEN it runs is a schedule (MR-06) and the fact
-- that it ran is an invocation, so nothing about a concrete run lives here.
CREATE TABLE IF NOT EXISTS run_recipes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  work_item_id TEXT,
  name TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  parameters_json TEXT,
  runtime_json TEXT,
  context_json TEXT,
  workspace_json TEXT,
  verification_json TEXT,
  limits_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_recipes_project ON run_recipes (project_id, updated_at DESC);
-- Schedules (MR-06): WHEN a recipe runs. The fact that it ran is an INVOCATION, and
-- an invocation creates a session — which in turn has its own runs. The hierarchy is
-- Schedule → Invocation → Session → Run(s); mixing them would be two truths about
-- the same thing (see ROADMAP_FULL.md, «Отдельный scheduled_runs не нужен»).
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  spec_json TEXT NOT NULL,
  misfire_policy TEXT NOT NULL,
  concurrency_policy TEXT NOT NULL,
  notify TEXT NOT NULL,
  approval_mode TEXT NOT NULL,
  parameters_json TEXT,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules (enabled, next_run_at);
CREATE TABLE IF NOT EXISTS invocations (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL,
  schedule_id TEXT,
  trigger TEXT NOT NULL,
  scheduled_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  misfire INTEGER NOT NULL DEFAULT 0,
  parameters_json TEXT,
  session_id TEXT,
  verification TEXT,
  workspace_ref TEXT,
  result_artifact TEXT
);
CREATE INDEX IF NOT EXISTS invocations_recipe ON invocations (recipe_id, started_at DESC);
CREATE INDEX IF NOT EXISTS invocations_schedule ON invocations (schedule_id, started_at DESC);
CREATE INDEX IF NOT EXISTS invocations_running ON invocations (status, schedule_id);
`;

function readJsonSync(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

export class TaskStore {
  constructor(dataRoot, options = {}) {
    this.root = path.join(dataRoot, 'tasks');
    this.dbPath = path.join(dataRoot, 'taskbridge.db');
    this.removed = new Set();
    this.fileWrites = new Map();
    // NORMAL is the default WAL trade-off; FULL costs a sync per commit but
    // survives a power loss without losing the last transaction.
    const synchronous = String(options.synchronous || 'NORMAL').toUpperCase();
    this.synchronous = ['NORMAL', 'FULL'].includes(synchronous) ? synchronous : 'NORMAL';
    this.busyTimeoutMs = Number.isSafeInteger(options.busyTimeoutMs)
      ? Math.min(Math.max(options.busyTimeoutMs, 0), 60000)
      : 5000;
    fs.mkdirSync(this.root, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    // WAL keeps readers (SSE replay, list) from blocking the streaming writer.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`PRAGMA synchronous = ${this.synchronous};`);
    // A second TaskBridge instance (or a test fixture) must wait for the writer
    // instead of failing immediately with SQLITE_BUSY.
    this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
    // Enforce task/event integrity; must be set outside any transaction.
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.#ensureCommandColumns();
    this.#migrateSchema();
    this.#importLegacy();
    this.storeId = this.#ensureStoreId();
  }

  // A random id of this database's history (plan invariant I10). `seq` restarts
  // when the database is recreated or restored from a backup, and a client that
  // cached `lastSeq = 1284` would then silently wait for events that never come.
  // Comparing storeId tells it to drop its cache instead.
  #ensureStoreId() {
    const existing = this.#meta('store_id');
    if (existing) return existing;
    const id = crypto.randomUUID();
    this.#setMeta('store_id', id);
    return id;
  }

  // user_version 0 is either a fresh database or one created before events had a
  // foreign key. Rebuild the table once, dropping rows whose task is gone.
  #migrateSchema() {
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version || 0);
    if (version >= 1) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE events_new (
          task_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (task_id, seq),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) WITHOUT ROWID
      `);
      this.db.exec('INSERT INTO events_new (task_id, seq, payload) SELECT task_id, seq, payload FROM events WHERE task_id IN (SELECT id FROM tasks)');
      this.db.exec('DROP TABLE events');
      this.db.exec('ALTER TABLE events_new RENAME TO events');
      this.db.exec('PRAGMA user_version = 1');
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already aborted */ }
      throw error;
    }
  }

  taskDir(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw Object.assign(new Error('Invalid session id'), { code: 'INPUT_INVALID' });
    }
    const target = path.resolve(this.root, id);
    if (!target.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Path escapes task store');
    return target;
  }

  // Durable commandId ledger (TZ stage 3): lets a retry after a process
  // restart replay the saved result instead of silently running a second time.
  getCommand(commandId) {
    const row = this.db.prepare('SELECT command_id, payload_hash AS hash, done, result, at, client_id AS clientId, status FROM commands WHERE command_id = ?').get(String(commandId));
    if (!row) return null;
    return { hash: row.hash, done: row.done === 1, result: row.result ? JSON.parse(row.result) : null, at: Number(row.at), clientId: row.clientId || null, status: row.status || null };
  }

  upsertCommand(commandId, { hash, done, result = null, at = Date.now(), clientId = null, status = null }) {
    this.db.prepare(`INSERT INTO commands (command_id, payload_hash, done, result, at, client_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(command_id) DO UPDATE SET
        payload_hash=excluded.payload_hash, done=excluded.done, result=excluded.result,
        at=excluded.at, client_id=excluded.client_id, status=excluded.status`)
      .run(String(commandId), String(hash), done ? 1 : 0, result == null ? null : JSON.stringify(result), at, clientId ? String(clientId) : null, status ? String(status) : null);
  }


  // Drops resolved ledger rows older than `olderThanMs` so the table stays
  // small; in-flight (done=0) rows are kept: they mark a possible crash.
  pruneCommands(olderThanMs) {
    const cutoff = Date.now() - olderThanMs;
    // Relay receipts outlive the recent-id cache and offline clients. Pruning
    // them would let an old commandId execute again after the local cache TTL.
    this.db.prepare("DELETE FROM commands WHERE done = 1 AND at < ? AND command_id NOT GLOB 'cloud-dispatch:*'").run(cutoff);
  }

  // Run ledger (TZ stage 2): one prompt/repair/retry turn, with its own status
  // and timing, kept next to the task without changing execution.
  recordRun(run) {
    this.db.prepare(`INSERT INTO runs (id, task_id, session_id, kind, status, started_at, finished_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, finished_at=excluded.finished_at, data=excluded.data
      WHERE runs.task_id = excluded.task_id AND runs.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`)
      .run(String(run.id), String(run.taskId), run.sessionId ?? null, String(run.kind || 'prompt'), String(run.status || 'RUNNING'),
        String(run.startedAt || new Date().toISOString()), run.finishedAt ?? null, run.data == null ? null : JSON.stringify(run.data));
  }

  getRun(id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(String(id));
    return row ? this.#runRow(row) : null;
  }

  interruptRuns(finishedAt) {
    // No process from the preceding server instance can still own these runs.
    // An interrupted run says nothing about whether its external effects landed.
    return this.db.prepare(`UPDATE runs SET status = 'FAILED', finished_at = ?,
      data = json_patch(COALESCE(data, '{}'), json_object('errorCode', 'UNKNOWN_AFTER_CRASH'))
      WHERE status = 'RUNNING'`).run(finishedAt).changes;
  }

  listRuns(taskId, limit = 50) {
    const rows = this.db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?').all(String(taskId), Math.max(1, Number(limit) || 50));
    return rows.map((row) => this.#runRow(row));
  }

  #runRow(row) {
    return {
      id: row.id, taskId: row.task_id, sessionId: row.session_id, kind: row.kind, status: row.status,
      startedAt: row.started_at, finishedAt: row.finished_at, data: row.data ? JSON.parse(row.data) : null,
    };
  }

  // Adds client_id/status to the commands table for databases created before
  // the status contract existed. Idempotent via PRAGMA table_info.
  #ensureCommandColumns() {
    try {
      const cols = new Set(this.db.prepare('PRAGMA table_info(commands)').all().map((r) => r.name));
      if (!cols.has('client_id')) this.db.exec('ALTER TABLE commands ADD COLUMN client_id TEXT');
      if (!cols.has('status')) this.db.exec('ALTER TABLE commands ADD COLUMN status TEXT');
    } catch { /* table may not exist yet on a broken/fresh db; SCHEMA recreates it */ }
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } finally { this.db = null; }
  }

  // Reclaims space freed by pruning/trimming. VACUUM needs exclusive access, so
  // callers only do this at startup before any task is admitted.
  async vacuum() {
    this.db.exec('VACUUM');
  }

  // Consistent snapshot while the server keeps running (VACUUM INTO). The target
  // must not exist, so callers use a unique file name.
  async backup(target) {
    const file = path.resolve(target);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    this.db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    // A backup is a different history from the moment it is taken: once it is
    // restored, the live database has moved on and its seq values no longer
    // match. Give the copy its own storeId so clients notice the restore.
    const copy = new DatabaseSync(file);
    try {
      copy.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('store_id', crypto.randomUUID());
    } finally { copy.close(); }
    return file;
  }

  async checkpoint() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  #meta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  #setMeta(key, value) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // Public meta access for components that need durable cursors outside the
  // task document itself (cloud event sequence, processed command ids).
  getMeta(key) {
    return this.#meta(String(key));
  }

  setMeta(key, value) {
    this.#setMeta(String(key), String(value));
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
      // Events cannot exist without their task row once the foreign key is on.
      if (!task || typeof task !== 'object') continue;
      const created = String(task.createdAt || '');
      insertTask.run(id, created, String(task.updatedAt || created), JSON.stringify({ ...task, id }));
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

  #appendRowAt(id, seq, event) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      event.seq = seq;
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

  // A terminal event and the task snapshot it describes must survive or roll
  // back together. External runtime effects remain outside SQLite transactions.
  async appendEventWithTask(id, event, task, run = null) {
    if (this.removed.has(id)) throw notFound();
    const dir = this.taskDir(id);
    if (task.id !== id || (run && run.taskId !== id)) throw new Error('Task/event/run identity mismatch');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      event.seq = this.#nextSeq(id);
      this.db.prepare('INSERT INTO events (task_id, seq, payload) VALUES (?, ?, ?)').run(id, event.seq, JSON.stringify(event));
      this.#upsert({ ...task, snapshotSeq: event.seq });
      if (run) this.recordRun(run);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    return event;
  }

  // The highest cursor ever allocated for a task; needed by callers that rewrite
  // history and must keep the event sequence monotonic (see #truncateFrom).
  async maxSeq(id) {
    this.taskDir(id);
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE task_id = ?').get(id).seq);
  }

  // Append at an explicit cursor. Only history rewrites use this: after a
  // truncation the rows above the cut are gone, so "MAX(seq) + 1" would hand
  // back a seq a live client has already seen and silently drop the event.
  async appendEventAt(id, seq, event) {
    if (this.removed.has(id)) throw notFound();
    if (!Number.isSafeInteger(seq) || seq < 1) throw Object.assign(new Error('Invalid event cursor'), { code: 'INPUT_INVALID' });
    const dir = this.taskDir(id);
    this.#appendRowAt(id, seq, event);
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    return event;
  }

  // Rewrite the payload of one existing event, keeping its cursor. Used when the
  // operator edits a message that must keep its identity (same event, same seq,
  // corrected text) — deleting and re-adding it would change its id.
  async updateEventData(id, seq, patch) {
    this.taskDir(id);
    const row = this.db.prepare('SELECT payload FROM events WHERE task_id = ? AND seq = ?').get(id, seq);
    if (!row) throw notFound();
    const event = { ...JSON.parse(row.payload), ...patch };
    this.db.prepare('UPDATE events SET payload = ? WHERE task_id = ? AND seq = ?').run(JSON.stringify(event), id, seq);
    return event;
  }

  // "Repeat message": permanently drops the last failed exchange from the
  // replayed history (everything from the last user message on) so the same
  // prompt can be resent without a visible duplicate.
  async truncateEvents(id, fromSeq) {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) {
      throw Object.assign(new Error('Invalid event cursor'), { code: 'INPUT_INVALID' });
    }
    this.db.prepare('DELETE FROM events WHERE task_id = ? AND seq >= ?').run(id, fromSeq);
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
    // The events foreign key cascades from the task row in one transaction.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already aborted */ }
      throw error;
    }
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

  // Event count per task, in one cheap GROUP BY (the primary key starts with
  // task_id). Used by the sessions list to show and sort by size without a
  // per-task query.
  eventCounts() {
    const rows = this.db.prepare('SELECT task_id, COUNT(*) AS n FROM events GROUP BY task_id').all();
    return new Map(rows.map(row => [String(row.task_id), Number(row.n)]));
  }

  // --- project view preferences (MR-01) --------------------------------------
  // Only what the operator changed about the view: the project registry in
  // config.json stays the source of truth for names, paths and worktrees, so
  // nothing is duplicated here. A row outlives a removed registration: bringing
  // the project back must not silently drop its pin.

  /** `projectId -> { pinned, archived, updatedAt }` for every project ever pinned or archived. */
  projectViewPreferences() {
    const rows = this.db.prepare('SELECT project_id, pinned, archived, updated_at FROM project_view_preferences').all();
    return new Map(rows.map(row => [String(row.project_id), {
      pinned: Number(row.pinned) === 1,
      archived: Number(row.archived) === 1,
      updatedAt: row.updated_at,
    }]));
  }

  /**
   * Merges a patch (a field left out keeps its stored value) and returns the
   * result, so a PATCH of one flag cannot clear the other.
   */
  setProjectViewPreferences(projectId, patch = {}) {
    const id = String(projectId);
    const current = this.projectViewPreferences().get(id);
    const next = {
      pinned: patch.pinned === undefined ? current?.pinned === true : patch.pinned === true,
      archived: patch.archived === undefined ? current?.archived === true : patch.archived === true,
    };
    const updatedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO project_view_preferences (project_id, pinned, archived, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        pinned=excluded.pinned, archived=excluded.archived, updated_at=excluded.updated_at`)
      .run(id, next.pinned ? 1 : 0, next.archived ? 1 : 0, updatedAt);
    return { ...next, updatedAt };
  }

  // --- work items (MR-02) ---------------------------------------------------

  /** One work item, as it is stored (arrays live in JSON columns). */
  #workItemRow(row) {
    if (!row) return null;
    const list = (json) => {
      if (!json) return [];
      try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : [];
      } catch { return []; }
    };
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      goal: row.goal ?? null,
      status: row.status,
      priority: row.priority === null || row.priority === undefined ? null : Number(row.priority),
      acceptanceCriteria: list(row.acceptance_json),
      tags: list(row.tags_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? null,
    };
  }

  /** Newest first; `projectId` narrows to one project. */
  listWorkItems(projectId = null) {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM work_items WHERE project_id = ? ORDER BY updated_at DESC').all(String(projectId))
      : this.db.prepare('SELECT * FROM work_items ORDER BY updated_at DESC').all();
    return rows.map(row => this.#workItemRow(row));
  }

  getWorkItem(id) {
    return this.#workItemRow(this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(String(id)));
  }

  createWorkItem(item) {
    this.db.prepare(`INSERT INTO work_items
      (id, project_id, title, goal, status, priority, acceptance_json, tags_json, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      item.id, item.projectId, item.title, item.goal ?? null, item.status, item.priority ?? null,
      JSON.stringify(item.acceptanceCriteria ?? []), JSON.stringify(item.tags ?? []),
      item.createdAt, item.updatedAt, item.completedAt ?? null,
    );
    return this.getWorkItem(item.id);
  }

  /** Writes the given fields; `undefined` leaves the stored value alone. */
  updateWorkItem(id, fields = {}) {
    const current = this.getWorkItem(id);
    if (!current) return null;
    const next = {
      title: fields.title === undefined ? current.title : fields.title,
      goal: fields.goal === undefined ? current.goal : fields.goal,
      status: fields.status === undefined ? current.status : fields.status,
      priority: fields.priority === undefined ? current.priority : fields.priority,
      acceptanceCriteria: fields.acceptanceCriteria === undefined ? current.acceptanceCriteria : fields.acceptanceCriteria,
      tags: fields.tags === undefined ? current.tags : fields.tags,
      updatedAt: fields.updatedAt ?? new Date().toISOString(),
      // DONE stamps the moment once; leaving DONE clears it again.
      completedAt: fields.completedAt === undefined
        ? (fields.status === undefined ? current.completedAt : (fields.status === 'DONE' ? (current.completedAt ?? fields.updatedAt ?? new Date().toISOString()) : null))
        : fields.completedAt,
    };
    this.db.prepare(`UPDATE work_items SET title=?, goal=?, status=?, priority=?, acceptance_json=?, tags_json=?, updated_at=?, completed_at=? WHERE id=?`).run(
      next.title, next.goal ?? null, next.status, next.priority ?? null,
      JSON.stringify(next.acceptanceCriteria ?? []), JSON.stringify(next.tags ?? []),
      next.updatedAt, next.completedAt ?? null, String(id),
    );
    return this.getWorkItem(id);
  }

  deleteWorkItem(id) {
    const current = this.getWorkItem(id);
    if (!current) return null;
    this.db.prepare('DELETE FROM work_items WHERE id = ?').run(String(id));
    return current;
  }

  // --- run recipes (MR-05) ---------------------------------------------------

  #recipeRow(row) {
    if (!row) return null;
    const parse = (json) => {
      if (!json) return null;
      try { return JSON.parse(json); } catch { return null; }
    };
    // Пустые `context`/`workspace`/`limits` не отдаём: рецепт их не применяет
    // (AUTO-01A), а `{}` в ответе читался бы как «настройка есть, но пустая».
    // Непустые значения из старых записей возвращаются как есть — молча терять
    // данные оператора нельзя.
    const present = (json) => {
      const value = parse(json);
      return value && typeof value === 'object' && Object.keys(value).length ? value : null;
    };
    const context = present(row.context_json);
    const workspace = present(row.workspace_json);
    const limits = present(row.limits_json);
    return {
      id: row.id,
      projectId: row.project_id,
      workItemId: row.work_item_id ?? null,
      name: row.name,
      promptTemplate: row.prompt_template,
      parameters: parse(row.parameters_json) ?? {},
      runtime: parse(row.runtime_json) ?? {},
      ...(context ? { context } : {}),
      ...(workspace ? { workspace } : {}),
      verification: parse(row.verification_json) ?? {},
      ...(limits ? { limits } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listRecipes(projectId = null) {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM run_recipes WHERE project_id = ? ORDER BY updated_at DESC').all(String(projectId))
      : this.db.prepare('SELECT * FROM run_recipes ORDER BY updated_at DESC').all();
    return rows.map(row => this.#recipeRow(row));
  }

  getRecipe(id) {
    return this.#recipeRow(this.db.prepare('SELECT * FROM run_recipes WHERE id = ?').get(String(id)));
  }

  createRecipe(recipe) {
    this.db.prepare(`INSERT INTO run_recipes
      (id, project_id, work_item_id, name, prompt_template, parameters_json, runtime_json, context_json, workspace_json, verification_json, limits_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      recipe.id, recipe.projectId, recipe.workItemId ?? null, recipe.name, recipe.promptTemplate,
      JSON.stringify(recipe.parameters ?? {}), JSON.stringify(recipe.runtime ?? {}), JSON.stringify(recipe.context ?? {}),
      JSON.stringify(recipe.workspace ?? {}), JSON.stringify(recipe.verification ?? {}), JSON.stringify(recipe.limits ?? {}),
      recipe.createdAt, recipe.updatedAt,
    );
    return this.getRecipe(recipe.id);
  }

  updateRecipe(id, recipe) {
    const current = this.getRecipe(id);
    if (!current) return null;
    const next = { ...current, ...recipe, id: current.id, createdAt: current.createdAt };
    this.db.prepare(`UPDATE run_recipes SET project_id=?, work_item_id=?, name=?, prompt_template=?,
      parameters_json=?, runtime_json=?, context_json=?, workspace_json=?, verification_json=?, limits_json=?, updated_at=?
      WHERE id=?`).run(
      next.projectId, next.workItemId ?? null, next.name, next.promptTemplate,
      JSON.stringify(next.parameters ?? {}), JSON.stringify(next.runtime ?? {}), JSON.stringify(next.context ?? {}),
      JSON.stringify(next.workspace ?? {}), JSON.stringify(next.verification ?? {}), JSON.stringify(next.limits ?? {}),
      next.updatedAt, String(id),
    );
    return this.getRecipe(id);
  }

  deleteRecipe(id) {
    const current = this.getRecipe(id);
    if (!current) return null;
    this.db.prepare('DELETE FROM run_recipes WHERE id = ?').run(String(id));
    return current;
  }

  // --- schedules and invocations (MR-06) -------------------------------------

  #scheduleRow(row) {
    if (!row) return null;
    const parse = (json, fallback) => {
      if (!json) return fallback;
      try { return JSON.parse(json); } catch { return fallback; }
    };
    return {
      id: row.id,
      recipeId: row.recipe_id,
      enabled: Number(row.enabled) === 1,
      spec: parse(row.spec_json, {}),
      misfirePolicy: row.misfire_policy,
      concurrencyPolicy: row.concurrency_policy,
      notify: row.notify,
      approvalMode: row.approval_mode,
      parameters: parse(row.parameters_json, {}),
      nextRunAt: row.next_run_at ?? null,
      lastRunAt: row.last_run_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listSchedules(recipeId = null) {
    const rows = recipeId
      ? this.db.prepare('SELECT * FROM schedules WHERE recipe_id = ? ORDER BY created_at DESC').all(String(recipeId))
      : this.db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all();
    return rows.map(row => this.#scheduleRow(row));
  }

  /** Enabled schedules whose moment has come — what the tick asks for. */
  dueSchedules(nowIso) {
    return this.db.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at')
      .all(String(nowIso)).map(row => this.#scheduleRow(row));
  }

  getSchedule(id) {
    return this.#scheduleRow(this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(String(id)));
  }

  createSchedule(schedule) {
    this.db.prepare(`INSERT INTO schedules
      (id, recipe_id, enabled, spec_json, misfire_policy, concurrency_policy, notify, approval_mode, parameters_json, next_run_at, last_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      schedule.id, schedule.recipeId, schedule.enabled ? 1 : 0, JSON.stringify(schedule.spec ?? {}),
      schedule.misfirePolicy, schedule.concurrencyPolicy, schedule.notify, schedule.approvalMode,
      JSON.stringify(schedule.parameters ?? {}), schedule.nextRunAt ?? null, schedule.lastRunAt ?? null,
      schedule.createdAt, schedule.updatedAt,
    );
    return this.getSchedule(schedule.id);
  }

  updateSchedule(id, schedule) {
    const current = this.getSchedule(id);
    if (!current) return null;
    const next = { ...current, ...schedule, id: current.id, createdAt: current.createdAt };
    this.db.prepare(`UPDATE schedules SET recipe_id=?, enabled=?, spec_json=?, misfire_policy=?, concurrency_policy=?,
      notify=?, approval_mode=?, parameters_json=?, next_run_at=?, last_run_at=?, updated_at=? WHERE id=?`).run(
      next.recipeId, next.enabled ? 1 : 0, JSON.stringify(next.spec ?? {}), next.misfirePolicy, next.concurrencyPolicy,
      next.notify, next.approvalMode, JSON.stringify(next.parameters ?? {}), next.nextRunAt ?? null, next.lastRunAt ?? null,
      next.updatedAt, String(id),
    );
    return this.getSchedule(id);
  }

  deleteSchedule(id) {
    const current = this.getSchedule(id);
    if (!current) return null;
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(String(id));
    return current;
  }

  #invocationRow(row) {
    if (!row) return null;
    const parse = (json) => {
      if (!json) return {};
      try { return JSON.parse(json); } catch { return {}; }
    };
    return {
      id: row.id,
      recipeId: row.recipe_id,
      scheduleId: row.schedule_id ?? null,
      trigger: row.trigger,
      scheduledAt: row.scheduled_at ?? null,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? null,
      status: row.status,
      reason: row.reason ?? null,
      misfire: Number(row.misfire) === 1,
      parameters: parse(row.parameters_json),
      sessionId: row.session_id ?? null,
      verification: row.verification ?? null,
      workspaceRef: row.workspace_ref ?? null,
      resultArtifact: row.result_artifact ?? null,
    };
  }

  createInvocation(invocation) {
    this.db.prepare(`INSERT INTO invocations
      (id, recipe_id, schedule_id, trigger, scheduled_at, started_at, finished_at, status, reason, misfire, parameters_json, session_id, verification, workspace_ref, result_artifact)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      invocation.id, invocation.recipeId, invocation.scheduleId ?? null, invocation.trigger,
      invocation.scheduledAt ?? null, invocation.startedAt, invocation.finishedAt ?? null, invocation.status,
      invocation.reason ?? null, invocation.misfire ? 1 : 0, JSON.stringify(invocation.parameters ?? {}),
      invocation.sessionId ?? null, invocation.verification ?? null, invocation.workspaceRef ?? null, invocation.resultArtifact ?? null,
    );
    return this.getInvocation(invocation.id);
  }

  /** Writes the given fields; `undefined` leaves the stored value alone. */
  updateInvocation(id, fields = {}) {
    const current = this.getInvocation(id);
    if (!current) return null;
    const next = {
      finishedAt: fields.finishedAt === undefined ? current.finishedAt : fields.finishedAt,
      status: fields.status === undefined ? current.status : fields.status,
      reason: fields.reason === undefined ? current.reason : fields.reason,
      sessionId: fields.sessionId === undefined ? current.sessionId : fields.sessionId,
      verification: fields.verification === undefined ? current.verification : fields.verification,
      workspaceRef: fields.workspaceRef === undefined ? current.workspaceRef : fields.workspaceRef,
      resultArtifact: fields.resultArtifact === undefined ? current.resultArtifact : fields.resultArtifact,
    };
    this.db.prepare(`UPDATE invocations SET finished_at=?, status=?, reason=?, session_id=?, verification=?, workspace_ref=?, result_artifact=? WHERE id=?`).run(
      next.finishedAt ?? null, next.status, next.reason ?? null, next.sessionId ?? null,
      next.verification ?? null, next.workspaceRef ?? null, next.resultArtifact ?? null, String(id),
    );
    return this.getInvocation(id);
  }

  getInvocation(id) {
    return this.#invocationRow(this.db.prepare('SELECT * FROM invocations WHERE id = ?').get(String(id)));
  }

  listInvocations({ recipeId = null, scheduleId = null, status = null, limit = 50 } = {}) {
    const clauses = [];
    const values = [];
    if (recipeId) { clauses.push('recipe_id = ?'); values.push(String(recipeId)); }
    if (scheduleId) { clauses.push('schedule_id = ?'); values.push(String(scheduleId)); }
    if (status) { clauses.push('status = ?'); values.push(String(status).toUpperCase()); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM invocations${where} ORDER BY started_at DESC LIMIT ?`)
      .all(...values, Math.min(Math.max(Number(limit) || 50, 1), 500));
    return rows.map(row => this.#invocationRow(row));
  }

  /** Invocations still marked RUNNING for a schedule — what «уже идёт» means. */
  runningInvocations(scheduleId = null) {
    const rows = scheduleId
      ? this.db.prepare("SELECT * FROM invocations WHERE status = 'RUNNING' AND schedule_id = ?").all(String(scheduleId))
      : this.db.prepare("SELECT * FROM invocations WHERE status = 'RUNNING'").all();
    return rows.map(row => this.#invocationRow(row));
  }

  // --- work item ↔ sessions (MR-03) -----------------------------------------

  /** Links a session to a work item. Linking twice is not an error: it updates the relation. */
  linkWorkItemSession(workItemId, sessionId, relation) {
    this.db.prepare(`INSERT INTO work_item_sessions (work_item_id, session_id, relation, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(work_item_id, session_id) DO UPDATE SET relation=excluded.relation`).run(
      String(workItemId), String(sessionId), String(relation), new Date().toISOString(),
    );
    return this.#sessionLinkRow(
      this.db.prepare('SELECT * FROM work_item_sessions WHERE work_item_id = ? AND session_id = ?')
        .get(String(workItemId), String(sessionId)),
    );
  }

  #sessionLinkRow(row) {
    if (!row) return null;
    return { workItemId: row.work_item_id, sessionId: row.session_id, relation: row.relation, createdAt: row.created_at };
  }

  /** Sessions of one work item, newest link first. */
  workItemSessions(workItemId) {
    return this.db.prepare('SELECT * FROM work_item_sessions WHERE work_item_id = ? ORDER BY created_at DESC')
      .all(String(workItemId)).map(row => this.#sessionLinkRow(row));
  }

  /** Work items a session belongs to (a session may serve more than one). */
  workItemsOfSession(sessionId) {
    return this.db.prepare('SELECT * FROM work_item_sessions WHERE session_id = ? ORDER BY created_at DESC')
      .all(String(sessionId)).map(row => this.#sessionLinkRow(row));
  }

  unlinkWorkItemSession(workItemId, sessionId) {
    const existing = this.db.prepare('SELECT * FROM work_item_sessions WHERE work_item_id = ? AND session_id = ?').get(String(workItemId), String(sessionId));
    if (!existing) return null;
    this.db.prepare('DELETE FROM work_item_sessions WHERE work_item_id = ? AND session_id = ?').run(String(workItemId), String(sessionId));
    return this.#sessionLinkRow(existing);
  }

  /** Drops every link of a work item — used when the work item itself goes. */
  removeWorkItemLinks(workItemId) {
    return this.db.prepare('DELETE FROM work_item_sessions WHERE work_item_id = ?').run(String(workItemId)).changes;
  }

  /**
   * Drops every link of a session — used when the session is deleted, so no work
   * item points at a session nobody can open.
   */
  removeSessionLinks(sessionId) {
    return this.db.prepare('DELETE FROM work_item_sessions WHERE session_id = ?').run(String(sessionId)).changes;
  }

  /**
   * How much work each project has open, for the dashboard: the whole count and
   * the items that still need doing (everything except DONE and CANCELLED).
   */
  workItemCounts() {
    const rows = this.db.prepare("SELECT project_id, COUNT(*) AS n, SUM(CASE WHEN status NOT IN ('DONE','CANCELLED') THEN 1 ELSE 0 END) AS open FROM work_items GROUP BY project_id").all();
    return new Map(rows.map(row => [String(row.project_id), { total: Number(row.n), open: Number(row.open) }]));
  }

  // `before` bounds the read from above (seq < before): paginated history walks
  // DOWN from the live tail, so a page must be the newest events BELOW the
  // cursor — reading "the last `limit` events of the session" like before would
  // make anything older than the newest slice unreachable, and a long session
  // could never page back past it.
  async readEvents(id, limit = 500, after = 0, before = null) {
    this.taskDir(id); // keep the id validation of the previous file store
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(after) || after < 0) {
      throw Object.assign(new Error('Invalid event cursor or limit'), { code: 'INPUT_INVALID' });
    }
    if (before != null && (!Number.isSafeInteger(before) || before < 0)) {
      throw Object.assign(new Error('Invalid event cursor'), { code: 'INPUT_INVALID' });
    }
    // Same contract as before: events after the cursor, then the last `limit`.
    const toEvent = row => ({ ...JSON.parse(row.payload), seq: Number(row.seq) });
    const params = before == null ? [id, after] : [id, after, before];
    const upper = before == null ? '' : ' AND seq < ?';
    if (!limit) {
      return this.db.prepare(`SELECT seq, payload FROM events WHERE task_id = ? AND seq > ?${upper} ORDER BY seq`).all(...params).map(toEvent);
    }
    const rows = this.db.prepare(`SELECT seq, payload FROM events WHERE task_id = ? AND seq > ?${upper} ORDER BY seq DESC LIMIT ?`).all(...params, limit);
    rows.reverse();
    return rows.map(toEvent);
  }

  // Forward replay for SSE reconnect: return the first events after the cursor,
  // not the history tail. If more than `limit` events accumulated, the client
  // reconnects again from the last delivered seq instead of silently skipping
  // the beginning of the gap.
  async readEventsForward(id, limit = 500, after = 0) {
    this.taskDir(id);
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(after) || after < 0) {
      throw Object.assign(new Error('Invalid event cursor or limit'), { code: 'INPUT_INVALID' });
    }
    const toEvent = row => ({ ...JSON.parse(row.payload), seq: Number(row.seq) });
    if (!limit) return this.db.prepare('SELECT seq, payload FROM events WHERE task_id = ? AND seq > ? ORDER BY seq').all(id, after).map(toEvent);
    return this.db.prepare('SELECT seq, payload FROM events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(id, after, limit).map(toEvent);
  }

  // Bounded-memory scan for recovery; readEvents(id, 0) would materialize the
  // whole history at once for a very long session.
  async *iterateEvents(id, after = 0, page = 2000) {
    this.taskDir(id);
    let cursor = after;
    while (true) {
      const rows = this.db.prepare('SELECT seq, payload FROM events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(id, cursor, page);
      if (!rows.length) return;
      for (const row of rows) {
        const event = { ...JSON.parse(row.payload), seq: Number(row.seq) };
        cursor = event.seq;
        yield event;
      }
      if (rows.length < page) return;
    }
  }

  // Drops message_update rows already superseded by a later message_end, mirroring
  // event-trim at write time so a long session does not accumulate megabytes of
  // dead deltas. Deltas after the last message_end (still in progress) are kept.
  async pruneStreamingDeltas(id) {
    this.taskDir(id);
    const lastEnd = Number(this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS seq FROM events
      WHERE task_id = ? AND json_extract(payload, '$.type') = 'PI_EVENT'
        AND json_extract(payload, '$.data.pi.type') = 'message_end'
    `).get(id).seq);
    if (!lastEnd) return 0;
    const info = this.db.prepare(`
      DELETE FROM events WHERE task_id = ? AND seq < ?
        AND json_extract(payload, '$.type') = 'PI_EVENT'
        AND json_extract(payload, '$.data.pi.type') = 'message_update'
    `).run(id, lastEnd);
    return Number(info.changes || 0);
  }
}
