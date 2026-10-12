import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeContext, sessionSummary, estimateContextTokens } from '../src/resume/resume-builder.mjs';
import { renderResumePrompt } from '../src/resume/resume-renderer.mjs';
import { contextFingerprint, validateResume, describeChanges } from '../src/resume/resume-validator.mjs';
import { normalizeRecap, deriveRecap, renderRecap } from '../src/resume/recap.mjs';
import { PiMemoryMdProvider, resumeMemoryQueries, memoryCollisions } from '../src/memory/project-memory-provider.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startFixture } from './server-fixture.mjs';

const exec = promisify(execFile);

/**
 * A real repository: the resume context's Git facts (HEAD, changed files) come from
 * one, so a fixture folder without git would let them all be null unnoticed.
 */
async function gitRepo(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-resume-repo-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const opts = { cwd: dir };
  const who = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  await exec('git', ['init', '-q'], opts);
  await exec('git', [...who, 'commit', '-q', '--allow-empty', '-m', 'init'], opts);
  await fs.writeFile(path.join(dir, 'app.mjs'), 'export const app = 1;\n', 'utf8');
  await exec('git', ['add', 'app.mjs'], opts);
  await exec('git', [...who, 'commit', '-q', '-m', 'app'], opts);
  return dir;
}

// MR-04: движок продолжения работы. Здесь проверяется главное обещание — новая
// сессия получает задачу, итоги прошлых сессий, состояние Git и проверки, но НЕ
// транскрипт; и то, что «предпросмотр ≠ запуск»: изменившиеся факты — это отказ с
// перечнем, а не запуск вслепую.

const workItem = {
  id: 'wi-1', projectId: 'p', title: 'Project Dashboard', goal: 'Проектный интерфейс',
  status: 'IN_PROGRESS', acceptanceCriteria: ['список проектов', 'pinned/archive'],
};

const SAVED_RECAP = {
  source: 'saved', objective: 'сделать обзор проектов', accomplished: ['схема в SQLite'],
  decisions: ['архив = флаг'], remaining: ['PWA'], blockers: [],
};

/** [recap] is taken from the overrides, so a session WITHOUT a recap can be built. */
function session({ recap = SAVED_RECAP, ...overrides } = {}) {
  return sessionSummary({
    sessionId: 's-1', relation: 'implementation', available: true,
    title: 'backend часть', status: 'SUCCEEDED', updatedAt: '2026-10-11T10:00:00.000Z',
    changedFiles: ['src/task-store.mjs', 'src/server.mjs'],
    verification: ['PASS: npm test', 'FAIL: emulator run'],
    ...overrides,
  }, { recap });
}

test('the context carries the work item, its sessions and the facts, and nothing else', () => {
  const context = buildResumeContext({
    workItem,
    sessions: [session()],
    workspace: { strategy: 'fresh-worktree', path: '/worktrees/a', head: 'abc1234', changedFiles: ['src/a.mjs'], worktree: true },
    verification: { status: 'PASSED', commands: [{ ok: true, command: 'npm test' }] },
    artifacts: [{ sessionId: 's-1', name: 'diff.patch', bytes: 2048 }],
    memory: { mode: 'native' },
    strategy: 'fresh-worktree',
  });
  assert.equal(context.workItem.title, 'Project Dashboard');
  assert.deepEqual(context.workItem.acceptanceCriteria, ['список проектов', 'pinned/archive']);
  assert.equal(context.previousSessions.length, 1);
  assert.equal(context.previousSessions[0].recap.source, 'saved');
  assert.equal(context.workspace.head, 'abc1234');
  assert.equal(context.workspace.strategy, 'fresh-worktree');
  assert.equal(context.verification.status, 'PASSED');
  assert.deepEqual(context.relevantArtifacts, [{ sessionId: 's-1', name: 'diff.patch', bytes: 2048 }]);
  assert.deepEqual(context.memory, { mode: 'native' });
  // An unknown strategy is refused rather than silently replaced. («patch» from the
  // roadmap's sketch is deliberately not implemented — see resume-builder.mjs.)
  assert.throws(() => buildResumeContext({ workItem, strategy: 'patch' }), /Unknown workspace strategy/);
  assert.throws(() => buildResumeContext({ workItem, strategy: 'nonsense' }), /Unknown workspace strategy/);
  assert.ok(estimateContextTokens(context) > 0);
});

