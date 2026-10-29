// Verified backup of a memory store: copy → per-file SHA-256 → re-hash source.
//
// Why this exists (MEM-01 of docs/GLOBAL_MEMORY_FIXES.md): the legacy MCP store
// (`data/persistent_memory`) rewrites topics in place; bounded history and
// best-effort git are not verified backups. Before migration or repair we need
// to verify copied bytes and detect observed source drift:
//
//   * the manifest records size, mtime and SHA-256 for every file;
//   * every copy is re-hashed and compared with its source;
//   * the source is hashed AGAIN after the copy, so a write that happened while
//     we observe while copying is reported as drift. This is NOT an atomic
//     snapshot: uncoordinated writers can change already-checked files.
//
// The tool never writes to the source. It refuses to run when the destination is
// inside the source (or the other way round) — a backup that overwrites its own
// input is not a backup.

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_NAME = 'manifest.json';

export async function hashFile(file) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

/** Regular files under `root`, as posix-relative paths, sorted. Symlinks are reported, not followed. */
export async function walkFiles(root) {
  const files = [];
  const skipped = [];
  async function visit(dir, prefix) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(abs, rel);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        files.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs });
      } else {
        skipped.push(rel);
      }
    }
  }
  await visit(root, '');
  return { files, skipped };
}

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Verify copied bytes and perform a second source scan. `consistent` describes
 * these observations, not a point-in-time snapshot or a lock on live writers.
 */
export async function backupStore({ source, destination, onAfterCopy, onBeforeCopy } = {}) {
  if (!source || !destination) throw new Error('source and destination are required');
  if (inside(destination, source) || inside(source, destination)) {
    throw new Error(`refusing to nest backup and source: ${source} ↔ ${destination}`);
  }
  const sourceStat = await fs.stat(source).catch(() => null);
  if (!sourceStat?.isDirectory()) throw new Error(`source is not a directory: ${source}`);

  // Never reuse a backup directory or follow its existing links.
  await fs.mkdir(destination, { recursive: false });
  const before = await walkFiles(source);
  const files = [];
  const errors = [];
  for (const file of before.files) {
    const from = path.join(source, file.rel);
    const to = path.join(destination, file.rel);
    try {
      if (typeof onBeforeCopy === 'function') await onBeforeCopy(file.rel, from);
      const sha256 = await hashFile(from);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to, constants.COPYFILE_EXCL);
      const copied = await hashFile(to);
      if (copied !== sha256) {
        errors.push({ path: file.rel, reason: 'copy-mismatch', source: sha256, copy: copied });
        continue;
      }
      files.push({ path: file.rel, size: file.size, mtimeMs: Math.round(file.mtimeMs), sha256 });
    } catch (error) {
      errors.push({ path: file.rel, reason: `copy-failed: ${error.code || error.message}` });
    }
  }

  if (typeof onAfterCopy === 'function') await onAfterCopy();

  // Second pass over the source: anything that changed while we copied makes the
  // snapshot a mixture of two states, which must not be presented as a backup.
  const after = await walkFiles(source);
  const firstByPath = new Map(before.files.map(file => [file.rel, file]));
  const drifted = [];
  if (after.files.length !== before.files.length) {
    drifted.push({ path: '.', reason: `file count changed ${before.files.length} → ${after.files.length}` });
  }
  for (const file of after.files) {
    const seen = firstByPath.get(file.rel);
    if (!seen) {
      drifted.push({ path: file.rel, reason: 'appeared-during-backup' });
      continue;
    }
    if (seen.size !== file.size || Math.round(seen.mtimeMs) !== Math.round(file.mtimeMs)) {
      drifted.push({ path: file.rel, reason: 'changed-during-backup' });
      continue;
    }
    const sha256 = await hashFile(path.join(source, file.rel)).catch(() => null);
    const recorded = files.find(item => item.path === file.rel);
    if (!sha256 || !recorded || recorded.sha256 !== sha256) {
      drifted.push({ path: file.rel, reason: 'content-changed-during-backup' });
    }
  }
  for (const file of before.files) {
    if (!after.files.some(item => item.rel === file.rel)) drifted.push({ path: file.rel, reason: 'deleted-during-backup' });
  }

  const report = {
    source: path.resolve(source),
    destination: path.resolve(destination),
    createdAt: new Date().toISOString(),
    consistencyMode: 'observed-double-scan',
    fileCount: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    skipped: before.skipped,
    errors,
    drifted,
    consistent: errors.length === 0 && drifted.length === 0 && before.skipped.length === 0 && after.skipped.length === 0,
    files,
  };
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, MANIFEST_NAME), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

/**
 * Restore a backup into an empty directory and compare it byte-for-byte with the
 * manifest. A backup nobody restored is a hope, not a backup.
 */
export async function verifyRestore({ manifestPath, restoreDir } = {}) {
  if (!manifestPath || !restoreDir) throw new Error('manifestPath and restoreDir are required');
  const report = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const source = report.destination;
  if (inside(restoreDir, source) || inside(source, restoreDir)) {
    throw new Error(`refusing to restore into the backup itself: ${restoreDir}`);
  }
  if (!report.consistent) throw new Error('refusing an inconsistent backup');
  for (const file of report.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.includes(':')
      || path.isAbsolute(file.path) || file.path.split('/').some(part => !part || part === '..' || part === '.')) {
      throw new Error('invalid manifest path');
    }
  }
  // An existing directory might contain user files or symlinks: do not reuse it.
  await fs.mkdir(restoreDir, { recursive: false });
  const problems = [];
  for (const file of report.files) {
    const from = path.join(source, file.path);
    const to = path.join(restoreDir, file.path);
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to, constants.COPYFILE_EXCL);
      const restored = await hashFile(to);
      if (restored !== file.sha256) problems.push({ path: file.path, reason: 'restore-mismatch', expected: file.sha256, restored });
    } catch (error) {
      problems.push({ path: file.path, reason: `restore-failed: ${error.code || error.message}` });
    }
  }
  const restoredFiles = await walkFiles(restoreDir);
  const extra = restoredFiles.files.map(file => file.rel).filter(rel => rel !== MANIFEST_NAME && !report.files.some(item => item.path === rel));
  return {
    restoreDir: path.resolve(restoreDir),
    fileCount: report.files.length - problems.length,
    expected: report.files.length,
    problems,
    extra,
    ok: problems.length === 0 && extra.length === 0,
  };
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

if (process.argv[1]?.endsWith('backup-memory-store.mjs')) {
  const source = argValue(process.argv, '--source');
  const destination = argValue(process.argv, '--destination');
  const restoreDir = argValue(process.argv, '--verify-into');
  try {
    if (!source || !destination) throw new Error('usage: --source <dir> --destination <dir> [--verify-into <dir>]');
    const report = await backupStore({ source, destination });
    const manifestPath = path.join(report.destination, MANIFEST_NAME);
    const result = { ...report, files: undefined, manifestPath };
    if (restoreDir) result.restore = await verifyRestore({ manifestPath, restoreDir });
    console.log(JSON.stringify(result, null, 2));
    if (!report.consistent || (result.restore && !result.restore.ok)) process.exitCode = 1;
  } catch (error) {
    console.error(`backup-memory-store: ${error.message}`);
    process.exitCode = 2;
  }
}
