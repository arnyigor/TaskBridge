import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class TaskStore {
  constructor(dataRoot) {
    this.root = path.join(dataRoot, 'tasks');
    this.writes = new Map();
    this.sequences = new Map();
    this.removed = new Set();
    fs.mkdirSync(this.root, { recursive: true });
  }

  taskDir(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw Object.assign(new Error('Invalid session id'), { code: 'INPUT_INVALID' });
    }
    const target = path.resolve(this.root, id);
    if (!target.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Path escapes task store');
    return target;
  }

  #write(id, action) {
    if (this.removed.has(id)) return Promise.reject(Object.assign(new Error('Session deleted'), { code: 'NOT_FOUND' }));
    const next = (this.writes.get(id) || Promise.resolve()).then(action);
    const settled = next.catch(() => {});
    this.writes.set(id, settled);
    settled.then(() => { if (this.writes.get(id) === settled) this.writes.delete(id); });
    return next;
  }

  async create(task) {
    const dir = this.taskDir(task.id);
    await fsp.mkdir(dir, { recursive: true });
    await this.save(task);
    return task;
  }

  async save(task) {
    const dir = this.taskDir(task.id);
    const text = JSON.stringify(task, null, 2);
    return this.#write(task.id, async () => {
      await fsp.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, 'task.json.tmp');
      const target = path.join(dir, 'task.json');
      await fsp.writeFile(tmp, text, 'utf8');
      await fsp.rename(tmp, target);
    });
  }

  async appendEvent(id, event) {
    const dir = this.taskDir(id);
    return this.#write(id, async () => {
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'events.jsonl');
      if (!this.sequences.has(id)) {
        const text = await fsp.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
        let seq = 0;
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          seq += 1;
          try { seq = Math.max(seq, Number(JSON.parse(line).seq) || 0); } catch {}
        }
        if (text && !text.endsWith('\n')) await fsp.appendFile(file, '\n');
        this.sequences.set(id, seq);
      }
      event.seq = this.sequences.get(id) + 1;
      await fsp.appendFile(file, JSON.stringify(event) + '\n', 'utf8');
      this.sequences.set(id, event.seq);
      return event;
    });
  }

  async appendRaw(id, name, content) {
    const dir = path.join(this.taskDir(id), 'artifacts');
    return this.#write(id, async () => {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.appendFile(path.join(dir, path.basename(name)), content, 'utf8');
    });
  }

  async writeArtifact(id, name, content) {
    const dir = path.join(this.taskDir(id), 'artifacts');
    return this.#write(id, async () => {
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
    await this.writes.get(id);
    await fsp.rm(dir, { recursive: true, force: true });
    this.sequences.delete(id);
  }

  async read(id) {
    const text = await fsp.readFile(path.join(this.taskDir(id), 'task.json'), 'utf8');
    return JSON.parse(text);
  }

  async list() {
    const entries = await fsp.readdir(this.root, { withFileTypes: true }).catch(() => []);
    const tasks = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try { tasks.push(await this.read(entry.name)); } catch {}
    }
    return tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async readEvents(id, limit = 500, after = 0) {
    const dir = this.taskDir(id);
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(after) || after < 0) {
      throw Object.assign(new Error('Invalid event cursor or limit'), { code: 'INPUT_INVALID' });
    }
    try {
      const text = await fsp.readFile(path.join(dir, 'events.jsonl'), 'utf8');
      const events = [];
      let seq = 0;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        seq += 1;
        try {
          const event = JSON.parse(line);
          seq = Math.max(seq, Number(event.seq) || 0);
          if (seq > after) events.push({ ...event, seq });
        } catch { /* A torn final record must not hide the valid history. */ }
      }
      return limit ? events.slice(-limit) : events;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
}
