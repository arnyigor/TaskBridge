import fs from 'node:fs/promises';
import path from 'node:path';

export class CloudOutbox {
  constructor(dataRoot, options = {}) {
    this.directory = path.join(dataRoot, 'cloud');
    this.file = path.join(this.directory, 'outbox.jsonl');
    this.maxBytes = Math.max(1, Number(options.maxOutboxMb || 100)) * 1024 * 1024;
    this.pending = [];
    this.pendingIds = new Set();
    this.bytes = 0;
    this.chain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    const text = await fs.readFile(this.file, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
    const lines = text.split('\n');
    this.pending = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index]) continue;
      try { this.pending.push(JSON.parse(lines[index])); }
      catch {
        if (index !== lines.length - 1 || text.endsWith('\n')) throw new Error(`Malformed cloud outbox at line ${index + 1}`);
      }
    }
    const repaired = this.pending.map(item => JSON.stringify(item)).join('\n') + (this.pending.length ? '\n' : '');
    this.pendingIds = new Set(this.pending.map(item => item.eventId));
    if (repaired !== text) await fs.writeFile(this.file, repaired, 'utf8');
    this.bytes = Buffer.byteLength(repaired);
  }

  #serial(action) {
    const next = this.chain.then(action);
    this.chain = next.catch(() => {});
    return next;
  }

  enqueue(record) {
    return this.#serial(async () => {
      if (this.pendingIds.has(record.eventId)) return record;
      const line = `${JSON.stringify(record)}\n`;
      const size = Buffer.byteLength(line);
      if (this.bytes + size > this.maxBytes) throw Object.assign(new Error('Cloud outbox переполнен; локальные события сохранены, но отправка в облако приостановлена.'), { code: 'CLOUD_OUTBOX_FULL' });
      const handle = await fs.open(this.file, 'a');
      try { await handle.writeFile(line, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      this.pending.push(record);
      this.pendingIds.add(record.eventId);
      this.bytes += size;
      return record;
    });
  }

  take(limit = 100, maxBytes = 256 * 1024) {
    return this.#serial(async () => {
      const result = [];
      let bytes = 2;
      for (const record of this.pending) {
        const size = Buffer.byteLength(JSON.stringify(record)) + 1;
        if (result.length && (result.length >= limit || bytes + size > maxBytes)) break;
        result.push(record);
        bytes += size;
      }
      return result;
    });
  }

  ack(eventIds) {
    return this.#serial(async () => {
      const acknowledged = new Set(eventIds);
      this.pending = this.pending.filter(item => !acknowledged.has(item.eventId));
      this.pendingIds = new Set(this.pending.map(item => item.eventId));
      const text = this.pending.length ? `${this.pending.map(item => JSON.stringify(item)).join('\n')}\n` : '';
      const temporary = `${this.file}.tmp`;
      await fs.writeFile(temporary, text, 'utf8');
      await fs.rename(temporary, this.file);
      this.bytes = Buffer.byteLength(text);
    });
  }

  size() { return this.pending.length; }
}
