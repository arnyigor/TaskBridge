// DownloadManager — очередь загрузок моделей с Hugging Face.
//
// Задача не «скачать файл HTTP-запросом»: загрузка модели — это фоновая работа
// на десятки гигабайт, которая обязана переживать перезапуск TaskBridge и давать
// прогресс/отмену. Поэтому:
//   - каждое задание (DownloadJob) живёт в памяти и персистится в
//     dataRoot/downloads.json (троттлинг ~1 c, чтобы не писать на диск каждый чанк);
//   - файл качается в <dir>/.taskbridge-part/<path>, по завершении переносится
//     на место (rename) — недокачанный файл никогда не выглядит готовым;
//   - уже скачанные файлы нужного размера пропускаются, поэтому retry после
//     обрыва докачивает, а не начинает с нуля;
//   - перед стартом проверяется свободное место (fs.statfs).
//
// Физический кэш Hugging Face (blobs/snapshots) здесь не эмулируется: TaskBridge
// хранит файлы в своём дереве <dir>, а регистрация установленной модели —
// забота ModelLibrary через onInstalled.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const JOB_STATES = ['QUEUED', 'DOWNLOADING', 'VERIFYING', 'INSTALLED', 'FAILED', 'CANCELLED', 'INTERRUPTED'];

const PERSIST_EVERY_MS = 1000;
const PART_DIR = '.taskbridge-part';

// Путь файла из HF-дерева внутри локальной директории. Пути с '..' или
// абсолютные пути — отказ: имя пришло из внешнего API.
export function safeJoin(dir, relativePath) {
  const parts = String(relativePath).split('/').filter(Boolean);
  if (!parts.length || parts.some(p => p === '..' || p === '.' || /^[a-zA-Z]:/.test(p))) return null;
  const target = path.join(dir, ...parts);
  if (path.relative(dir, target).startsWith('..')) return null;
  return target;
}

function speedOf(job) {
  const started = job.startedAt || job.updatedAt;
  if (!started || !job.downloadedBytes) return null;
  const seconds = (Date.now() - started) / 1000;
  return seconds > 0.5 ? job.downloadedBytes / seconds : null;
}

export class DownloadManager extends EventEmitter {
  constructor(dataRoot, options = {}) {
    super();
    this.dataRoot = dataRoot;
    // onInstalled вызывается после успешной установки: так DownloadManager
    // остаётся слоем загрузки, а регистрацию модели делает ModelLibrary.
    this.onInstalled = options.onInstalled || null;
    this.stateFile = path.join(dataRoot, 'downloads.json');
    this.jobs = new Map();
    this.#restore();
  }

