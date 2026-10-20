import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { measureTree, sessionStorage, warnSessionBytes, forgetSessionStorage } from '../src/session-storage.mjs';

// Предупреждение «сессия занимает много места» построено на измерении, поэтому
// проверяется именно измерение: сумма по дереву, пропуск отсутствующих каталогов,
// предел обхода, попадание в кэш и порог из конфига. Ничего здесь не удаляет и не
// ограничивает — это и есть требование к фиче.

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('measureTree sums nested files and tolerates a missing directory', async (t) => {
  const root = await sandbox(t);
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await fs.mkdir(path.join(root, 'files'), { recursive: true });
  await fs.writeFile(path.join(root, 'artifacts', 'pi-events.jsonl'), 'x'.repeat(2048));
  await fs.writeFile(path.join(root, 'files', 'upload'), 'y'.repeat(1024));

  const tree = await measureTree(root);
  assert.equal(tree.bytes, 3072);
  assert.equal(tree.files, 2);
  assert.equal(tree.partial, false);

  // Каталога нет — это нормальный случай (сессия ещё ничего не писала), не ошибка.
  const missing = await measureTree(path.join(root, 'nope'));
  assert.deepEqual(missing, { bytes: 0, files: 0, partial: false });
});

test('measureTree reports a partial result instead of walking forever', async (t) => {
  const root = await sandbox(t);
  await fs.mkdir(path.join(root, 'many'));
  for (let i = 0; i < 20; i += 1) await fs.writeFile(path.join(root, 'many', `f${i}`), 'z');

  const tree = await measureTree(root, 5);
  assert.equal(tree.partial, true, 'предел обхода достигнут — цифра неполная');
  assert.ok(tree.files <= 5);
});

test('sessionStorage covers every area of the session and is cached', async (t) => {
  const root = await sandbox(t);
  const taskId = 'abc123';
  await fs.mkdir(path.join(root, 'tasks', taskId, 'artifacts'), { recursive: true });
  await fs.mkdir(path.join(root, 'pi-sessions', taskId), { recursive: true });
  await fs.writeFile(path.join(root, 'tasks', taskId, 'artifacts', 'diff.patch'), 'd'.repeat(100));
  await fs.writeFile(path.join(root, 'pi-sessions', taskId, 'session.json'), 's'.repeat(50));

  const now = 1_000_000;
  const first = await sessionStorage({ dataRoot: root, taskId, now });
  assert.equal(first.bytes, 150, 'артефакты и нативная сессия pi в одной цифре');
  assert.equal(first.files, 2);
  assert.equal(first.id, taskId);

  // Дописали файл, но кэш ещё свежий — размер не пересчитывается (иначе каждый
  // показ чата стоил бы обхода гигабайтов).
  await fs.writeFile(path.join(root, 'tasks', taskId, 'artifacts', 'result.md'), 'r'.repeat(10));
  const cached = await sessionStorage({ dataRoot: root, taskId, now: now + 1000 });
  assert.equal(cached.bytes, 150);

  // Кэш истёк — цифра обновилась.
  const fresh = await sessionStorage({ dataRoot: root, taskId, now: now + 6 * 60 * 1000 });
  assert.equal(fresh.bytes, 160);
  forgetSessionStorage();
});

test('warnSessionBytes reads the config and falls back to 1 GiB', () => {
  assert.equal(warnSessionBytes({}), 1024 * 1024 * 1024);
  assert.equal(warnSessionBytes({ storage: { warnSessionMb: 100 } }), 100 * 1024 * 1024);
  assert.equal(warnSessionBytes({ storage: { warnSessionMb: 'garbage' } }), 1024 * 1024 * 1024);
  assert.equal(warnSessionBytes({ storage: { warnSessionMb: -5 } }), 1024 * 1024 * 1024);
});

test('the server route reports the measured size, the threshold and the flag', { timeout: 60000 }, async (t) => {
  const { startFixture } = await import('./server-fixture.mjs');
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'storage probe' });
  const storage = await fixture.api(`/api/tasks/${task.id}/storage`);
  assert.equal(storage.id, task.id);
  assert.ok(Number.isInteger(storage.bytes) && storage.bytes >= 0, 'размер — число байт');
  assert.ok(Number.isInteger(storage.files));
  assert.equal(storage.thresholdBytes, 1024 * 1024 * 1024, 'порог по умолчанию — 1 ГБ');
  assert.equal(storage.warn, storage.bytes >= storage.thresholdBytes);
  assert.equal(storage.warn, false, 'свежая сессия не может занимать гигабайт');
});
