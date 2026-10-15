import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startFixture } from './server-fixture.mjs';
import {
  validateProposal, createProposal, listProposals, acceptProposal, rejectProposal, proposalCounts, proposalsDir,
} from '../src/memory/memory-proposals.mjs';

const exec = promisify(execFile);

// MEM-08: Memory Suggestions. Здесь проверяется главное обещание: предложение
// НИКОГДА не попадает в память само, а принятие не проходит, если
// детерминированная проверка не чиста — и в этом случае на диске не меняется ничего.

async function removeDir(dir) {
  for (let attempt = 0; ; attempt += 1) {
    try { await fs.rm(dir, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt >= 9 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

async function tmpMemory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-proposals-supersede-'));
  t.after(() => removeDir(root));
  return root;
}

async function memoryFixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-proposals-repo-'));
  const repo = path.join(parent, 'proposals-repo');
  await fs.mkdir(repo, { recursive: true });
  const who = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  await exec('git', ['init', '-q'], { cwd: repo });
  await exec('git', [...who, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'app.mjs'), 'export const app = 1;\n', 'utf8');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-proposals-mem-'));
  return { parent, repo, root };
}

test('the deterministic gate refuses what must not become project knowledge', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-proposals-gate-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-proposals-project-'));
  try {
    await fs.writeFile(path.join(project, 'app.mjs'), 'x\n', 'utf8');
    const clean = { text: 'Курсор событий должен оставаться монотонным.', category: 'constraint', paths: ['app.mjs'] };
    assert.deepEqual(validateProposal(clean, { projectPath: project }).problems, []);
    // Шаблоны в объявленных путях: проверяются по списку файлов проекта, поэтому
    // «src/**/*.mjs» — законный путь, а не «файла с таким именем нет».
    const index = { files: ['app.mjs', 'src/a/b.mjs'], git: true };
    assert.deepEqual(validateProposal({ text: 'Про модули', paths: ['src/**/*.mjs'] }, { projectPath: project, fileIndex: index }).problems, []);
    // `*` не перешагивает разделитель каталогов: src/a/b.mjs под src/*.mjs не подходит.
    assert.deepEqual(
      validateProposal({ text: 'Про модули', paths: ['src/*.mjs'] }, { projectPath: project, fileIndex: index }).problems.map(problem => problem.code),
      ['MISSING_PATHS'],
    );
    assert.deepEqual(
      validateProposal({ text: 'Про модули', paths: ['src/*.mjs'] }, { projectPath: project, fileIndex: { files: ['src/a.mjs'], git: true } }).problems,
      [],
    );
    assert.deepEqual(
      validateProposal({ text: 'Про модули', paths: ['src/**/*.mjs'] }, { projectPath: project, fileIndex: { files: [], git: true } }).problems,
      [],
      'пустой список файлов — это «списка нет», а не «файлов нет»: правило одно и для гейта, и для устаревания',
    );
    // Списка файлов нет (вне git): шаблон не признаётся мёртвым, а точное имя — да.
    assert.deepEqual(validateProposal({ text: 'Про модули', paths: ['src/**/*.mjs'] }, { projectPath: project }).problems, []);
    assert.deepEqual(
      validateProposal({ text: 'Про модули', paths: ['src/gone.mjs'] }, { projectPath: project }).problems.map(problem => problem.code),
      ['MISSING_PATHS'],
    );

    const codes = (input, options = {}) => validateProposal(input, options).problems.map(problem => problem.code);
    assert.deepEqual(codes({ text: '   ' }), ['EMPTY_TEXT']);
    assert.deepEqual(codes({ text: 'x'.repeat(4001) }), ['TOO_LONG']);
    assert.deepEqual(codes({ text: 'нормально', category: 'epic' }), ['UNKNOWN_CATEGORY']);
    assert.deepEqual(codes({ text: 'нечто', paths: ['src/gone.mjs'] }, { projectPath: project }), ['MISSING_PATHS']);
    assert.deepEqual(codes({ text: 'Уже известно' }, { existingText: ['уже известно'] }), ['DUPLICATE']);
    assert.deepEqual(codes({ text: 'DEEPSEEK_API_KEY = "sk-abcdefghijklmnop1234"' }), ['SECRET_SHAPE']);
    assert.deepEqual(codes({ text: 'token: "ghp_abcdefghijklmnopqrst"' }), ['SECRET_SHAPE']);
    // Слово «token» без значения секретом не считается — фильтр, а не паранойя.
    assert.deepEqual(codes({ text: 'Токен доступа обновляется на клиенте каждые 15 минут.' }), []);

    // Bufffer: предложение живёт ВНЕ `core`, поэтому Pi его не инжектит.
    const memoryDir = path.join(root, 'projects');
    await fs.mkdir(path.join(memoryDir, 'core', 'project'), { recursive: true });
    const created = await createProposal(memoryDir, clean);
    assert.match(created.id, /^mp-/);
    assert.equal(created.status, 'proposed');
    assert.ok(await fs.stat(path.join(proposalsDir(memoryDir), `${created.id}.md`)));
    assert.deepEqual(await fs.readdir(path.join(memoryDir, 'core', 'project')), [], 'ничего не записано в core — предложение только предложено');
    assert.equal(proposalCounts(await listProposals(memoryDir)).pending, 1);
  } finally {
    await removeDir(root);
    await removeDir(project);
  }
});

test('MEM-08: a suggestion becomes knowledge only through accept — and only if it passes', { timeout: 120000 }, async t => {
  const { parent, repo, root } = await memoryFixture();
  const fixture = await startFixture(undefined, { root: { memory: { projectMemoryRoot: root } } });
  t.after(() => fixture.close());
  t.after(async () => { await removeDir(root); await removeDir(parent); });
  const api = fixture.api;
  const headers = { 'content-type': 'application/json' };
  const post = async (route, body, expect = 200) => {
    const response = await fetch(fixture.base + route, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, expect, `POST ${route} → ${response.status}: ${text}`);
    return JSON.parse(text);
  };
  const project = await api('/api/projects/local-register', { path: repo, name: 'Proposals' });
  const memoryDir = path.join(root, path.basename(repo));
  const coreProject = path.join(memoryDir, 'core', 'project');
  await fs.mkdir(coreProject, { recursive: true });
  await fs.writeFile(path.join(coreProject, 'existing.md'), '---\ndescription: "Known"\n---\nКурсор событий должен оставаться монотонным.\n', 'utf8');

  const before = await api(`/api/projects/${project.id}/memory`);
  assert.equal(before.entries, 1);
  assert.equal(before.proposals.pending, 0);

  // --- предложение создаётся и НЕ становится памятью -------------------------
  const created = await post(`/api/projects/${project.id}/memory/proposals`, {
    text: 'Оборванная сессия должна оставлять базу чекпоинта: commit и время старта.',
    category: 'architecture',
    reason: 'иначе новая сессия не знает, с чего начиналась прерванная работа',
    paths: ['app.mjs'],
    sourceWorkItemId: 'wi-42',
  }, 201);
  assert.match(created.proposal.id, /^mp-/);
  assert.deepEqual(created.problems, []);

  const listed = await api(`/api/projects/${project.id}/memory/proposals`);
  assert.equal(listed.proposals.length, 1);
  assert.equal(listed.counts.pending, 1);
  const afterProposal = await api(`/api/projects/${project.id}/memory`);
  assert.equal(afterProposal.entries, 1, 'предложение не попало в память проекта');
  assert.equal(afterProposal.proposals.pending, 1, 'но видно инспектору как ожидающее решения');
  assert.deepEqual(await fs.readdir(coreProject), ['existing.md'], 'в core нового файла нет');

  // --- дубль и несуществующий путь отвергаются детерминированно --------------
  const duplicate = await post(`/api/projects/${project.id}/memory/proposals`, {
    text: 'Курсор событий должен оставаться монотонным.',
    category: 'constraint',
  }, 201);
  assert.deepEqual(duplicate.problems.map(problem => problem.code), ['DUPLICATE'], 'дубль виден сразу при создании');
  const dupAccept = await fetch(`${fixture.base}/api/projects/${project.id}/memory/proposals/${duplicate.proposal.id}/accept`, { method: 'POST', headers });
  assert.equal(dupAccept.status, 400, 'принять дубль нельзя');
  assert.deepEqual((await dupAccept.json()).problems.map(problem => problem.code), ['DUPLICATE']);
  // Вторая попытка того же — телеметрия накапливает коды, а не перезаписывает их.
  await fetch(`${fixture.base}/api/projects/${project.id}/memory/proposals/${duplicate.proposal.id}/accept`, { method: 'POST', headers });
  const withRefusals = await api(`/api/projects/${project.id}/memory/proposals`);
  assert.equal(withRefusals.counts.refused, 2, `счётчик отказов: ${JSON.stringify(withRefusals.counts)}`);
  assert.equal(withRefusals.counts.reasons.DUPLICATE, 2, 'видно, какой гейт срабатывает чаще всего');
  const duplicateEntry = withRefusals.proposals.find(entry => entry.id === duplicate.proposal.id);
  assert.deepEqual(duplicateEntry.refusals, ['DUPLICATE', 'DUPLICATE']);
  assert.match(String(duplicateEntry.lastRefusalAt), /^\d{4}-/);
  assert.equal(duplicateEntry.status, 'proposed', 'отказ не закрывает предложение — его можно исправить');

  const ghost = await post(`/api/projects/${project.id}/memory/proposals`, {
    text: 'Про модуль, которого нет.', category: 'architecture', paths: ['src/deleted.mjs'],
  }, 201);
  const ghostAccept = await fetch(`${fixture.base}/api/projects/${project.id}/memory/proposals/${ghost.proposal.id}/accept`, { method: 'POST', headers });
  assert.equal(ghostAccept.status, 400);
  assert.deepEqual((await ghostAccept.json()).problems.map(problem => problem.code), ['MISSING_PATHS']);
  assert.deepEqual(await fs.readdir(coreProject), ['existing.md'], 'ни одна отказанная заявка не тронула core');

  // --- принятие: единственный путь в память ---------------------------------
  const accepted = await post(`/api/projects/${project.id}/memory/proposals/${created.proposal.id}/accept`);
  assert.equal(accepted.ok, true);
  assert.match(accepted.target, /^core\/project\//);
  const files = await fs.readdir(coreProject);
  assert.equal(files.length, 2, `принятая заметка появилась в core: ${files}`);
  const note = await fs.readFile(path.join(memoryDir, accepted.target), 'utf8');
  assert.match(note, /tags: \[suggested\]/);
  assert.match(note, /paths: app\.mjs/, 'объявленные пути переносятся в заметку');
  assert.match(note, /источник|wi-42/, 'происхождение записано');

  const afterAccept = await api(`/api/projects/${project.id}/memory?q=${encodeURIComponent('чекпоинт')}`);
  assert.equal(afterAccept.entries, 2);
  assert.equal(afterAccept.hits.length, 1, 'принятое знание теперь находится поиском');
  // Не принято: дубль и «модуль, которого нет» — оба ждут решения человека.
  assert.equal(afterAccept.proposals.pending, 2, 'в буфере остались только непринятые');
  assert.equal(afterAccept.proposals.accepted, 1);

  // Повторное принятие — не «ещё одна запись», а отказ.
  const again = await fetch(`${fixture.base}/api/projects/${project.id}/memory/proposals/${created.proposal.id}/accept`, { method: 'POST', headers });
  assert.equal(again.status, 400);
  assert.match((await again.json()).error, /уже accepted/);
  assert.equal((await fs.readdir(coreProject)).length, 2, 'повторное принятие ничего не продублировало');

  // --- отклонение: файл остаётся, память не меняется -------------------------
  const rejected = await post(`/api/projects/${project.id}/memory/proposals/${ghost.proposal.id}/reject`, { reason: 'модуль уже удалён из проекта' });
  assert.equal(rejected.proposal.status, 'rejected');
  assert.equal(rejected.proposal.decisionReason, 'модуль уже удалён из проекта');
  assert.equal((await fs.readdir(coreProject)).length, 2, 'отказ не пишет в память');

  // --- переживает рестарт, потому что это файлы, а не состояние процесса -----
  await fixture.restart();
  const afterRestart = await api(`/api/projects/${project.id}/memory/proposals`);
  assert.deepEqual(
    { ...afterRestart.counts, refused: undefined, reasons: undefined },
    { pending: 1, accepted: 1, rejected: 1, refused: undefined, reasons: undefined },
    'счётчики пережили рестарт',
  );
  assert.equal(afterRestart.counts.reasons.DUPLICATE, 2, 'и телеметрия отказов тоже');
  assert.equal((await api(`/api/projects/${project.id}/memory`)).entries, 2);
  // Неизвестное предложение — 404 с внятной причиной, а не пустой успех: запрос
  // корректен, вещи с таким именем нет.
  const missing = await fetch(`${fixture.base}/api/projects/${project.id}/memory/proposals/mp-nope/accept`, { method: 'POST', headers });
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /не найдено/);
});

test('a suggestion can be accepted by the module directly, and never overwrites an existing note', async () => {
  const { parent, repo, root } = await memoryFixture();
  try {
    const memoryDir = path.join(root, path.basename(repo));
    const coreProject = path.join(memoryDir, 'core', 'project');
    await fs.mkdir(coreProject, { recursive: true });
    const first = await createProposal(memoryDir, { text: 'Правило первое: worktree не откатывается на main.', category: 'constraint' });
    const second = await createProposal(memoryDir, { text: 'Правило первое: worktree не откатывается на main.', category: 'constraint' });
    const ok = await acceptProposal(memoryDir, first.id, { projectPath: repo });
    assert.equal(ok.ok, true);
    const naming = await fs.readdir(coreProject);
    assert.equal(naming.length, 1);
    // Второе предложение с тем же текстом теперь дубль — и это отказ, а не вторая копия.
    const dup = await acceptProposal(memoryDir, second.id, { projectPath: repo, existingText: ['правило первое: worktree не откатывается на main.'] });
    assert.equal(dup.ok, false);
    assert.equal(dup.code, 'DUPLICATE');
    assert.equal((await fs.readdir(coreProject)).length, 1, 'файл не перезаписан и не продублирован');
    // Принятие без наблюдений вообще: путей нет — заметка не считается устаревшей.
    const noPaths = await createProposal(memoryDir, { text: 'Знание без путей живёт до явной отмены человеком.' });
    assert.equal((await acceptProposal(memoryDir, noPaths.id, { projectPath: repo })).ok, true);
    // Отказ при принятии НЕ закрывает предложение: его можно исправить и принять
    // позже или отклонить руками — поэтому оно остаётся pending.
    const all = await listProposals(memoryDir);
    // Отказ при принятии виден и в телеметрии: код DUPLICATE посчитан.
    assert.deepEqual(proposalCounts(all), { pending: 1, accepted: 2, rejected: 0, refused: 1, reasons: { DUPLICATE: 1 } });
    assert.equal((await rejectProposal(memoryDir, second.id, { reason: 'текст — дубль' })).ok, true);
    assert.deepEqual(proposalCounts(await listProposals(memoryDir)), { pending: 0, accepted: 2, rejected: 1, refused: 1, reasons: { DUPLICATE: 1 } });
    assert.deepEqual(await fs.readdir(coreProject).then(names => names.length), 2);
  } finally {
    await removeDir(root);
    await removeDir(parent);
  }
});

// M3: принятое предложение помечает себя `modified`, а предложение-замена адресует
// существующую заметку через `supersedes`. Замена — единственный способ вывести
// знание из контекста: в память его пишет человек, а не агент.
test('an accepted proposal is marked modified and can supersede an existing note', async t => {
  const memoryDir = await tmpMemory(t);
  const coreDir = path.join(memoryDir, 'core', 'project');
  await fs.mkdir(coreDir, { recursive: true });
  await fs.writeFile(path.join(coreDir, 'old.md'), '---\ndescription: Старое решение\n---\nОчередь через файл.\n', 'utf8');

  const proposal = await createProposal(memoryDir, {
    text: 'Очередь через брокер',
    category: 'decision',
    supersedes: 'core/project/old.md',
  }, { now: '2026-10-14T00:00:00.000Z' });
  assert.equal(proposal.supersedes, 'core/project/old.md', 'замена сохранена в предложении');

  const accepted = await acceptProposal(memoryDir, proposal.id, { now: '2026-10-14T01:00:00.000Z' });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.problems));
  const note = await fs.readFile(path.join(memoryDir, accepted.target), 'utf8');
  assert.match(note, /^modified: 2026-10-14T01:00:00\.000Z$/m, 'заметка помечена временем изменения');
  assert.match(note, /^supersedes: core\/project\/old\.md$/m, 'заметка знает, что заменяет');
});

test('a proposal that supersedes an unknown note is refused with the reason', async t => {
  const memoryDir = await tmpMemory(t);
  await fs.mkdir(path.join(memoryDir, 'core', 'project'), { recursive: true });
  const proposal = await createProposal(memoryDir, { text: 'Замена несуществующего', supersedes: 'core/project/нет.md' });
  const verdict = validateProposal(proposal, { memoryDir });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some(problem => problem.code === 'SUPERSEDES_UNKNOWN'), JSON.stringify(verdict.problems));
  // Замена вне core/ тоже не проходит: память инжектится только из core.
  const outside = validateProposal({ text: 'x', supersedes: '../секрет.md' }, { memoryDir });
  assert.ok(outside.problems.some(problem => problem.code === 'SUPERSEDES_UNKNOWN'), JSON.stringify(outside.problems));
});
