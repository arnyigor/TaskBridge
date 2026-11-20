import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../src/task-store.mjs';

// Usage: npm run backup → <TASKBRIDGE_DATA_DIR or root/data>/backups/taskbridge-<timestamp>.db
// VACUUM INTO produces a consistent snapshot while the server keeps running.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = process.env.TASKBRIDGE_DATA_DIR
  ? path.resolve(process.env.TASKBRIDGE_DATA_DIR)
  : path.join(rootDir, 'data');
const outDir = path.join(dataRoot, 'backups');
const keep = Number(process.env.BACKUP_KEEP) || 2;
const reserveGb = Number(process.env.BACKUP_RESERVE_GB) || 30;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(outDir, `taskbridge-${stamp}.db`);

// Preflight места (ревью 2026-11-20): объём новой копии = DB + WAL + артефакты,
// после создания должно остаться не меньше резерва (по умолчанию 30 ГБ).
const disk = await import('node:fs').then(m => m.statfs ? m.statfs(dataRoot) : null).catch(() => null);
const freeBytes = disk ? disk.bsize * disk.bavail : null;
const dirSize = async dir => { let n = 0; for (const [,, files] of [] ) {} // placeholder
  try { for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p2 = path.join(dir, entry.name);
    if (entry.isDirectory()) n += await dirSize(p2); else n += (await fs.stat(p2)).size;
  } } catch { /* нет каталога */ }
  return n;
};
const estimateBytes = (await fs.stat(path.join(dataRoot, 'taskbridge.db')).catch(() => null))?.size || 0
  + (await fs.stat(path.join(dataRoot, 'taskbridge.db-wal')).catch(() => null))?.size || 0
  + await dirSize(path.join(dataRoot, 'tasks'));
if (freeBytes != null && freeBytes - estimateBytes < reserveGb * 1024 ** 3) {
  console.error(`[backup] отказ: после копии останется меньше ${reserveGb} ГБ (свободно ${Math.round(freeBytes / 1024 ** 3)} ГБ, оценка копии ${Math.round(estimateBytes / 1024 ** 3)} ГБ). Бэкап не создаётся, существующие копии не тронуты.`);
  process.exit(1);
}

const store = new TaskStore(dataRoot);
let succeeded = false;
try {
  await store.backup(target);
  succeeded = true;
  // Связанные артефакты (файлы результата/логи) — часть бэкапа: БД хранит
  // только ссылки, содержимое лежит в data/tasks/<id>/{files,artifacts}
  // (требование ревью 2026-11-20).
  const artifactsTarget = target.replace(/\.db$/, '.artifacts');
  await fs.cp(path.join(dataRoot, 'tasks'), artifactsTarget, { recursive: true });
  await store.checkpoint();
} catch (error) {
  // Частичная копия не должна выглядеть как бэкап: убираем обломки.
  await fs.rm(target, { force: true }).catch(() => {});
  await fs.rm(target.replace(/\.db$/, '.artifacts'), { recursive: true, force: true }).catch(() => {});
  throw error;
} finally {
  store.close();
}

const backups = (await fs.readdir(outDir, { withFileTypes: true }))
  .filter(entry => entry.isFile() && (entry.name.endsWith('.db') || entry.name.endsWith('.artifacts')));

const size = (await fs.stat(target)).size;
console.log(`Бэкап: ${target} (${(size / 1048576).toFixed(1)} МиБ). Храню последние ${keep} комплектов.`);

// Ротация СОГЛАСОВАННЫМИ комплектами: БД и её артефакты удаляются вместе,
// чтобы не остаться с БД без артефактов (ревью 2026-11-20).
const kits = [...new Set(backups.map(entry => entry.name.replace(/\.(db|artifacts)$/, '')))].sort();
const stale = kits.slice(0, Math.max(0, kits.length - keep));
for (const kit of stale) {
  await fs.rm(path.join(outDir, `${kit}.db`), { force: true });
  await fs.rm(path.join(outDir, `${kit}.artifacts`), { recursive: true, force: true });
}
