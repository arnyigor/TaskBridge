import fs from 'node:fs/promises';
import path from 'node:path';

const LOCK_RETRIES = 10;
const LOCK_DELAY_MS = 20;
const STALE_LOCK_MS = 10_000;

async function canonicalPath(directory) {
  const resolved = path.resolve(directory);
  return fs.realpath(resolved).catch(() => resolved);
}

async function readStore(file) {
  try {
    const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== true && value !== false && value !== null) throw new Error(`invalid decision for ${JSON.stringify(key)}`);
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw Object.assign(new Error(`Не удалось прочитать хранилище доверия Pi: ${error.message}`), { code: 'PROJECT_TRUST_FAILED' });
  }
}

async function acquireLock(file) {
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      await fs.mkdir(lock);
      return async () => { await fs.rm(lock, { recursive: true, force: true }); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stale = await fs.stat(lock).then(stat => Date.now() - stat.mtimeMs > STALE_LOCK_MS, () => false);
      if (stale) {
        await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (attempt + 1 < LOCK_RETRIES) await new Promise(resolve => setTimeout(resolve, LOCK_DELAY_MS));
    }
  }
  throw Object.assign(new Error('Хранилище доверия Pi сейчас занято. Повторите попытку.'), { code: 'PROJECT_TRUST_BUSY' });
}

/** Persist the same exact-folder decision that Pi's interactive `/trust` writes. */
export async function trustProjectDirectory(directory, agentDir) {
  const stat = await fs.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) throw Object.assign(new Error('Папка сессии не найдена.'), { code: 'NOT_FOUND' });

  const trustedPath = await canonicalPath(directory);
  const file = path.join(path.resolve(agentDir), 'trust.json');
  let release;
  try {
    release = await acquireLock(file);
    const data = await readStore(file);
    data[trustedPath] = true;
    const sorted = Object.fromEntries(Object.keys(data).sort().map(key => [key, data[key]]));
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
    return { path: trustedPath, trusted: true };
  } catch (error) {
    if (error.code === 'PROJECT_TRUST_BUSY' || error.code === 'PROJECT_TRUST_FAILED') throw error;
    throw Object.assign(new Error(`Не удалось сохранить доверие к папке: ${error.message}`), { code: 'PROJECT_TRUST_FAILED' });
  } finally {
    await release?.().catch(() => {});
  }
}
