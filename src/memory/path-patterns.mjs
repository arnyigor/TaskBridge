import fsSync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Declared paths of a memory note (`paths:` in the frontmatter).
//
// Two questions are answered here, and both must be deterministic:
//   • is this note still about something that exists? (staleness)
//   • may a suggestion declare these paths at all? (the accept gate)
//
// Plain names («app.mjs») are checked on the filesystem — the cheapest truth, and
// the only one available outside Git. Patterns («src/**/*.mjs») are matched against
// the project's file list, so a folder that moved one level does not silently turn
// a live note into a dead one. The list comes from Git when it can: Git already
// knows what a project's files are, and a directory walk would mean deciding for
// every project what to skip.

const FILE_LIMIT = 20000;

/**
 * Files of the project, posix-relative. `git ls-files --cached --others
 * --exclude-standard` gives tracked plus not-ignored files in one bounded call;
 * outside a repository the list is empty and only exact names can be checked.
 */
export async function projectFileIndex(projectPath) {
  if (!projectPath) return { files: [], truncated: false, git: false };
  try {
    const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: projectPath,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    const files = stdout.split('\0').filter(Boolean).map(entry => entry.replaceAll('\\', '/'));
    return { files: files.slice(0, FILE_LIMIT), truncated: files.length > FILE_LIMIT, git: true };
  } catch {
    return { files: [], truncated: false, git: false };
  }
}

/**
 * `src/**\/*.mjs` → RegExp. `**` crosses directory separators, `*` does not, `?` is
 * one character. Matching is case-insensitive on purpose: the path is written by a
 * human, and a wrong case on Windows is not a fact about the project.
 */
export function patternToRegExp(pattern) {
  const escaped = String(pattern).trim().replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  const body = escaped
    .replace(/\*\*\//gu, '\u0000')
    .replace(/\*\*/gu, '\u0000')
    .replace(/\*/gu, '[^/]*')
    .replace(/\?/gu, '[^/]')
    .replace(/\u0000/gu, '.*');
  return new RegExp(`^${body}$`, 'iu');
}

const isPattern = value => /[*?]/u.test(String(value ?? ''));

/** Есть ли в списке файлов хоть один под этот шаблон. */
export function patternMatches(pattern, index) {
  const cleaned = String(pattern).trim().replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!cleaned) return false;
  if (!isPattern(cleaned)) {
    return index.files.some(file => file.toLowerCase() === cleaned.toLowerCase());
  }
  const re = patternToRegExp(cleaned);
  return index.files.some(file => re.test(file));
}

/**
 * True when at least one declared path exists. No declared paths — nothing to
 * check, so «alive». A pattern with no file list to match against is NOT treated
 * as missing: hiding live knowledge would be the worse of the two mistakes.
 */
export function anyPathExists(patterns, { projectPath = null, index = null } = {}) {
  const list = (Array.isArray(patterns) ? patterns : []).map(item => String(item ?? '').trim()).filter(Boolean);
  if (!list.length) return true;
  // Список файлов без git — это не «в проекте ничего нет», а «списка нет»:
  // по нему шаблон нельзя объявить пропавшим.
  const usable = index?.git && index.files?.length ? index : null;
  return list.some(pattern => {
    if (!isPattern(pattern)) return Boolean(projectPath && fsSync.existsSync(path.join(projectPath, pattern)));
    return usable ? patternMatches(pattern, usable) : true;
  });
}

/** Which of them are gone — for a message a human reads. */
export function missingPaths(patterns, { projectPath = null, index = null } = {}) {
  return (Array.isArray(patterns) ? patterns : [])
    .map(item => String(item ?? '').trim())
    .filter(Boolean)
    .filter(pattern => !anyPathExists([pattern], { projectPath, index }));
}