  #restore() {
    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch { /* нет файла или он битый — начинаем с пустой очереди */ }
    for (const job of Array.isArray(saved) ? saved : []) {
      if (!job || typeof job.id !== 'string') continue;
      // Состояние на момент смерти процесса сохранено, но процесс умер: всё,
      // что «шло», прерывается, а не продолжает притворяться живым. Retry
      // поднимает такие задания заново (готовые файлы пропускаются по размеру).
      if (job.state === 'DOWNLOADING' || job.state === 'QUEUED' || job.state === 'VERIFYING') {
        job.state = 'INTERRUPTED';
        job.error = 'TaskBridge перезапущен во время загрузки.';
      }
      job.speed = null;
      this.jobs.set(job.id, job);
    }
  }

  #persist() {
    const payload = JSON.stringify([...this.jobs.values()], null, 2);
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.stateFile);
  }

  list({ id } = {}) {
    const jobs = [...this.jobs.values()]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(job => ({ ...job, speed: job.state === 'DOWNLOADING' ? speedOf(job) : null }));
    return id ? (jobs.find(job => job.id === id) || null) : jobs;
  }

  /**
   * Убрать из списка завершённые задания (INSTALLED/FAILED/CANCELLED/INTERRUPTED):
   * файлы не трогаются (установленные модели живут в библиотеке), удаляется
   * только запись очереди. Активные задания остаются. Возвращает число удалённых.
   */
  clearFinished() {
    let removed = 0;
    for (const [id, job] of [...this.jobs]) {
      if (!['QUEUED', 'DOWNLOADING', 'VERIFYING'].includes(job.state)) {
        this.jobs.delete(id);
        removed += 1;
      }
    }
    if (removed) this.#persist();
    return removed;
  }

  /** Свободное место в байтах для директории назначения. */
  async freeBytes(dir) {
    try {
      const stats = await fsp.statfs(dir);
      return Number(stats.bsize) * Number(stats.bavail);
    } catch {
      return null; // диск недоступен для statfs — проверка места невозможна
    }
  }

  /**
   * Запустить задание. { repo, revision, files: [{path,size}], dir, label }
   * Возвращает задание в состоянии QUEUED; сама загрузка идёт в фоне.
   */
  async start({ repo, revision = 'main', files, dir, label, resolveBase } = {}) {
    if (!Array.isArray(files) || !files.length) {
      throw Object.assign(new Error('Список файлов загрузки пуст.'), { code: 'INPUT_INVALID' });
    }
    for (const file of files) {
      if (!file || typeof file.path !== 'string' || !safeJoin(dir || '', file.path)) {
        throw Object.assign(new Error(`Недопустимый путь файла: ${file?.path}`), { code: 'INPUT_INVALID' });
      }
    }
    await fsp.mkdir(path.join(dir, PART_DIR), { recursive: true });
    const totalBytes = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
    const free = await this.freeBytes(dir);
    if (free != null && free < totalBytes) {
      throw Object.assign(new Error(
        `Недостаточно места: нужно ${(totalBytes / 1e9).toFixed(1)} ГБ, свободно ${(free / 1e9).toFixed(1)} ГБ.`),
      { code: 'NO_SPACE' });
    }

    const job = {
      id: `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      repo, revision, dir, label: label || repo,
      // resolveBase — точка моноплачивания URL скачивания (по умолчанию HF
      // resolve-эндпоинт); тесты подставляют локальный http-сервер.
      resolveBase: resolveBase || null,
      files: files.map(f => ({ ...f, done: false })),
      totalBytes,
      downloadedBytes: 0,
      state: 'QUEUED',
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null
    };
    this.jobs.set(job.id, job);
    this.#persist();
    this.#emit(job);
    this.#run(job).catch(() => {}); // ошибки уже записаны в job
    return { ...job };
  }

  #emit(job) {
    this.emit('update', { ...job, speed: job.state === 'DOWNLOADING' ? speedOf(job) : null });
  }

  #touch(job) {
    job.updatedAt = Date.now();
    this.#persist();
    this.#emit(job);
  }

  #throttledPersist(job) {
    const now = Date.now();
    if (now - (job.lastPersist || 0) < PERSIST_EVERY_MS) return;
    job.lastPersist = now;
    job.updatedAt = now;
    this.#persist();
    this.#emit(job);
  }

  async #run(job) {
    job.state = 'DOWNLOADING';
    job.startedAt = Date.now();
    this.#touch(job);
    const controller = new AbortController();
    job.abort = controller;
    try {
      for (const file of job.files) {
        if (job.cancelRequested) break;
        await this.#downloadFile(job, file, controller.signal);
      }
      if (job.cancelRequested) {
        job.state = 'CANCELLED';
        job.error = 'Загрузка отменена.';
        this.#touch(job);
        return;
      }
      job.state = 'VERIFYING';
      this.#touch(job);
      // Верификация: каждый файл существует и имеет ожидаемый размер. Хэши
      // HF для LFS-файлов доступны в дереве (lfs.oid), но сравнение размера —
      // достаточная первая проверка целостности; хэш-верификация — следующий шаг.
      for (const file of job.files) {
        const target = safeJoin(job.dir, file.path);
        const stat = await fsp.stat(target);
        if (file.size != null && stat.size !== file.size) {
          throw new Error(`Размер ${file.path} не совпал: ${stat.size} вместо ${file.size}.`);
        }
      }
      job.state = 'INSTALLED';
      job.finishedAt = Date.now();
      this.#touch(job);
      // Остатки частичных файлов больше не нужны.
      await fsp.rm(path.join(job.dir, PART_DIR), { recursive: true, force: true });
      if (this.onInstalled) {
        try { await this.onInstalled({ ...job, abort: undefined }); }
        catch (error) { job.installError = String(error.message || error); this.#persist(); }
      }
    } catch (error) {
      if (job.cancelRequested || error.name === 'AbortError') {
        job.state = 'CANCELLED';
        job.error = 'Загрузка отменена.';
      } else {
        job.state = 'FAILED';
        job.error = String(error.message || error);
      }
      this.#touch(job);
    } finally {
      delete job.abort;
      delete job.cancelRequested;
    }
  }

  async #downloadFile(job, file, signal) {
    const target = safeJoin(job.dir, file.path);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    // Уже готовый файл нужного размера пропускаем: retry после обрыва
    // докачивает недостающее, а не начинается с нуля.
    try {
      const stat = await fsp.stat(target);
      if (file.size == null || stat.size === file.size) {
        file.done = true;
        return;
      }
    } catch { /* файла нет — качаем */ }

    const url = `${this.baseUrlFor(job)}/${file.path}`;
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} при загрузке ${file.path}.`);
    }
    // При отмене/ошибке посреди стрима соединение обязано вернуться в пул:
    // недочитанный body держит сокет и uv-хендл, без cancel() процесс
    // падает на teardown (uv_handle_closing под --test-force-exit).
    const part = path.join(job.dir, PART_DIR, file.path);
    await fsp.mkdir(path.dirname(part), { recursive: true });
    try {
      const written = await this.#pump(res.body, job, part);
      const expected = file.size;
      if (expected != null && written !== expected) {
        throw new Error(`Недокачан ${file.path}: ${written} из ${expected} байт.`);
      }
    } finally {
      await res.body.cancel().catch(() => {});
    }
    await fsp.rename(part, target);
    file.done = true;
    this.#touch(job);
  }

  async #pump(body, job, part) {
    const out = fs.createWriteStream(part);
    let written = 0;
    for await (const chunk of body) {
      out.write(chunk);
      written += chunk.length;
      job.downloadedBytes += chunk.length;
      this.#throttledPersist(job);
    }
    await new Promise((resolve, reject) => {
      out.end(resolve);
      out.on('error', reject);
    });
    return written;
  }

  baseUrlFor(job) {
    // Скачивание идёт через resolve-эндпоинт Хабра; сюда же подставляется
    // зеркало, если оно появится в конфиге.
    return job.resolveBase || `https://huggingface.co/${job.repo}/resolve/${job.revision}`;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw Object.assign(new Error('Задание не найдено.'), { code: 'NOT_FOUND' });
    if (!['QUEUED', 'DOWNLOADING', 'VERIFYING'].includes(job.state)) {
      throw Object.assign(new Error(`Задание уже завершено (${job.state}).`), { code: 'INPUT_INVALID' });
    }
    job.cancelRequested = true;
    job.abort?.abort();
    if (job.state === 'QUEUED' || job.state === 'VERIFYING') {
      job.state = 'CANCELLED';
      job.error = 'Загрузка отменена.';
      this.#touch(job);
    }
    return { ...job };
  }

  /** Повторить прерванное/неудавшееся задание. Готовые файлы пропускаются. */
  async retry(id) {
    const job = this.jobs.get(id);
    if (!job) throw Object.assign(new Error('Задание не найдено.'), { code: 'NOT_FOUND' });
    if (!['FAILED', 'INTERRUPTED', 'CANCELLED'].includes(job.state)) {
      throw Object.assign(new Error(`Задание в состоянии ${job.state}: повтор не нужен.`), { code: 'INPUT_INVALID' });
    }
    // Сбрасываем счётчик на реально недостающие файлы: скачанное раньше
    // входит в прогресс, иначе полоса прыгает назад.
    job.downloadedBytes = 0;
    for (const file of job.files) {
      const target = safeJoin(job.dir, file.path);
      let size = null;
      try { size = (await fsp.stat(target)).size; } catch { /* нет файла */ }
      if (file.size != null && size === file.size) {
        file.done = true;
        job.downloadedBytes += file.size;
      } else {
        file.done = false;
        if (size != null) job.downloadedBytes += size;
      }
    }
    job.error = null;
    this.#run(job).catch(() => {});
    return { ...job };
  }
}
