import fs from 'node:fs';
import path from 'node:path';
import { CloudError } from './errors.mjs';
import { compareCommands } from '../../src/domain/cloud-command.mjs';

// Cloud state store (§74, §75, §76). All durable state lives here, never in
// function memory, so a new deployment cannot invalidate a running task.
//
// Two adapters:
//   MemoryStore  — tests and ephemeral local runs.
//   SqliteStore  — single-node / self-hosted deployment (node:sqlite, no build
//                  step). A serverless deployment should implement the same
//                  interface on Postgres; see docs/cloud-transport.md.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_owner_created ON tasks (owner_id, created_at DESC);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  task_id TEXT,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (machine_id, seq)
);
CREATE INDEX IF NOT EXISTS commands_machine_seq ON commands (machine_id, seq);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (task_id, seq)
);
CREATE INDEX IF NOT EXISTS events_task_seq ON events (task_id, seq);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.machines = new Map();
    this.tasks = new Map();
    this.commands = new Map();
    this.events = new Map(); // eventId → event
    this.approvals = new Map();
    this.meta = new Map();
  }

  async init() { return this; }
  async close() {}
  async checkpoint() {}
  getMeta(key) { return this.meta.get(key) ?? null; }
  setMeta(key, value) { this.meta.set(key, String(value)); }

  async upsertMachine(machine) {
    const existing = this.machines.get(machine.id) || {};
    const record = { ...existing, ...clone(machine), createdAt: existing.createdAt || machine.createdAt || new Date().toISOString() };
    this.machines.set(record.id, record);
    return clone(record);
  }
  async getMachine(id) { return clone(this.machines.get(id) || null); }
  async listMachines(ownerId) {
    return [...this.machines.values()].filter(m => !ownerId || m.ownerId === ownerId).map(clone);
  }

  async createTask(task) {
    if (this.tasks.has(task.id)) throw new CloudError('TASK_ALREADY_FINISHED', `Task ${task.id} already exists`);
    this.tasks.set(task.id, clone(task));
    return clone(task);
  }
  async getTask(id) { return clone(this.tasks.get(id) || null); }
  async listTasks(ownerId, { limit = 200 } = {}) {
    return [...this.tasks.values()]
      .filter(t => !ownerId || t.ownerId === ownerId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
      .map(clone);
  }
  async updateTask(id, patch) {
    const task = this.tasks.get(id);
    if (!task) return null;
    Object.assign(task, clone(patch));
    return clone(task);
  }
  async deleteTask(id) {
    this.tasks.delete(id);
    for (const [eventId, event] of this.events) if (event.taskId === id) this.events.delete(eventId);
  }

  async enqueueCommand(command) {
    const duplicate = [...this.commands.values()].find(c => c.machineId === command.machineId && Number(c.seq) === Number(command.seq));
    if (duplicate) return clone(duplicate);
    const record = { ...clone(command), status: command.status || 'PENDING', createdAt: command.createdAt || new Date().toISOString() };
    this.commands.set(record.id, record);
    return clone(record);
  }
  async getCommand(id) { return clone(this.commands.get(id) || null); }
  async listCommands(machineId, { after = 0, limit = 50 } = {}) {
    return [...this.commands.values()]
      .filter(c => c.machineId === machineId && Number(c.seq) > after)
      .sort(compareCommands)
      .slice(0, limit)
      .map(clone);
  }
  async ackCommand(id, status, detail = null, at = new Date().toISOString()) {
    const command = this.commands.get(id);
    if (!command) return null;
    command.status = status;
    command.acknowledgedAt = at;
    command.ackDetail = detail;
    return clone(command);
  }
  async lastCommandSeq(machineId) {
    let max = 0;
    for (const command of this.commands.values()) {
      if (command.machineId === machineId) max = Math.max(max, Number(command.seq) || 0);
    }
    return max;
  }
  async nextCommandSeq(machineId) { return (await this.lastCommandSeq(machineId)) + 1; }

  async insertEvents(events) {
    let inserted = 0;
    let duplicates = 0;
    for (const event of events) {
      const bySeq = [...this.events.values()].find(e => e.taskId === event.taskId && Number(e.seq) === Number(event.seq));
      if (this.events.has(event.eventId) || bySeq) { duplicates += 1; continue; }
      this.events.set(event.eventId, clone(event));
      inserted += 1;
    }
    return { inserted, duplicates };
  }
  async listEvents(taskId, { after = 0, limit = 500 } = {}) {
    return [...this.events.values()]
      .filter(e => e.taskId === taskId && Number(e.seq) > after)
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .slice(0, limit)
      .map(clone);
  }
  async lastEventSeq(taskId) {
    let max = 0;
    for (const event of this.events.values()) if (event.taskId === taskId) max = Math.max(max, Number(event.seq) || 0);
    return max;
  }

  async createApproval(approval) {
    if (this.approvals.has(approval.id)) throw new CloudError('INVALID_STATE', `Approval ${approval.id} already exists`);
    this.approvals.set(approval.id, clone(approval));
    return clone(approval);
  }
  async getApproval(id) { return clone(this.approvals.get(id) || null); }
  async resolveApproval(id, decision, at = new Date().toISOString()) {
    const approval = this.approvals.get(id);
    if (!approval) return null;
    approval.status = decision === 'ALLOW_ONCE' ? 'APPROVED' : 'DENIED';
    approval.decision = decision;
    approval.resolvedAt = at;
    return clone(approval);
  }
  async listApprovals(taskId) {
    return [...this.approvals.values()].filter(a => a.taskId === taskId).map(clone);
  }

  async prune({ taskDays = 90, eventDays = 30 } = {}) {
    const taskCutoff = Date.now() - taskDays * 86400000;
    const eventCutoff = Date.now() - eventDays * 86400000;
    let tasks = 0;
    let events = 0;
    for (const task of [...this.tasks.values()]) {
      if (Date.parse(task.createdAt) < taskCutoff && ['COMPLETED', 'FAILED', 'ABORTED'].includes(task.status)) {
        this.tasks.delete(task.id);
        tasks += 1;
      }
    }
    for (const [eventId, event] of [...this.events]) {
      if (Date.parse(event.createdAt || event.timestamp) < eventCutoff) { this.events.delete(eventId); events += 1; }
    }
    return { tasks, events };
  }
}

