import fs from 'node:fs/promises';
import path from 'node:path';

const fail = (message, code = 'INPUT_INVALID') => Object.assign(new Error(message), { code });
const SKIP = new Set(['node_modules', '.git', '.gradle', '.idea', 'venv', '__pycache__', 'dist', 'build', 'data']);

function configuredRoots(config) {
  const roots = config.projectBrowser?.roots;
  return Array.isArray(roots) ? roots.filter(r => typeof r === 'string' && path.isAbsolute(r)) : [];
}

async function canonicalRoots(config) {
  const resolved = [];
  for (const root of configuredRoots(config)) {
    try { resolved.push(await fs.realpath(root)); } catch { /* configured root missing on disk right now */ }
  }
  return resolved;
}

function withinRoot(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolves and validates that `requested` falls inside a configured root, rejecting symlink escapes. */
export async function resolveBrowsablePath(config, requested) {
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw fail('Недопустимый путь.');
  const roots = await canonicalRoots(config);
  if (!roots.length) throw fail('Просмотр папок не настроен: задайте projectBrowser.roots в config.json.', 'NOT_CONFIGURED');
  let resolved;
  try { resolved = await fs.realpath(requested); } catch { throw fail('Папка не найдена.', 'NOT_FOUND'); }
  if (!roots.some(root => withinRoot(root, resolved))) throw fail('Папка вне разрешённых директорий.', 'FILE_FORBIDDEN');
  return resolved;
}

/** A folder chosen through the Desktop OS picker on the server machine. */
export async function resolveLocalProjectPath(requested) {
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw fail('Выберите абсолютный путь к папке.');
  let resolved;
  try { resolved = await fs.realpath(requested); } catch { throw fail('Папка не найдена.', 'NOT_FOUND'); }
  if (!(await fs.stat(resolved)).isDirectory()) throw fail('Выбранный путь не является папкой.');
  return resolved;
}

/**
 * Files and folders inside a task workspace, as relative posix paths — the same
 * paths an @-reference in a prompt resolves against (the task workspace is pi's cwd).
 * Bounded walk: SKIP dirs, hidden entries and symlinks are not followed; the list
 * is capped so a huge tree cannot blow up the response.
 */
const WORKSPACE_FILE_CAP = 2000;
const WORKSPACE_DEPTH_CAP = 12;

export async function listWorkspaceFiles(root) {
  let base;
  try { base = await fs.realpath(root); } catch { throw fail('Рабочая папка не найдена.', 'NOT_FOUND'); }
  if (!(await fs.lstat(base)).isDirectory()) throw fail('Рабочая папка не найдена.', 'NOT_FOUND');
  const entries = [];
  const walk = async (dir, relBase, depth) => {
    if (depth > WORKSPACE_DEPTH_CAP || entries.length >= WORKSPACE_FILE_CAP) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entries.length >= WORKSPACE_FILE_CAP) return;
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        entries.push({ name: entry.name, path: rel, isFile: false });
        await walk(path.join(dir, entry.name), rel, depth + 1);
      } else if (entry.isFile()) {
        entries.push({ name: entry.name, path: rel, isFile: true });
      }
    }
  };
  await walk(base, '', 0);
  // Code-unit comparison, not localeCompare: paths with '/' must sort deterministically.
  entries.sort((a, b) => (a.isFile === b.isFile ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : a.isFile ? 1 : -1));
  return { path: '', entries };
}

export async function listDirectory(config, requested) {
  const roots = await canonicalRoots(config);
  if (!roots.length) throw fail('Просмотр папок не настроен: задайте projectBrowser.roots в config.json.', 'NOT_CONFIGURED');
  const dir = requested ? await resolveBrowsablePath(config, requested) : null;
  if (dir) {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('Это не папка.');
  }
  const entries = [];
  if (dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      entries.push({ name: entry.name, path: path.join(dir, entry.name) });
    }
  } else {
    for (const root of roots) entries.push({ name: path.basename(root) || root, path: root });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = !dir || roots.includes(dir) ? null : path.dirname(dir);
  return { path: dir, parent, entries };
}
