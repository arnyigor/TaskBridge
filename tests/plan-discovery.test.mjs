// FP-UX-04: сканирование проекта, вердикт выбранного файла и необязательная
// проверка ИИ — без HTTP и без Pi.
//
// Проверяются те свойства, ради которых всё это разделено: сканирование не
// обходит ссылки и служебные каталоги, не читает файлы целиком; вердикт не
// считает README планом; ИИ не запускается сам и не блокирует подключение.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { FollowPlanService } from '../src/follow-plan-service.mjs';
import { scanPlanFiles, classifyPlanHead, SCAN_DEFAULTS } from '../src/application/plan-scan.mjs';
import { classifyPlan, declaresManagedFormat, hasCheckboxSteps } from '../src/application/plan-file.mjs';
import { buildPlanReviewPrompt, parsePlanReviewAnswer, AI_REVIEW_LIMITS } from '../src/application/plan-ai-review.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-scan
revision: 1
goal: "FP-UX-04: сканирование"
---

# План: сканирование

## Шаги

### S-001 | TODO | P1 | Первый шаг
**Критерии:** сделано.
**Проверка:** run

## Обнаруженные проблемы
`;

const TODO_LIST = '# Задачи\n\n- [ ] Починить пагинацию\n- [ ] Проверить приёмку\n';
const README = '# Проект\n\nОписание проекта.\n\n1. Установить зависимости\n2. Запустить сервер\n';

const setup = async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-discovery-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'PLAN.md'), PLAN, 'utf8');
  const store = new TaskStore(root);
  t.after(async () => {
    store.close?.();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
  const manager = {
    getTask: id => (String(id) === 't-1' ? { id: 't-1', workspacePath: workspace, runId: null } : null),
    listTasks: () => [{ id: 't-1' }],
    message: async () => ({ id: 'x' }),
    cancel: async () => {},
    publishFollowPlanEvent: async () => {}
  };
  const service = new FollowPlanService({ manager, store, config: { followPlan: { enabled: true } } });
  return { root, workspace, store, manager, service };
};


/** Закрыть store и убрать временный каталог (эти тесты не используют t.after). */
function cleanupStore(store, root) {
  store.close?.();
  fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

const write = async (file, text = '# документ\n') => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
};

// --- FP-UX-04B: сканирование ------------------------------------------------

test('DISC-03/DISC-04: nested Markdown is found and the answer lists files, not folders', async t => {
  const { workspace } = await setup(t);
  await write(path.join(workspace, 'docs', 'deep', 'nested.md'), TODO_LIST);
  await write(path.join(workspace, 'docs', 'readme.markdown'), README);
  await write(path.join(workspace, 'notes.txt'), 'не план\n');

  const scan = await scanPlanFiles({ root: workspace });
  const paths = scan.files.map(file => file.path);
  assert.deepEqual(paths, ['PLAN.md', 'docs/deep/nested.md', 'docs/readme.markdown']);
  for (const file of scan.files) {
    assert.equal(typeof file.name, 'string');
    assert.equal(file.path.includes('\\'), false, 'пути отдаются через /');
    assert.equal(file.name.includes('/'), false, 'в списке только файлы');
  }
  assert.equal(scan.partial, false);
  assert.equal(scan.path, '');
});

test('DISC-05: the query filters by name and by relative path', async t => {
  const { workspace } = await setup(t);
  await write(path.join(workspace, 'docs', 'release-notes.md'));
  const byName = await scanPlanFiles({ root: workspace, query: 'RELEASE' });
  assert.deepEqual(byName.files.map(file => file.path), ['docs/release-notes.md']);
  const byPath = await scanPlanFiles({ root: workspace, query: 'docs/' });
  assert.deepEqual(byPath.files.map(file => file.path), ['docs/release-notes.md']);
  // Фильтр не прячет общее число найденного: интерфейс говорит «показано N из M».
  assert.equal(byPath.total, 2);
  const none = await scanPlanFiles({ root: workspace, query: 'нет-такого' });
  assert.deepEqual(none.files, []);
  assert.equal(none.partial, false);
});

test('DISC-06: service directories are skipped, so a big project does not hang', async t => {
  const { workspace } = await setup(t);
  for (const dir of ['node_modules', 'build', 'dist', '.git', '.local', '.gradle']) {
    await write(path.join(workspace, dir, 'PLAN.md'), PLAN);
  }
  const scan = await scanPlanFiles({ root: workspace });
  assert.deepEqual(scan.files.map(file => file.path), ['PLAN.md']);
  assert.equal(scan.skippedLinks.length, 0);
});

test('DISC-07: a link pointing outside the project is not walked', async t => {
  const { root, workspace } = await setup(t);
  const outside = path.join(root, 'outside');
  await write(path.join(outside, 'SECRET-PLAN.md'), TODO_LIST);
  const link = path.join(workspace, 'link');
  let type = 'dir';
  try {
    // junction на Windows работает без прав администратора; на POSIX — обычный symlink
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : type);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.diagnostic(`symlink недоступен в этой среде: ${error.code}`);
      return;
    }
    throw error;
  }
  const scan = await scanPlanFiles({ root: workspace });
  assert.deepEqual(scan.files.map(file => file.path), ['PLAN.md'], 'ссылка наружу не обходится');
  assert.ok(scan.skippedLinks.some(item => item.path === 'link'), `ссылка названа: ${JSON.stringify(scan.skippedLinks)}`);
});

test('DISC-08: a repeated scan sees new and removed files', async t => {
  const { workspace } = await setup(t);
  const first = await scanPlanFiles({ root: workspace });
  assert.deepEqual(first.files.map(file => file.path), ['PLAN.md']);
  await write(path.join(workspace, 'docs', 'new.md'));
  const second = await scanPlanFiles({ root: workspace });
  assert.deepEqual(second.files.map(file => file.path), ['PLAN.md', 'docs/new.md']);
  await fs.rm(path.join(workspace, 'PLAN.md'));
  const third = await scanPlanFiles({ root: workspace });
  assert.deepEqual(third.files.map(file => file.path), ['docs/new.md']);
});

test('limits are reported as a partial result, never as a full one', async t => {
  const { workspace } = await setup(t);
  for (let index = 0; index < 5; index += 1) await write(path.join(workspace, 'docs', `p${index}.md`));
  const capped = await scanPlanFiles({ root: workspace, maxResults: 2 });
  assert.equal(capped.files.length, 2);
  assert.equal(capped.partial, true);
  assert.equal(capped.limited.results, true);

  const shallow = await scanPlanFiles({ root: workspace, maxDepth: 0 });
  assert.equal(shallow.partial, true);
  assert.equal(shallow.limited.depth, true);
  assert.deepEqual(shallow.files.map(file => file.path), ['PLAN.md']);

  const slow = await scanPlanFiles({ root: workspace, maxMs: -1 });
  assert.equal(slow.partial, true);
  assert.equal(slow.limited.time, true);
});

test('a missing workspace is a refusal, not an empty list', async () => {
  await assert.rejects(scanPlanFiles({ root: null }), { code: 'SESSION_UNAVAILABLE' });
  await assert.rejects(scanPlanFiles({ root: path.join(os.tmpdir(), 'tb-no-such-workspace-xyz') }), { code: 'SESSION_UNAVAILABLE' });
});

test('the scan reads only a head of each file and labels it as a preliminary guess', async t => {
  const { workspace } = await setup(t);
  await write(path.join(workspace, 'docs', 'todo.md'), TODO_LIST);
  await write(path.join(workspace, 'docs', 'readme.md'), README);
  const scan = await scanPlanFiles({ root: workspace });
  const byPath = new Map(scan.files.map(file => [file.path, file]));
  assert.equal(byPath.get('PLAN.md').classification, 'VALID_MANAGED');
  assert.equal(byPath.get('docs/todo.md').classification, 'CONVERTIBLE');
  assert.equal(byPath.get('docs/readme.md').classification, null, 'нумерованный список — не признак плана');
  assert.equal(scan.limits.headBytes, SCAN_DEFAULTS.headBytes);
});

test('classifyPlanHead does not mistake a numbered list or a heading for steps', () => {
  assert.equal(classifyPlanHead(README), null);
  assert.equal(classifyPlanHead('## Разделы\n\n### Один\n### Два\n'), null);
  assert.equal(classifyPlanHead('- [ ] шаг\n'), 'CONVERTIBLE');
  assert.equal(classifyPlanHead(PLAN), 'VALID_MANAGED');
  assert.equal(classifyPlanHead(''), null);
});

test('service.scan is scoped to the session workspace and needs no command', async t => {
  const { service, workspace } = await setup(t);
  await write(path.join(workspace, 'docs', 'todo.md'), TODO_LIST);
  const scan = await service.scan({ taskId: 't-1', query: 'todo' });
  assert.deepEqual(scan.files.map(file => file.path), ['docs/todo.md']);
  assert.equal(scan.enabled, true);
});

// --- FP-UX-04D: вердикт выбранного файла ------------------------------------

test('VALID-01: a correct managed plan is ready to attach', async t => {
  const { service, store } = await setup(t);
  const inspection = await service.inspect({ taskId: 't-1', path: 'PLAN.md' });
  assert.equal(inspection.verdict, 'VALID_MANAGED');
  assert.equal(inspection.managed, true);
  assert.equal(inspection.steps, 1);
  assert.deepEqual(inspection.problems, []);
  assert.equal(store.getPlanBinding('t-1'), null, 'проверка ничего не подключает');
});

test('VALID-02: README and AGENTS documents are not plans just because of a list', async t => {
  const { service, workspace } = await setup(t);
  await write(path.join(workspace, 'README.md'), README);
  await write(path.join(workspace, 'AGENTS.md'), '# Правила\n\n1. Сначала прочитать\n2. Потом сделать\n');
  for (const file of ['README.md', 'AGENTS.md']) {
    const inspection = await service.inspect({ taskId: 't-1', path: file });
    assert.equal(inspection.verdict, 'NOT_A_PLAN', file);
    assert.equal(inspection.preview, null);
    assert.ok(inspection.problems.length > 0, 'причина названа');
  }
  await assert.rejects(
    service.importPlan({ taskId: 't-1', path: 'README.md', commandId: 'readme' }),
    error => error.code === 'PLAN_INVALID'
  );
  assert.equal(await fs.readFile(path.join(workspace, 'README.md'), 'utf8'), README, 'файл не переписан');
});

test('VALID-03: an unmanaged TODO gets a conversion preview instead of an attach', async t => {
  const { service, workspace } = await setup(t);
  await write(path.join(workspace, 'docs', 'TODO.md'), TODO_LIST);
  const inspection = await service.inspect({ taskId: 't-1', path: 'docs/TODO.md' });
  assert.equal(inspection.verdict, 'CONVERTIBLE');
  assert.equal(inspection.managed, false);
  assert.deepEqual(inspection.preview.steps.map(step => step.title), ['Починить пагинацию', 'Проверить приёмку']);
  // Предпросмотр будущего управляемого файла: он не записан на диск.
  assert.match(inspection.preview.content, /taskbridge_plan: 1/);
  assert.equal(await fs.readFile(path.join(workspace, 'docs', 'TODO.md'), 'utf8'), TODO_LIST, 'источник цел');
  const preview = await service.importPlan({ taskId: 't-1', path: 'docs/TODO.md', commandId: 'preview' });
  assert.equal(preview.needsConfirmation, true);
  assert.equal(await fs.readFile(path.join(workspace, 'docs', 'TODO.md'), 'utf8'), TODO_LIST);
});

test('VALID-04: an empty or broken file is refused with a reason', async t => {
  const empty = classifyPlan('   \n\n');
  assert.equal(empty.verdict, 'INVALID');
  assert.deepEqual(empty.problems, ['файл пуст']);

  const broken = classifyPlan('---\ntaskbridge_plan: 1\n');
  assert.equal(broken.verdict, 'INVALID');
  assert.ok(broken.problems.length > 0);

  const garbage = classifyPlan('---\ntaskbridge_plan: 1\nplan_id: p-x\nrevision: nope\ngoal: ""\n---\n\n## Шаги\n\n### S-1 | TODO | P9 | шаг\n');
  assert.equal(garbage.verdict, 'INVALID');
  assert.ok(garbage.problems.some(problem => /revision/.test(problem)));
});

test('VALID-05: a failed conversion leaves the source text alone', async t => {
  const { service, workspace } = await setup(t);
  // Чекбоксы есть, но шагов из них не собрать: пустой пункт не шаг.
  await write(path.join(workspace, 'docs', 'EDGE.md'), '- [ ]\n');
  await assert.rejects(
    service.importPlan({ taskId: 't-1', path: 'docs/EDGE.md', confirmImport: true, commandId: 'edge' }),
    error => error.code === 'PLAN_INVALID'
  );
  assert.equal(await fs.readFile(path.join(workspace, 'docs', 'EDGE.md'), 'utf8'), '- [ ]\n');
});

test('VALID-06: an external edit between preview and attach is detected', async t => {
  const { service, workspace } = await setup(t);
  await write(path.join(workspace, 'docs', 'TODO.md'), TODO_LIST);
  const preview = await service.importPlan({ taskId: 't-1', path: 'docs/TODO.md', commandId: 'p1' });
  assert.equal(preview.needsConfirmation, true);
  // Файл переписан оператором между предпросмотром и подтверждением.
  await fs.writeFile(path.join(workspace, 'docs', 'TODO.md'), '# другое\n', 'utf8');
  const after = await service.inspect({ taskId: 't-1', path: 'docs/TODO.md' });
  assert.equal(after.verdict, 'NOT_A_PLAN', 'подтверждение видит актуальный файл, а не кэш');
});

test('declaresManagedFormat and hasCheckboxSteps are the two cheap markers', () => {
  assert.equal(declaresManagedFormat(PLAN), true);
  assert.equal(declaresManagedFormat(README), false);
  assert.equal(declaresManagedFormat('---\ngoal: x\n---\n'), false);
  assert.equal(hasCheckboxSteps(TODO_LIST), true);
  assert.equal(hasCheckboxSteps(README), false);
});

// --- FP-UX-04E: необязательная проверка ИИ ----------------------------------

const fakeModel = answer => {
  const calls = [];
  const ask = async input => {
    calls.push(input);
    return answer(input);
  };
  return { calls, ask };
};

test('AI-01: the model is never asked by inspecting or attaching', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-ai-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'PLAN.md'), PLAN, 'utf8');
  const store = new TaskStore(root);
  t.after(async () => { store.close?.(); await fs.rm(root, { recursive: true, force: true }).catch(() => {}); });
  const model = fakeModel(() => ({ ok: true, text: '{"verdict":"PLAN","reasons":[]}' }));
  const service = new FollowPlanService({
    manager: {
      getTask: id => (String(id) === 't-1' ? { id: 't-1', workspacePath: workspace, runId: null } : null),
      listTasks: () => [{ id: 't-1' }],
      message: async () => ({ id: 'x' }),
      cancel: async () => {},
      publishFollowPlanEvent: async () => {}
    },
    store,
    config: { followPlan: { enabled: true } },
    askModel: model.ask
  });
  await service.scan({ taskId: 't-1' });
  await service.inspect({ taskId: 't-1', path: 'PLAN.md' });
  await service.attach({ taskId: 't-1', path: 'PLAN.md', commandId: 'attach-ai' });
  assert.equal(model.calls.length, 0, 'сканирование, проверка и подключение модель не спрашивают');

  const review = await service.aiReview({ taskId: 't-1', path: 'PLAN.md' });
  assert.equal(model.calls.length, 1, 'только явное нажатие спрашивает модель');
  assert.equal(review.ai.verdict, 'PLAN');
  assert.equal(review.structural.verdict, 'VALID_MANAGED', 'структурный вердикт остаётся рядом');
  assert.equal(review.charsSent <= AI_REVIEW_LIMITS.maxChars, true);
  // Прикрепление не запущено: ничего не отправлено в сессию.
  assert.equal(store.getPlanBinding('t-1').state, 'IDLE');
});

test('AI-02: a refusing model blocks nothing and keeps the structural verdict', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-ai2-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'PLAN.md'), PLAN, 'utf8');
  const store = new TaskStore(root);
  t.after(async () => { store.close?.(); await fs.rm(root, { recursive: true, force: true }).catch(() => {}); });
  const service = new FollowPlanService({
    manager: {
      getTask: id => (String(id) === 't-1' ? { id: 't-1', workspacePath: workspace, runId: null } : null),
      listTasks: () => [{ id: 't-1' }],
      message: async () => ({ id: 'x' }),
      cancel: async () => {},
      publishFollowPlanEvent: async () => {}
    },
    store,
    config: { followPlan: { enabled: true } },
    askModel: async () => ({ ok: false, code: 'NO_KEY', message: 'нет ключа провайдера' })
  });
  await assert.rejects(service.aiReview({ taskId: 't-1', path: 'PLAN.md' }), error => error.code === 'AI_UNAVAILABLE');
  const attached = await service.attach({ taskId: 't-1', path: 'PLAN.md', commandId: 'attach-nokey' });
  assert.equal(attached.attached, true, 'валидный план подключается без модели');
});

test('the AI check is rate limited instead of burning tokens', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-ai3-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'PLAN.md'), PLAN, 'utf8');
  const store = new TaskStore(root);
  let clock = Date.parse('2026-10-24T10:00:00Z');
  t.after(async () => { store.close?.(); await fs.rm(root, { recursive: true, force: true }).catch(() => {}); });
  const model = fakeModel(() => ({ ok: true, text: '{"verdict":"PLAN","reasons":["цель и шаги есть"]}' }));
  const service = new FollowPlanService({
    manager: {
      getTask: id => (String(id) === 't-1' ? { id: 't-1', workspacePath: workspace, runId: null } : null),
      listTasks: () => [{ id: 't-1' }],
      message: async () => ({ id: 'x' }),
      cancel: async () => {},
      publishFollowPlanEvent: async () => {}
    },
    store,
    config: { followPlan: { enabled: true } },
    askModel: model.ask,
    now: () => clock
  });
  for (let index = 0; index < AI_REVIEW_LIMITS.requestsPerMinute; index += 1) {
    await service.aiReview({ taskId: 't-1', path: 'PLAN.md' });
  }
  await assert.rejects(service.aiReview({ taskId: 't-1', path: 'PLAN.md' }), error => error.code === 'AI_RATE_LIMITED');
  clock += 61_000;
  const after = await service.aiReview({ taskId: 't-1', path: 'PLAN.md' });
  assert.equal(after.ai.verdict, 'PLAN');
});

test('the prompt is bounded and the answer is parsed strictly', () => {
  const prompt = buildPlanReviewPrompt({ path: 'PLAN.md', text: 'x'.repeat(AI_REVIEW_LIMITS.maxChars), truncated: true });
  assert.match(prompt, /PLAN\.md/);
  assert.match(prompt, /показано начало файла/);
  assert.match(prompt, /Инструментов у тебя нет/);

  assert.deepEqual(parsePlanReviewAnswer('```json\n{"looksLikePlan":true,"verdict":"PLAN","reasons":["есть шаги"]}\n```'), {
    ok: true, verdict: 'PLAN', looksLikePlan: true, reasons: ['есть шаги']
  });
  assert.equal(parsePlanReviewAnswer('не знаю').ok, false);
  assert.equal(parsePlanReviewAnswer('').code, 'EMPTY_ANSWER');
  assert.equal(parsePlanReviewAnswer('{"verdict":"МОЖЕТ БЫТЬ"}').ok, false);
});

// --- приёмочные проверки FP-UX-04 (backend) --------------------------------

test('the file changed between preview and attach is refused, not applied', async t => {
  const { service, workspace } = await setup(t);
  await write(path.join(workspace, 'docs', 'TODO.md'), TODO_LIST);
  const preview = await service.inspect({ taskId: 't-1', path: 'docs/TODO.md' });
  assert.equal(preview.verdict, 'CONVERTIBLE');
  assert.ok(preview.hash, 'проверка отдаёт хэш показанного текста');
  // Оператор ещё думает, а файл уже переписали.
  await fs.writeFile(path.join(workspace, 'docs', 'TODO.md'), '# Совсем другой документ\n\n1. пункт\n', 'utf8');
  await assert.rejects(
    service.importPlan({
      taskId: 't-1', path: 'docs/TODO.md', confirmImport: true,
      expectedHash: preview.hash, commandId: 'stale-attach'
    }),
    error => error.code === 'PLAN_REVISION_CONFLICT'
  );
  assert.equal(
    await fs.readFile(path.join(workspace, 'docs', 'TODO.md'), 'utf8'),
    '# Совсем другой документ\n\n1. пункт\n',
    'внешняя версия не перезаписана'
  );
  assert.equal(await service.status('t-1').then(status => status.attached), false);
});

test('a managed plan edited into garbage between preview and attach is refused', async t => {
  const { service, workspace } = await setup(t);
  const seen = await service.inspect({ taskId: 't-1', path: 'PLAN.md' });
  assert.equal(seen.verdict, 'VALID_MANAGED');
  await fs.writeFile(path.join(workspace, 'PLAN.md'), '---\ntaskbridge_plan: 1\nplan_id: ?\n---\n', 'utf8');
  await assert.rejects(
    service.importPlan({ taskId: 't-1', path: 'PLAN.md', expectedHash: seen.hash, commandId: 'stale-managed' }),
    error => error.code === 'PLAN_REVISION_CONFLICT'
  );
  // Без хэша решение принимает уже текущий файл: подключить повреждённый нельзя.
  await assert.rejects(
    service.importPlan({ taskId: 't-1', path: 'PLAN.md', commandId: 'managed-late' }),
    error => error.code === 'PLAN_INVALID'
  );
});

test('plan structure after the first 2 KB is found by the verdict, not by the scan hint', async t => {
  const { service, workspace } = await setup(t);
  const prose = `${'Длинное вступление без плана. '.repeat(120)}\n`;   // > 2 KB
  const text = `# Документ\n\n${prose}\n- [ ] Починить пагинацию\n- [ ] Проверить приёмку\n`;
  assert.ok(Buffer.byteLength(text) > SCAN_DEFAULTS.headBytes * 2);
  await write(path.join(workspace, 'docs', 'LATE.md'), text);

  const scan = await scanPlanFiles({ root: workspace });
  const late = scan.files.find(file => file.path === 'docs/LATE.md');
  assert.equal(late.classification, null, 'по голове файла формат не определить — и это честно');

  const inspection = await service.inspect({ taskId: 't-1', path: 'docs/LATE.md' });
  assert.equal(inspection.verdict, 'CONVERTIBLE');
  assert.deepEqual(inspection.preview.steps.map(step => step.title), ['Починить пагинацию', 'Проверить приёмку']);
});

