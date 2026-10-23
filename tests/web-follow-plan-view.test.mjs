// Переключатель «По плану» и карточка плана (FP-05C): проверяются чистые решения,
// а не DOM — что показывает карточка, какие кнопки доступны, что означает
// выключение переключателя и как формируется тело команды с ревизией.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PLAN_MODE_LABEL, PLAN_STATE_LABELS, PLAN_EVENT_TYPES,
  planActions, planCardModel, planCurrentStep, planErrorText, planEventNotice, planFileChoices, planFileGroups,
  planFindingsSummary, planHeadline, planIconState, planInspectionText, planMetaLine, planPrimaryAction,
  PLAN_ICON_TITLES, planPathProblem, planToggleState, verificationText,
  planRequestBody, planFindingsLine, toggleOffAction
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
  assert.equal(planIconState({ attached: true, state: 'IDLE', conflict: true }), 'attention');
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
  assert.deepEqual([...PLAN_EVENT_TYPES].sort(), ['PLAN_ATTACHED', 'PLAN_COMPLETED', 'PLAN_CONFLICT', 'PLAN_PAUSED', 'PLAN_REVISED', 'PLAN_STEP_CHECKPOINT', 'PLAN_STEP_STARTED']);
});

test('the dialog picks a file from the system picker or by an explicit project path', async () => {
  const html = await fs.readFile(path.join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(html, /id="planToggle"[^>]*aria-label="По плану"/);
  const actions = html.slice(html.indexOf('class="composerActions"'));
  assert.ok(actions.indexOf('id="planToggle"') < actions.indexOf('id="files"'), 'the plan icon sits in the composer row');
  // UI-02: no automatic listing of the project's Markdown files any more.
  assert.equal(/id="planFiles"/.test(html), false, 'nothing is scanned when the dialog opens');
  assert.match(html, /id="planPickFile"[^>]*>Выбрать файл .md/);
  assert.match(html, /id="planFileInput"[^>]*accept="\.md,\.markdown/);
  // The project browser is the primary way to choose a file that lives on the
  // computer: a phone cannot reach it otherwise.
  assert.match(html, /id="planBrowser"/);
  assert.equal(/planPathInput/.test(html), false, 'the manual path field was unclear and is gone');
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
  assert.deepEqual(planPrimaryAction({ attached: false }), { id: 'pick', label: 'Выбрать файл .md' });
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
