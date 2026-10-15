// Ключ проекта для каталога памяти (этап M1 плана улучшений, §1.5).
//
// Зачем: каталог памяти назывался basename'ом корня репозитория (так его называло
// расширение pi-memory-md — «как Pi инжектит»). Два разных репозитория с одинаковым
// именем каталога («api», «web», «scratch») попадали в одну папку, и знание одного
// проекта утекало в контекст другого. Расширения больше нет (удалено 2026-09-21),
// поэтому совместимость с его схемой имён больше никого не держит.
//
// Ключ = человекочитаемый слаг + 8 символов sha256 от канонического корня:
//   G:\Android\AndroidStudioProjects\Taskbridge → taskbridge-1f86f591
// Слаг нужен человеку (каталог читается глазами), хеш — уникальности.
//
// Миграция НЕ выполняется молча при старте: переименование папок в архиве
// оператора — это его данные. Модуль умеет построить план (planMigration) и
// выполнить его (applyMigration) — вызывающий решает, когда.

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export const MEMORY_META_FILE = 'meta.json';
export const META_VERSION = 1;

/** Scratch-сессии живут в своей папке без привязки к репозиторию. */
export const SCRATCH_KEY = 'scratch';

/**
 * Слаг для имени каталога: буквы (включая кириллицу — каталог читает человек),
 * цифры и дефис. Всё остальное — дефис, регистр приводится к нижнему (Windows
 * не различает регистр, и `Taskbridge`/`taskbridge` иначе выглядели бы как две
 * разные памяти).
 */
export function memorySlug(text) {
  const slug = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'project';
}

/** 8 hex-символов от канонического корня: различает одноимённые проекты. */
export function rootHash(canonicalRoot) {
  const normalized = String(canonicalRoot || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Ключ проекта. [canonicalRoot] — корень основного checkout'а (не worktree: у
 * worktree каталог .git общий, и знание принадлежит проекту, а не ветке), для
 * scratch — не передаётся.
 */
export function memoryKey({ canonicalRoot = null, name = null, scratch = false } = {}) {
  if (scratch) return SCRATCH_KEY;
  if (!canonicalRoot) return SCRATCH_KEY;
  const slug = memorySlug(name || path.basename(String(canonicalRoot).replaceAll('\\', '/')));
  return `${slug}-${rootHash(canonicalRoot)}`;
}

/** Каталог памяти этого ключа внутри корня памяти. */
export function memoryDirFor(root, key) {
  return path.join(root, key);
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

/**
 * meta.json в корне памяти: сопоставление ключей с корнями и каталогами.
 * Здесь же остаётся след миграции — по нему видно, откуда переехала папка.
 */
export async function readMeta(root) {
  const meta = await readJson(path.join(root, MEMORY_META_FILE));
  if (!meta || typeof meta !== 'object' || typeof meta.projects !== 'object' || meta.projects === null) {
    return { version: META_VERSION, projects: {} };
  }
  return { version: META_VERSION, ...meta, projects: { ...meta.projects } };
}

export async function writeMeta(root, meta) {
  const file = path.join(root, MEMORY_META_FILE);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: META_VERSION, ...meta }, null, 2) + '\n', 'utf8');
  return file;
}

async function dirExists(dir) {
  const stat = await fs.stat(dir).catch(() => null);
  return Boolean(stat?.isDirectory());
}

/**
 * План переезда старых каталогов (basename) в ключевые.
 *
 * Возвращает по каждому проекту:
 *   { status: 'keep', key }            — уже по ключу (или каталога нет);
 *   { status: 'move', from, to, key }  — одна папка, переезд однозначен;
 *   { status: 'collision', from, key, projects } — папка ОДНА, а проектов с таким
 *     именем несколько: какой из них владеет знанием — неизвестно, поэтому
 *     модуль не угадывает и ничего не двигает. Причина, по которой это вообще
 *     важно: раньше такие проекты молча делили одну память (D1).
 *   { status: 'blocked', reason }      — цель занята другим каталогом.
 */
export async function planMigration({ root, projects = [] } = {}) {
  const meta = await readMeta(root);
  const byLegacyDir = new Map();
  for (const project of projects) {
    if (!project?.canonicalRoot && !project?.scratch) continue;
    const key = memoryKey(project);
    const legacyName = project.scratch ? null : path.basename(String(project.canonicalRoot).replaceAll('\\', '/'));
    const list = byLegacyDir.get(legacyName || '') || [];
    list.push({ ...project, key });
    byLegacyDir.set(legacyName || '', list);
  }

  const plan = [];
  for (const project of projects) {
    if (!project?.canonicalRoot && !project?.scratch) continue;
    const key = memoryKey(project);
    const target = memoryDirFor(root, key);
    const legacyDir = project.scratch ? null : memoryDirFor(root, String(project.canonicalRoot).replaceAll('\\', '/').split('/').filter(Boolean).pop());

    if (await dirExists(target)) {
      plan.push({ status: 'keep', key, dir: target, project });
      continue;
    }
    if (!legacyDir) { plan.push({ status: 'keep', key, dir: target, project }); continue; }
    if (!(await dirExists(legacyDir))) {
      plan.push({ status: 'keep', key, dir: target, legacyDir, project });
      continue;
    }
    const owners = byLegacyDir.get(path.basename(legacyDir)) || [];
    if (owners.length > 1) {
      plan.push({ status: 'collision', key, from: legacyDir, to: target, projects: owners, project });
      continue;
    }
    if (meta.projects[key]?.dir && path.resolve(meta.projects[key].dir) !== path.resolve(target)) {
      plan.push({ status: 'blocked', key, from: legacyDir, to: target, reason: 'meta already points at another directory', project });
      continue;
    }
    plan.push({ status: 'move', key, from: legacyDir, to: target, project });
  }
  return plan;
}

/**
 * Выполняет план: переезды + запись маппинга в meta. Идемпотентно: повторный
 * вызов на уже переехавших каталогах ничего не делает (план вернёт `keep`).
 * [dryRun] возвращает, что было бы сделано, ничего не трогая.
 */
export async function applyMigration({ root, plan, dryRun = false } = {}) {
  const meta = await readMeta(root);
  const moved = [];
  const skipped = [];
  for (const entry of plan || []) {
    if (entry.status !== 'move') {
      if (entry.status === 'collision' || entry.status === 'blocked') skipped.push(entry);
      continue;
    }
    if (!dryRun) {
      await fs.mkdir(root, { recursive: true });
      await fs.rename(entry.from, entry.to);
    }
    meta.projects[entry.key] = {
      dir: entry.to,
      canonicalRoot: entry.project?.canonicalRoot ?? null,
      // Слаг без хеша: по нему человек ищет проект в meta глазами.
      slug: memorySlug(path.basename(String(entry.key).replaceAll('/', '\\'))),
      legacyDir: entry.from,
      migratedAt: new Date().toISOString(),
    };
    moved.push(entry);
  }
  if (!dryRun && moved.length) await writeMeta(root, meta);
  return { moved, skipped, meta };
}