export class SqliteStore {
  constructor(file) {
    this.file = file;
    this.kind = 'sqlite';
  }

  static async open(file) {
    const store = new SqliteStore(file);
    await store.init();
    return store;
  }

  async init() {
    if (this.db) return this;
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import('node:sqlite'));
    } catch {
      throw new Error('SqliteStore requires Node.js 22.13+ (node:sqlite)');
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    return this;
  }

  async close() { this.db?.close(); this.db = null; }
  async checkpoint() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); }
  getMeta(key) { return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; }
  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  async upsertMachine(machine) {
    const existing = await this.getMachine(machine.id);
    const record = { ...(existing || {}), ...clone(machine), createdAt: existing?.createdAt || machine.createdAt || new Date().toISOString() };
    this.db.prepare('INSERT INTO machines (id, owner_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, data = excluded.data')
      .run(record.id, record.ownerId, JSON.stringify(record));
    return clone(record);
  }
  async getMachine(id) {
    const row = this.db.prepare('SELECT data FROM machines WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  }
  async listMachines(ownerId) {
    const rows = ownerId
      ? this.db.prepare('SELECT data FROM machines WHERE owner_id = ? ORDER BY id').all(ownerId)
      : this.db.prepare('SELECT data FROM machines ORDER BY id').all();
    return rows.map(row => JSON.parse(row.data));
  }

  async createTask(task) {
    if (this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(task.id)) {
      throw new CloudError('TASK_ALREADY_FINISHED', `Task ${task.id} already exists`);
    }
    this.db.prepare('INSERT INTO tasks (id, owner_id, machine_id, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(task.id, task.ownerId, task.machineId, task.status, task.createdAt, JSON.stringify(task));
    return clone(task);
  }
  async getTask(id) {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  }
  async listTasks(ownerId, { limit = 200 } = {}) {
    const rows = this.db.prepare('SELECT data FROM tasks WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?').all(ownerId, limit);
    return rows.map(row => JSON.parse(row.data));
  }
  async updateTask(id, patch) {
    const task = await this.getTask(id);
    if (!task) return null;
    const merged = { ...task, ...clone(patch) };
    this.db.prepare('UPDATE tasks SET status = ?, data = ? WHERE id = ?').run(merged.status, JSON.stringify(merged), id);
    return merged;
  }
  async deleteTask(id) {
    this.db.prepare('DELETE FROM events WHERE task_id = ?').run(id);
    this.db.prepare('DELETE FROM approvals WHERE task_id = ?').run(id);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  async enqueueCommand(command) {
    const existing = this.db.prepare('SELECT data FROM commands WHERE machine_id = ? AND seq = ?').get(command.machineId, Number(command.seq));
    if (existing) return JSON.parse(existing.data);
    const record = { ...clone(command), status: command.status || 'PENDING', createdAt: command.createdAt || new Date().toISOString() };
    this.db.prepare('INSERT INTO commands (id, machine_id, task_id, seq, type, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.machineId, record.taskId ?? null, Number(record.seq), record.type, record.status, record.createdAt, JSON.stringify(record));
    return clone(record);
  }
  async getCommand(id) {
    const row = this.db.prepare('SELECT data FROM commands WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  }
  async listCommands(machineId, { after = 0, limit = 50 } = {}) {
    const rows = this.db.prepare('SELECT data FROM commands WHERE machine_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(machineId, after, Math.max(limit * 4, limit));
    // Priority ordering is applied after the seq window so a high-priority
    // command queued later is still delivered in the same poll (§85).
    return rows.map(row => JSON.parse(row.data)).sort(compareCommands).slice(0, limit);
  }
  async ackCommand(id, status, detail = null, at = new Date().toISOString()) {
    const command = await this.getCommand(id);
    if (!command) return null;
    const merged = { ...command, status, acknowledgedAt: at, ackDetail: detail };
    this.db.prepare('UPDATE commands SET status = ?, data = ? WHERE id = ?').run(status, JSON.stringify(merged), id);
    return merged;
  }
  async lastCommandSeq(machineId) {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM commands WHERE machine_id = ?').get(machineId).seq);
  }
  async nextCommandSeq(machineId) { return (await this.lastCommandSeq(machineId)) + 1; }

  async insertEvents(events) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO events (event_id, task_id, machine_id, seq, type, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)');
    let inserted = 0;
    let duplicates = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) {
        const info = insert.run(event.eventId, event.taskId, event.machineId, Number(event.seq), event.type, event.createdAt || event.timestamp, JSON.stringify(event));
        if (Number(info.changes) > 0) inserted += 1;
        else duplicates += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already aborted */ }
      throw error;
    }
    return { inserted, duplicates };
  }
  async listEvents(taskId, { after = 0, limit = 500 } = {}) {
    const rows = this.db.prepare('SELECT payload FROM events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(taskId, after, limit);
    return rows.map(row => JSON.parse(row.payload));
  }
  async lastEventSeq(taskId) {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE task_id = ?').get(taskId).seq);
  }

  async createApproval(approval) {
    if (this.db.prepare('SELECT 1 FROM approvals WHERE id = ?').get(approval.id)) {
      throw new CloudError('INVALID_STATE', `Approval ${approval.id} already exists`);
    }
    this.db.prepare('INSERT INTO approvals (id, task_id, status, data) VALUES (?, ?, ?, ?)')
      .run(approval.id, approval.taskId, approval.status || 'PENDING', JSON.stringify(approval));
    return clone(approval);
  }
  async getApproval(id) {
    const row = this.db.prepare('SELECT data FROM approvals WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  }
  async resolveApproval(id, decision, at = new Date().toISOString()) {
    const approval = await this.getApproval(id);
    if (!approval) return null;
    const merged = { ...approval, status: decision === 'ALLOW_ONCE' ? 'APPROVED' : 'DENIED', decision, resolvedAt: at };
    this.db.prepare('UPDATE approvals SET status = ?, data = ? WHERE id = ?').run(merged.status, JSON.stringify(merged), id);
    return merged;
  }
  async listApprovals(taskId) {
    return this.db.prepare('SELECT data FROM approvals WHERE task_id = ?').all(taskId).map(row => JSON.parse(row.data));
  }

  async prune({ taskDays = 90, eventDays = 30 } = {}) {
    const taskCutoff = new Date(Date.now() - taskDays * 86400000).toISOString();
    const eventCutoff = new Date(Date.now() - eventDays * 86400000).toISOString();
    const tasks = Number(this.db.prepare("DELETE FROM tasks WHERE created_at < ? AND status IN ('COMPLETED','FAILED','ABORTED')").run(taskCutoff).changes || 0);
    const events = Number(this.db.prepare('DELETE FROM events WHERE created_at < ?').run(eventCutoff).changes || 0);
    return { tasks, events };
  }
}

export async function openStore(target = 'memory:') {
  if (!target || target === 'memory:' || target === 'memory') return new MemoryStore().init();
  if (target.startsWith('sqlite:')) return SqliteStore.open(path.resolve(target.slice('sqlite:'.length)));
  // A serverless deployment must use a persistent store (§74): any Postgres
  // connection string is accepted directly.
  if (/^postgres(ql)?:\/\//i.test(target)) {
    const { PostgresStore } = await import('./store-postgres.mjs');
    return PostgresStore.open(target);
  }
  throw new Error(`Unsupported cloud store target: ${target}`);
}

// Resolves the configured target, falling back to the conventional Vercel
// Postgres variables before memory (which is not durable).
export function resolveStoreTarget(env = process.env) {
  return env.TASKBRIDGE_CLOUD_STORE
    || env.POSTGRES_URL
    || env.POSTGRES_PRISMA_URL
    || env.DATABASE_URL
    || 'memory:';
}