test('a project with thousands of files stays bounded and says how', async t => {
  const { workspace } = await setup(t);
  const bulk = path.join(workspace, 'bulk');
  await fs.mkdir(bulk, { recursive: true });
  await Promise.all(Array.from({ length: 3000 }, (_, index) =>
    fs.writeFile(path.join(bulk, `doc-${index}.md`), `# документ ${index}\n`, 'utf8')));
  const startedAt = Date.now();
  const scan = await scanPlanFiles({ root: workspace, maxResults: 500 });
  const elapsed = Date.now() - startedAt;
  assert.equal(scan.files.length, 500);
  assert.equal(scan.partial, true);
  assert.equal(scan.limited.results, true);
  assert.ok(scan.total >= 500, `всего найдено: ${scan.total}`);
  // Служебных каталогов здесь нет, поэтому обход не должен упираться во время.
  assert.ok(elapsed < 10_000, `обход ограничен по времени, а не по терпению: ${elapsed} мс`);
});

test('two simultaneous scans answer the same list', async t => {
  const { service, workspace } = await setup(t);
  await write(path.join(workspace, 'docs', 'a.md'), TODO_LIST);
  const [first, second] = await Promise.all([
    scanPlanFiles({ root: workspace }),
    scanPlanFiles({ root: workspace })
  ]);
  assert.deepEqual(first.files.map(file => file.path), second.files.map(file => file.path));
  const [a, b] = await Promise.all([service.scan({ taskId: 't-1' }), service.scan({ taskId: 't-1' })]);
  assert.deepEqual(a.files, b.files);
  assert.equal(a.partial, false);
});

