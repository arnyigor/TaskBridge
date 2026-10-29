import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectFileIndex, anyPathExists } from './path-patterns.mjs';
import { MemoryIndex } from './memory-index.mjs';
import { memoryKey } from './project-key.mjs';

const exec = promisify(execFile);

const DEFAULT_MEMORY_ROOT = path.join(os.homedir(), '.pi', 'memory-md');
const MAX_FILE_BYTES = 256 * 1024;
const MAX_HITS = 12;

/** Директория глобальных знаний (общая для всех проектов) и их ключ в индексе. */
export const GLOBAL_SCOPE_DIR = '_global';
export const GLOBAL_INDEX_KEY = '__global__';

/**
 * Дефолты бюджета инъекции (план §1.5): индекс проекта — 2000 токенов, глобальный
 * мини-бюджет — 400. Сервер передаёт значения из конфига (`memory.*`), здесь —
 * фолбэк для прямых вызовов в тестах.
 */
export const INDEX_BUDGET_TOKENS = 2000;
export const GLOBAL_BUDGET_TOKENS = 400;

/**
 * Вес категории при ранжировании: решение и ограничение важнее «прочего».
 * Порядок из плана: pinned → category weight → релевантность → давность.
 */
const CATEGORY_WEIGHT = Object.freeze({
  decision: 5, constraint: 4, architecture: 3, pattern: 2, 'known-issue': 2, other: 0,
});
// Категории памяти: и то, чем помечается найденная заметка, и то, что можно
// предложить. Один словарь — чтобы предложение не могло «изобрести» категорию.
export const MEMORY_CATEGORIES = Object.freeze(['architecture', 'decision', 'constraint', 'pattern', 'known-issue', 'other']);
const CATEGORY_BY_TEXT = [
  ['architecture', /\barchitecture\b|архитектур/iu],
  ['decision', /\bdecision\b|решени[ея]/iu],
  ['constraint', /\bconstraint\b|ограничени/iu],
  ['pattern', /\bpattern\b|паттерн|соглашени/iu],
  ['known-issue', /known[- ]issue|gotcha|проблем|ошибк/iu],
];

