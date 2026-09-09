import { CloudError } from './errors.mjs';
import { compareCommands } from '../../src/domain/cloud-command.mjs';

// Postgres adapter for the cloud control plane. Implements exactly the same
// interface as MemoryStore/SqliteStore (§75, §76), so the router and the tests
// do not care which one is behind it.
//
// Required for any serverless deployment: Vercel's filesystem is ephemeral, so
// SQLite cannot survive a function invocation (§74). `pg` is an optional
// dependency; this module only loads it when Postgres is actually configured.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_owner_created ON tasks (owner_id, created_at DESC);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  task_id TEXT,
  seq BIGINT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  UNIQUE (machine_id, seq)
);
CREATE INDEX IF NOT EXISTS commands_machine_seq ON commands (machine_id, seq);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  UNIQUE (task_id, seq)
);
CREATE INDEX IF NOT EXISTS events_task_seq ON events (task_id, seq);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export class PostgresStore {
  constructor(connectionString, options = {}) {
    this.connectionString = connectionString;
    this.kind = 'postgres';
    this.options = options;
    this.pool = null;
  }

  static async open(connectionString, options = {}) {
    const store = new PostgresStore(connectionString, options);
    await store.init();
    return store;
  }

  async init() {
    if (this.pool) return this;
    let pg;
    try {
      pg = await import('pg');
    } catch {
      throw new Error("PostgresStore requires the optional 'pg' package: npm install pg");
    }
    const Pool = pg.default?.Pool || pg.Pool;
    this.pool = new Pool({
      connectionString: this.connectionString,
      // Serverless functions must not hold a large pool open; a single
      // connection per invocation is enough and works with PgBouncer.
      max: this.options.max ?? 1,
      idleTimeoutMillis: this.options.idleTimeoutMillis ?? 10000,
      connectionTimeoutMillis: this.options.connectionTimeoutMillis ?? 10000,
      ssl: this.options.ssl ?? (/sslmode=disable/.test(this.connectionString) ? false : { rejectUnauthorized: false })
    });
    await this.pool.query(SCHEMA);
    return this;
  }

  async close() { await this.pool?.end(); this.pool = null; }
  async checkpoint() { /* Postgres manages durability itself */ }

  async #query(text, params = []) {
    if (!this.pool) throw new CloudError('INTERNAL_ERROR', 'Postgres store is not initialised');
    return this.pool.query(text, params);
  }

  async getMeta(key) {
    const result = await this.#query('SELECT value FROM meta WHERE key = $1', [key]);
    return result.rows[0]?.value ?? null;
  }

  async setMeta(key, value) {
    await this.#query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [String(key), String(value)]);
  }

  async upsertMachine(machine) {
    const existing = await this.getMachine(machine.id);
    const record = { ...(existing || {}), ...clone(machine), createdAt: existing?.createdAt || machine.createdAt || new Date().toISOString() };
    await this.#query(
      'INSERT INTO machines (id, owner_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, data = EXCLUDED.data',
      [record.id, record.ownerId, JSON.stringify(record)]
    );
    return clone(record);
  }

  async getMachine(id) {
    const result = await this.#query('SELECT data FROM machines WHERE id = $1', [id]);
    return result.rows[0]?.data ?? null;
  }

  async listMachines(ownerId) {
    const result = ownerId
      ? await this.#query('SELECT data FROM machines WHERE owner_id = $1 ORDER BY id', [ownerId])
      : await this.#query('SELECT data FROM machines ORDER BY id');
    return result.rows.map(row => row.data);
  }

  async createTask(task) {
    const existing = await this.getTask(task.id);
    if (existing) throw new CloudError('TASK_ALREADY_FINISHED', `Task ${task.id} already exists`);
    await this.#query(
      'INSERT INTO tasks (id, owner_id, machine_id, status, created_at, data) VALUES ($1, $2, $3, $4, $5, $6)',
      [task.id, task.ownerId, task.machineId, task.status, task.createdAt, JSON.stringify(task)]
    );
    return clone(task);
  }

  async getTask(id) {
    const result = await this.#query('SELECT data FROM tasks WHERE id = $1', [id]);
    return result.rows[0]?.data ?? null;
  }

  async listTasks(ownerId, { limit = 200 } = {}) {
    const result = await this.#query('SELECT data FROM tasks WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2', [ownerId, limit]);
    return result.rows.map(row => row.data);
  }

  async updateTask(id, patch) {
    const task = await this.getTask(id);
    if (!task) return null;
    const merged = { ...task, ...clone(patch) };
    await this.#query('UPDATE tasks SET status = $1, data = $2 WHERE id = $3', [merged.status, JSON.stringify(merged), id]);
    return merged;
  }

  async deleteTask(id) {
    await this.#query('DELETE FROM events WHERE task_id = $1', [id]);
    await this.#query('DELETE FROM approvals WHERE task_id = $1', [id]);
    await this.#query('DELETE FROM tasks WHERE id = $1', [id]);
  }

  async enqueueCommand(command) {
    const existing = await this.#query('SELECT data FROM commands WHERE machine_id = $1 AND seq = $2', [command.machineId, Number(command.seq)]);
    if (existing.rows[0]) return existing.rows[0].data;
    const record = { ...clone(command), status: command.status || 'PENDING', createdAt: command.createdAt || new Date().toISOString() };
    await this.#query(
      'INSERT INTO commands (id, machine_id, task_id, seq, type, status, created_at, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [record.id, record.machineId, record.taskId ?? null, Number(record.seq), record.type, record.status, record.createdAt, JSON.stringify(record)]
    );
    return clone(record);
  }

  async getCommand(id) {
    const result = await this.#query('SELECT data FROM commands WHERE id = $1', [id]);
    return result.rows[0]?.data ?? null;
  }

  async listCommands(machineId, { after = 0, limit = 50 } = {}) {
    const result = await this.#query(
      'SELECT data FROM commands WHERE machine_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
      [machineId, after, Math.max(limit * 4, limit)]
    );
    return result.rows.map(row => row.data).sort(compareCommands).slice(0, limit);
  }

  async ackCommand(id, status, detail = null, at = new Date().toISOString()) {
    const command = await this.getCommand(id);
    if (!command) return null;
    const merged = { ...command, status, acknowledgedAt: at, ackDetail: detail };
    await this.#query('UPDATE commands SET status = $1, data = $2 WHERE id = $3', [status, JSON.stringify(merged), id]);
    return merged;
  }

  async lastCommandSeq(machineId) {
    const result = await this.#query('SELECT COALESCE(MAX(seq), 0) AS seq FROM commands WHERE machine_id = $1', [machineId]);
    return Number(result.rows[0]?.seq ?? 0);
  }

  async nextCommandSeq(machineId) { return (await this.lastCommandSeq(machineId)) + 1; }

  async insertEvents(events) {
    if (!events.length) return { inserted: 0, duplicates: 0 };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let inserted = 0;
      let duplicates = 0;
      for (const event of events) {
        const result = await client.query(
          `INSERT INTO events (event_id, task_id, machine_id, seq, type, created_at, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [event.eventId, event.taskId, event.machineId, Number(event.seq), event.type, event.createdAt || event.timestamp, JSON.stringify(event)]
        );
        if (result.rowCount > 0) inserted += 1;
        else duplicates += 1;
      }
      await client.query('COMMIT');
      return { inserted, duplicates };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* already aborted */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvents(taskId, { after = 0, limit = 500 } = {}) {
    const result = await this.#query('SELECT payload FROM events WHERE task_id = $1 AND seq > $2 ORDER BY seq LIMIT $3', [taskId, after, limit]);
    return result.rows.map(row => row.payload);
  }

  async lastEventSeq(taskId) {
    const result = await this.#query('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE task_id = $1', [taskId]);
    return Number(result.rows[0]?.seq ?? 0);
  }

  async createApproval(approval) {
    const existing = await this.getApproval(approval.id);
    if (existing) throw new CloudError('INVALID_STATE', `Approval ${approval.id} already exists`);
    await this.#query('INSERT INTO approvals (id, task_id, status, data) VALUES ($1, $2, $3, $4)', [approval.id, approval.taskId, approval.status || 'PENDING', JSON.stringify(approval)]);
    return clone(approval);
  }

  async getApproval(id) {
    const result = await this.#query('SELECT data FROM approvals WHERE id = $1', [id]);
    return result.rows[0]?.data ?? null;
  }

  async resolveApproval(id, decision, at = new Date().toISOString()) {
    const approval = await this.getApproval(id);
    if (!approval) return null;
    const merged = { ...approval, status: decision === 'ALLOW_ONCE' ? 'APPROVED' : 'DENIED', decision, resolvedAt: at };
    await this.#query('UPDATE approvals SET status = $1, data = $2 WHERE id = $3', [merged.status, JSON.stringify(merged), id]);
    return merged;
  }

  async listApprovals(taskId) {
    const result = await this.#query('SELECT data FROM approvals WHERE task_id = $1', [taskId]);
    return result.rows.map(row => row.data);
  }

  async prune({ taskDays = 90, eventDays = 30 } = {}) {
    const taskCutoff = new Date(Date.now() - taskDays * 86400000).toISOString();
    const eventCutoff = new Date(Date.now() - eventDays * 86400000).toISOString();
    const tasks = await this.#query("DELETE FROM tasks WHERE created_at < $1 AND status IN ('COMPLETED','FAILED','ABORTED')", [taskCutoff]);
    const events = await this.#query('DELETE FROM events WHERE created_at < $1', [eventCutoff]);
    return { tasks: tasks.rowCount || 0, events: events.rowCount || 0 };
  }
}