test('a model that says «это план» cannot override the structural verdict', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-ai4-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), README, 'utf8');
  const store = new TaskStore(root);
  t.after(async () => { store.close?.(); await fs.rm(root, { recursive: true, force: true }).catch(() => {}); });
  const manager = {
    getTask: id => (String(id) === 't-1' ? { id: 't-1', workspacePath: workspace, runId: null } : null),
    listTasks: () => [{ id: 't-1' }],
    message: async () => { throw new Error('ход не должен отправляться'); },
    cancel: async () => {},
    publishFollowPlanEvent: async () => {}
  };
  const service = new FollowPlanService({
    manager, store,
    config: { followPlan: { enabled: true } },
    askModel: async () => ({ ok: true, text: '{"looksLikePlan":true,"verdict":"PLAN","reasons":["похоже"]}', provider: 'p', model: 'm', local: true })
  });
  const review = await service.aiReview({ taskId: 't-1', path: 'README.md' });
  assert.equal(review.ai.verdict, 'PLAN', 'мнение модели остаётся её мнением');
  assert.equal(review.structural.verdict, 'NOT_A_PLAN', 'структурный вердикт считается отдельно');
  await assert.rejects(
    service.importPlan({ taskId: 't-1', path: 'README.md', confirmImport: true, commandId: 'ai-bypass' }),
    error => error.code === 'PLAN_INVALID'
  );
  assert.equal(await fs.readFile(path.join(workspace, 'README.md'), 'utf8'), README);
});

