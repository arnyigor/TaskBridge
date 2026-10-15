import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiMemoryMdProvider } from '../src/memory/project-memory-provider.mjs';

// Этап M1 п.3-4: провайдер остаётся фасадом, но поиск идёт через FTS5-индекс —
// индекс выбирает кандидатов по BM25, а с диска читаются только они. Формат
// ответа не меняется: им пользуются инъекция в resume-контекст и инспектор.
// Бюджет инъекции жёсткий, ранжирование — pinned → категория → релевантность → давность.

async function memoryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-memory-provider-'));
  const dir = path.join(root, 'taskbridge-1f86f591', 'core', 'project');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'queue.md'),
    '---\ndescription: Очередь сообщений\ntags: очередь, доставка\n---\nСообщение ждёт очереди, пока модель занята. Курсор двигается только после подтверждения.\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'ui.md'),
    '---\ndescription: Кнопка STOP\n---\nКнопка отмены всегда доступна в чате.\n',
    'utf8',
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
  return root;
}

function provider(root, t) {
  const p = new PiMemoryMdProvider({ root, indexPath: path.join(root, 'index', 'memory-index.db') });
  t.after(() => p.closeIndex());
  return p;
}

// Каталог памяти проекта называется basename'ом корня (так его видит провайдер),
// поэтому у проекта в тестах есть имя, совпадающее с папкой.
const project = { id: 'p', name: 'taskbridge-1f86f591', path: null };

test('search goes through the index and keeps the response shape', async t => {
  const root = await memoryRoot(t);
  const p = provider(root, t);
  assert.equal(p.index, null, 'индекс открывается лениво — файл не держится без нужды');

  const hits = await p.search(project, 'курсор');
  assert.ok(p.index, `индекс должен открыться на первом поиске: ${p.indexError}`);
  assert.equal(hits.length, 1, JSON.stringify(hits.map(h => h.source)));
  const hit = hits[0];
  for (const field of ['id', 'text', 'category', 'source', 'updatedAt', 'description', 'tags', 'paths', 'stale', 'provenance', 'estimatedTokens', 'score']) {
    assert.ok(field in hit, `поле ${field} потеряно`);
  }
  assert.equal(hit.source, 'core/project/queue.md');
  assert.match(hit.text, /Курсор двигается/);
  assert.equal(p.index.stats().notes, 2, 'каталог проиндексирован');
  assert.equal((await p.search(project, 'курс'))[0].source, 'core/project/queue.md', 'префикс ищется как раньше');
  assert.equal((await p.search(project, 'доставка'))[0].source, 'core/project/queue.md', 'теги тоже ищутся');
});

test('an unchanged note is not reindexed, and a removed one leaves the results', async t => {
  const root = await memoryRoot(t);
  const p = provider(root, t);
  await p.search(project, 'курсор');
  const before = p.index.stats();
  await p.search(project, 'курсор');
  assert.equal(p.index.stats().notes, before.notes, 'состав индекса не изменился');

  const dir = path.join(root, 'taskbridge-1f86f591', 'core', 'project');
  await fs.writeFile(path.join(dir, 'new.md'), '---\ndescription: Новое знание\n---\nПро курсор и его подтверждение.\n', 'utf8');
  assert.equal((await p.search(project, 'курсор')).length, 2);

  await fs.rm(path.join(dir, 'new.md'));
  const after = await p.search(project, 'курсор');
  assert.deepEqual(after.map(h => h.source), ['core/project/queue.md'], 'удалённый файл не находится');
  assert.equal(p.index.stats().notes, 2);
});

test('relevant() keeps its contract: hits, tokens and the matching reason', async t => {
  const root = await memoryRoot(t);
  const p = provider(root, t);
  const result = await p.relevant(project, { queries: ['очередь сообщений', 'кнопка отмены'], budgetTokens: 2000, limit: 8 });
  assert.equal(result.overview.status, 'available');
  assert.equal(result.hits.length, 2, JSON.stringify(result.hits.map(h => h.source)));
  for (const hit of result.hits) {
    assert.match(hit.reason, /^matched: /, 'причина попадания остаётся в ответе');
    assert.ok(hit.estimatedTokens > 0);
  }
  assert.ok(result.estimatedTokens <= 2000, 'бюджет соблюдён');
  assert.deepEqual(result.warnings, []);
});

