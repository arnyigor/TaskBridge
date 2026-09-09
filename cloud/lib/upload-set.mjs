import fs from 'node:fs/promises';
import path from 'node:path';

import { SKIPPED_DIRS, findSensitivePaths, matchesIgnore, normalizeRelativePath, verifyVercelIgnore } from './deploy.mjs';

// Computes the exact set of files `vercel deploy` would upload, so the deploy
// script can refuse to run when a secret or a task database is in it.
//
// This deliberately walks the filesystem instead of trusting `.vercelignore`:
// the point of the check is to catch a wrong or missing ignore file.

export function parseIgnoreFile(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => normalizeRelativePath(line));
}

async function walk(root, current, out, ignoreLines) {
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRS.includes(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    const relative = normalizeRelativePath(path.relative(root, absolute));
    if (matchesIgnore(relative, ignoreLines)) continue;
    if (entry.isDirectory()) {
      await walk(root, absolute, out, ignoreLines);
    } else if (entry.isFile()) {
      out.push(relative);
    }
  }
}

export async function collectUploadCandidates({ root, ignoreLines = [] } = {}) {
  const candidates = [];
  await walk(root, root, candidates, ignoreLines);
  return candidates.sort();
}

// `vercel deploy` uploads the working directory and does not read .gitignore,
// therefore anything sensitive must be excluded by .vercelignore (or by the
// rules in cloud/lib/deploy.mjs).
export async function auditUploadSet({ root, vercelIgnoreText = null } = {}) {
  const ignoreLines = parseIgnoreFile(vercelIgnoreText ?? (await fs.readFile(path.join(root, '.vercelignore'), 'utf8').catch(() => '')));
  const coverage = verifyVercelIgnore(vercelIgnoreText ?? (await fs.readFile(path.join(root, '.vercelignore'), 'utf8').catch(() => '')));
  const candidates = await collectUploadCandidates({ root, ignoreLines });
  const findings = findSensitivePaths(candidates);
  return { ok: findings.length === 0 && coverage.ok, findings, coverage, candidates };
}

// Local files that must never be committed either. `probe` is a path inside the
// entry: a .gitignore entry like `data/*` ignores the contents, not the directory
// itself, so the directory name alone cannot be checked.
export const SENSITIVE_LOCAL_FILES = [
  { path: 'config.json', probe: 'config.json' },
  { path: 'data', probe: 'data/probe.db' },
  { path: 'artifacts', probe: 'artifacts/probe.log' },
  { path: 'cloud/data', probe: 'cloud/data/probe.db' }
];

export function formatAudit({ findings, coverage, candidates }) {
  const lines = [];
  lines.push(`upload candidates: ${candidates.length} files`);
  if (!coverage.ok) lines.push(`.vercelignore does not exclude: ${coverage.missing.join(', ')}`);
  for (const finding of findings) lines.push(`LEAK: ${finding.path} (${finding.rule}) would be uploaded`);
  if (!findings.length && coverage.ok) lines.push('no sensitive path in the upload set');
  return lines.join('\n');
}