test('the AI check neither sends a turn nor runs a tool', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-ai5-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'PLAN.md'), PLAN, 'utf8');
  const store = new TaskStore(root);
  t.after(async () => { store.close?.(); await fs.rm(root, { recursive: true, force: true }).catch(() => {}); });
  const calls = { message: 0, cancel: 0, events: 0 };
  const service = new FollowPlanService({
    manager: {
      getTask: id => (String(id) === 't-1' ? { id: 't-1', workspacePath: workspace, runId: null } : null),
      listTasks: () => [{ id: 't-1' }],
      message: async () => { calls.message += 1; return { id: 'x' }; },
      cancel: async () => { calls.cancel += 1; },
      publishFollowPlanEvent: async () => { calls.events += 1; }
    },
    store,
    config: { followPlan: { enabled: true } },
    askModel: async input => {
      // Никакого «выполни» в промпте: модель получает только текст файла.
      assert.match(input.prompt, /Инструментов у тебя нет/);
      return { ok: true, text: '{"verdict":"PLAN","reasons":[]}', provider: 'p', model: 'm', local: false };
    }
  });
  await service.aiReview({ taskId: 't-1', path: 'PLAN.md' });
  assert.deepEqual(calls, { message: 0, cancel: 0, events: 0 }, 'ни хода, ни отмены, ни событий плана');
  const status = await service.status('t-1');
  assert.equal(status.attached, false);
  assert.equal(status.state, 'NOT_ATTACHED');
});

