import fs from 'node:fs/promises';
import path from 'node:path';

export class CloudEventState {
  constructor(dataRoot, store) {
    this.file = path.join(dataRoot, 'cloud', 'event-state.json');
    this.store = store;
    this.cursors = {};
  }

  async init(tasks, enqueue) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    let state;
    try { state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Enabling cloud starts a new cloud history. Existing sessions are still
      // discoverable through SYNC_STATE, but their potentially huge old event
      // logs are not uploaded retroactively.
      for (const task of tasks) {
        const tail = await this.store.readEvents(task.id, 1);
        this.cursors[task.id] = tail.at(-1)?.seq || 0;
      }
      await this.#save();
      return;
    }
    this.cursors = state?.uploadedSeq && typeof state.uploadedSeq === 'object' ? state.uploadedSeq : {};
    for (const task of tasks) {
      const after = Number(this.cursors[task.id] || 0);
      for (const event of await this.store.readEvents(task.id, 0, after)) await enqueue(event);
    }
  }

  async mark(records) {
    let changed = false;
    for (const record of records) {
      const seq = record.event?.seq;
      if (!Number.isSafeInteger(seq) || seq <= 0 || !record.taskId) continue;
      if (seq > Number(this.cursors[record.taskId] || 0)) { this.cursors[record.taskId] = seq; changed = true; }
    }
    if (changed) await this.#save();
  }

  async #save() {
    const temporary = `${this.file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ uploadedSeq: this.cursors }, null, 2)}\n`, 'utf8');
    const handle = await fs.open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, this.file);
  }
}
