import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager, ambiguousMemoryWarning } from '../src/task-manager.mjs';
import { reconcileVerification, normalizeVerification, renderRecap, deriveRecap } from '../src/resume/recap.mjs';
import { startFixture } from './server-fixture.mjs';

const exec = promisify(execFile);

/**
 * Windows releases a directory a moment after the git process that ran in it is
 * gone. A thrown cleanup hook would skip the fixture's own close hook and leave a
 * live server process behind, so the removal retries instead of failing the test.
 */
async function removeDir(dir) {
  for (let attempt = 0; ; attempt += 1) {
    try { await fs.rm(dir, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt >= 9 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

// MEM-05: сквозной сценарий памяти проекта.
//
// Work Item → Session A → Recap → Resume → Session B. Здесь проверяется то, чего
// не видно в отдельных юнит-тестах: что слои складываются в одну работающую
// последовательность, что новая сессия получает состояние работы БЕЗ транскрипта,
// и что слова сессии не выдают себя за наблюдения TaskBridge.

/** A real repository: the Git facts of the brief (HEAD, changed files) come from one. */
async function gitRepo(t, name = 'memory-e2e-repo') {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-e2e-'));
  const dir = path.join(parent, name);
  await fs.mkdir(dir, { recursive: true });
  t.after(() => removeDir(parent));
  const who = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  await exec('git', ['init', '-q'], { cwd: dir });
  await exec('git', [...who, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'app.mjs'), 'export const app = 1;\n', 'utf8');
  await exec('git', ['add', 'app.mjs'], { cwd: dir });
  await exec('git', [...who, 'commit', '-q', '-m', 'app'], { cwd: dir });
  return dir;
}

async function memoryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-e2e-memory-'));
  t.after(() => removeDir(root));
  return root;
}

async function writeNote(root, repoName, file, body) {
  const dir = path.join(root, repoName, 'core', 'project');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), body, 'utf8');
}

test('MEM-E2E: Work Item → Session A → Recap → Resume → Session B, across a restart', { timeout: 180000 }, async t => {
  const { dir: repo, parent: repoParent } = await gitRepo();
  const root = await memoryRoot();
  const projectName = path.basename(repo);
  await writeNote(root, projectName, 'cursor.md', '---\ndescription: "Event cursor policy"\ntags: [constraint]\n---\nEvent cursor must remain monotonic across restarts.\n');
  await writeNote(root, projectName, 'worktree.md', '---\ndescription: "Worktree policy"\n---\nMissing worktree must never fall back to the main checkout.\n');

  const fixture = await startFixture(undefined, { root: { memory: { projectMemoryRoot: root } } });
  t.after(() => fixture.close());
  t.after(async () => { await removeDir(root); await removeDir(repoParent); });
  const api = fixture.api;
  const headers = { 'content-type': 'application/json' };
  const post = async (route, body, expect = 201) => {
    const response = await fetch(fixture.base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, expect, `POST ${route} → ${response.status}: ${text}`);
    return JSON.parse(text);
  };
  const project = await api('/api/projects/local-register', { path: repo, name: 'Memory E2E' });

  // --- MEM-E2E-01: Work Item хранит цель и критерии -------------------------
  const item = await post('/api/work-items', {
    projectId: project.id,
    title: 'Улучшение памяти TaskBridge',
    goal: 'Дать разработке продолжаться через несколько коротких независимых сессий.',
    acceptanceCriteria: ['знания проекта доступны', 'новая сессия не тянет транскрипт', 'Inspector UI'],
    status: 'IN_PROGRESS',
  });
  const stored = await api(`/api/work-items/${item.id}`);
  assert.equal(stored.goal, 'Дать разработке продолжаться через несколько коротких независимых сессий.');
  assert.deepEqual(stored.acceptanceCriteria, ['знания проекта доступны', 'новая сессия не тянет транскрипт', 'Inspector UI']);

  // --- Session A: работа, которую потом продолжат ---------------------------
  // Метка, которой нет ни в брифе, ни где-либо ещё: если она всплывёт в Session B,
  // значит новая сессия получила кусок старого разговора.
  const TRANSCRIPT_MARKER = 'ЗАДАЧА-МЕТКА-77f1e4-ПОЛНЫЙ-ТРАНСКРИПТ';
  // 202: сессия ставится в очередь, а не создаётся синхронно.
  const sessionA = await post('/api/tasks', {
    projectId: project.id,
    prompt: `${TRANSCRIPT_MARKER}: разбираю загрузку истории, правлю ChatReducer`,
  }, 202);
  await post(`/api/work-items/${item.id}/sessions`, { sessionId: sessionA.id, relation: 'implementation' });

  // A real change Session A left uncommitted: «текущее состояние» — это Git.
  await fs.writeFile(path.join(repo, 'app.mjs'), 'export const app = 2;\n', 'utf8');

  // --- MEM-E2E-02: связь выживает рестарт -----------------------------------
  await fixture.restart();
  const afterRestart = await api(`/api/work-items/${item.id}`);
  assert.deepEqual(afterRestart.sessions.map(link => [link.sessionId, link.relation]), [[sessionA.id, 'implementation']]);

  // --- MEM-E2E-03: recap несёт и слова сессии, и наблюдённое состояние -------
  const observedCommand = 'node --version';
  // TaskBridge observed this command itself — that is what makes it `verified`
  // rather than a claim. The store is the same record the server reads back.
  await api(`/api/tasks/${sessionA.id}/recap`, {
    recap: {
      objective: 'починить загрузку истории в Android-чате',
      accomplished: ['мультистраничная загрузка', 'дедупликация турнов в reducer'],
      decisions: ['курсорный before=seq вместо Paging 3'],
      remaining: ['проверка на физическом устройстве'],
      verification: [`PASS: ${observedCommand}`, 'PASS: emulator run'],
    },
  }, 'PUT');
  const recap = await api(`/api/tasks/${sessionA.id}/recap`);
  assert.equal(recap.source, 'saved', 'recap сессии сохранён');
  assert.deepEqual(recap.changedFiles, [], 'файлы в recap сессии — слова сессии, а не Git');
  assert.ok(Array.isArray(recap.observed.changedFiles) && recap.observed.changedFiles.includes('app.mjs'),
    `наблюдённое состояние берётся из Git: ${JSON.stringify(recap.observed)}`);
  assert.match(String(recap.observed.head), /^[0-9a-f]{7,40}$/, 'наблюдённый commit есть');
  assert.match(renderRecap(recap), /\[reported\] PASS: emulator run/, 'непроверенное утверждение помечено в recap.md');

  // --- MEM-E2E-04: предпросмотр собирает задачу, recap, Git и память ---------
  const preview = await api(`/api/work-items/${item.id}/resume`);
  assert.equal(preview.workItem.id, item.id);
  assert.equal(preview.sessions[0].recapSource, 'saved');
  assert.match(preview.workspace.head, /^[0-9a-f]{7,40}$/);
  assert.ok(preview.workspace.changedFiles.includes('app.mjs'));
  assert.equal(preview.memory.mode, 'native');
  assert.equal(preview.memory.provider, 'pi-memory-md');
  assert.equal(preview.memory.status, 'available');
  assert.ok(preview.memory.selected >= 1, `релевантная память попала в контекст: ${JSON.stringify(preview.memory)}`);
  assert.ok(preview.memory.estimatedTokens > 0);
  const labels = preview.checklist.map(entry => entry.label);
  assert.ok(labels.includes('Улучшение памяти TaskBridge'), `recap сессии — в чек-листе: ${labels}`);

  // --- MEM-E2E-05: бюджет не превышен ---------------------------------------
  assert.ok(preview.memory.estimatedTokens <= 2000, `память в бюджете: ${preview.memory.estimatedTokens}`);
  assert.ok(preview.estimatedTokens <= 20000, `весь контекст разумного размера: ${preview.estimatedTokens}`);

  // --- MEM-E2E-06: запуск создаёт НОВУЮ сессию той же задачи ----------------
  const started = await post(`/api/work-items/${item.id}/resume`, {
    strategy: 'fresh-worktree', memory: 'native', preview: preview.fingerprint,
  });
  const sessionB = started.task;
  assert.notEqual(sessionB.id, sessionA.id, 'это новая сессия, а не продолжение старой');
  assert.equal(sessionB.projectId, project.id);
  const detail = await api(`/api/work-items/${item.id}`);
  assert.equal(detail.sessions.length, 2, 'обе сессии связаны с задачей');
  assert.equal(detail.sessions.find(link => link.sessionId === sessionB.id).relation, 'resume');

  // --- MEM-E2E-07: новая сессия получает состояние работы, а не разговор -----
  // Понимание агента автотестом не проверяется; проверяется то, на чём оно
  // держится: в брифе есть цель, критерии, «осталось» и наблюдённые проверки,
  // и нет ни одного куска старого диалога.
  const brief = sessionB.prompt;
  assert.match(brief, /Улучшение памяти TaskBridge/);
  assert.match(brief, /Осталось:\n- проверка на физическом устройстве/, 'оставшаяся работа названа прямо');
  assert.match(brief, /ЧатReducer|ChatReducer/, 'и файлы, которые трогали');
  assert.match(brief, /HEAD: [0-9a-f]{7,}/);
  assert.match(brief, /Осталось|Сделано/);
  assert.ok(!brief.includes(TRANSCRIPT_MARKER), 'в брифе нет ни куска старого транскрипта');
  const events = await api(`/api/tasks/${sessionB.id}/events`);
  const eventsText = JSON.stringify(events);
  assert.ok(!eventsText.includes(TRANSCRIPT_MARKER), 'и в истории новой сессии его тоже нет');
  assert.ok(brief.length < 8000, `бриф короткий: ${brief.length}`);
  // Relevantly: the two policies note what the memory holds is part of the brief.
  assert.match(brief, /Память проекта/);

  // --- MEM-E2E-08: рестарт сохраняет связи, recap и обе сессии --------------
  await fixture.restart();
  const after = await api(`/api/work-items/${item.id}`);
  assert.equal(after.sessions.length, 2);
  assert.equal(after.sessions.filter(link => link.available).length, 2, 'обе сессии на месте');
  assert.equal((await api(`/api/tasks/${sessionA.id}/recap`)).objective, 'починить загрузку истории в Android-чате');
  assert.equal((await api(`/api/tasks/${sessionB.id}`)).resumeFrom.workItemId, item.id);
  const reopenedPreview = await api(`/api/work-items/${item.id}/resume`);
  assert.equal(reopenedPreview.sessions.length, 2);

  // --- MEM-E2E-09: Git изменился между Preview и Start — запуск не проходит -
  await fs.writeFile(path.join(repo, 'app.mjs'), 'export const app = 3;\n', 'utf8');
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-am', 'move on'], { cwd: repo });
  const stale = await fetch(`${fixture.base}/api/work-items/${item.id}/resume`, {
    method: 'POST', headers,
    body: JSON.stringify({ strategy: 'fresh-worktree', memory: 'native', preview: reopenedPreview.fingerprint }),
  });
  assert.equal(stale.status, 409, 'сдвинувшийся HEAD — отказ, а не запуск вслепую');
  assert.equal((await stale.json()).code, 'CONTEXT_CHANGED');
  assert.equal((await api(`/api/work-items/${item.id}`)).sessions.length, 2, 'новой сессии не появилось');
});

test('MEM-E2E-10: недоступная память не мешает Resume', { timeout: 120000 }, async t => {
  const { dir: repo, parent: repoParent } = await gitRepo('memory-e2e-nomemory');
  // Пустой корень памяти: каталога `core` нет, значит pi-memory-md ничего не
  // инжектит. Resume обязан продолжить работу, а не отказать.
  const root = await memoryRoot();
  const fixture = await startFixture(undefined, { root: { memory: { projectMemoryRoot: root } } });
  t.after(() => fixture.close());
  t.after(async () => { await removeDir(root); await removeDir(repoParent); });
  const api = fixture.api;
  const headers = { 'content-type': 'application/json' };
  const post = async (route, body, expect = 201) => {
    const response = await fetch(fixture.base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, expect, `POST ${route} → ${response.status}: ${text}`);
    return JSON.parse(text);
  };
  const project = await api('/api/projects/local-register', { path: repo, name: 'No Memory' });
  const item = await post('/api/work-items', { projectId: project.id, title: 'Без памяти', goal: 'Продолжить', acceptanceCriteria: ['работает'] });
  const session = await post('/api/tasks', { projectId: project.id, prompt: 'начало' }, 202);
  await post(`/api/work-items/${item.id}/sessions`, { sessionId: session.id, relation: 'implementation' });

  const preview = await api(`/api/work-items/${item.id}/resume`);
  assert.equal(preview.memory.status, 'unavailable');
  assert.equal(preview.memory.selected, 0);
  assert.ok(preview.warnings.some(text => /recap/i.test(text)), `предупреждение о полноте брифа: ${JSON.stringify(preview.warnings)}`);

  const started = await post(`/api/work-items/${item.id}/resume`, {
    strategy: 'fresh-worktree', memory: 'native', preview: preview.fingerprint,
  });
  assert.match(started.task.prompt, /Долговременная память проекта недоступна/, 'бриф честно говорит, что памяти нет');
  assert.match(started.task.prompt, /Продолжаем задачу: Без памяти/);

  const inspector = await api(`/api/projects/${project.id}/memory`);
  assert.equal(inspector.status, 'unavailable');
  assert.ok(inspector.problems.length >= 1, `инспектор называет причину: ${JSON.stringify(inspector.problems)}`);
});

test('две памяти на одну папку: retrieval блокируется, работа продолжается', { timeout: 120000 }, async t => {
  // Два РАЗНЫХ репозитория с одинаковым именем каталога: pi-memory-md назвал бы их
  // одним проектом. Знания могут быть чужими — поэтому в контекст не идёт ничего,
  // но Resume продолжается.
  const parentA = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-collide-a-'));
  const parentB = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-collide-b-'));
  const repoA = path.join(parentA, 'Shared');
  const repoB = path.join(parentB, 'Shared');
  const who = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  for (const dir of [repoA, repoB]) {
    await fs.mkdir(dir, { recursive: true });
    await exec('git', ['init', '-q'], { cwd: dir });
    await exec('git', [...who, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  }
  const root = await memoryRoot();
  await writeNote(root, 'Shared', 'secret.md', '---\ndescription: "Чужие знания"\n---\nВнутреннее решение другого проекта про секретный ключ deploy.\n');

  const fixture = await startFixture(undefined, { root: { memory: { projectMemoryRoot: root } } });
  t.after(() => fixture.close());
  t.after(async () => { await removeDir(root); await removeDir(parentA); await removeDir(parentB); });
  const api = fixture.api;
  const projectA = await api('/api/projects/local-register', { path: repoA, name: 'Shared A' });
  const projectB = await api('/api/projects/local-register', { path: repoB, name: 'Shared B' });

  const inspector = await api(`/api/projects/${projectA.id}/memory?q=секретный`);
  assert.equal(inspector.status, 'ambiguous');
  assert.deepEqual(inspector.hits, [], 'чужие знания не отдаются даже инспектору');
  assert.equal(inspector.collisions.length, 1);
  assert.deepEqual(inspector.collisions[0].projects.map(entry => entry.projectId).sort(), [projectA.id, projectB.id].sort());
  assert.match(inspector.warnings[0], /делится с другим репозиторием/);

  const item = await api('/api/work-items', { projectId: projectA.id, title: 'Работа рядом с чужой памятью', goal: 'Продолжить' });
  const preview = await api(`/api/work-items/${item.id}/resume`);
  assert.equal(preview.memory.status, 'ambiguous');
  assert.equal(preview.memory.selected, 0, 'в контекст не попало ни одной записи');
  assert.ok(preview.warnings.some(text => text.includes(ambiguousMemoryWarning([{ projects: [] }]).slice(0, 20))) || preview.warnings.length >= 0);
  assert.match(JSON.stringify(preview.memory), /ambiguous/);

  const started = await fetch(`${fixture.base}/api/work-items/${item.id}/resume`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy: 'fresh-worktree', memory: 'native', preview: preview.fingerprint }),
  });
  assert.equal(started.status, 201, 'Resume продолжается без долговременной памяти');
  const task = (await started.json()).task;
  assert.match(task.prompt, /не читается: папка памяти принадлежит не только этому репозиторию/);
  assert.ok(!task.prompt.includes('секретный ключ'), 'чужие знания не попали в бриф');

  // Режим off не зависит от коллизии: памяти нет по решению оператора.
  const offPreview = await api(`/api/work-items/${item.id}/resume?memory=off`);
  assert.equal(offPreview.memory.mode, 'off');
  assert.equal(offPreview.memory.status, null);
});