test('ИИ-сборка плана: модель получает ТЗ формата, ответ вычищается и проверяется', async () => {
  const { buildPlanDraftPrompt, extractManagedPlan } = await import('../src/application/plan-ai-review.mjs');
  const prompt = buildPlanDraftPrompt({ path: 'docs/NOTES.md', text: 'сделать пагинацию', truncated: true, hint: 'два шага' });
  assert.match(prompt, /taskbridge_plan: 1/);
  assert.match(prompt, /### S-001 \| TODO \| P1 \|/);
  assert.match(prompt, /Инструментов у тебя нет/);
  assert.match(prompt, /Пожелание оператора: два шага/);
  assert.match(prompt, /показано начало документа/);

  // Модель почти всегда добавляет «Вот план:» и заборы — их снимаем.
  const answer = 'Вот план:\n```markdown\n---\ntaskbridge_plan: 1\n---\n\n## Шаги\n```';
  assert.equal(extractManagedPlan(answer), '---\ntaskbridge_plan: 1\n---\n\n## Шаги\n');
  assert.equal(extractManagedPlan('```\n---\ntaskbridge_plan: 1\n---\n```'), '---\ntaskbridge_plan: 1\n---\n');
});

test('ИИ-сборка плана: невалидный ответ модели не пишется и назван причиной', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-draft-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'NOTES.md'), '# Заметки\n\nсделать пагинацию\n', 'utf8');
  const store = new TaskStore(root);
  t.after(() => cleanupStore(store, root));
  const service = new FollowPlanService({
    manager: {
      getTask: id => (String(id) === 't-1' ? { id: 't-1', workspacePath: workspace, runId: null } : null),
      listTasks: () => [{ id: 't-1' }],
      message: async () => ({ id: 'x' }),
      cancel: async () => {},
      publishFollowPlanEvent: async () => {}
    },
    store,
    config: { followPlan: { enabled: true } },
    askModel: async () => ({ ok: true, text: 'Вот план:\n### S-1 | TODO | P9 | без формата', provider: 'p', model: 'm', local: true })
  });
  await assert.rejects(
    service.aiDraft({ taskId: 't-1', path: 'NOTES.md' }),
    error => error.code === 'AI_INVALID_PLAN' && /не является планом/.test(error.message)
  );
  assert.equal(await fs.readFile(path.join(workspace, 'NOTES.md'), 'utf8'), '# Заметки\n\nсделать пагинацию\n', 'файл не изменён');
});

