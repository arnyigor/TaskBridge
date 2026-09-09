import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../src/task-store.mjs';

// Usage: npm run backup  →  data/backups/taskbridge-<timestamp>.db
// VACUUM INTO produces a consistent snapshot while the server keeps running.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.join(rootDir, 'data');
const outDir = path.join(dataRoot, 'backups');
const keep = 5;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(outDir, `taskbridge-${stamp}.db`);

const store = new TaskStore(dataRoot);
try {
  await store.backup(target);
  await store.checkpoint();
} finally {
  store.close();
}

const backups = (await fs.readdir(outDir, { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.db'))
  .map(entry => entry.name)
  .sort();
for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
  await fs.rm(path.join(outDir, name), { force: true });
}

const size = (await fs.stat(target)).size;
console.log(`Бэкап: ${target} (${(size / 1048576).toFixed(1)} МиБ). Храню последние ${keep} шт.`);
