import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { parseMultipart } from './multipart.mjs';
import { contentType } from './files.mjs';

const tokenPattern = /^[a-f0-9-]{36}$/;
const fail = (code, message) => Object.assign(new Error(message), { code });

export function safeUploadName(name) {
  const base = path.basename(String(name || 'file.bin'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 180);
  if (!base || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) return 'file.bin';
  return base;
}

// Files are streamed into data/uploads/<token>/<id> and referenced by id.
// Nothing is written into a project workspace until a task/message is accepted,
// so an abandoned upload can only cost temporary disk space.
export class UploadStore {
  constructor(dataRoot, options = {}) {
    this.root = path.join(dataRoot, 'uploads');
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.maxFiles = options.maxFiles ?? 10;
    this.maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 128 * 1024 * 1024;
  }

  newToken() {
    return crypto.randomUUID();
  }

  async #dir(token) {
    if (!tokenPattern.test(String(token || ''))) throw fail('INPUT_INVALID', 'Неверный идентификатор загрузки.');
    return path.join(this.root, token);
  }

  async receive(req, boundary, token) {
    const dir = await this.#dir(token);
    await fs.mkdir(dir, { recursive: true });
    const index = [];
    const streams = new Set();
    try {
      await parseMultipart(req, boundary, {
        maxBytes: this.maxTotalBytes,
        maxFiles: this.maxFiles,
        maxFileBytes: this.maxFileBytes,
        onFile: async ({ filename, contentType: mime }) => {
          const id = crypto.randomUUID();
          const stream = createWriteStream(path.join(dir, id), { flags: 'wx' });
          // Errors are surfaced through the write/end callbacks; the listener
          // only prevents an unhandled 'error' event from crashing the server.
          stream.on('error', () => {});
          streams.add(stream);
          const descriptor = { id, name: safeUploadName(filename), size: 0, mimeType: mime || contentType(filename) };
          return {
            // Awaiting the callback applies backpressure instead of buffering
            // the whole file in the WriteStream when the disk is slower than
            // the network.
            write: chunk => new Promise((resolve, reject) => {
              stream.write(chunk, error => (error ? reject(error) : resolve()));
            }),
            end: size => new Promise((resolve, reject) => {
              descriptor.size = size;
              stream.end(error => {
                streams.delete(stream);
                if (error) reject(error);
                else { index.push(descriptor); resolve(); }
              });
            })
          };
        }
      });
      await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(index));
      return { token, files: index };
    } catch (error) {
      for (const stream of streams) stream.destroy();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async #load(token) {
    const dir = await this.#dir(token);
    try {
      return { dir, files: JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')) };
    } catch (error) {
      if (error.code === 'ENOENT') throw fail('INPUT_INVALID', 'Загрузка не найдена или истекла.');
      throw error;
    }
  }

  // Resolves client references against what was actually staged. Client-supplied
  // name/size/mime are ignored, so a forged ref cannot point outside the token.
  async resolve(token, refs) {
    const { dir, files } = await this.#load(token);
    // A task can wait in the queue longer than the TTL; keep the staging
    // directory alive as soon as it is actually referenced.
    const now = new Date();
    await fs.utimes(dir, now, now).catch(() => {});
    return refs.map(ref => {
      const entry = files.find(file => file.id === ref?.id);
      if (!entry) throw fail('INPUT_INVALID', 'Файл загрузки не найден.');
      return { ...entry, sourcePath: path.join(dir, entry.id) };
    });
  }

  async discard(token) {
    const dir = await this.#dir(token);
    await fs.rm(dir, { recursive: true, force: true });
  }

  async cleanup(now = Date.now()) {
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.root, entry.name);
      const stat = await fs.stat(dir).catch(() => null);
      if (stat && now - stat.mtimeMs > this.ttlMs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
