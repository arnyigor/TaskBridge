// Переключатель «По плану» и карточка плана (FP-05C): проверяются чистые решения,
// а не DOM — что показывает карточка, какие кнопки доступны, что означает
// выключение переключателя и как формируется тело команды с ревизией.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  PLAN_MODE_LABEL, PLAN_STATE_LABELS, PLAN_EVENT_TYPES, planStepMark, planStepsSummary,
  planActions, planCardModel, planCurrentStep, planErrorText, planEventNotice, planFileChoices, planFileGroups,
  planFindingsSummary, planHeadline, planIconState, planInspectionText, planMetaLine, planPrimaryAction,
  PLAN_ICON_TITLES, planPathProblem, planToggleState, verificationText,
  planRequestBody, planFindingsLine, toggleOffAction, planSelectionView,
  planScanRows, planScanStatusLine, planScanEmptyText, planVerdictView, planAiReviewView, planAiErrorText
} from '../web/follow-plan-view.mjs';

const running = {
  attached: true, path: 'docs/PLAN.md', state: 'RUNNING_STEP', stepId: 'S-004',
  revision: 7, progress: { done: 3, total: 7 }, goal: 'Стабилизировать историю',
  findings: [{ id: 'F-002', priority: 'P1', state: 'OPEN', summary: 'дубли при reconnect' }]
};

test('the icon itself carries the state', () => {
  assert.equal(planIconState(null), 'off');
  assert.equal(planIconState({ attached: false, enabled: true }), 'off');
  assert.equal(planIconState({ attached: true, state: 'IDLE' }), 'idle');
  assert.equal(planIconState({ attached: true, state: 'RUNNING_STEP' }), 'running');
  assert.equal(planIconState({ attached: true, state: 'REVIEWING' }), 'running');
  assert.equal(planIconState({ attached: true, state: 'PAUSED' }), 'attention');
  assert.equal(planIconState({ attached: true, state: 'PAUSED_REVIEW' }), 'attention');
  // Конфликт и ошибка файла — красный (поломка); разбор посреди цикла — жёлтый:
  // план шёл, 4 из 73, а иконка горела красным (живой отчёт 2026-10-28).
  assert.equal(planIconState({ attached: true, state: 'IDLE', conflict: true }), 'error');
  assert.equal(planIconState({ attached: true, state: 'RUNNING_STEP', fileError: { message: 'нет доступа' } }), 'error');
  assert.equal(planIconState({ attached: true, state: 'COMPLETED' }), 'completed');
  assert.equal(PLAN_ICON_TITLES.off, 'По плану: выбрать файл плана');
});

test('a mode switched off on the server stays visible and says so', () => {
  // Hiding the chip made the pilot phone look like the feature never shipped.
  assert.deepEqual(planToggleState({ enabled: false }), {
    visible: true, enabled: false, hint: 'режим выключен в конфигурации сервера'
  });
  assert.deepEqual(planToggleState({ enabled: true }), { visible: true, enabled: true, hint: null });
  assert.deepEqual(planToggleState(null), { visible: true, enabled: false, hint: null });
});

test('the switch is called «По плану», not «Plan Mode»', () => {
  assert.equal(PLAN_MODE_LABEL, 'По плану');
  assert.equal(PLAN_MODE_LABEL.includes('Plan Mode'), false);
  assert.deepEqual(Object.keys(PLAN_STATE_LABELS), ['NOT_ATTACHED', 'IDLE', 'RUNNING_STEP', 'REVIEWING', 'PAUSED_REVIEW', 'PAUSED', 'COMPLETED']);
});

test('the card names the file, the progress and the step being executed', () => {
  assert.equal(planHeadline(running), 'docs/PLAN.md • 3/7 • выполняется шаг S-004');
  assert.equal(planHeadline({ ...running, state: 'PAUSED', stepId: 'S-004' }), 'docs/PLAN.md • 3/7 • пауза');
  assert.equal(planHeadline({ attached: false }), 'План не подключён');
  assert.equal(planHeadline({ attached: true, path: 'PLAN.md', state: 'COMPLETED', progress: { done: 7, total: 7 } }), 'PLAN.md • 7/7 • план завершён');
});

test('open findings are shown by priority, without flooding the chat', () => {
  assert.equal(planFindingsLine(running), 'P1 дубли при reconnect');
  const many = { findings: [
    { id: 'F-3', priority: 'P2', state: 'OPEN', summary: 'лог' },
    { id: 'F-1', priority: 'P0', state: 'OPEN', summary: 'потеря данных' },
    { id: 'F-2', priority: 'P1', state: 'DONE', summary: 'закрыто' }
  ] };
  assert.equal(planFindingsLine(many), 'P0 потеря данных (+1)');
  assert.equal(planFindingsLine({ findings: [] }), '');
});