function defaultRoot() {
  return process.env.TASKBRIDGE_PROJECT_MEMORY_ROOT || DEFAULT_MEMORY_ROOT;
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function hashText(text) {
  return crypto.createHash('sha256').update(normalizeText(text)).digest('hex').slice(0, 16);
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { data: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: raw };
  const data = {};
  for (const line of raw.slice(4, end).split(/\r?\n/u)) {
    const match = /^(\w[\w-]*):\s*(.*)$/u.exec(line.trim());
    if (!match) continue;
    const value = match[2].trim().replace(/^['"](.*)['"]$/u, '$1');
    data[match[1]] = value;
  }
  return { data, body: raw.slice(raw.indexOf('\n', end + 1) + 1).trim() };
}

function categoryOf(file, data, text) {
  const haystack = `${file}\n${data.category || ''}\n${data.tags || ''}\n${data.description || ''}\n${text}`;
  const explicit = String(data.category || '').trim();
  if (MEMORY_CATEGORIES.includes(explicit)) return explicit;
  return CATEGORY_BY_TEXT.find(([, re]) => re.test(haystack))?.[0] ?? 'other';
}

async function git(args, cwd) {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function gitToplevel(cwd) {
  try { return await git(['rev-parse', '--show-toplevel'], cwd); } catch { return null; }
}

async function gitCommonProjectRoot(cwd) {
  try {
    const top = await gitToplevel(cwd);
    if (!top) return null;
    const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
    // Linked worktree: common dir is <main-worktree>/.git, so the project memory
    // key is the main checkout basename, not the feature worktree basename.
    if (path.basename(common) === '.git') return path.dirname(common);
    return top;
  } catch {
    return null;
  }
}

async function listMarkdown(dir) {
  const out = [];
  async function walk(current) {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full);
    }
  }
  await walk(dir);
  return out.sort();
}

async function readMemoryFile(file, memoryDir, { projectPath = null, fileIndex = null } = {}) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return null;
  const limited = raw.length > MAX_FILE_BYTES ? raw.slice(0, MAX_FILE_BYTES) : raw;
  const { data, body } = parseFrontmatter(limited);
  const relative = path.relative(memoryDir, file).replaceAll(path.sep, '/');
  const text = (body || data.description || '').trim();
  const declaredPaths = declaredPathsOf(data.paths);
  return {
    id: hashText(`${relative}\n${text}`),
    text,
    category: categoryOf(relative, data, text),
    source: relative,
    updatedAt: stat.mtime.toISOString(),
    description: data.description || null,
    tags: data.tags || null,
    // M3: `modified` — когда знание менялось по существу (свежее mtime, который
    // двигает любой редактор), `supersedes` — какую заметку эта заменяет.
    modified: typeof data.modified === 'string' && data.modified.trim() ? data.modified.trim() : null,
    supersedes: typeof data.supersedes === 'string' && data.supersedes.trim() ? data.supersedes.trim() : null,
    // Этап M1 (бюджет и ранжирование): `pinned: true` в frontmatter — заметка
    // оператора «держать всегда»: она инжектится первой, до весов категорий.
    pinned: data.pinned === true || String(data.pinned || '').toLowerCase() === 'true',
    paths: declaredPaths,
    // A note that names files, none of which exist any more, describes a project
    // that is not there. TaskBridge does NOT delete it and does not guess that it
    // is «probably» still true: it stops handing it to an agent and says why.
    // Шаблоны сверяются со списком файлов проекта, поэтому переезд папки на уровень
    // глубже не убивает живую заметку.
    stale: !anyPathExists(declaredPaths, { projectPath, index: fileIndex }),
    provenance: { file: relative },
    estimatedTokens: estimateTokens(text),
  };
}

/**
 * Помечает заметки, которые заменены другими (M3).
 *
 * Замена адресуется путём заметки (`supersedes: core/project/old.md`), её именем
 * файла или id — человеку проще написать путь, а id меняется вместе с текстом.
 * Заменённая заметка выпадает из ИНЪЕКЦИИ (её знание уже неверно или неполно), но
 * остаётся в ПОИСКЕ с пометкой: история решения тоже знание.
 */
export function markSuperseded(entries = [], targets = []) {
  const wanted = new Set(targets.map(value => String(value || '').trim()).filter(Boolean));
  if (!wanted.size) return entries;
  const supersededBy = new Map();
  for (const entry of entries) {
    if (!entry?.supersedes) continue;
    let key = String(entry.supersedes).split('\\').join('/');
    if (key.startsWith('./')) key = key.slice(2);
    supersededBy.set(key, entry.source);
    supersededBy.set(key.split('/').pop(), entry.source);
  }
  return entries.map(entry => {
    const source = String(entry?.source || '');
    if (wanted.has(source) || wanted.has(source.split('/').pop()) || wanted.has(entry?.id)) {
      const bySource = supersededBy.get(source) ?? supersededBy.get(source.split('/').pop()) ?? null;
      return { ...entry, superseded: true, supersededBy: bySource };
    }
    return entry;
  });
}

/** `paths: a.mjs, b/` — the only form of invalidation TaskBridge can prove. */
function declaredPathsOf(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\s]+/u)
    .map(item => item.trim().replace(/^["']|["']$/gu, ''))
    .filter(Boolean)
    .slice(0, 20);
}


function queryTerms(query) {
  return normalizeText(query).split(/[^\p{L}\p{N}_-]+/u).filter(term => term.length >= 3).slice(0, 20);
}

// Scoring looks at the note's NAME, its frontmatter and its text — not at the
// directories above it. «core/project/» is in every path here, so including it
// would make the word «project» match the whole memory and drown the signal.
// Words are compared as words, not as substrings: «not» must not match
// «monotonic», or one generic query term pulls in unrelated notes. A term also
// matches a word it starts, which is what makes «курсор» find «курсора».
function words(text) {
  return normalizeText(text).split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
}

function scoreEntry(entry, terms) {
  if (!terms.length) return 0;
  const name = String(entry.source || '').split('/').pop();
  const haystack = words(`${name} ${entry.description || ''} ${entry.tags || ''} ${entry.text}`);
  return terms.reduce((sum, term) => sum + (haystack.some(word => word.startsWith(term)) ? 1 : 0), 0);
}

function excerpt(text, terms, maxChars) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const lower = clean.toLowerCase();
  const pos = terms.map(term => lower.indexOf(term.toLowerCase())).find(index => index >= 0) ?? 0;
  const start = Math.max(0, pos - Math.floor(maxChars / 3));
  const slice = clean.slice(start, start + maxChars).trim();
  return `${start > 0 ? '…' : ''}${slice}${start + maxChars < clean.length ? '…' : ''}`;
}

/**
 * Two DIFFERENT repositories whose canonical roots share a directory name map to
 * one memory directory — that is how pi-memory-md names projects (basename of the
 * git toplevel), so TaskBridge cannot fix it by renaming the folder without
 * reading a directory Pi never injects. What it can do is refuse to pretend: the
 * inspector and the resume warnings name the collision instead of silently mixing
 * two projects' knowledge.
 */
export function memoryCollisions(resolved = []) {
  const byDir = new Map();
  for (const entry of resolved) {
    if (!entry?.memoryDir) continue;
    const key = entry.repoRoot || entry.projectPath || entry.projectId || entry.projectName;
    const group = byDir.get(entry.memoryDir) || new Map();
    group.set(key, entry);
    byDir.set(entry.memoryDir, group);
  }
  const collisions = [];
  for (const [memoryDir, group] of byDir) {
    if (group.size < 2) continue;
    collisions.push({
      memoryDir,
      projects: [...group.values()].map(entry => ({ projectId: entry.projectId ?? null, root: entry.repoRoot || entry.projectPath || null })),
    });
  }
  return collisions.sort((a, b) => a.memoryDir.localeCompare(b.memoryDir));
}

export class PiMemoryMdProvider {
  /**
   * [indexPath] — ФТС5-индекс как кэш поиска (этап M1). Если файла нет, он создатся;
   * если индекс недоступен (битый файл, нет места), память продолжает работать
   * обходом файлов: индекс — ускорение, а не условие.
   */
  constructor({ root = defaultRoot(), indexPath = null } = {}) {
    // `null` in config means «the default location», not «no memory root».
    this.root = path.resolve(root || defaultRoot());
    this.indexPath = indexPath ? path.resolve(indexPath) : null;
    this.index = null;
    this.indexError = null;
  }

  /**
   * Индекс открывается лениво — при первом обращении к памяти. Сервер, которому
   * память не понадобилась, не держит файл БД открытым: на Windows это мешало
   * удалению каталога данных (EBUSY в тестах и при удалении сессии).
   */
  #openIndex() {
    if (this.index || !this.indexPath) return this.index;
    try {
      this.index = new MemoryIndex({ dbPath: this.indexPath });
    } catch (error) {
      this.indexError = error.message;
    }
    return this.index;
  }

  /** Закрыть индекс: вызывается при остановке сервера. */
  closeIndex() {
    try { this.index?.close(); } catch { /* кэш, терять нечего */ }
    this.index = null;
  }

  /** Ключ проекта для индекса: слаг + хеш канонического корня (этап M1). */
  #indexKey(resolved, project = {}) {
    const scratch = project.id === '__scratch__' || resolved.projectId === '__scratch__';
    // Без пути (проект из реестра без папки, тесты) каноническим корнем становится
    // сам каталог памяти: ключ остаётся стабильным, а не «scratch» для всего подряд.
    return memoryKey({
      canonicalRoot: scratch ? null : (resolved.repoRoot || resolved.projectPath || resolved.memoryDir),
      name: resolved.projectName,
      scratch,
    });
  }

  /**
   * Приводит индекс в соответствие каталогу: по `mtime + size` — без чтения
   * неизменённых файлов (fs-watcher на Windows ненадёжен и не нужен).
   */
  async #syncIndex(resolved, files, project = {}) {
    const index = this.#openIndex();
    if (!index) return null;
    const key = this.#indexKey(resolved, project);
    const seen = [];
    for (const file of files) {
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      const relative = path.relative(resolved.memoryDir, file).replaceAll(path.sep, '/');
      const noteId = `${key}:${relative}`;
      seen.push(noteId);
      if (!index.needsUpdate(noteId, { mtimeMs: stat.mtimeMs, sizeBytes: stat.size })) continue;
      const entry = await readMemoryFile(file, resolved.memoryDir, { projectPath: resolved.projectPath });
      if (!entry) continue;
      const { data } = parseFrontmatter(await fs.readFile(file, 'utf8').catch(() => ''));
      index.upsertNote({
        noteId,
        scope: 'project',
        projectKey: key,
        category: entry.category,
        relPath: relative,
        description: entry.description || '',
        tags: Array.isArray(data.tags) ? data.tags.join(', ') : String(data.tags || ''),
        supersedes: entry.supersedes || '',
        body: entry.text || '',
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        updatedAt: entry.updatedAt,
      });
    }
    index.pruneMissing(key, seen);
    return key;
  }

  /**
   * Все живые записи проекта с пометкой заменённых — материал для консолидатора (M3).
   *
   * Заменённые заметки тоже возвращаются (с `superseded: true`): консолидатор их
   * отфильтрует сам, зато вызывающий видит полную картину памяти.
   */
  async searchableEntries(project = {}) {
    const resolved = await this.resolveProject(project);
    if (!fsSync.existsSync(resolved.coreDir)) return [];
    const entries = await this.allEntries({ path: resolved.projectPath });
    const index = this.#openIndex();
    if (index) await this.#syncIndex(resolved, await listMarkdown(resolved.coreDir), project).catch(() => null);
    return markSuperseded(entries, this.#supersedeTargetsFromCache(resolved, project, entries));
  }

  /**
   * Записи проекта с метаданными использования из индекса (этап M2, инспектор).  /**
   * Записи проекта с метаданными использования из индекса (этап M2, инспектор).
   * Без индекса метаданные пусты, но список записей остаётся: инспектор не
   * должен зависеть от кэша.
   */
  async indexedNotes(project = {}) {
    const resolved = await this.resolveProject(project);
    if (!fsSync.existsSync(resolved.coreDir)) return [];
    const index = this.#openIndex();
    let usage = new Map();
    if (index) {
      await this.#syncIndex(resolved, await listMarkdown(resolved.coreDir), project).catch(() => null);
      usage = index.usage(this.#indexKey(resolved, project));
    }
    const entries = await this.allEntries({ path: resolved.projectPath });
    return entries.map(entry => ({
      source: entry.source,
      category: entry.category,
      description: entry.description,
      updatedAt: entry.updatedAt,
      estimatedTokens: entry.estimatedTokens,
      useCount: usage.get(entry.source)?.useCount ?? 0,
      lastUsedAt: usage.get(entry.source)?.lastUsedAt ?? null,
    }));
  }

  /** Состояние индекса: сколько записей и сколько раз память использовалась. */
  async indexStatus(project = {}) {
    const index = this.#openIndex();
    if (!index) return { available: false, notes: 0, uses: 0, error: this.indexError };
    const resolved = await this.resolveProject(project);
    const stats = index.stats({ projectKey: this.#indexKey(resolved, project) });
    return { available: true, notes: stats.notes, uses: stats.uses, lastUsedAt: stats.lastUsedAt, approxTokens: stats.approxTokens };
  }

  /**
   * Поиск по скоупам (этап M2): `project` | `global` | `all`.
   * `all` — режим cross-project: его результаты в инъекцию сами по себе не
   * попадают, но человеку и агенту видны, с пометкой происхождения (scope).
   */
  async searchScope(query, options = {}) {
    return (await this.searchScopePage(query, options)).hits;
  }

  /** Filter and deduplicate all matches BEFORE slicing a page. The index
   * selects candidates; reading matching bodies is necessary to validate dynamic
   * path staleness and exact deduplication. No 50/200-file storage cutoff. */
  async searchScopePage(query, { scope = 'project', project = null, limit = 20, offset = 0 } = {}) {
    const take = Math.max(1, Math.min(50, Number(limit) || 20));
    const skip = Math.max(0, Math.floor(Number(offset) || 0));
    const selections = [];
    if ((scope === 'project' || scope === 'all') && project) {
      selections.push(await this.#scopeSearchHits(query, 'project', project));
    }
    if (scope === 'global' || scope === 'all') {
      selections.push(await this.#scopeSearchHits(query, 'global', project));
    }
    const ranked = selections.flatMap(selection => selection.hits);
    ranked.sort((a, b) => b.score - a.score
      || Number(a.category === 'other') - Number(b.category === 'other')
      || String(b.updatedAt).localeCompare(String(a.updatedAt))
      || String(a.source).localeCompare(String(b.source))
      || String(a.scope).localeCompare(String(b.scope)));
    const seen = new Set();
    const unique = ranked.filter(hit => {
      if (seen.has(hit.dedupKey)) return false;
      seen.add(hit.dedupKey);
      return true;
    });
    const sources = new Set(selections.map(selection => selection.source));
    return {
      hits: unique.slice(skip, skip + take).map(({ dedupKey, ...hit }) => hit),
      total: unique.length,
      matched: selections.reduce((sum, selection) => sum + selection.matched, 0),
      limit: take,
      offset: skip,
      counts: {
        projectTotal: unique.filter(hit => hit.scope === 'project').length,
        globalTotal: unique.filter(hit => hit.scope === 'global').length,
        matchedProject: selections.find(selection => selection.scope === 'project')?.matched ?? 0,
        matchedGlobal: selections.find(selection => selection.scope === 'global')?.matched ?? 0,
      },
      source: sources.size > 1 ? 'mixed' : [...sources][0] ?? 'files',
    };
  }

  async #scopeSearchHits(query, scope, project) {
    const global = scope === 'global';
    const resolved = global
      ? { memoryDir: this.root, coreDir: path.join(this.root, GLOBAL_SCOPE_DIR), projectPath: null }
      : await this.resolveProject(project);
    const terms = queryTerms(query);
    const files = fsSync.existsSync(resolved.coreDir) ? await listMarkdown(resolved.coreDir) : [];
    const fileIndex = global ? null : await projectFileIndex(resolved.projectPath);
    const index = this.#openIndex();
    const hits = [];
    let source = 'files';
    let matched = 0;
    const add = async (file, score = null) => {
      const entry = await readMemoryFile(file, resolved.memoryDir, { projectPath: resolved.projectPath, fileIndex });
      if (!entry) return;
      const rank = score ?? scoreEntry(entry, terms);
      if (score === null && terms.length && rank <= 0) return;
      if (score === null) matched += 1;
      if (entry.stale) return;
      hits.push({ ...entry, scope, score: rank, dedupKey: hashText(entry.text),
        text: excerpt(entry.text || '', terms, 700) });
    };
    if (index && terms.length && files.length) {
      try {
        const key = global ? await this.#syncGlobal() : await this.#syncIndex(resolved, files, project);
        matched = index.searchCount(query, { projectKey: key, scope });
        // Bound the scan to the initial candidate count even under concurrent updates.
        for (let offset = 0; offset < matched; offset += 50) {
          const rows = index.search(query, { projectKey: key, scope, limit: 50, offset });
          for (const row of rows) await add(path.join(resolved.memoryDir, row.relPath), -row.score);
        }
        source = 'index';
      } catch (error) {
        this.indexError = error.message;
        hits.length = 0;
        matched = 0;
      }
    }
    if (source === 'files') {
      for (const file of files) await add(file);
    }
    const marked = global ? hits : markSuperseded(hits, this.#supersedeTargetsFromCache(resolved, project, hits));
    return { scope, hits: marked, matched, source };
  }

  /**
   * Счётчик глобальных заметок без чтения содержимого (MEM-05A).
   *
   * `stored` — сколько файлов есть в `_global` на диске, `indexed` — сколько из
   * них знает индекс. Это размер ХРАНИЛИЩА: рост числа заметок не меняет ни
   * бюджет инъекции (`#globalHits`), ни размер выдачи поиска.
   */
  async globalStats() {
    const dir = path.join(this.root, GLOBAL_SCOPE_DIR);
    const files = fsSync.existsSync(dir) ? await listMarkdown(dir) : [];
    let indexed = null;
    if (this.index) {
      try { indexed = this.index.stats({ projectKey: GLOBAL_INDEX_KEY }).notes; } catch { indexed = null; }
    }
    return { dir: path.resolve(this.root), scopeDir: GLOBAL_SCOPE_DIR, stored: files.length, indexed };
  }

  /**
   * Глобальные знания (markdown-файлы внутри `<root>/_global`): предпочтения
   * оператора и кросс-проектные договорённости. Живут в индексе под своим ключом
   * и инжектятся с отдельным мини-бюджетом.
   */
  async globalEntries({ limit = 100 } = {}) {
    const dir = path.join(this.root, GLOBAL_SCOPE_DIR);
    if (!fsSync.existsSync(dir)) return [];
    const files = await listMarkdown(dir);
    const entries = [];
    for (const file of files) {
      const entry = await readMemoryFile(file, this.root, { projectPath: null });
      if (entry && !entry.stale) entries.push({ ...entry, scope: 'global' });
    }
    const sorted = entries.sort((a, b) => String(a.source).localeCompare(String(b.source)));
    // Чтение содержимого — дорогая часть: считать заметки нужно через
    // globalStats(), а не через `limit: 0` (MEM-05A).
    return sorted.slice(0, limit);
  }

  /** Глобальный каталог в индекс: тот же контракт mtime+size, свой ключ. */
  async #syncGlobal() {
    const index = this.#openIndex();
    if (!index) return null;
    const dir = path.join(this.root, GLOBAL_SCOPE_DIR);
    if (!fsSync.existsSync(dir)) return null;
    const files = await listMarkdown(dir);
    const seen = [];
    for (const file of files) {
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      const relative = path.relative(this.root, file).replaceAll(path.sep, '/');
      const noteId = `${GLOBAL_INDEX_KEY}:${relative}`;
      seen.push(noteId);
      if (!index.needsUpdate(noteId, { mtimeMs: stat.mtimeMs, sizeBytes: stat.size })) continue;
      const entry = await readMemoryFile(file, this.root, { projectPath: null });
      if (!entry) continue;
      const { data } = parseFrontmatter(await fs.readFile(file, 'utf8').catch(() => ''));
      index.upsertNote({
        noteId,
        scope: 'global',
        projectKey: GLOBAL_INDEX_KEY,
        category: entry.category,
        relPath: relative,
        description: entry.description || '',
        tags: Array.isArray(data.tags) ? data.tags.join(', ') : String(data.tags || ''),
        body: entry.text || '',
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        updatedAt: entry.updatedAt,
      });
    }
    index.pruneMissing(GLOBAL_INDEX_KEY, seen);
    return GLOBAL_INDEX_KEY;
  }

  /** Кандидаты из индекса: только те файлы, которые действительно стоит читать. */
  async #indexCandidates(resolved, query, project, limit) {
    const index = this.#openIndex();
    if (!index) return null;
    const key = this.#indexKey(resolved, project);
    const rows = index.search(query, { projectKey: key, limit: Math.max(limit * 3, 12) });
    if (!rows.length) return { key, files: [], scores: new Map() };
    const scores = new Map();
    const files = [];
    for (const row of rows) {
      const file = path.join(resolved.memoryDir, row.relPath);
      files.push(file);
      // BM25 в FTS5 отрицателен: меньше — лучше, поэтому знак меняем, чтобы
      // порядок «больше — лучше» остался прежним для вызывающих.
      scores.set(file, -row.score);
    }
    return { key, files, scores };
  }

  /** The identity of every registered project at once — what collision detection needs. */
  async resolveProjects(projects = []) {
    const resolved = [];
    for (const project of projects) {
      if (!project) continue;
      resolved.push({ projectId: project.id ?? null, ...(await this.resolveProject(project)) });
    }
    return resolved;
  }

  async resolveProject(project = {}) {
    const projectPath = project.path ? path.resolve(project.path) : null;
    const repoRoot = projectPath ? await gitCommonProjectRoot(projectPath) : null;
    const projectName = path.basename(repoRoot || projectPath || project.name || project.id || 'project');
    const memoryDir = path.join(this.root, projectName);
    const coreDir = path.join(memoryDir, 'core');
    return { projectPath, repoRoot, projectName, memoryDir, coreDir };
  }

  async inspect(project = {}) {
    const resolved = await this.resolveProject(project);
    const gateOpen = fsSync.existsSync(resolved.coreDir);
    const files = gateOpen ? await listMarkdown(resolved.coreDir) : [];
    const fileIndex = gateOpen ? await projectFileIndex(resolved.projectPath) : null;
    const entries = [];
    for (const file of files) {
      const entry = await readMemoryFile(file, resolved.memoryDir, { projectPath: resolved.projectPath, fileIndex });
      if (entry) entries.push(entry);
    }
    const stale = entries.filter(entry => entry.stale);
    const live = entries.filter(entry => !entry.stale);
    const indexChars = entries.reduce((sum, entry) => sum + (entry.description || entry.source).length + 80, 260);
    return {
      provider: 'pi-memory-md',
      status: gateOpen ? 'available' : 'unavailable',
      write: 'SAVE_DISABLED',
      projectRoot: resolved.repoRoot || resolved.projectPath,
      projectName: resolved.projectName,
      memoryDir: resolved.memoryDir,
      coreDir: resolved.coreDir,
      injectedAutomatically: gateOpen,
      entries: entries.length,
      approxTokens: Math.ceil(indexChars / 4),
      categories: entries.reduce((acc, entry) => { acc[entry.category] = (acc[entry.category] || 0) + 1; return acc; }, {}),
      // Не удалено и не переписано — просто больше не отдаётся агенту, пока в
      // заметке не появятся существующие пути. Инспектор показывает их список.
      stale: { count: stale.length, sources: stale.map(entry => ({ source: entry.source, paths: entry.paths })) },
      liveEntries: live.length,
      problems: gateOpen ? [] : ['pi-memory-md core directory is missing; project memory will not be injected'],
    };
  }

  async status(project = {}) {
    const overview = await this.inspect(project);
    return {
      provider: overview.provider,
      status: overview.status,
      write: overview.write,
      projectRoot: overview.projectRoot,
      projectName: overview.projectName,
      entries: overview.entries,
      approxTokens: overview.approxTokens,
      problems: overview.problems,
    };
  }

  async search(project = {}, query = '', { limit = MAX_HITS, maxChars = 700, includeStale = false, fileIndex = null } = {}) {
    const resolved = await this.resolveProject(project);
    if (!fsSync.existsSync(resolved.coreDir)) return [];
    const terms = queryTerms(query);
    const files = await listMarkdown(resolved.coreDir);
    const hits = [];
    // The file list is built once by the caller when several queries are asked
    // (`relevant`): a git call per query would be work for nothing.
    const index = fileIndex ?? await projectFileIndex(resolved.projectPath);
    // Этап M1: индекс выбирает кандидатов по BM25, и читаются только они.
    // Запрос без нормальных термов (однобуквенный) идёт прежним путём —
    // иначе он внезапно перестал бы находить хоть что-то.
    const selection = terms.length && this.#openIndex()
      ? await this.#syncIndex(resolved, files, project)
        .then(() => this.#indexCandidates(resolved, query, project, limit))
        .catch(error => { this.indexError = error.message; return null; })
      : null;
    const candidates = selection ? selection.files : files;
    for (const file of candidates) {
      const entry = await readMemoryFile(file, resolved.memoryDir, { projectPath: resolved.projectPath, fileIndex: index });
      if (!entry) continue;
      // A note whose declared files are gone is not knowledge about this project
      // any more: it is not «maybe still true», it is unverifiable.
      if (entry.stale && !includeStale) continue;
      // С индексом релевантность приходит от BM25 (кандидаты уже отобраны), без
      // него — прежний скоринг по вхождениям термов.
      const score = selection ? (selection.scores.get(file) ?? 0) : scoreEntry(entry, terms);
      if (!selection && terms.length && score <= 0) continue;
      const text = excerpt(entry.text || entry.description || '', terms, maxChars);
      hits.push({ ...entry, text, score, estimatedTokens: estimateTokens(text) });
    }
    // M3: заменённые заметки остаются в выдаче, но с пометкой — по ней инъекция их
    // и отбрасывает. Цели берём из индекса (один запрос), иначе — из самих кандидатов.
    const supersededHits = markSuperseded(hits, this.#supersedeTargetsFromCache(resolved, project, hits));
    const seen = new Set();
    return supersededHits
      .sort((a, b) => b.score - a.score
        || Number(a.category === 'other') - Number(b.category === 'other')
        || String(b.updatedAt).localeCompare(String(a.updatedAt))
        || String(a.source).localeCompare(String(b.source)))
      .filter(hit => {
        const key = hashText(hit.text);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, Math.max(0, Math.min(50, Number(limit) || MAX_HITS)));
  }

  /**
   * Все живые записи целиком — для проверки «такое знание уже есть» при
   * принятии предложения. Полный текст, без вырезок: сравнение должно быть точным.
   */
  async allEntries(project = {}, { limit = 500 } = {}) {
    const resolved = await this.resolveProject(project);
    if (!fsSync.existsSync(resolved.coreDir)) return [];
    const files = await listMarkdown(resolved.coreDir);
    const fileIndex = await projectFileIndex(resolved.projectPath);
    const entries = [];
    for (const file of files) {
      const entry = await readMemoryFile(file, resolved.memoryDir, { projectPath: resolved.projectPath, fileIndex });
      if (entry && !entry.stale) entries.push(entry);
    }
    return entries.sort((a, b) => a.source.localeCompare(b.source)).slice(0, limit);
  }

  /**
   * Отбор заметок для инъекции в контекст (этап M1: бюджет и ранжирование).
   *
   * Порядок: `pinned` → вес категории → BM25-релевантность → давность
   * использования. Не влезшие в бюджет заметки не выбрасываются из памяти —
   * они остаются доступны поиском; в ответе это видно как `overflow`.
   */
  async relevant(project = {}, { queries = [], budgetTokens = INDEX_BUDGET_TOKENS, globalBudgetTokens = GLOBAL_BUDGET_TOKENS, limit = MAX_HITS } = {}) {
    const overview = await this.inspect(project).catch(error => ({
      provider: 'pi-memory-md', status: 'error', write: 'SAVE_DISABLED', entries: 0, approxTokens: 0, problems: [error.message],
    }));
    if (overview.status !== 'available') {
      const globalOnly = await this.#globalHits(queries, globalBudgetTokens, []).catch(() => ({ hits: [], tokens: 0, overflow: null }));
      return {
        overview,
        hits: globalOnly.hits,
        warnings: overview.problems || [],
        estimatedTokens: 0,
        globalTokens: globalOnly.tokens,
        overflow: globalOnly.overflow,
      };
    }
    const seen = new Map();
    const fileIndex = await projectFileIndex(project.path ?? null);
    for (const query of queries.filter(Boolean).slice(0, 8)) {
      for (const hit of await this.search(project, query, { limit, fileIndex })) {
        const key = hashText(hit.text);
        const previous = seen.get(key);
        if (!previous || (hit.score ?? 0) > (previous.score ?? 0)) seen.set(key, { ...hit, reason: `matched: ${String(query).slice(0, 120)}` });
      }
    }
    // Давность использования живёт в индексе (метаданные, не содержимое):
    // заметка, которая уже помогала, идёт раньше той, что не помогала никогда.
    const usage = await this.#usageFor(project);
    const all = [...seen.values()];
    // M3: заменённое знание в контекст не идёт — его заменили осознанно. В поиске
    // такие заметки остаются (см. search): история решения тоже знание.
    const supersededTargets = await this.#supersedeTargets(project, all);
    const withMarks = markSuperseded(all, supersededTargets);
    const supersededCount = withMarks.filter(hit => hit.superseded).length;
    const live = withMarks.filter(hit => !hit.superseded);
    const ranked = live.map(hit => ({ ...hit, usage: usage.get(hit.source) ?? null }));
    ranked.sort((a, b) =>
      Number(b.pinned === true) - Number(a.pinned === true)
      || (CATEGORY_WEIGHT[b.category] ?? 0) - (CATEGORY_WEIGHT[a.category] ?? 0)
      || (b.score ?? 0) - (a.score ?? 0)
      || String(b.usage?.lastUsedAt || '').localeCompare(String(a.usage?.lastUsedAt || ''))
      || String(a.source).localeCompare(String(b.source)));

    const selected = [];
    const used = [];
    let tokens = 0;
    let dropped = 0;
    let droppedTokens = 0;
    for (const hit of ranked) {
      const cost = hit.estimatedTokens || estimateTokens(hit.text);
      if (tokens + cost > budgetTokens) {
        // Бюджет жёсткий (практика Claude Code): лишнее в индекс не попадает.
        dropped += 1;
        droppedTokens += cost;
        continue;
      }
      selected.push(hit);
      used.push(hit.source);
      tokens += cost;
      if (selected.length >= limit) break;
    }
    // Попадание в инъекцию — это использование: на этих числах живут давность,
    // decay и консолидация (M3).
    await this.#markUsage(project, used).catch(() => {});

    // Глобальные знания — свой мини-бюджет (план §1.5): предпочтения оператора
    // не должны вытеснять знание проекта, но и теряться не должны.
    const rankSeen = selected.map(hit => hashText(hit.text));
    const globalPick = await this.#globalHits(queries, globalBudgetTokens, rankSeen).catch(() => ({ hits: [], tokens: 0, overflow: null }));
    for (const hit of globalPick.hits) selected.push(hit);
    const projected = selected.filter(hit => hit.scope !== 'global');
    const overflow = (dropped > 0 || globalPick.overflow)
      ? {
        dropped: dropped + (globalPick.overflow?.dropped || 0),
        droppedTokens: droppedTokens + (globalPick.overflow?.droppedTokens || 0),
        budgetTokens,
        globalBudgetTokens,
        warning: `В контекст вошло ${projected.length} заметок проекта из ${ranked.length} (~${tokens} из ${tokens + droppedTokens} токенов бюджета памяти). Остальные доступны поиском.`,
      }
      : null;
    return {
      overview,
      hits: selected,
      warnings: overflow ? [overflow.warning] : [],
      estimatedTokens: tokens,
      globalTokens: globalPick.tokens,
      overflow,
      // Сколько заметок заменено: это видно оператору, а не догадывается им.
      superseded: supersededCount,
    };
  }

  /** Цели `supersedes` из индекса: один запрос вместо чтения всего каталога. */
  #supersedeTargetsFromCache(resolved, project, entries = []) {
    const index = this.index;
    if (index) {
      try {
        const targets = index.supersedesTargets(this.#indexKey(resolved, project));
        if (targets.length) return targets;
      } catch { /* без индекса — по выданным записям */ }
    }
    return entries.filter(hit => hit.supersedes).map(hit => hit.supersedes);
  }

  /** Пути, которые заменены другими заметками: из индекса, иначе обходом файлов. */
  async #supersedeTargets(project, entries) {
    const index = this.#openIndex();
    const resolved = await this.resolveProject(project);
    if (index) {
      try {
        const key = this.#indexKey(resolved, project);
        await this.#syncIndex(resolved, await listMarkdown(resolved.coreDir), project).catch(() => null);
        const targets = index.supersedesTargets(key);
        if (targets.length || entries.some(hit => hit.supersedes)) return targets.length ? targets : entries.filter(hit => hit.supersedes).map(hit => hit.supersedes);
      } catch { /* без индекса читаем из выданных записей */ }
    }
    return entries.filter(hit => hit.supersedes).map(hit => hit.supersedes);
  }

  /**
   * Глобальные заметки для инъекции: кандидаты из индекса, ранжирование как у
   * проектных, но бюджет свой и свои счётчики.
   */
  async #globalHits(queries, budgetTokens, taken) {
    const index = this.#openIndex();
    if (!index) return { hits: [], tokens: 0, overflow: null };
    await this.#syncGlobal();
    const seen = new Set(taken || []);
    const usage = index.usage(GLOBAL_INDEX_KEY);
    const candidates = new Map();
    for (const query of (queries || []).filter(Boolean).slice(0, 8)) {
      for (const row of index.search(query, { scope: 'global', limit: 12 })) candidates.set(row.relPath, row);
    }
    const ranked = [];
    for (const row of candidates.values()) {
      const file = path.join(this.root, row.relPath);
      const entry = await readMemoryFile(file, this.root, { projectPath: null });
      if (!entry || entry.stale) continue;
      const key = hashText(entry.text);
      if (seen.has(key)) continue;
      seen.add(key);
      ranked.push({ ...entry, scope: 'global', text: entry.text, score: -row.score, usage: usage.get(row.relPath) ?? null, reason: 'global knowledge' });
    }
    ranked.sort((a, b) =>
      Number(b.pinned === true) - Number(a.pinned === true)
      || (CATEGORY_WEIGHT[b.category] ?? 0) - (CATEGORY_WEIGHT[a.category] ?? 0)
      || (b.score ?? 0) - (a.score ?? 0)
      || String(a.source).localeCompare(String(b.source)));
    const hits = [];
    let tokens = 0;
    let dropped = 0;
    let droppedTokens = 0;
    for (const hit of ranked) {
      const cost = hit.estimatedTokens || estimateTokens(hit.text);
      if (tokens + cost > budgetTokens) { dropped += 1; droppedTokens += cost; continue; }
      hits.push(hit);
      tokens += cost;
    }
    await this.#markGlobalUsage(hits.map(hit => hit.source)).catch(() => {});
    return { hits, tokens, overflow: dropped ? { dropped, droppedTokens, budgetTokens } : null };
  }

  async #markGlobalUsage(relPaths) {
    const index = this.#openIndex();
    if (!index || !relPaths.length) return 0;
    return index.markUsed(relPaths.map(relPath => `${GLOBAL_INDEX_KEY}:${relPath}`));
  }

  async #usageFor(project) {
    const index = this.#openIndex();
    if (!index) return new Map();
    const resolved = await this.resolveProject(project);
    try {
      return index.usage(this.#indexKey(resolved, project));
    } catch { return new Map(); }
  }

  async #markUsage(project, relPaths) {
    const index = this.#openIndex();
    if (!index || !relPaths.length) return 0;
    const resolved = await this.resolveProject(project);
    const key = this.#indexKey(resolved, project);
    return index.markUsed(relPaths.map(relPath => `${key}:${relPath}`));
  }
}

export function resumeMemoryQueries(workItem = {}, sessions = [], workspace = {}) {
  const criteria = Array.isArray(workItem.acceptanceCriteria) ? workItem.acceptanceCriteria : [];
  const remaining = sessions.flatMap(session => session.recap?.remaining || []);
  const files = Array.isArray(workspace.changedFiles) ? workspace.changedFiles.slice(0, 10) : [];
  return [
    workItem.title,
    workItem.goal,
    criteria.join(' '),
    remaining.join(' '),
    files.join(' '),
  ].filter(Boolean).map(text => String(text).slice(0, 300));
}
