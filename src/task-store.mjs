import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class TaskStore {
  constructor(dataRoot) {
    this.root = path.join(dataRoot, 'tasks');
    fs.mkdirSync(this.root, { recursive: true });
  }

  taskDir(id) {
    return path.join(this.root, id);
  }

  async create(task) {
    const dir = this.taskDir(task.id);
    await fsp.mkdir(dir, { recursive: true });
    await this.save(task);
    return task;
  }

  async save(task) {
    const dir = this.taskDir(task.id);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, 'task.json.tmp');
    const target = path.join(dir, 'task.json');
    await fsp.writeFile(tmp, JSON.stringify(task, null, 2), 'utf8');
    await fsp.rename(tmp, target);
  }

  async appendEvent(id, event) {
    const dir = this.taskDir(id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8');
  }

  async appendRaw(id, name, content) {
    const dir = path.join(this.taskDir(id), 'artifacts');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(path.join(dir, path.basename(name)), content, 'utf8');
  }

  async writeArtifact(id, name, content) {
    const dir = path.join(this.taskDir(id), 'artifacts');
    await fsp.mkdir(dir, { recursive: true });
    const safe = path.basename(name);
    const target = path.join(dir, safe);
    await fsp.writeFile(target, content);
    return target;
  }

  async remove(id) {
    await fsp.rm(this.taskDir(id), { recursive: true, force: true });
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

  async readEvents(id, limit = 500) {
    try {
      const text = await fsp.readFile(path.join(this.taskDir(id), 'events.jsonl'), 'utf8');
      const lines = text.split(/\r?\n/).filter(Boolean).slice(-limit);
      return lines.map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
}