test('while a step runs only pause and STOP are available, and the mode switch pauses', () => {
  const actions = Object.fromEntries(planActions(running).map(action => [action.id, action]));
  assert.equal(actions.start.disabled, true, 'no second step while one runs');
  assert.equal(actions.pause.disabled, false);
  assert.equal(actions.stop.disabled, false);
  assert.equal(actions.open.disabled, false);
  assert.equal(toggleOffAction(running), 'pause', 'turning the switch off never kills the running turn');
  assert.equal(toggleOffAction({ state: 'PAUSED' }), 'none');
  assert.equal(toggleOffAction(null), 'none');
});

test('a conflict blocks «Продолжить» and offers adopting the file', () => {
  const conflict = planCardModel({ ...running, state: 'PAUSED_REVIEW', conflict: true });
  assert.match(conflict.conflict, /изменён снаружи/);
  const actions = Object.fromEntries(conflict.actions.map(action => [action.id, action]));
  assert.equal(actions.start.disabled, true);
  assert.equal(actions.reconcile.disabled, false);
});

test('a card without a plan stays out of the chat', () => {
  const empty = planCardModel({ attached: false, enabled: true });
  assert.equal(empty.visible, false);
  assert.deepEqual(empty.actions, []);
  const model = planCardModel(running);
  assert.equal(model.visible, true);
  assert.equal(model.goal, 'Стабилизировать историю');
  assert.equal(model.actions.length, 7);
});

test('the attach request needs a relative Markdown path inside the project', () => {
  assert.equal(planPathProblem('docs/PLAN.md'), null);
  assert.match(planPathProblem(''), /Укажите путь/);
  assert.match(planPathProblem('C:\\work\\PLAN.md'), /относительным/);
  assert.match(planPathProblem('/etc/PLAN.md'), /относительным/);
  assert.match(planPathProblem('docs/PLAN.txt'), /Markdown/);
});

test('the plan is picked from the project, not typed from memory', () => {
  const listing = {
    entries: [
      { name: 'PLAN.md', path: 'PLAN.md', isFile: true },
      { name: 'docs', path: 'docs', isFile: false },
      { name: 'notes.txt', path: 'notes.txt', isFile: true },
      { name: 'docs/IMPLEMENTATION_PLAN.MD', path: 'docs/IMPLEMENTATION_PLAN.MD', isFile: true }
    ]
  };
  assert.deepEqual(planFileChoices(listing), [
    { path: 'PLAN.md', name: 'PLAN.md' },
    { path: 'docs/IMPLEMENTATION_PLAN.MD', name: 'IMPLEMENTATION_PLAN.MD' }
  ]);
  assert.deepEqual(planFileChoices(null), []);
  assert.equal(planFileChoices({ entries: [{ path: 'a.md' }] }, { limit: 0 }).length, 0);
});

test('the picker groups plans by project folder, root first', () => {
  const listing = { entries: [
    { path: 'docs/DESIGN.md', isFile: true },
    { path: 'PLAN.md', isFile: true },
    { path: 'docs/PLAN-2.md', isFile: true },
    { path: 'app/index.js', isFile: true }
  ] };
  assert.deepEqual(planFileGroups(listing), [
    { folder: '', files: [{ path: 'PLAN.md', name: 'PLAN.md' }] },
    { folder: 'docs', files: [
      { path: 'docs/DESIGN.md', name: 'DESIGN.md' },
      { path: 'docs/PLAN-2.md', name: 'PLAN-2.md' }
    ] }
  ]);
  assert.deepEqual(planFileGroups({ entries: [] }), []);
});

test('the command body carries the revision for CAS', () => {
  assert.deepEqual(planRequestBody(running, { commandId: 'c1' }), { expectedRevision: 7, commandId: 'c1' });
  assert.deepEqual(planRequestBody({ attached: false }, { commandId: 'c2' }), { commandId: 'c2' });
});

test('plan events become one short line, and only plan events do', () => {
  assert.equal(planEventNotice({ type: 'PLAN_STEP_STARTED', message: 'Отправлен шаг S-004.' }), 'Шаг отправлен: Отправлен шаг S-004.');
  // The server's sentence already carries the meaning: it is not repeated.
  assert.equal(planEventNotice({ type: 'PLAN_COMPLETED', message: 'План завершён и подтверждён.' }), 'План завершён');
  assert.equal(planEventNotice({ type: 'PLAN_PAUSED', message: '' }), 'Цикл на паузе');
  assert.equal(planEventNotice({ type: 'USER_MESSAGE', message: 'привет' }), null);
  assert.equal(planEventNotice(null), null);
  assert.deepEqual([...PLAN_EVENT_TYPES].sort(), ['PLAN_ATTACHED', 'PLAN_CHECKPOINT_APPLIED', 'PLAN_CHECKPOINT_RECEIVED', 'PLAN_CHECKPOINT_REJECTED', 'PLAN_COMPLETED', 'PLAN_CONFLICT', 'PLAN_PAUSED', 'PLAN_REVISED', 'PLAN_STEP_CHECKPOINT', 'PLAN_STEP_STARTED']);
});

