// Сколько места занимает сессия на диске компьютера.
//
// Это только ИЗМЕРЕНИЕ: ничего не удаляется, не обрезается и не ограничивается.
// Нужно оно потому, что сессия хранит сырой журнал кадров pi (аргументы
// инструментов и их вывод — bash stdout/stderr, содержимое файлов) и вложения, и
// набирает гигабайты незаметно для оператора: 2026-10-20 одна из сессий занимала
// 3,7 ГБ. Клиент показывает предупреждение, когда размер перешёл порог
// config.storage.warnSessionMb (по умолчанию 1 ГБ).
import fs from 'node:fs/promises';
import path from 'node:path';

/** Порог предупреждения в байтах: config.storage.warnSessionMb, иначе 1 ГБ. */
export function warnSessionBytes(config, fallbackMb = 1024) {
  const mb = Number(config?.storage?.warnSessionMb);
  return (Number.isFinite(mb) && mb > 0 ? mb : fallbackMb) * 1024 * 1024;
}

/**
 * Суммарный размер дерева каталогов.
 *
 * Симлинки и устройства не считаются (чужое дерево не разворачиваем), а обход
 * ограничен числом записей: измерение не имеет права подвиснуть на огромной
 * папке — лучше вернуть `partial: true`, чем держать запрос.
 */
export async function measureTree(dir, maxEntries = 20000) {
  let bytes = 0;
  let files = 0;
  let entries = 0;
  let partial = false;
  const stack = [dir];
  while (stack.length && !partial) {
    const current = stack.pop();
    let list;
    try {
      list = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue; // каталога нет: сессия ещё ничего не писала — это норма, не ошибка
    }
    for (const entry of list) {
      if (++entries > maxEntries) {
        partial = true;
        break;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      bytes += stat.size;
      files += 1;
    }
  }
  return { bytes, files, partial };
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();

/** Размер сессии: артефакты, вложения, рабочая копия и нативная сессия pi. Кэш 5 минут. */
export async function sessionStorage({ dataRoot, taskId, now = Date.now(), ttlMs = TTL_MS }) {
  const cached = cache.get(taskId);
  if (cached && now - cached.at < ttlMs) return cached.value;
  let bytes = 0;
  let files = 0;
  let partial = false;
  for (const area of ['tasks', 'pi-sessions', 'workspaces']) {
    const tree = await measureTree(path.join(dataRoot, area, taskId));
    bytes += tree.bytes;
    files += tree.files;
    partial = partial || tree.partial;
  }
  const value = { id: taskId, bytes, files, partial, computedAt: new Date(now).toISOString() };
  cache.set(taskId, { at: now, value });
  return value;
}

/** Забыть измерение: без id — весь кэш (удаление сессии, тесты). */
export function forgetSessionStorage(taskId) {
  if (taskId === undefined) cache.clear();
  else cache.delete(taskId);
}
