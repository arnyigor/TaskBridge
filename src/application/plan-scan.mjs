// Рекурсивный поиск Markdown-файлов в серверном workspace сессии (FP-UX-04B).
//
// Зачем отдельный модуль: это единственное место, где TaskBridge по запросу
// оператора обходит дерево проекта. Ошибаются здесь тихо и дорого — обход
// symlink/junction выводит за пределы проекта, служебные каталоги (`node_modules`,
// `build`) превращают нажатие в минуту ожидания, а чтение содержимого каждого
// файла делает сканирование чтением всего проекта.
//
// Поэтому:
//   * только относительные пути внутри workspace, реальный путь проверяется
//     (Windows junction приходит из readdir как symlink, но проверка realpath
//     остаётся: она же ловит каталог, подменённый ссылкой между вызовами);
//   * ссылки наружу и циклы ссылок не обходятся, а попадают в skippedLinks;
//   * служебные каталоги пропускаются по имени;
//   * глубина, число результатов, число каталогов и время ограничены, и ответ
//     честно говорит `partial: true`, а не притворяется полным;
//   * содержимое Markdown-файлов целиком не читается — только голова (headBytes)
//     для предварительной классификации, и она не считается вердиктом;
//   * ни Pi, ни Run не затрагиваются: это чтение файловой системы.

import fs from 'node:fs/promises';
import path from 'node:path';

export const PLAN_FILE_EXTENSION = /\.(md|markdown)$/i;

/** Служебные каталоги: в них не бывает плана, а обход стоит времени. */
export const SCAN_SKIP = new Set([
  '.git', '.gradle', '.idea', '.local', '.pi', '.taskbridge-input', '.vscode',
  'node_modules', 'build', 'dist', 'out', 'target', 'vendor', 'coverage',
  '__pycache__', 'venv', '.venv', 'data',
  // Движки и IDE держат рядом с документацией десятки тысяч служебных каталогов:
  // у Unreal это Binaries/Intermediate/DerivedDataCache/Saved (живой проект
  // 2026-10-27 — 2025 каталогов до первого файла), у Unity — Library/obj/Logs.
  'binaries', 'intermediate', 'deriveddatacache', 'saved', 'library', 'obj',
  'logs', 'temp', '.vs', '.next', '.nuxt', '.terraform'
]);

/** Каталоги-варианты: Saved_HEDeviceState, Saved_HEMiniHorror и т.п. */
export const SCAN_SKIP_PREFIX = ['saved_', 'deriveddatacache_'];

export const SCAN_DEFAULTS = Object.freeze({
  maxDepth: 8,
  maxResults: 500,
  // Запас на большие проекты: обход в ширину прошёл 2272 каталога за 700 мс
  // (живой Unreal-проект), а предел по времени остаётся главным ограничителем.
  maxDirs: 4000,
  maxMs: 1500,
  // Голова файла для предварительной классификации. Вердикт даёт только inspect
  // выбранного файла: одна голова не доказывает, что план исполним.
  headBytes: 2048,
  maxClassified: 200
});

const scanError = (code, message) => Object.assign(new Error(message), { code });

const insideRoot = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const skipDir = name => {
  const lower = String(name).toLowerCase();
  if (SCAN_SKIP.has(lower)) return true;
  return SCAN_SKIP_PREFIX.some(prefix => lower.startsWith(prefix));
};

const pathKey = value => (process.platform === 'win32' ? String(value).toLowerCase() : String(value));

/**
 * Предварительная классификация по голове файла: `VALID_MANAGED` — есть маркер
 * формата, `CONVERTIBLE` — нашёлся список шагов, `null` — по голове не понять.
 * Никогда не `NOT_A_PLAN`/`INVALID`: это решает inspect выбранного файла.
 */