test('ranking follows the plan: pinned, then category, then relevance and age', async t => {
  const root = await memoryRoot(t);
  const dir = path.join(root, 'taskbridge-1f86f591', 'core', 'project');
  await fs.writeFile(path.join(dir, 'pinned.md'), '---\ndescription: Правило оператора\npinned: true\n---\nПро курсор и его подтверждение.\n', 'utf8');
  await fs.writeFile(path.join(dir, 'constraint.md'), '---\ndescription: Ограничение\ncategory: constraint\n---\nКурсор меняется только после подтверждения модели.\n', 'utf8');
  const p = provider(root, t);
  const result = await p.relevant(project, { queries: ['курсор подтверждение'], budgetTokens: 2000, limit: 8 });
  const order = result.hits.map(h => h.source);
  assert.equal(order[0], 'core/project/pinned.md', `pinned идёт первым: ${order.join(' -> ')}`);
  assert.equal(order[1], 'core/project/constraint.md', `constraint важнее прочих: ${order.join(' -> ')}`);
});

test('the budget is hard: extra notes are reported, not injected, and stay searchable', async t => {
  const root = await memoryRoot(t);
  const p = provider(root, t);
  const tight = await p.relevant(project, { queries: ['очередь сообщений'], budgetTokens: 5, limit: 8 });
  assert.equal(tight.hits.length, 0);
  assert.ok(tight.overflow, 'переполнение бюджета должно быть видно');
  assert.ok(tight.overflow.dropped >= 1);
  assert.match(tight.warnings[0], /бюджета памяти/);
  assert.equal((await p.search(project, 'очередь')).length, 1, 'не влезшее остаётся доступным поиском');

  const roomy = await p.relevant(project, { queries: ['очередь сообщений'], budgetTokens: 2000, limit: 8 });
  assert.equal(roomy.overflow, null);
  assert.deepEqual(roomy.warnings, []);
});

test('a note that reached the context is marked used, and that ordering is reused later', async t => {
  const root = await memoryRoot(t);
  const p = provider(root, t);
  await p.relevant(project, { queries: ['курсор'], budgetTokens: 2000, limit: 8 });
  const stats = p.index.stats();
  assert.equal(stats.uses, 1, 'попадание в инъекцию = использование');
  assert.ok(stats.lastUsedAt, 'и время использования записано');

  const hit = (await p.relevant(project, { queries: ['курсор'], budgetTokens: 2000, limit: 8 })).hits[0];
  assert.equal(hit.usage?.useCount, 1, 'давность видна вызывающему для ранжирования');
});

test('a broken index never breaks memory: search falls back to walking files', async t => {
  const root = await memoryRoot(t);
  const p = provider(root, t);
  p.closeIndex();
  p.indexPath = null;
  p.indexError = 'index disabled';
  const hits = await p.search(project, 'курсор');
  assert.equal(hits.length, 1, 'память читается и без индекса');
  assert.equal(hits[0].source, 'core/project/queue.md');
});

test('global knowledge is injected with its own budget and marked as such', async t => {
  const root = await memoryRoot(t);
  const globalDir = path.join(root, '_global', 'decision');
  await fs.mkdir(globalDir, { recursive: true });
  await fs.writeFile(
    path.join(globalDir, 'prefs.md'),
    '---\ndescription: Предпочтения оператора\n---\nНикогда не запускай длинные команды без вывода: оператор считает это зависанием. Про очередь и подтверждение.\n',
    'utf8',
  );
  const p = provider(root, t);
  const result = await p.relevant(project, { queries: ['очередь подтверждение'], budgetTokens: 2000, globalBudgetTokens: 400, limit: 8 });

  const global = result.hits.filter(hit => hit.scope === 'global');
  assert.equal(global.length, 1, JSON.stringify(result.hits.map(h => `${h.scope}:${h.source}`)));
  assert.equal(global[0].source, '_global/decision/prefs.md');
  assert.ok(result.globalTokens > 0, 'глобальный бюджет считается отдельно');
  assert.ok(result.globalTokens <= 400);
  // Проектные заметки не вытесняются глобальными и наоборот.
  assert.ok(result.hits.some(hit => hit.scope !== 'global'), 'знание проекта осталось');

  // Мини-бюджет жёсткий: с бюджетом в 1 токен глобальное не входит вовсе.
  const tight = await p.relevant(project, { queries: ['очередь подтверждение'], budgetTokens: 2000, globalBudgetTokens: 1, limit: 8 });
  assert.equal(tight.hits.filter(hit => hit.scope === 'global').length, 0);
  assert.ok(tight.overflow, 'отброшенное по глобальному бюджету видно в overflow');
});

