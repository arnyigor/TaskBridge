// ModelLibrary — локальная библиотека моделей TaskBridge.
//
// Модель в TaskBridge — это объект (источник, ревизия, файлы, квант, vision),
// а не просто путь к .gguf. Реестр персистится в dataRoot/model-library.json;
// записи создают два пути:
//   1. DownloadManager после успешной установки (onInstalled) — модели с HF;
//   2. scan() — индексация уже лежащих на диске .gguf (P0).
//
// Реестр не запускает и не скачивает ничего: это источник правды о том, что
// установлено и где лежат файлы.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { quantFromFilename } from './huggingface.mjs';

const SCAN_DEPTH = 6;

export function idForEntry({ repo, revision, quant }) {
  const repoId = String(repo || 'local')
    .toLowerCase()
    .replace(/[^a-z0-9./_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const rev = revision ? String(revision).slice(0, 12) : 'local';
  const q = (quant || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `hf:${repoId}@${rev}:${q}`;
}

// Рекурсивный обход в поисках .gguf. Скрытые и служебные директории
// (.taskbridge-part, .hf-cache) пропускаются: недокачанные файлы — не модели.
export async function scanDirectory(root, { depth = SCAN_DEPTH } = {}) {
  const found = [];
  const walk = async (dir, level) => {
    if (level > depth) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '$RECYCLE.BIN') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full, level + 1); continue; }
      if (!entry.isFile() || !/\.gguf$/i.test(entry.name)) continue;
      let size = null;
      try { size = (await fsp.stat(full)).size; } catch { /* файл исчез при сканировании */ }
      found.push({ path: full, size, quant: quantFromFilename(entry.name) });
    }
  };
  await walk(root, 0);
  return found;
}

export class ModelLibrary extends EventEmitter {
  constructor(dataRoot, options = {}) {
    super();
    this.dataRoot = dataRoot;
    this.file = path.join(dataRoot, 'model-library.json');
    this.entries = new Map();
    this.presenceCache = { at: 0, value: null };
    try {
      for (const entry of JSON.parse(fs.readFileSync(this.file, 'utf8'))) {
        if (entry?.id) this.entries.set(entry.id, entry);
      }
    } catch { /* пустой реестр — файл появится при первой записи */ }
  }

  #persist() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.entries.values()], null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** Зарегистрировать модель из завершённого задания загрузки. */
  addFromJob(job) {
    const files = (job.files || []).map(f => ({ path: path.join(job.dir, f.path), size: f.size ?? null, sha256: f.sha256 || null }));
    const quants = [...new Set(files.map(f => quantFromFilename(path.basename(f.path))).filter(Boolean))];
    const quant = quants.length === 1 ? quants[0] : (quants[0] || null);
    const entry = {
      // libraryId вычислен при старте загрузки — реестр обязан использовать
      // именно его, иначе UI, знавший id заранее, промахнётся мимо записи.
      id: job.libraryId || idForEntry({ repo: job.repo, revision: job.revision, quant }),
      name: job.label || job.repo,
      source: { type: 'huggingface', repo: job.repo, revision: job.revision },
      format: 'gguf',
      quant,
      dir: job.dir,
      files,
      // mmproj-проектор для vision-моделей: наличие определяется по именам файлов.
      vision: (job.files || []).some(f => /mmproj/i.test(f.path)),
      runtime: { preferred: 'llama.cpp' },
      jobId: job.id,
      addedAt: Date.now()
    };
    this.entries.set(entry.id, entry);
    this.presenceCache = { at: 0, value: null };
    this.#persist();
    this.emit('changed', entry);
    return entry;
  }

  add(entry) {
    if (!entry?.id) throw Object.assign(new Error('Запись без id.'), { code: 'INPUT_INVALID' });
    const existing = this.entries.get(entry.id);
    this.entries.set(entry.id, { ...existing, ...entry, id: entry.id });
    this.presenceCache = { at: 0, value: null };
    this.#persist();
    return this.entries.get(entry.id);
  }

  get(id) {
    return this.entries.get(id) || null;
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    this.entries.delete(id);
    this.presenceCache = { at: 0, value: null };
    this.#persist();
    return entry;
  }

  /**
   * Список установленных моделей с проверкой наличия файлов (кэш 5 c —
   * записи приходят и в polled-эндпоинты).
   */
  async list({ fresh = false } = {}) {
    if (!fresh && this.presenceCache.value && Date.now() - this.presenceCache.at < 5000) {
      return this.presenceCache.value;
    }
    const value = [];
    for (const entry of this.entries.values()) {
      const missing = [];
      for (const file of entry.files || []) {
        try {
          const stat = await fsp.stat(file.path);
          if (file.size != null && stat.size !== file.size) missing.push(path.basename(file.path));
        } catch { missing.push(path.basename(file.path)); }
      }
      value.push({ ...entry, preset: entry.runtime?.preset || null, filesPresent: missing.length === 0, missingFiles: missing });
    }
    this.presenceCache = { at: Date.now(), value };
    return value;
  }

  /**
   * Индексация .gguf, уже лежащих на диске: файлы вне реестра попадают в
   * список как standalone-модели, не создавая записей (запись создаёт
   * пользователь или загрузка с HF).
   */
  async scan(root) {
    const found = await scanDirectory(root);
    const registered = new Set();
    for (const entry of this.entries.values()) {
      for (const file of entry.files || []) registered.add(path.resolve(file.path).toLowerCase());
    }
    return found
      .filter(f => !registered.has(path.resolve(f.path).toLowerCase()))
      .map(f => ({
        id: `scan:${f.path}`,
        name: path.basename(f.path).replace(/\.gguf$/i, ''),
        quant: f.quant,
        format: 'gguf',
        path: f.path,
        size: f.size,
        files: [{ path: f.path, size: f.size }],
        source: { type: 'standalone' }
      }));
  }
}