export function classifyPlanHead(head) {
  const text = String(head || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return null;
  if (/^[ \t]*taskbridge_plan[ \t]*:[ \t]*\d+/m.test(text)) return 'VALID_MANAGED';
  if (/^[-*+][ \t]*\[(?: |x|X)\][ \t]+\S/m.test(text)) return 'CONVERTIBLE';
  return null;
}

async function readHead(fsImpl, absolute, bytes) {
  let handle;
  try {
    handle = await fsImpl.open(absolute, 'r');
  } catch {
    return '';
  }
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Список Markdown-файлов проекта. `query` фильтрует по имени и относительному
 * пути (регистронезависимо), чтобы большой проект оставался пригодным.
 */
export async function scanPlanFiles({
  root,
  query = '',
  maxDepth = SCAN_DEFAULTS.maxDepth,
  maxResults = SCAN_DEFAULTS.maxResults,
  maxDirs = SCAN_DEFAULTS.maxDirs,
  maxMs = SCAN_DEFAULTS.maxMs,
  headBytes = SCAN_DEFAULTS.headBytes,
  maxClassified = SCAN_DEFAULTS.maxClassified,
  fsImpl = fs,
  now = () => Date.now()
} = {}) {
  if (!root) throw scanError('SESSION_UNAVAILABLE', 'Рабочий каталог сессии ещё не создан.');
  const startedAt = now();
  let base;
  try {
    base = await fsImpl.realpath(root);
  } catch {
    throw scanError('SESSION_UNAVAILABLE', 'Рабочий каталог сессии не найден на диске.');
  }
  const baseStat = await fsImpl.stat(base).catch(() => null);
  if (!baseStat?.isDirectory()) throw scanError('SESSION_UNAVAILABLE', 'Рабочий каталог сессии не найден на диске.');

  const files = [];
  const skippedLinks = [];
  const seen = new Set([pathKey(base)]);
  const limited = { results: false, depth: false, dirs: false, time: false };
  let dirs = 0;
  const timeUp = () => now() - startedAt > maxMs;

  // Обход в ширину, а не в глубину. Разница решающая: у проекта с тяжёлым
  // каталогом (Unreal Content — 2669 подкаталогов) обход в глубину съедал весь
  // бюджет каталогов, так и не дойдя до соседнего Docs с документацией. В ширину
  // сначала читаются все каталоги одного уровня, поэтому документация первого
  // уровня видна всегда, каким бы тяжёлым ни был сосед.
  const queue = [{ dir: base, rel: '', depth: 0 }];
  const walk = async (dir, relBase, depth) => {
    dirs += 1;
    if (dirs > maxDirs) { limited.dirs = true; return; }
    let entries;
    try {
      entries = await fsImpl.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxResults) { limited.results = true; return; }
      if (timeUp()) { limited.time = true; return; }
      const name = String(entry.name);
      if (name.startsWith('.') || skipDir(name)) continue;
      const childRel = relBase ? `${relBase}/${name}` : name;
      const absolute = path.join(dir, name);
      // Ссылка (и junction, который Node отдаёт как симлинк) в обход не идёт:
      // куда она ведёт, решает realpath, а не имя.
      if (entry.isSymbolicLink()) {
        skippedLinks.push({ path: childRel, reason: 'LINK_SKIPPED' });
        continue;
      }
      if (entry.isDirectory()) {
        if (depth + 1 > maxDepth) { limited.depth = true; continue; }
        let real;
        try {
          real = await fsImpl.realpath(absolute);
        } catch {
          continue;
        }
        if (!insideRoot(base, real)) {
          skippedLinks.push({ path: childRel, reason: 'LINK_OUTSIDE' });
          continue;
        }
        if (seen.has(pathKey(real))) {
          skippedLinks.push({ path: childRel, reason: 'LINK_CYCLE' });
          continue;
        }
        seen.add(pathKey(real));
        queue.push({ dir: absolute, rel: childRel, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || !PLAN_FILE_EXTENSION.test(name)) continue;
      const stat = await fsImpl.stat(absolute).catch(() => null);
      if (!stat?.isFile()) continue;
      files.push({
        name,
        path: childRel,
        size: stat.size,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
        classification: null
      });
    }
  };

  while (queue.length > 0) {
    // Останавливаться надо с названной причиной: иначе обход прерывается «молча»
    // и ответ притворяется полным (тест про лимиты это и проверяет).
    if (files.length >= maxResults) { limited.results = true; break; }
    if (timeUp()) { limited.time = true; break; }
    const next = queue.shift();
    await walk(next.dir, next.rel, next.depth);
  }

  const needle = String(query || '').trim().toLowerCase();
  const matched = needle
    ? files.filter(file => `${file.path} ${file.name}`.toLowerCase().includes(needle))
    : files;
  matched.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Классифицируется только голова, и только в пределах бюджета: сканирование
  // не должно превращаться в чтение всего проекта.
  let classified = 0;
  for (const file of matched) {
    if (classified >= maxClassified || timeUp()) break;
    file.classification = classifyPlanHead(await readHead(fsImpl, path.join(base, file.path), headBytes));
    classified += 1;
  }

  const partial = Object.values(limited).some(Boolean) || classified < matched.length;
  return {
    path: '',
    query: String(query || ''),
    files: matched,
    // Сколько всего нашлось без фильтра: интерфейс говорит «показано N из M».
    total: files.length,
    classified,
    partial,
    limited,
    skippedLinks,
    limits: { maxDepth, maxResults, maxDirs, maxMs, headBytes, maxClassified },
    scanned: { dirs, files: files.length },
    elapsedMs: now() - startedAt
  };
}