test('ИИ-сборка плана: валидный ответ модели возвращается, но файл не пишется', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-draft2-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'NOTES.md'), '# Заметки\n\nсделать пагинацию\n', 'utf8');
  const store = new TaskStore(root);
  t.after(() => cleanupStore(store, root));
  const model = '```markdown\n' + `---
taskbridge_plan: 1
plan_id: p-draft
revision: 1
goal: "Починить пагинацию"
---

# План: пагинация

## Шаги

### S-001 | TODO | P1 | Починить пагинацию
**Критерии:** страницы переключаются.
**Проверка:** node --test tests/pagination.test.mjs

## Обнаруженные проблемы
` + '\n```';
  let asked = null;
  const service = new FollowPlanService({
    manager: {
      getTask: id => (String(id) === 't-1' ? { id: 't-1', workspacePath: workspace, runId: null } : null),
      listTasks: () => [{ id: 't-1' }],
      message: async () => ({ id: 'x' }),
      cancel: async () => {},
      publishFollowPlanEvent: async () => {}
    },
    store,
    config: { followPlan: { enabled: true } },
    askModel: async input => { asked = input; return { ok: true, text: model, provider: 'p', model: 'm', local: true }; }
  });
  const draft = await service.aiDraft({ taskId: 't-1', path: 'NOTES.md' });
  assert.equal(draft.verdict, 'VALID_MANAGED');
  assert.equal(draft.steps, 1);
  assert.match(draft.text, /^---\ntaskbridge_plan: 1/);
  assert.equal(asked.maxTokens, 2000);
  // Ничего не записано: сохранение — отдельное действие оператора.
  assert.equal(await fs.readFile(path.join(workspace, 'NOTES.md'), 'utf8'), '# Заметки\n\nсделать пагинацию\n');
});