test('the brief says what to do and does not repeat the conversation', () => {
  const context = buildResumeContext({
    workItem,
    sessions: [session(), session({ sessionId: 's-2', title: 'android часть', recap: null })],
    workspace: { strategy: 'fresh-worktree', path: '/worktrees/a', head: 'abc1234', changedFiles: ['src/ChatSession.kt'] },
    verification: { status: 'PASSED', commands: [{ ok: true, command: 'npm test' }] },
    memory: { mode: 'native' },
  });
  const prompt = renderResumePrompt(context);
  assert.match(prompt, /Продолжаем задачу: Project Dashboard/);
  assert.match(prompt, /## Критерии готовности\n- список проектов\n- pinned\/archive/, 'критерии перечислены');
  assert.match(prompt, /сделать обзор проектов/, 'итог сессии с recap попал в бриф');
  assert.match(prompt, /схема в SQLite/, 'и что было сделано');
  assert.match(prompt, /Осталось:\n- PWA/, 'и что осталось');
  assert.match(prompt, /итог этой сессии не зафиксирован/, 'сессия без recap честно помечена');
  assert.match(prompt, /flutter|npm test/u, 'проверки в брифе');
  assert.match(prompt, /HEAD: abc1234/);
  assert.match(prompt, /pi-memory-md/, 'сказано, что память проекта подключается сама');
  assert.match(prompt, /Не пересказывай этот бриф/, 'и как работать');
  // No transcript: the brief is short, and it never quotes the conversation.
  assert.ok(prompt.length < 6000, `бриф должен быть коротким, а он ${prompt.length} символов`);
  assert.ok(!prompt.includes('assistant-'), 'никаких кусков транскрипта');
});

test('a recap derives what is known and leaves the semantic lists empty', () => {
  const derived = deriveRecap({
    title: 'Project Dashboard',
    prompt: 'многострочный промпт\nвторая строка',
    git: { changedFiles: ['a.mjs', 'b.mjs'] },
    verification: [{ ok: true, command: 'npm test' }, { ok: false, command: 'gradle test' }],
  });
  assert.equal(derived.source, 'derived');
  assert.equal(derived.recap.objective, 'Project Dashboard', 'цель — из самой сессии');
  assert.deepEqual(derived.recap.changedFiles, ['a.mjs', 'b.mjs']);
  // Проверки, которые запускал TaskBridge, — это результат, а не слова сессии.
  assert.deepEqual(derived.recap.verification, [
    { text: 'PASS: npm test', status: 'passed' },
    { text: 'FAIL: gradle test', status: 'failed' },
  ]);
  assert.deepEqual(derived.recap.accomplished, [], 'придумывать «сделано» нельзя');
  assert.deepEqual(derived.recap.decisions, []);
  assert.deepEqual(normalizeRecap({ objective: '  x  ', accomplished: [' ', 'y', null], tags: 'нет' }).accomplished, ['y']);
  assert.equal(normalizeRecap({ objective: '  x  ' }).objective, 'x', 'значение обрезается');
  assert.match(renderRecap(derived.recap), /ничего не зафиксировано/);
});

test('pi-memory-md provider inspects, searches and deduplicates read-only project memory', async t => {
  const repo = await gitRepo(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const memoryDir = path.join(root, path.basename(repo), 'core', 'project');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'history.md'), `---\ndescription: "Cursor paging decision"\ntags: [decision, chat]\n---\nAndroid chat history uses cursor-based before=seq paging. Cursor must decrease.\n`, 'utf8');
  await fs.writeFile(path.join(memoryDir, 'history-copy.md'), `---\ndescription: "Duplicate"\n---\nAndroid chat history uses cursor-based before=seq paging. Cursor must decrease.\n`, 'utf8');
  await fs.writeFile(path.join(memoryDir, 'worktree.md'), `---\ndescription: "Worktree constraint"\n---\nMissing worktree must never fall back to the main checkout.\n`, 'utf8');

  const provider = new PiMemoryMdProvider({ root });
  const overview = await provider.inspect({ path: repo });
  assert.equal(overview.status, 'available');
  assert.equal(overview.write, 'SAVE_DISABLED');
  assert.equal(overview.entries, 3);
  assert.ok(overview.injectedAutomatically);

  const hits = await provider.search({ path: repo }, 'Android chat history cursor', { limit: 10 });
  assert.equal(hits.length, 1, 'identical memory text is included once');
  assert.equal(hits[0].category, 'decision');
  assert.match(hits[0].text, /before=seq/);

  const selected = await provider.relevant({ path: repo }, { queries: resumeMemoryQueries({ title: 'Android chat history' }, [], { changedFiles: ['ChatSession.kt'] }), budgetTokens: 80 });
  assert.equal(selected.overview.status, 'available');
  assert.ok(selected.hits.length >= 1);

  const again = await provider.relevant({ path: repo }, { queries: ['Android chat history cursor'], budgetTokens: 80 });
  assert.deepEqual(again.hits.map(hit => hit.id), selected.hits.map(hit => hit.id), 'same query and memory state select the same hits');
});

