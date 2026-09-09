import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 20_000;
const MAX_DEPTH = 8;

function comparable(file) {
  const normalized = path.normalize(file).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function canonical(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Session cwd must be an absolute path');
  return comparable(await fs.realpath(file));
}

// The HTTP layer resolves an opaque key from listPiSessions, never a client path.
// Reject symlinks/junctions in the resolved file's ancestors as an extra safeguard.
async function regularFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw new Error('Invalid session file path');
  }
  let cursor = path.normalize(file);
  let stat;
  while (true) {
    const current = await fs.lstat(cursor);
    if (current.isSymbolicLink()) throw new Error('Symbolic links are not allowed for session files');
    stat ??= current;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!stat.isFile()) throw new Error('Session path is not a regular file');
  return stat;
}

async function openSession(file) {
  const before = await regularFile(file);
  const handle = await fs.open(file, 'r');
  try {
    const after = await handle.stat();
    if (!after.isFile() || before.ino !== after.ino || before.dev !== after.dev) throw new Error('Session file changed while opening');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function validateHeader(header, projectPath) {
  if (!header || header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || !header.id.trim()
    || typeof header.timestamp !== 'string' || !Number.isFinite(Date.parse(header.timestamp))) {
    throw new Error('Invalid Pi v3 session header');
  }
  if (await canonical(header.cwd) !== projectPath) throw new Error('Pi session belongs to a different project');
  return header;
}

async function readHeader(handle, projectPath) {
  const buffer = Buffer.alloc(MAX_HEADER_BYTES + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  const newline = buffer.subarray(0, bytesRead).indexOf(10);
  const length = newline < 0 ? bytesRead : newline;
  if (length > MAX_HEADER_BYTES) throw new Error('Pi session header is too large');
  return validateHeader(JSON.parse(buffer.subarray(0, length).toString('utf8').replace(/^\uFEFF/, '')), projectPath);
}

/** Bounded header-only discovery. `file` is internal; expose `key` to clients. */
export async function listPiSessions(project, roots) {
  const projectPath = await canonical(project.path);
  const results = [];
  const seen = new Set();
  let scanned = 0;
  async function scan(dir, depth) {
    if (depth > MAX_DEPTH || scanned >= MAX_SCAN_ENTRIES) return;
    let directory;
    try {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      directory = await fs.opendir(dir);
    } catch { return; }
    for await (const entry of directory) {
      if (++scanned > MAX_SCAN_ENTRIES) break;
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(file, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        let handle;
        try {
          handle = await openSession(file);
          const header = await readHeader(handle, projectPath);
          const resolved = await fs.realpath(file);
          const identity = comparable(resolved);
          if (seen.has(identity)) continue;
          seen.add(identity);
          const stat = await handle.stat();
          results.push({ key: crypto.createHash('sha256').update(identity).digest('hex'), file: resolved,
            id: header.id, cwd: header.cwd, mtime: stat.mtime.toISOString(),
            name: typeof header.name === 'string' ? header.name : path.basename(file, path.extname(file)) });
        } catch { /* Malformed, unrelated, inaccessible and concurrently removed files are not candidates. */ }
        finally { await handle?.close(); }
      }
    }
  }
  for (const root of roots || []) {
    if (typeof root === 'string' && path.isAbsolute(root)) await scan(path.normalize(root), 0);
  }
  return results.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.key.localeCompare(b.key));
}

function toMessage(entry) {
  const timestamp = Date.parse(entry.timestamp);
  if (entry.type === 'message') {
    const message = entry.message;
    return ['user', 'assistant', 'toolResult'].includes(message.role) && message.content == null ? { ...message, content: [] } : message;
  }
  if (entry.type === 'compaction') return { role: 'compactionSummary', summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp };
  if (entry.type === 'branch_summary' && entry.summary) return { role: 'branchSummary', summary: entry.summary, fromId: entry.fromId, timestamp };
  if (entry.type === 'custom_message') return { role: 'custom', customType: entry.customType, content: entry.content ?? [], display: entry.display, details: entry.details, timestamp };
  return null;
}

/**
 * Read a native snapshot without modifying its source. entries includes the
 * header and all branches: serialize it unchanged for continuation in a copy.
 * messages follows Pi's active, compacted context; branchMessages retains the
 * complete selected branch for chat display. Both retain native message roles.
 */
export async function readPiSession(file, projectPath) {
  const project = await canonical(projectPath);
  const handle = await openSession(file);
  let source;
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_SESSION_BYTES) throw new Error('Pi session exceeds 64 MiB');
    await readHeader(handle, project);
    // Bound allocation/read even if another Pi process is still appending.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_SESSION_BYTES + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_SESSION_BYTES) throw new Error('Pi session exceeds 64 MiB');
    source = buffer.subarray(0, offset).toString('utf8').replace(/^\uFEFF/, '');
  } finally { await handle.close(); }
  const lines = source.split('\n');
  const entries = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    try { entries.push(JSON.parse(lines[index])); }
    catch {
      if (index === lines.length - 1 && index > 0 && !source.endsWith('\n')) break;
      throw new Error(`Malformed Pi session JSON at line ${index + 1}`);
    }
  }
  const header = await validateHeader(entries[0], project);
  const byId = new Map();
  for (const entry of entries.slice(1)) {
    if (!entry || typeof entry.type !== 'string' || entry.type === 'session' || typeof entry.id !== 'string' || !entry.id
      || byId.has(entry.id) || !(entry.parentId === null || (typeof entry.parentId === 'string' && byId.has(entry.parentId)))) {
      throw new Error('Invalid Pi session entry or parent chain');
    }
    if (entry.type === 'message' && (!entry.message || typeof entry.message.role !== 'string')) throw new Error('Invalid Pi session message');
    byId.set(entry.id, entry);
  }
  const branch = [];
  let current = entries.length > 1 ? entries.at(-1) : null;
  while (current) {
    branch.push(current);
    current = current.parentId === null ? null : byId.get(current.parentId);
  }
  branch.reverse();
  let context = branch;
  const compactionIndex = branch.findLastIndex(entry => entry.type === 'compaction');
  if (compactionIndex >= 0) {
    const compaction = branch[compactionIndex];
    const firstKeptIndex = branch.findIndex(entry => entry.id === compaction.firstKeptEntryId);
    const kept = firstKeptIndex >= 0 && firstKeptIndex < compactionIndex ? branch.slice(firstKeptIndex, compactionIndex) : [];
    context = [compaction, ...kept, ...branch.slice(compactionIndex + 1)];
  }
  return { header, entries, messages: context.map(toMessage).filter(Boolean), branchMessages: branch.map(toMessage).filter(Boolean) };
}