test('globalEntries() lists the shared notes for the inspector', async t => {
  const root = await memoryRoot(t);
  const globalDir = path.join(root, '_global', 'architecture');
  await fs.mkdir(globalDir, { recursive: true });
  await fs.writeFile(path.join(globalDir, 'conventions.md'), '---\ndescription: Конвенции\n---\nКороткие ответы без воды.\n', 'utf8');
  const p = provider(root, t);
  const entries = await p.globalEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, '_global/architecture/conventions.md');
  assert.equal(entries[0].scope, 'global');
  // Проектная память не попадает в глобальную выдачу.
  assert.equal(entries.some(entry => entry.source.startsWith('core/')), false);
});

test('a superseded note leaves the injection but stays findable with a mark', async t => {
  const root = await memoryRoot(t);
  const dir = path.join(root, 'taskbridge-1f86f591', 'core', 'project');
  // Старое решение и заметка, которая его заменяет (M3): замена адресуется путём.
  await fs.writeFile(path.join(dir, 'old.md'), '---\ndescription: Очередь через файл\n---\nСообщения ждут в файле очереди.\n', 'utf8');
  await fs.writeFile(path.join(dir, 'new.md'), '---\ndescription: Очередь через брокер\nsupersedes: core/project/old.md\nmodified: 2026-10-14T00:00:00.000Z\n---\nСообщения ждут в брокере, файл очереди больше не используется.\n', 'utf8');
  const p = provider(root, t);

  // Инъекция: заменённое знание в контекст не идёт.
  const injected = await p.relevant(project, { queries: ['очередь сообщения файл'], budgetTokens: 2000, limit: 8 });
  const sources = injected.hits.map(hit => hit.source);
  assert.ok(sources.includes('core/project/new.md'), `замена должна попасть в контекст: ${sources}`);
  assert.equal(sources.includes('core/project/old.md'), false, `заменённое в контекст не идёт: ${sources}`);
  assert.equal(injected.superseded, 1, 'число заменённых заметок видно вызывающему');

  // Поиск: заменённая заметка остаётся — с пометкой «кем заменена».
  const found = await p.search(project, 'очередь файл');
  const old = found.find(hit => hit.source === 'core/project/old.md');
  assert.ok(old, `заменённая заметка обязана искаться: ${found.map(h => h.source)}`);
  assert.equal(old.superseded, true);
  assert.equal(old.supersededBy, 'core/project/new.md', 'видно, чем заменена');
  // `modified` — семантическое время изменения, отдельно от mtime файла.
  assert.equal(found.find(hit => hit.source === 'core/project/new.md').modified, '2026-10-14T00:00:00.000Z');
});

test('a supersede pointing at an unknown note changes nothing', async t => {
  const root = await memoryRoot(t);
  const dir = path.join(root, 'taskbridge-1f86f591', 'core', 'project');
  await fs.writeFile(path.join(dir, 'new.md'), '---\ndescription: Замена\nsupersedes: core/project/нет-такой.md\n---\nСвежее знание про очередь.\n', 'utf8');
  const p = provider(root, t);
  const injected = await p.relevant(project, { queries: ['очередь'], budgetTokens: 2000, limit: 8 });
  assert.equal(injected.superseded, 0, 'неизвестная цель ничего не заменяет');
  assert.ok(injected.hits.some(hit => hit.source === 'core/project/new.md'));
});