test('pi-memory-md provider uses the main checkout identity for git worktrees', async t => {
  const repo = await gitRepo(t);
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-linked-worktree-'));
  await fs.rm(worktree, { recursive: true, force: true });
  t.after(() => fs.rm(worktree, { recursive: true, force: true }));
  await exec('git', ['worktree', 'add', '-q', '--detach', worktree, 'HEAD'], { cwd: repo });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, path.basename(repo), 'core', 'project'), { recursive: true });
  await fs.writeFile(path.join(root, path.basename(repo), 'core', 'project', 'policy.md'), `---\ndescription: "Worktree policy"\n---\nLinked worktrees share one project memory.\n`, 'utf8');

  const provider = new PiMemoryMdProvider({ root });
  const main = await provider.inspect({ path: repo });
  const linked = await provider.inspect({ path: worktree });
  assert.equal(linked.projectName, main.projectName);
  assert.equal(linked.memoryDir, main.memoryDir);
  assert.equal(linked.entries, 1);
});

test('two different repositories with the same directory name are reported as a memory collision, not merged silently', async t => {
  const parentA = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-identity-a-'));
  const parentB = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-identity-b-'));
  t.after(() => fs.rm(parentA, { recursive: true, force: true }));
  t.after(() => fs.rm(parentB, { recursive: true, force: true }));
  const repoA = path.join(parentA, 'SameName');
  const repoB = path.join(parentB, 'SameName');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const exec2 = (cwd, args) => exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
  for (const dir of [repoA, repoB]) {
    await fs.mkdir(dir, { recursive: true });
    await exec2(dir, ['init', '-q']);
    await exec2(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  }

  const provider = new PiMemoryMdProvider({ root });
  const resolved = await provider.resolveProjects([
    { id: 'a', name: 'SameName', path: repoA },
    { id: 'b', name: 'SameName', path: repoB },
  ]);
  assert.notEqual(resolved[0].repoRoot, resolved[1].repoRoot, 'это разные репозитории');
  const collisions = memoryCollisions(resolved);
  assert.equal(collisions.length, 1, 'общая папка памяти между разными репозиториями видна');
  assert.deepEqual(collisions[0].projects.map(project => project.projectId).sort(), ['a', 'b']);

  // Two DIFFERENT names never collide, and neither does the same project twice.
  const distinct = await provider.resolveProjects([
    { id: 'a', name: 'A', path: path.join(parentA, 'UniqueA') },
    { id: 'b', name: 'B', path: path.join(parentB, 'UniqueB') },
  ]);
  assert.deepEqual(memoryCollisions(distinct), [], 'разные имена — разная память');
  assert.deepEqual(memoryCollisions(await provider.resolveProjects([{ id: 'a', path: repoA }, { id: 'a2', path: repoA }])), [], 'один и тот же репозиторий — не коллизия');
});

test('a changed memory selection is caught between preview and launch, an irrelevant change is not', async t => {
  const repo = await gitRepo(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const memoryDir = path.join(root, path.basename(repo), 'core', 'project');
  await fs.mkdir(memoryDir, { recursive: true });
  const note = path.join(memoryDir, 'cursor.md');
  await fs.writeFile(note, `---\ndescription: "Cursor policy"\n---\nEvent cursor must remain monotonic.\n`, 'utf8');

  const provider = new PiMemoryMdProvider({ root });
  const project = { path: repo };
  const fingerprintOf = async () => {
    const facts = await provider.relevant(project, { queries: ['event cursor monotonic'], budgetTokens: 500 });
    const context = buildResumeContext({ workItem, sessions: [session()], memory: { mode: 'native', ...facts }, strategy: 'fresh-worktree' });
    return contextFingerprint(context);
  };

  const preview = await fingerprintOf();
  assert.equal(preview.memoryHits.length, 1, 'релевантная запись выбрана');
  assert.equal(preview.memoryStatus, 'available');

  // A note the query does not match: the new session's memory is unchanged, so the
  // launch must NOT be blocked by it — otherwise every unrelated edit stops resume.
  await fs.writeFile(path.join(memoryDir, 'unrelated.md'), `---\ndescription: "Build times"\n---\nGradle takes seven minutes.\n`, 'utf8');
  const afterUnrelated = await fingerprintOf();
  assert.deepEqual(afterUnrelated.memoryHits, preview.memoryHits);
  assert.equal(validateResume({ preview, current: afterUnrelated }).ok, true, 'нерелевантное изменение не мешает запуску');

  // The selected record itself changed: the brief would now say something else.
  await fs.writeFile(note, `---\ndescription: "Cursor policy"\n---\nEvent cursor must remain monotonic and never reset on restart.\n`, 'utf8');
  const afterChange = await fingerprintOf();
  assert.notDeepEqual(afterChange.memoryHits, preview.memoryHits, 'другая редакция — другая запись');
  const verdict = validateResume({ preview, current: afterChange });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.changes[0].field, 'memory.hits');
  assert.match(describeChanges(verdict.changes), /записи памяти изменились/);

  // Memory going away entirely is named as such, not as a generic change.
  const gone = validateResume({ preview, current: { ...preview, memoryStatus: 'unavailable', memoryHits: [] } });
  assert.equal(gone.ok, false);
  assert.match(describeChanges(gone.changes), /состояние памяти изменилось/);
});

test('pi-memory-md provider is unavailable instead of guessing for missing memory and respects budgets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-memory-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-not-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const provider = new PiMemoryMdProvider({ root });
  const unavailable = await provider.relevant({ path: project }, { queries: ['anything'] });
  assert.equal(unavailable.overview.status, 'unavailable');
  assert.deepEqual(unavailable.hits, []);
  assert.ok(unavailable.warnings.length, 'resume can show memory warning and continue');

  const memoryDir = path.join(root, path.basename(project), 'core', 'project');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'huge.md'), `---\ndescription: "Huge memory"\n---\n${'memory '.repeat(5000)}`, 'utf8');
  const tinyBudget = await provider.relevant({ path: project }, { queries: ['memory'], budgetTokens: 10 });
  assert.equal(tinyBudget.overview.status, 'available');
  assert.deepEqual(tinyBudget.hits, [], 'one large hit is not allowed to exceed the memory budget');

  // Many small records: the count limit holds as well as the token budget, and
  // the total of what was selected never exceeds the budget it was given.
  for (let index = 0; index < 40; index += 1) {
    await fs.writeFile(path.join(memoryDir, `small-${index}.md`), `---\ndescription: "Мелкая заметка ${index}"\n---\nКурсор событий должен оставаться монотонным. Многострочная заметка:\nвторая строка\nтретья строка\n`, 'utf8');
  }
  const many = await provider.relevant({ path: project }, { queries: ['курсор событий'], budgetTokens: 2000 });
  assert.ok(many.hits.length > 0 && many.hits.length <= 8, `записей не больше восьми: ${many.hits.length}`);
  const spent = many.hits.reduce((sum, hit) => sum + hit.estimatedTokens, 0);
  assert.ok(spent <= 2000, `бюджет соблюдён: ${spent}`);
  assert.equal(many.estimatedTokens, spent, 'названная цена — сумма выбранного');
  // Кириллица и многострочный markdown не ломают ни оценку, ни выбор.
  assert.match(many.hits[0].text, /Курсор событий/u);
});

