import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MEMORY_META_FILE, SCRATCH_KEY, applyMigration, memoryDirFor, memoryKey, memorySlug,
  planMigration, readMeta, rootHash,
} from '../src/memory/project-key.mjs';

// Этап M1 плана (§1.5): ключ проекта вместо basename. Два репозитория с одинаковым
// именем каталога больше не делят одну память — раньше знание одного проекта
// утекало в контекст другого (D1).

async function tmpRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-memory-key-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('a key is a readable slug plus a hash of the canonical root', async t => {
  const key = memoryKey({ canonicalRoot: 'G:\\Android\\AndroidStudioProjects\\Taskbridge' });
  assert.match(key, /^taskbridge-[0-9a-f]{8}$/, key);
  // Регистр и разделители пути не создают второй ключ.
  assert.equal(memoryKey({ canonicalRoot: 'g:/android/androidstudioprojects/taskbridge/' }), key);
  assert.equal(rootHash('G:\\A\\B'), rootHash('g:/a/b/'));
});

test('two repositories with the same directory name get different keys', () => {
  const one = memoryKey({ canonicalRoot: 'G:\\work\\client-a\\api' });
  const two = memoryKey({ canonicalRoot: 'G:\\work\\client-b\\api' });
  assert.notEqual(one, two, 'иначе память двух проектов смешалась бы');
  assert.ok(one.startsWith('api-') && two.startsWith('api-'), `${one} / ${two}`);
});

test('a worktree belongs to the project of its main checkout', () => {
  // Провайдер передаёт канонический корень (git-common-dir), поэтому ключ один и
  // тот же и в основной копии, и в worktree: знание принадлежит проекту, не ветке.
  const main = memoryKey({ canonicalRoot: 'G:\\Android\\AndroidStudioProjects\\Taskbridge' });
  const worktree = memoryKey({ canonicalRoot: 'G:\\Android\\AndroidStudioProjects\\Taskbridge' });
  assert.equal(main, worktree);
});

test('scratch has its own key, and a missing root never invents one', () => {
  assert.equal(memoryKey({ scratch: true }), SCRATCH_KEY);
  assert.equal(memoryKey({}), SCRATCH_KEY);
  assert.equal(memoryDirFor('/mem', SCRATCH_KEY), path.join('/mem', 'scratch'));
});

test('slugs keep cyrillic and stay filesystem-safe', () => {
  assert.equal(memorySlug('Мой проект'), 'мой-проект');
  assert.equal(memorySlug('  My//Project  '), 'my-project');
  assert.equal(memorySlug('...'), 'project');
});

test('a legacy basename directory moves to the keyed one, and meta remembers where from', async t => {
  const root = await tmpRoot(t);
  const canonicalRoot = 'G:\\work\\api';
  const legacy = path.join(root, 'api');
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, 'note.md'), 'знание проекта', 'utf8');

  const projects = [{ canonicalRoot }];
  const plan = await planMigration({ root, projects });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].status, 'move');
  assert.equal(plan[0].from, legacy);

  const { moved } = await applyMigration({ root, plan });
  assert.equal(moved.length, 1);
  const key = memoryKey({ canonicalRoot });
  assert.equal(await fs.readFile(path.join(root, key, 'note.md'), 'utf8'), 'знание проекта', 'содержимое переехало');
  const meta = await readMeta(root);
  assert.equal(meta.projects[key].legacyDir, legacy, 'meta хранит источник переезда');
  assert.equal(meta.projects[key].canonicalRoot, canonicalRoot);

  // Идемпотентно: второй прогон видит каталог по ключу и ничего не двигает.
  const again = await planMigration({ root, projects });
  assert.equal(again[0].status, 'keep');
  assert.deepEqual((await applyMigration({ root, plan: again })).moved, []);
  assert.ok(await fs.stat(path.join(root, MEMORY_META_FILE)));
});

test('a shared directory name is reported, not guessed', async t => {
  const root = await tmpRoot(t);
  await fs.mkdir(path.join(root, 'api'), { recursive: true });
  const projects = [{ canonicalRoot: 'G:\\work\\client-a\\api' }, { canonicalRoot: 'G:\\work\\client-b\\api' }];
  const plan = await planMigration({ root, projects });
  assert.equal(plan.every(entry => entry.status === 'collision'), true, JSON.stringify(plan));
  const result = await applyMigration({ root, plan });
  assert.deepEqual(result.moved, [], 'неизвестно, чьё это знание — двигать нельзя');
  assert.equal(result.skipped.length, 2);
  assert.ok(await fs.stat(path.join(root, 'api')), 'папка осталась на месте');
});

test('a dry run reports the move without touching anything', async t => {
  const root = await tmpRoot(t);
  await fs.mkdir(path.join(root, 'proj'), { recursive: true });
  const plan = await planMigration({ root, projects: [{ canonicalRoot: 'G:\\x\\proj' }] });
  assert.equal(plan[0].status, 'move');
  await applyMigration({ root, plan, dryRun: true });
  assert.ok(await fs.stat(path.join(root, 'proj')), 'каталог не тронут');
  assert.ok(!(await fs.stat(path.join(root, memoryKey({ canonicalRoot: 'G:\\x\\proj' }))).then(() => true, () => false)));
});
