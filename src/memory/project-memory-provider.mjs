import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectFileIndex, anyPathExists } from './path-patterns.mjs';

const exec = promisify(execFile);

const DEFAULT_MEMORY_ROOT = path.join(os.homedir(), '.pi', 'memory-md');
const MAX_FILE_BYTES = 256 * 1024;
const MAX_HITS = 12;
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
  constructor({ root = defaultRoot() } = {}) {
    // `null` in config means «the default location», not «no memory root».
    this.root = path.resolve(root || defaultRoot());
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
    for (const file of files) {
      const entry = await readMemoryFile(file, resolved.memoryDir, { projectPath: resolved.projectPath, fileIndex: index });
      if (!entry) continue;
      // A note whose declared files are gone is not knowledge about this project
      // any more: it is not «maybe still true», it is unverifiable.
      if (entry.stale && !includeStale) continue;
      const score = scoreEntry(entry, terms);
      if (terms.length && score <= 0) continue;
      const text = excerpt(entry.text || entry.description || '', terms, maxChars);
      hits.push({ ...entry, text, score, estimatedTokens: estimateTokens(text) });
    }
    const seen = new Set();
    return hits
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

  async relevant(project = {}, { queries = [], budgetTokens = 2000, limit = MAX_HITS } = {}) {
    const overview = await this.inspect(project).catch(error => ({
      provider: 'pi-memory-md', status: 'error', write: 'SAVE_DISABLED', entries: 0, approxTokens: 0, problems: [error.message],
    }));
    if (overview.status !== 'available') return { overview, hits: [], warnings: overview.problems || [] };
    const seen = new Map();
    const fileIndex = await projectFileIndex(project.path ?? null);
    for (const query of queries.filter(Boolean).slice(0, 8)) {
      for (const hit of await this.search(project, query, { limit, fileIndex })) {
        const key = hashText(hit.text);
        const previous = seen.get(key);
        if (!previous || (hit.score ?? 0) > (previous.score ?? 0)) seen.set(key, { ...hit, reason: `matched: ${String(query).slice(0, 120)}` });
      }
    }
    const selected = [];
    let tokens = 0;
    for (const hit of [...seen.values()].sort((a, b) => b.score - a.score)) {
      const cost = hit.estimatedTokens || estimateTokens(hit.text);
      if (tokens + cost > budgetTokens) continue;
      selected.push(hit);
      tokens += cost;
      if (selected.length >= limit) break;
    }
    return { overview, hits: selected, warnings: [], estimatedTokens: tokens };
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
