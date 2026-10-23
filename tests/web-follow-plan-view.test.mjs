// Переключатель «По плану» и карточка плана (FP-05C): проверяются чистые решения,
// а не DOM — что показывает карточка, какие кнопки доступны, что означает
// выключение переключателя и как формируется тело команды с ревизией.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PLAN_MODE_LABEL, PLAN_STATE_LABELS, PLAN_EVENT_TYPES,
  planActions, planCardModel, planEventNotice, planFileChoices, planFileGroups, planHeadline, planIconState,
  PLAN_ICON_TITLES, planPathProblem, planToggleState,
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
  assert.equal(model.actions.length, 6);
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

test('the switch is an icon in the composer row, next to attach and the session menu', async () => {
  const html = await fs.readFile(path.join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(html, /id="planToggle"[^>]*aria-label="По плану"/);
  assert.equal(/Plan Mode/.test(html), false);
  // Same row as the attachment button: the plan icon lives where a file is picked,
  // not in a separate chip above the composer.
  const actions = html.slice(html.indexOf('class="composerActions"'));
  assert.ok(actions.indexOf('id="planToggle"') < actions.indexOf('id="files"'), 'the plan icon comes before the attachment input');
  // No card in the chat any more: the chat keeps its space for the work, the icon
  // carries the state and the dialog carries the details.
  assert.equal(/id="planCard"/.test(html), false);
  assert.match(html, /id="planStatusBlock"/, 'status lives in the dialog');
  assert.match(html, /id="planDetach"/, 'a selected plan can be removed from the dialog');
  // The buttons themselves are built by planActions (labels are asserted above, in
  // one place), the page only reserves the container for them.
  assert.match(html, /id="planActions"/);
  assert.match(html, /id="planPath"/, 'the dialog can name a file that is not in the listing');
  assert.match(html, /id="planFiles"/, 'and the listing itself is rendered, so nothing has to be typed');
});