test('the launch refuses when the previewed facts moved', () => {
  const context = buildResumeContext({
    workItem,
    sessions: [session()],
    workspace: { strategy: 'fresh-worktree', path: '/worktrees/a', head: 'abc1234' },
    artifacts: [{ sessionId: 's-1', name: 'diff.patch', bytes: 10 }],
    memory: { mode: 'native' },
  });
  const preview = contextFingerprint(context);
  assert.deepEqual(validateResume({ preview, current: preview }).changes, [], 'ничего не изменилось — запускаем');

  const movedHead = validateResume({ preview, current: { ...preview, head: 'def5678' } });
  assert.equal(movedHead.ok, false);
  assert.match(describeChanges(movedHead.changes), /HEAD сдвинулся/);

  const goneWorktree = validateResume({ preview, current: { ...preview, worktreePath: null } });
  assert.match(describeChanges(goneWorktree.changes), /рабочая папка исчезла/);

  const goneSession = validateResume({ preview, current: { ...preview, sessionIds: [] } });
  assert.match(describeChanges(goneSession.changes), /сессии из превью больше нет/);

  const goneArtifact = validateResume({ preview, current: { ...preview, artifacts: [] } });
  assert.match(describeChanges(goneArtifact.changes), /артефакт из превью удалён/);

  // The workspace strategy is part of what the operator confirmed: a preview taken
  // with one strategy and a launch with another must be refused, and the client
  // re-asks for the preview instead of starting something nobody saw.
  const strategyMoved = validateResume({ preview, current: { ...preview, strategy: 'reuse' }, requested: { strategy: 'reuse' } });
  assert.equal(strategyMoved.ok, false);
  assert.equal(strategyMoved.changes[0].field, 'workspace.strategy');
  // What the operator confirms is what starts: the same strategy is fine.
  assert.equal(validateResume({ preview, current: preview, requested: { strategy: 'fresh-worktree' } }).ok, true);
  // An unknown requested value is refused, with the field named.
  const unknown = validateResume({ preview, current: preview, requested: { memory: 'telepathy' } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.changes[0].field, 'memory');
});

test('a work item resumes into a new short session, and a moved HEAD stops it', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const api = fixture.api;
  const headers = { 'content-type': 'application/json' };
  const [project] = await api('/api/projects');
  const post = async (route, body, expect = 201) => {
    const response = await fetch(fixture.base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, expect, `POST ${route} → ${response.status}: ${text}`);
    return JSON.parse(text);
  };

  // A real repository: HEAD and the changed files in the brief are git facts, and a
  // temp folder without git would let them be null without anyone noticing.
  const repo = await gitRepo(t);
  const project2 = await api('/api/projects/local-register', { path: repo, name: 'Resume Repo' });
  assert.notEqual(project2.id, project.id);

  const item = await post('/api/work-items', {
    projectId: project2.id, title: 'Project Dashboard', goal: 'Проектный интерфейс',
    acceptanceCriteria: ['обзор проектов'],
  });
  const first = await api('/api/tasks', { projectId: project2.id, prompt: 'backend часть' });
  await post(`/api/work-items/${item.id}/sessions`, { sessionId: first.id, relation: 'implementation' });
  // A change the session left uncommitted: that is what «current state» means.
  await fs.writeFile(path.join(repo, 'app.mjs'), 'export const app = 2;\n', 'utf8');

  // A recap written by the agent is what the next session will read.
  const saved = await api(`/api/tasks/${first.id}/recap`, {
    recap: {
      objective: 'сделать обзор проектов',
      accomplished: ['схема в SQLite', 'дашборд-API'],
      decisions: ['архив — это флаг, а не удаление'],
      remaining: ['PWA-дашборд'],
      verification: ['PASS: npm test'],
    },
  }, 'PUT');
  assert.equal(saved.source, 'saved', 'recap сохранён как написанный');
  assert.match(saved.updatedAt, /^\d{4}-/);
  const readBack = await api(`/api/tasks/${first.id}/recap`);
  assert.deepEqual(readBack.accomplished, ['схема в SQLite', 'дашборд-API']);
  assert.equal(readBack.source, 'saved');

  // The preview: what will be in the new session, and what will not.
  const preview = await api(`/api/work-items/${item.id}/resume`);
  assert.equal(preview.workItem.title, 'Project Dashboard');
  assert.ok(preview.estimatedTokens > 0, 'предпросмотр называет цену');
  assert.ok(preview.promptChars > 0);
  const labels = preview.checklist.map(entry => entry.label);
  assert.ok(labels.includes('Цель') && labels.includes('Критерии готовности'), `чек-лист: ${labels}`);
  assert.equal(preview.checklist.find(entry => entry.label === 'Цель').present, true);
  assert.equal(preview.checklist.find(entry => entry.label === 'backend часть').present, true, 'recap сессии — в контексте');
  assert.deepEqual(preview.sessions.map(s => s.sessionId), [first.id]);
  assert.equal(preview.sessions[0].recapSource, 'saved');
  assert.match(String(preview.fingerprint.head), /^[0-9a-f]{7,40}$/, 'fingerprint знает commit');
  assert.equal(preview.workspace.head, preview.fingerprint.head, 'предпросмотр и запуск смотрят один и тот же commit');
  assert.ok(preview.workspace.changedFiles.includes('app.mjs'), `незакоммиченная правка видна: ${JSON.stringify(preview.workspace.changedFiles)}`);
  assert.deepEqual(preview.workspace.strategies, ['fresh-worktree', 'reuse'], 'предлагаются только реализованные стратегии');
  assert.equal(preview.memory.mode, 'native');

  // Launch with a preview that no longer matches: refused, with the reason.
  const stale = { ...preview.fingerprint, head: 'deadbeef' };
  const refused = await fetch(`${fixture.base}/api/work-items/${item.id}/resume`, {
    method: 'POST', headers,
    body: JSON.stringify({ strategy: 'fresh-worktree', memory: 'native', preview: stale }),
  });
  assert.equal(refused.status, 409);
  const refusal = await refused.json();
  assert.equal(refusal.code, 'CONTEXT_CHANGED');
  assert.ok(Array.isArray(refusal.changes) && refusal.changes.length, `перечень изменений обязателен: ${JSON.stringify(refusal)}`);

  // Launch with the confirmed preview: a NEW session, short, linked as `resume`.
  const started = await post(`/api/work-items/${item.id}/resume`, {
    strategy: 'fresh-worktree', memory: 'native', preview: preview.fingerprint,
  });
  const resumed = started.task;
  assert.notEqual(resumed.id, first.id, 'это новая сессия, а не продолжение старой');
  assert.equal(resumed.projectId, project2.id);
  assert.match(resumed.prompt, /Продолжаем задачу: Project Dashboard/);
  assert.match(resumed.prompt, /схема в SQLite/, 'новая сессия знает, что уже сделано');
  assert.match(resumed.prompt, /Осталось:\n- PWA-дашборд/);
  assert.match(resumed.prompt, new RegExp(`HEAD: ${preview.fingerprint.head}`), 'новая сессия знает commit');
  assert.match(resumed.prompt, /Незакоммиченные изменения: app\.mjs/, 'и что осталось незакоммиченным');
  assert.ok(resumed.prompt.length < 8000, `промпт короткий: ${resumed.prompt.length}`);
  assert.equal(resumed.title, 'Project Dashboard (продолжение)');
  assert.equal(resumed.resumeFrom.workItemId, item.id, 'происхождение записано в самой сессии');
  assert.deepEqual(resumed.resumeFrom.sessionIds, [first.id]);
  assert.equal(resumed.resumeFrom.workspaceStrategy, 'fresh-worktree');

  const detail = await api(`/api/work-items/${item.id}`);
  const link = detail.sessions.find(session => session.sessionId === resumed.id);
  assert.equal(link.relation, 'resume', 'новая сессия связана с задачей как resume');
  assert.equal(detail.sessions.length, 2, 'и старая связь осталась');

  // Reuse without a preview is refused: it is a decision about someone's working copy.
  const noPreview = await fetch(`${fixture.base}/api/work-items/${item.id}/resume`, {
    method: 'POST', headers, body: JSON.stringify({ strategy: 'reuse' }),
  });
  assert.equal(noPreview.status, 400);
  // And an unknown strategy is refused too.
  assert.equal((await fetch(`${fixture.base}/api/work-items/${item.id}/resume`, {
    method: 'POST', headers, body: JSON.stringify({ strategy: 'patch' }),
  })).status, 400);

  // A resume of an unknown work item is a 404, not a new session.
  assert.equal((await fetch(`${fixture.base}/api/work-items/wi-nope/resume`)).status, 404);

  // The recap can be forgotten: the derived one takes over.
  await api(`/api/tasks/${first.id}/recap`, {}, 'DELETE');
  const afterForget = await api(`/api/tasks/${first.id}/recap`);
  assert.equal(afterForget.source, 'derived');
  assert.match(afterForget.objective ?? '', /backend часть/, 'выведенная цель — из самой сессии');
  const noRecapPreview = await api(`/api/work-items/${item.id}/resume`);
  assert.equal(noRecapPreview.sessions.find(s => s.sessionId === first.id).recapSource, 'derived');
  assert.ok(noRecapPreview.warnings.some(text => text.includes('нет recap')), `предупреждение обязательно: ${JSON.stringify(noRecapPreview.warnings)}`);

  // A restart keeps the linkage and the recap file.
  await fixture.restart();
  assert.equal((await api(`/api/work-items/${item.id}`)).sessions.length, 2);
  assert.equal((await api(`/api/tasks/${first.id}/recap`)).source, 'derived');
});