test('the dialog picks a file from the system picker or by an explicit project path', async () => {
  const html = await fs.readFile(path.join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(html, /id="planToggle"[^>]*aria-label="По плану"/);
  const actions = html.slice(html.indexOf('class="composerActions"'));
  assert.ok(actions.indexOf('id="planToggle"') < actions.indexOf('id="files"'), 'the plan icon sits in the composer row');
  // UI-02/FP-UX-04A: nothing is listed when the dialog opens; the scan is a click.
  assert.equal(/id="planFiles"/.test(html), false, 'nothing is scanned when the dialog opens');
  assert.match(html, /id="planScanStart"[^>]*>Сканировать проект</);
  assert.match(html, /id="planScanPanel"[^>]*class="planScanPanel hidden"/, 'the result list starts hidden');
  // FP-UX-03/04C: the system file picker is still there, next to the scan.
  assert.match(html, /id="planPickFile"[^>]*>Открыть файл</);
  assert.match(html, /id="planFileInput"[^>]*accept="\.md,\.markdown/);
  assert.equal(/id="planBrowser"/.test(html), false, 'no folder listing in the dialog');
  assert.equal(/planProjectPath/.test(html), false, 'no manual path field in the dialog');
  assert.equal(/planPathInput/.test(html), false, 'the manual path field was unclear and is gone');
  assert.match(html, /id="planSelectedName"/, 'the chosen file is named before anything is written');
  assert.match(html, /id="planSelectedPath"/, 'the server path is shown before anything is written');
  assert.match(html, /Подключение не запускает выполнение/);
  assert.match(html, /id="planStatusBlock"/, 'status lives in the dialog');
  assert.match(html, /id="planDetach"/, 'a selected plan can be detached from the dialog');
  assert.match(html, /id="planSteps"/, 'the whole step list is behind a disclosure');
  assert.match(html, /id="planFindingsSummary"/);
  assert.match(html, /Следование плану/);
  assert.equal(/Plan Mode/.test(html), false);
  const source = await fs.readFile(path.join(import.meta.dirname, '..', 'web', 'app.js'), 'utf8');
  const planSection = source.slice(source.indexOf('/* ---------------- Follow Plan (UI-02)'), source.indexOf("$('newTaskButton').onclick"));
  assert.equal(/workspace-files/.test(planSection), false, 'opening the dialog fetches no file list');
});

test('a file with every step done is finished, and nothing offers to start it', () => {
  const finished = { attached: true, state: 'COMPLETED', enabled: true, revision: 3, steps: [], progress: { done: 2, total: 2 }, file: { open: 0, complete: true } };
  assert.deepEqual(planPrimaryAction(finished), { id: 'open', label: 'Открыть результат' });
  const start = planActions(finished).find(action => action.id === 'start');
  assert.equal(start.disabled, true, 'no «Начать выполнение» on a finished plan');

  // Re-attached file whose steps are all DONE reports open=0 even if the binding
  // says IDLE: the state shown is the file's, not the cycle's.
  const reattached = { attached: true, state: 'COMPLETED', enabled: true, file: { open: 0, complete: true } };
  assert.equal(planActions(reattached).find(action => action.id === 'start').disabled, true);
});

test('one primary action per state, exactly as the table says', () => {
  assert.deepEqual(planPrimaryAction({ attached: false }), { id: 'scan', label: 'Сканировать проект' });
  assert.deepEqual(planPrimaryAction({ attached: true, state: 'IDLE' }), { id: 'start', label: 'Начать выполнение' });
  assert.deepEqual(planPrimaryAction({ attached: true, state: 'RUNNING_STEP' }), { id: 'pause', label: 'Пауза после шага' });
  assert.deepEqual(planPrimaryAction({ attached: true, state: 'PAUSED' }), { id: 'resume', label: 'Продолжить' });
  assert.deepEqual(planPrimaryAction({ attached: true, state: 'PAUSED_REVIEW' }), { id: 'reconcile', label: 'Разобрать результат' });
  assert.deepEqual(planPrimaryAction({ attached: true, state: 'IDLE', conflict: true }), { id: 'reconcile', label: 'Обновить и сверить' });
  assert.deepEqual(planPrimaryAction({ attached: true, state: 'COMPLETED' }), { id: 'open', label: 'Открыть результат' });
});

test('the dialog states where the plan is, in words', () => {
  const line = planMetaLine({
    attached: true, state: 'RUNNING_STEP', revision: 3, progress: { done: 1, total: 3 },
    cycleNumber: 2, stepId: 'S-002', stage: 'PROGRESS'
  });
  assert.equal(line, 'выполняется шаг • revision 3 • шагов 1/3 • цикл 2 • шаг S-002 • ответ идёт');
  assert.equal(planMetaLine({ attached: false }), '');

  const step = planCurrentStep({
    attached: true, stepId: 'S-002',
    steps: [
      { id: 'S-001', status: 'DONE', title: 'Первый', result: 'тесты зелёные' },
      { id: 'S-002', status: 'IN_PROGRESS', title: 'Второй', result: '' }
    ]
  });
  assert.deepEqual(step, { id: 'S-002', title: 'Второй', status: 'IN_PROGRESS', result: '', verification: null });

  // The level of proof is shown in words, never as a colour or a hidden prefix.
  const verified = planCurrentStep({
    attached: true, stepId: 'S-002',
    steps: [{ id: 'S-002', status: 'DONE', title: 'Второй', result: 'тесты зелёные', verification: 'MODEL_REPORTED' }]
  });
  assert.equal(verified.verification, 'MODEL_REPORTED');
  assert.equal(verificationText('MODEL_REPORTED'), 'заявлено моделью');
  assert.equal(verificationText('SYSTEM_VERIFIED'), 'подтверждено системой');
  assert.equal(verificationText(null), null);

  const findings = planFindingsSummary({
    findings: [
      { id: 'F-1', priority: 'P1', state: 'OPEN', summary: 'дубли' },
      { id: 'F-2', priority: 'P3', state: 'OPEN', summary: 'кнопка' },
      { id: 'F-3', priority: 'P0', state: 'DONE', summary: 'закрыто' }
    ]
  });
  assert.equal(findings.blocking, 1);
  assert.equal(findings.notes, 1);
});

test('errors name the problem and the fix, not a generic failure', () => {
  assert.match(planErrorText({ code: 'PLAN_INVALID', message: 'шаг S-002: неизвестный статус' }), /формату плана/);
  assert.match(planErrorText({ code: 'PLAN_REVISION_CONFLICT' }), /изменён вне TaskBridge/);
  assert.match(planErrorText({ code: 'PLAN_UNKNOWN_OUTCOME' }), /автоматический повтор запрещён/);
  assert.match(planErrorText({ code: 'PLAN_BUDGET_EXCEEDED' }), /лимит/);
  assert.match(planErrorText({ code: 'FOLLOW_PLAN_DISABLED' }), /followPlan\.enabled/);
  assert.match(planErrorText({ code: 'PLAN_FILE_EXISTS' }), /перезапись/);
  assert.match(planErrorText({ code: 'PLAN_BLOCKED', message: 'шаг S-003' }), /шаг S-003/);
  assert.equal(planErrorText('что-то пошло не так'), 'что-то пошло не так');
});

test('the inspection tells managed from free-form before anything is written', () => {
  assert.match(planInspectionText({ managed: true, steps: 3, revision: 2 }), /Управляемый план: 3 шаг\(ов\), revision 2/);
  assert.match(planInspectionText({ managed: false, preview: { steps: [{}, {}] } }), /будет импортировано шагов — 2/);
  assert.match(planInspectionText({ managed: false, preview: { steps: [] } }), /Файл не изменяется до подтверждения/);
});



test('editor keeps its CAS base separate from SSE state, and dialog never lists files on open', async () => {
  const source = await fs.readFile(path.join(import.meta.dirname, '..', 'web', 'app.js'), 'utf8');
  const opening = source.slice(source.indexOf('function openPlanDialog()'), source.indexOf('function closePlanDialog()'));
  assert.doesNotMatch(opening, /openPlanBrowser\(/);
  assert.match(source, /planDraftBase = \{ expectedRevision: file.revision, expectedHash: file.hash \}/);
  assert.match(source, /\.\.\.planDraftBase/);
  assert.match(source, /planDraft = \$\('planEditorText'\).value/);
  assert.match(source, /planDraftDirty && !confirm/);
});

test('resume is offered only after pause, and editing never races an active step', () => {
  const actions = state => Object.fromEntries(planActions({ attached: true, enabled: true, state }).map(a => [a.id, a]));
  assert.equal(actions('PAUSED').resume.disabled, false);
  assert.equal(actions('PAUSED').start.disabled, true);
  assert.equal(actions('PAUSED_REVIEW').resume.disabled, true);
  assert.equal(actions('RUNNING_STEP').edit.disabled, true);
  assert.equal(actions('REVIEWING').reconcile.disabled, true);
  assert.match(planErrorText({ code: 'PLAN_API_UNAVAILABLE' }), /Обновите сервер/);
  assert.match(planErrorText({ code: 'PLAN_CONNECTION_LOST' }), /Соединение/);
});


test('all specified control-panel states have exactly one primary action', () => {
  const cases = [
    ['READY', { attached: true, state: 'IDLE' }, 'start'],
    ['RUNNING', { attached: true, state: 'RUNNING_STEP' }, 'pause'],
    ['PAUSE_REQUESTED', { attached: true, state: 'REVIEWING' }, 'pause'],
    ['PAUSED', { attached: true, state: 'PAUSED' }, 'resume'],
    ['PAUSED_REVIEW', { attached: true, state: 'PAUSED_REVIEW' }, 'reconcile'],
    ['BLOCKED', { attached: true, state: 'PAUSED_REVIEW', fileError: { message: 'blocked' } }, 'reconcile'],
    ['CONFLICT', { attached: true, state: 'IDLE', conflict: true }, 'reconcile'],
    ['COMPLETED', { attached: true, state: 'COMPLETED' }, 'open'],
    ['DISABLED', { attached: true, state: 'IDLE', enabled: false }, 'start'],
  ];
  for (const [name, status, primaryId] of cases) {
    const primary = planPrimaryAction(status);
    assert.equal(primary.id, primaryId, name);
    const actions = planActions(status);
    if (name === 'DISABLED') assert.ok(actions.every(action => action.disabled || action.id === 'open'));
    if (name === 'RUNNING') assert.equal(actions.find(action => action.id === 'stop').disabled, false);
  }
});

test('an open dialog re-reads status so an external edit cannot hide a conflict', async () => {
  const source = await fs.readFile(path.join(import.meta.dirname, '..', 'web', 'app.js'), 'utf8');
  const schedule = source.slice(source.indexOf('function schedulePlanStatusRefresh()'), source.indexOf('async function loadPlanStatus()'));
  assert.match(schedule, /const open = !\$\('planDialog'\)/);
  assert.match(schedule, /open \? 3000 : 10000/, 'the open panel polls; a closed one only follows stale/disabled status');
});

test('the chosen file is described before anything is written, and a second file needs a click', () => {
  const managed = { path: 'docs/PLAN.md', managed: true, steps: 3, revision: 2, problems: [], alreadyAttached: false, replaces: null };
  const fresh = planSelectionView(managed, { attached: false });
  assert.equal(fresh.name, 'PLAN.md');
  assert.equal(fresh.target, 'Файл в проекте: docs/PLAN.md');
  assert.match(fresh.format, /управляемый план, 3 шаг/);
  assert.equal(fresh.needsConfirm, true, 'the destination is shown before the explicit Connect click');

  // An uploaded file lands in the project: say exactly where.
  const uploaded = planSelectionView({ ...managed, path: 'PLAN.md' }, { uploaded: true, attached: false });
  assert.equal(uploaded.target, 'Будет сохранён в проекте: PLAN.md');

  // A second file never replaces the active plan on its own.
  const replacement = planSelectionView({ ...managed, replaces: 'docs/PLAN.md' }, { attached: true });
  assert.equal(replacement.needsConfirm, true);
  assert.equal(replacement.confirmLabel, 'Заменить план');

  // Free-form Markdown is a preview, not an automatic edit.
  const freeForm = planSelectionView({ path: 'NOTES.md', managed: false, preview: { steps: [{ id: 'S-001' }] }, problems: [] }, { uploaded: true });
  assert.equal(freeForm.needsConfirm, true);
  assert.equal(freeForm.confirmLabel, 'Импортировать и подключить');
  assert.match(freeForm.format, /обычный Markdown, шагов для импорта — 1/);

  // A broken file is named by its first problem, not attached silently.
  const broken = planSelectionView({ path: 'BAD.md', managed: false, problems: ['нет заголовка'], preview: { steps: [] } });
  assert.match(broken.format, /Формат: нет заголовка/);
  assert.equal(planSelectionView(null), null);
});

test('an already attached plan is named and never detached for the operator', () => {
  const text = planErrorText({ code: 'PLAN_ALREADY_ATTACHED', message: 'Уже подключён план docs/PLAN.md.' });
  assert.match(text, /docs\/PLAN\.md/);
  const generic = planErrorText({ code: 'PLAN_ALREADY_ATTACHED' });
  assert.match(generic, /отключите/i);
  assert.equal(/detach|отключён автоматически/i.test(generic), false);
  const source = fsSync.readFileSync(path.join(import.meta.dirname, '..', 'web', 'app.js'), 'utf8');
  const handler = source.slice(source.indexOf("if (error.code === 'PLAN_ALREADY_ATTACHED')"), source.indexOf('if (error.code === \'PLAN_ALREADY_ATTACHED\')') + 120);
  assert.match(handler, /loadPlanStatus\(\)/, 'the operator is shown the plan that is actually attached');
  assert.doesNotMatch(handler, /detach/i, 'nothing is detached automatically');
});

// --- FP-UX-04: сканирование, вердикт и ИИ в интерфейсе ----------------------

test('the scan list shows files with a relative path, never folders', () => {
  const scan = {
    files: [
      { name: 'PLAN.md', path: 'PLAN.md', size: 2048, classification: 'VALID_MANAGED' },
      { name: 'TODO.md', path: 'docs/TODO.md', size: 900, classification: 'CONVERTIBLE' },
      { name: 'readme.md', path: 'docs/deep/readme.md', size: 10, classification: null }
    ],
    total: 3, partial: false, skippedLinks: []
  };
  const rows = planScanRows(scan);
  assert.deepEqual(rows.map(row => row.name), ['PLAN.md', 'TODO.md', 'readme.md']);
  assert.deepEqual(rows.map(row => row.folder), ['', 'docs', 'docs/deep']);
  assert.equal(rows[0].hint, 'управляемый план');
  assert.equal(rows[1].hint, 'нужен импорт');
  assert.equal(rows[2].hint, '');
  assert.equal(rows[0].size, '2 КБ');
});

test('DISC-05: the search filters the loaded list locally, without a new scan', () => {
  const scan = { files: [
    { name: 'PLAN.md', path: 'PLAN.md' },
    { name: 'release-notes.md', path: 'docs/release-notes.md' }
  ], total: 2 };
  assert.deepEqual(planScanRows(scan, { query: 'RELEASE' }).map(row => row.path), ['docs/release-notes.md']);
  assert.deepEqual(planScanRows(scan, { query: 'docs/' }).map(row => row.path), ['docs/release-notes.md']);
  assert.deepEqual(planScanRows(scan, { query: '' }).map(row => row.path), ['PLAN.md', 'docs/release-notes.md']);
  assert.deepEqual(planScanRows(scan, { query: 'нет такого' }), []);
  // Ничего не сканировали — это не «ничего не найдено».
  assert.match(planScanEmptyText(null), /не сканировались/);
  assert.match(planScanEmptyText({ files: [] }), /не найдено ни одного Markdown/);
  assert.match(planScanEmptyText(scan, 'нет такого'), /ничего не найдено/);
});

test('a partial scan says so instead of pretending to be complete', () => {
  const line = planScanStatusLine({ total: 40, partial: true, skippedLinks: [{ path: 'link' }] }, 12);
  assert.match(line, /найдено файлов: 40/);
  assert.match(line, /показано 12/);
  assert.match(line, /неполный/);
  assert.match(line, /ссылок пропущено: 1/);
  assert.equal(planScanStatusLine({ total: 2, partial: false, skippedLinks: [] }, 2), 'найдено файлов: 2');
  assert.equal(planScanStatusLine(null, 0), '');
});

test('VALID-01…04: the verdict decides what the operator may press', () => {
  const managed = planVerdictView({ verdict: 'VALID_MANAGED', managed: true, steps: 2, revision: 1 });
  assert.equal(managed.label, 'Готов к подключению');
  assert.equal(managed.canAttach, true);
  assert.equal(managed.confirmLabel, 'Подключить');
  assert.equal(managed.preview, '');

  const convertible = planVerdictView({
    verdict: 'CONVERTIBLE', managed: false,
    preview: { steps: [{ id: 'S-001' }], content: '---\ntaskbridge_plan: 1\n', problems: [] }
  });
  assert.equal(convertible.label, 'Требует преобразования');
  assert.equal(convertible.canAttach, true);
  assert.equal(convertible.confirmLabel, 'Импортировать и подключить');
  // Предпросмотр будущего файла показывается, но не пишется.
  assert.match(convertible.preview, /taskbridge_plan: 1/);

  const notAPlan = planVerdictView({ verdict: 'NOT_A_PLAN', problems: ['нет списка шагов'], preview: null });
  assert.equal(notAPlan.label, 'Это не план');
  assert.equal(notAPlan.canAttach, false);
  assert.deepEqual(notAPlan.reasons, ['нет списка шагов']);

  const invalid = planVerdictView({ verdict: 'INVALID', problems: ['файл пуст'] });
  assert.equal(invalid.label, 'Файл непригоден');
  assert.equal(invalid.canAttach, false);

  // Старые ответы сервера без verdict не ломают экран.
  assert.equal(planVerdictView({ managed: true, steps: 1 }).verdict, 'VALID_MANAGED');
  assert.equal(planVerdictView(null), null);
});

test('AI-02: the AI answer is advice with its model named, never the verdict', () => {
  const review = planAiReviewView({
    ai: { verdict: 'NOT_PLAN', reasons: ['нет критериев выполнения'] },
    structural: { verdict: 'VALID_MANAGED' },
    model: { provider: 'openai', id: 'gpt-4o', local: false },
    truncated: true
  });
  assert.match(review.text, /модель считает, что это не план/);
  assert.match(review.text, /нет критериев выполнения/);
  assert.match(review.text, /облачный провайдер/);
  assert.match(review.text, /только начало файла/);
  assert.equal(review.structural, 'VALID_MANAGED', 'структурный вердикт остаётся главным');

  const local = planAiReviewView({ ai: { verdict: 'PLAN', reasons: [] }, model: { provider: 'llama', id: 'qwen', local: true } });
  assert.match(local.text, /локальная/);

  const failure = planAiReviewView(null, { code: 'AI_UNAVAILABLE', message: 'Модель не ответила: TIMEOUT.' });
  assert.equal(failure.ok, false);
  assert.match(failure.text, /Модель не ответила/);
  assert.match(planAiErrorText({ code: 'AI_RATE_LIMITED', message: 'Слишком часто.' }), /Слишком часто/);
  assert.match(planAiErrorText({ code: 'AI_UNAVAILABLE' }), /обычная проверка формата/);
});

test('DISC-01/DISC-02/UX-01: the dialog scans only on a click and returns to the start state', () => {
  const source = fsSync.readFileSync(path.join(import.meta.dirname, '..', 'web', 'app.js'), 'utf8');
  const open = source.slice(source.indexOf('function openPlanDialog()'), source.indexOf('function closePlanDialog()'));
  assert.doesNotMatch(open, /plan\/scan/, 'opening the dialog never scans');
  assert.match(open, /planScan = null/, 'no stale results from a previous opening');
  // Один обработчик = одно сканирование: кнопка ведёт прямо в runPlanScan, а
  // повторный поиск — отдельная кнопка «Повторить».
  const startHandler = source.slice(source.indexOf("$('planScanStart').onclick"), source.indexOf("$('planRescan').onclick"));
  assert.match(startHandler, /runPlanScan\(\)/);
  assert.equal((startHandler.match(/runPlanScan/g) || []).length, 1);
  const rescanHandler = source.slice(source.indexOf("$('planRescan').onclick"), source.indexOf("$('planSearch').oninput"));
  assert.match(rescanHandler, /runPlanScan\(\)/);
  // Никакого сканирования по таймеру или на каждом событии чата.
  const planSection = source.slice(source.indexOf('/* ---------------- Follow Plan (UI-02)'), source.indexOf("$('newTaskButton').onclick"));
  assert.equal(/setInterval/.test(planSection), false, 'no periodic scan');
  // Поиск фильтрует уже полученный список, а не запускает сканирование.
  const search = source.slice(source.indexOf("$('planSearch').oninput"), source.indexOf("$('planSearch').oninput") + 200);
  assert.match(search, /renderPlanScan\(\)/);
  assert.doesNotMatch(search, /plan\/scan/);
  // «Отменить выбор» ничего не удаляет и не отключает.
  const cancel = source.slice(source.indexOf('function cancelPlanSelection()'), source.indexOf('function cancelPlanSelection()') + 500);
  assert.doesNotMatch(cancel, /detach|DELETE|remove/i);
  // Отключение и отмена — разные действия с разными подписями.
  const detach = source.slice(source.indexOf('async function detachPlan()'), source.indexOf('async function detachPlan()') + 400);
  assert.match(detach, /Отключить следование плану\? Файл останется в проекте/);
});

test('every element the plan dialog touches exists in the markup', async () => {
  // Дешёвая, но настоящая проверка проводки: опечатка в id не ловится ни одним
  // доменным тестом, а в браузере выглядит как «кнопка ничего не делает».
  const html = await fs.readFile(path.join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const source = await fs.readFile(path.join(import.meta.dirname, '..', 'web', 'app.js'), 'utf8');
  const section = source.slice(source.indexOf('/* ---------------- Follow Plan (UI-02)'), source.indexOf("$('newTaskButton').onclick"));
  const used = new Set([...section.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]));
  assert.ok(used.size > 10, `плановая секция найдена: ${used.size} id`);
  const missing = [...used].filter(id => !ids.has(id));
  assert.deepEqual(missing, [], `в markup нет элементов: ${missing.join(', ')}`);
});

test('FP-UX-05: the panel is a compact dialog with two equal entry buttons', async () => {
  const dir = path.join(import.meta.dirname, '..', 'web');
  const css = await fs.readFile(path.join(dir, 'app.css'), 'utf8');
  const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
  const source = await fs.readFile(path.join(dir, 'app.js'), 'utf8');

  // Ширина: 540–560 px, а не «на всё окно»; крупный заголовок и основной текст 14 px.
  const dialog = /\.planDialog\s*\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(dialog, /width:\s*min\(560px, 96vw\)/);
  assert.match(dialog, /max-width:\s*min\(560px, 96vw\)/);
  assert.match(css, /#planDialog \.dialogHeader h2\s*\{\s*font-size:\s*1\.25rem/);
  assert.match(css, /\.planPicker > p\s*\{\s*font-size:\s*0\.875rem/);
  assert.match(css, /\.planStartActions \.planPick\s*\{\s*flex:\s*1 1 0/);

  // Дубля «Закрыть» внизу нет: закрытие — крестик в заголовке.
  assert.equal(/id="planDialogDone"/.test(html), false);
  assert.equal(/planDialogDone/.test(source), false);
  assert.match(html, /id="planDialogClose"/);

  // Список: поиск и строки — в области списка, отдельной навигации по папкам нет.
  assert.match(html, /id="planSearch"/);
  assert.equal(/id="planBrowser"/.test(html), false);
});

test('«Исправить формат» есть в диалоге и пишет только валидный план', async () => {
  const dir = path.join(import.meta.dirname, '..', 'web');
  const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
  const source = await fs.readFile(path.join(dir, 'app.js'), 'utf8');
  // Кнопка живёт в карточке выбора и показывается только когда файл не готов.
  assert.match(html, /id="planRepairOpen"[^>]*>Исправить формат</);
  assert.match(html, /id="planRepairText"[^>]*aria-label="Текст файла для исправления формата"/);
  assert.match(html, /id="planRepairSave"[^>]*>Сохранить как план</);
  assert.match(source, /\$\('planRepairOpenRow'\)\.classList\.toggle\('hidden', verdict\?\.canAttach !== false\)/,
    'кнопка видна только для NOT_A_PLAN/INVALID');
  // Чтение — read-only маршрут, сохранение — команда с CAS по хэшу.
  assert.match(source, /\/plan\/read-file\?path=/);
  assert.match(source, /\/plan\/save-file/);
  assert.match(source, /expectedHash: planRepairBase\.hash/);
  assert.match(source, /overwrite: planRepairOverwrite/);
  assert.doesNotMatch(source, /planRepair[\s\S]{0,400}plan\/import[\s\S]{0,80}confirmImport: true, overwrite: true\b.*planRepair/,
    'правка не подменяет подтверждение импорта');
});

test('«Исправить формат» не показан для готового плана', async () => {
  // Чистое решение карточки: canAttach=false ⇒ кнопка есть, canAttach=true ⇒ нет.
  const notAPlan = planVerdictView({ verdict: 'NOT_A_PLAN', problems: ['нет шагов'] });
  const managed = planVerdictView({ verdict: 'VALID_MANAGED', managed: true, steps: 2, revision: 1 });
  assert.equal(notAPlan.canAttach, false);
  assert.equal(managed.canAttach, true);
});

test('список шагов показывает, что сделано и что выполняется сейчас', () => {
  const steps = [
    { id: 'S-001', status: 'DONE', title: 'Известное' },
    { id: 'S-002', status: 'DONE', title: 'Сверка' },
    { id: 'S-003', status: 'IN_PROGRESS', title: 'Смоук' },
    { id: 'S-004', status: 'TODO', title: 'Реестр' },
    { id: 'S-005', status: 'SKIPPED', title: 'Лишний' },
    { id: 'S-006', status: 'BLOCKED', title: 'Заблокирован' }
  ];
  assert.equal(planStepMark(steps[0], 'S-003'), '✓');
  assert.equal(planStepMark(steps[2], 'S-003'), '●');
  assert.equal(planStepMark(steps[3], 'S-003'), '○');
  assert.equal(planStepMark(steps[4], 'S-003'), '»');
  assert.equal(planStepMark(steps[5], 'S-003'), '!');
  // Шаг, который сервер назвал текущим, помечен даже если статус ещё TODO.
  assert.equal(planStepMark({ id: 'S-009', status: 'TODO' }, 'S-009'), '●');
  assert.equal(planStepsSummary({ steps, stepId: 'S-003' }), 'закрыто 2 из 6 · сейчас S-003');
  assert.equal(planStepsSummary({ steps: [] }), '');
});