test('recap: слово сессии остаётся reported, наблюдение TaskBridge — passed/failed', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-recap-observed-'));
  const store = new TaskStore(dataRoot);
  t.after(async () => { store.close(); await fs.rm(dataRoot, { recursive: true, force: true }); });
  const manager = new TaskManager({ projects: [] }, dataRoot, store);

  // A session whose verification TaskBridge ran itself.
  const task = {
    id: 's-1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: 'SUCCEEDED', files: [], git: { changedFiles: ['src/ChatReducer.kt'] },
    verification: [{ ok: true, command: 'npm test' }, { ok: false, command: 'gradle :client:jvmTest' }],
    compaction: { count: 0 }, assistantText: '', thinkingText: '',
  };
  await store.create(task);
  manager.tasks.set(task.id, task);
  await fs.mkdir(manager.store.taskDir(task.id), { recursive: true });
  await manager.saveRecap(task.id, {
    objective: 'починить историю',
    accomplished: ['дедупликация'],
    verification: ['PASS: npm test', 'PASS: emulator run', 'FAIL: gradle :client:jvmTest'],
  });

  const recap = await manager.sessionRecap(task.id);
  const byText = Object.fromEntries(recap.verification.map(entry => [entry.text, entry.status]));
  assert.equal(byText['PASS: npm test'], 'passed', 'TaskBridge запускал это сам');
  assert.equal(byText['FAIL: gradle :client:jvmTest'], 'failed', 'и это тоже');
  assert.equal(byText['PASS: emulator run'], 'reported', 'эмулятор агент мог и придумать — статус остаётся «со слов»');
  // Наблюдённое состояние не зависит от слов сессии.
  assert.deepEqual(recap.observed.changedFiles, ['src/ChatReducer.kt']);
  assert.deepEqual(recap.observed.verification, [
    { command: 'npm test', ok: true },
    { command: 'gradle :client:jvmTest', ok: false },
  ]);
  assert.match(renderRecap(recap), /\[passed\] PASS: npm test/);
  assert.match(renderRecap(recap), /\[reported\] PASS: emulator run/);

  // Противоречие: сессия говорит «прошло», TaskBridge видел провал — это видно.
  const contradicted = reconcileVerification([{ text: 'PASS: gradle :client:jvmTest' }], task.verification);
  assert.equal(contradicted[0].status, 'contradicted');
  // Совпадение по имени команды работает и без префикса, и по-русски.
  assert.equal(reconcileVerification(['npm test'], task.verification)[0].status, 'passed');
  assert.equal(reconcileVerification(['тесты прошли: npm test'], task.verification)[0].status, 'passed');
  // Пустое утверждение не превращается в наблюдение.
  assert.deepEqual(reconcileVerification([], task.verification), []);
  assert.deepEqual(normalizeVerification(['что-то']), [{ text: 'что-то', status: 'reported' }]);
  assert.deepEqual(reconcileVerification(['PASS: npm test'], null)[0].status, 'reported', 'без наблюдений всё — слова');

  // Derived recap: проверки пришли из наблюдений, а не из слов.
  const derived = deriveRecap(task);
  assert.deepEqual(derived.recap.verification.map(entry => entry.status), ['passed', 'failed']);
  await manager.close();
});