test('пустой ответ модели из-за лимита токенов повторяется, а не показывается как EMPTY', async () => {
  const { completeOnce } = await import('../src/model-probe.mjs');
  const budgets = [];
  const fake = async (url, init) => {
    const body = JSON.parse(init.body);
    budgets.push(body.max_tokens);
    const truncated = budgets.length === 1;
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: truncated ? '' : '---\ntaskbridge_plan: 1\n' }, finish_reason: truncated ? 'length' : 'stop' }] })
    };
  };
  // Живой случай 2026-10-26: reasoning съел лимит, content пустой, «Модель не ответила: EMPTY».
  const result = await completeOnce({ baseUrl: 'http://x/v1', id: 'm', prompt: 'p', maxTokens: 2000, fetchImpl: fake });
  assert.deepEqual(budgets, [2000, 4000], 'одна повторная попытка с удвоенным лимитом');
  assert.equal(result.ok, true);
  assert.match(result.text, /taskbridge_plan: 1/);

  // Если и повтор пуст — честный EMPTY с признаком len, а не тишина.
  const alwaysEmpty = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) });
  const failed = await completeOnce({ baseUrl: 'http://x/v1', id: 'm', prompt: 'p', maxTokens: 100, fetchImpl: alwaysEmpty });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'EMPTY');
  assert.equal(failed.truncated, true);

  // Ответ массивом частей тоже читается.
  const parts = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: [{ type: 'text', text: 'abc' }, 'def'] } }] }) });
  const fromParts = await completeOnce({ baseUrl: 'http://x/v1', id: 'm', prompt: 'p', fetchImpl: parts });
  assert.equal(fromParts.text, 'abcdef');
});

test('обход в ширину: тяжёлый соседний каталог не съедает бюджет и не прячет документацию', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-bfs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Тяжёлый каталог первым по алфавиту — как Unreal Content (2669 подкаталогов),
  // из-за которого обход в глубину возвращал один файл корня (живой отчёт 2026-10-27).
  for (let index = 0; index < 40; index += 1) {
    await fs.mkdir(path.join(root, 'aaa-heavy', `sub-${index}`), { recursive: true });
    await fs.writeFile(path.join(root, 'aaa-heavy', `sub-${index}`, 'note.txt'), 'x', 'utf8');
  }
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'PLAN.md'), PLAN, 'utf8');
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# правила\n', 'utf8');

  const scan = await scanPlanFiles({ root, maxDirs: 10 });
  assert.deepEqual(scan.files.map(file => file.path), ['AGENTS.md', 'docs/PLAN.md']);
  assert.equal(scan.limited.dirs, true, 'бюджет каталогов всё равно честно исчерпан');
});

test('служебные каталоги движков не обходятся: Saved, Intermediate, Binaries, DerivedDataCache', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-skip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['Saved', 'Saved_HEDeviceState', 'Intermediate', 'Binaries', 'DerivedDataCache', 'Library', 'obj']) {
    await fs.mkdir(path.join(root, name), { recursive: true });
    await fs.writeFile(path.join(root, name, 'PLAN.md'), PLAN, 'utf8');
  }
  await fs.mkdir(path.join(root, 'Docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'Docs', 'REAL.md'), PLAN, 'utf8');

  const scan = await scanPlanFiles({ root });
  assert.deepEqual(scan.files.map(file => file.path), ['Docs/REAL.md']);
  assert.equal(scan.scanned.dirs, 2, 'обойдены только корень и Docs');
});

test('подписочная модель: один ответ через Pi без инструментов и без сессии', async () => {
  const { piOneShotArgs, PI_ONESHOT_FLAGS } = await import('../src/pi-oneshot.mjs');
  const args = piOneShotArgs({ provider: 'openai-codex', model: 'gpt-6.1-sol', promptFile: 'C:/tmp/prompt.txt' });
  // Подписка работает только через сам Pi, и он не должен получить ни инструментов,
  // ни доступа к проекту: иначе «собери план» превращается в правку файлов.
  for (const flag of ['--print', '--no-session', '--no-tools', '--no-mcp', '--no-extensions', '--no-context-files']) {
    assert.ok(PI_ONESHOT_FLAGS.includes(flag), `флаг ${flag} обязателен`);
  }
  assert.ok(args.includes('openai-codex/gpt-6.1-sol'));
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'C:/tmp/prompt.txt', 'задание уходит файлом');
  assert.equal(args[args.length - 1], 'Выполни.', 'сообщение без пробелов');
});

test('свободный текст в «Обнаруженных проблемах» становится записью F-###, а не отказом', async () => {
  const { normalizeDraftIssues } = await import('../src/application/plan-ai-review.mjs');
  const { classifyPlan } = await import('../src/application/plan-file.mjs');
  const draft = `---
taskbridge_plan: 1
plan_id: p-issues
revision: 1
goal: "Проверка раздела проблем"
---

# План

## Шаги

### S-001 | TODO | P1 | Шаг
**Критерии:** сделано.
**Проверка:** run

## Обнаруженные проблемы

- F-001 | P1 | OPEN | уже в формате
Источник показан частично и обрывается.
`;
  const fixed = normalizeDraftIssues(draft);
  assert.match(fixed, /^- F-001 \| P1 \| OPEN \| уже в формате$/m, 'существующая запись не тронута');
  assert.match(fixed, /^- F-002 \| P3 \| OPEN \| Источник показан частично и обрывается\.$/m);
  assert.equal(classifyPlan(fixed, { planId: 'p-issues' }).verdict, 'VALID_MANAGED');
  // Без раздела проблем текст не переписывается.
  assert.equal(normalizeDraftIssues('# просто текст\n'), '# просто текст\n');
});
