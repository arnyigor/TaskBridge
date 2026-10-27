// FP-05A: подключение PlanFollower к TaskBridge, без Pi и без HTTP.
//
// Подставной TaskManager даёт ровно те три точки, к которым обращается сервис:
// отправка через существующий путь сообщений, отмена и журнал событий задачи.
// Файл плана и SQLite — настоящие: проверяется именно то, что уйдёт в прод.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { FollowPlanService } from '../src/follow-plan-service.mjs';
import { parsePlan, planHash } from '../src/application/plan-file.mjs';
import { planActions } from '../web/follow-plan-view.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-api
revision: 1
goal: "FP-05: подключение"
---

# План: подключение

## Шаги

### S-001 | TODO | P1 | Первый
**Критерии:** сделано.
**Проверка:** run

### S-002 | TODO | P1 | Второй
**Критерии:** сделано.
**Проверка:** run

## Обнаруженные проблемы
`;

function fakeManager({ workspace, taskId = 't-1' }) {
  const dispatched = [];
  const cancelled = [];
  const events = [];
  let runId = null;
  const task = () => ({ id: taskId, workspacePath: workspace, runId });
  return {
    dispatched, cancelled, events,
    get task() { return task(); },
    getTask: id => (String(id) === taskId ? task() : null),
    listTasks: () => [{ id: taskId }],
    message: async (id, text, _mode, _files, _token, opts = {}) => {
      dispatched.push({ text, commandId: opts.commandId });
      return { id };
    },
    cancel: async (id, opts) => { cancelled.push(opts); },
    publishFollowPlanEvent: async (id, type, message, data) => { events.push({ type, message, data }); }
  };
}

const setup = async (t, { enabled = true } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-service-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'docs-PLAN.md'), PLAN, 'utf8');
  const store = new TaskStore(root);
  t.after(async () => {
    store.close?.();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
  const manager = fakeManager({ workspace });
  const service = new FollowPlanService({ manager, store, config: { followPlan: { enabled } } });
  return { root, workspace, store, manager, service, planPath: 'docs-PLAN.md' };
};

const readPlanFile = async (workspace, relPath) => parsePlan(await fs.readFile(path.join(workspace, relPath), 'utf8'));

test('attach reads the file, spends no turn and reports progress', async t => {
  const { service, manager, planPath } = await setup(t);
  const status = await service.attach({ taskId: 't-1', path: planPath, commandId: 'cmd-attach' });
  assert.equal(manager.dispatched.length, 0, 'attaching must not call the model');
  assert.equal(status.attached, true);
  assert.equal(status.state, 'IDLE');
  assert.equal(status.revision, 1);
  assert.deepEqual(status.progress, { done: 0, total: 2 });
  assert.deepEqual(status.steps.map(step => step.id), ['S-001', 'S-002']);
  assert.equal(manager.events.at(-1).type, 'PLAN_ATTACHED');
});

test('FP-FIX-05: the service publishes how a checkpoint ended, not just that it arrived', async t => {
  const { service, manager, store, workspace, planPath } = await setup(t);
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'cmd-attach' });
  const started = await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 'cmd-start' });

  // Ход завершается, когда цикл уже на разборе: checkpoint получен, применять некуда.
  store.savePlanBinding({ ...store.getPlanBinding('t-1'), state: 'PAUSED_REVIEW', dispatchCommandId: null, dispatchStepId: null });
  await service.turnSettled({
    taskId: 't-1',
    commandId: started ? store.getPlanBinding('t-1').dispatchCommandId : 'plan:c',
    checkpoint: { planId: 'p-api', revision: 1, cycleId: 'c-1', decision: 'CONTINUE', completedStepIds: ['S-001'],
      evidence: [{ stepId: 'S-001', kind: 'test', ref: 'call-1', summary: 'тесты зелёные' }] },
    toolCalls: [{ id: 'call-1', name: 'bash', isError: false, exitCode: 0 }]
  });

  const rejected = manager.events.find(event => event.type === 'PLAN_CHECKPOINT_REJECTED');
  assert.ok(rejected, 'отказ опубликован отдельным событием');
  assert.equal(rejected.data.outcome, 'REJECTED');
  assert.equal(rejected.data.reasonCode, 'STATE_INACTIVE');
  assert.ok(rejected.data.checkpointId, 'checkpoint назван идентификатором');
  assert.match(rejected.message, /не применён/);
  // Файл не переписан: шаг остался открытым, пока цикл не активен.
  assert.equal((await readPlanFile(workspace, planPath)).steps[0].status, 'TODO');
});

test('start dispatches through the existing message path with a command id', async t => {
  const { service, manager, store, planPath } = await setup(t);
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'cmd-attach' });
  const status = await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 'cmd-start' });
  assert.equal(manager.dispatched.length, 1);
  assert.match(manager.dispatched[0].text, /FOLLOW PLAN/);
  assert.match(manager.dispatched[0].text, /S-001/);
  assert.equal(manager.dispatched[0].commandId, store.getPlanBinding('t-1').dispatchCommandId);
  assert.equal(status.state, 'RUNNING_STEP');
  assert.equal(status.stepId, 'S-001');
  assert.equal(manager.events.at(-1).type, 'PLAN_STEP_STARTED');
});

test('a settled turn with a valid checkpoint records the step and continues', async t => {
  const { service, manager, store, workspace, planPath } = await setup(t);
  store.recordRun({ id: 'run-1', taskId: 't-1', sessionId: 't-1', kind: 'prompt', status: 'RUNNING', startedAt: new Date().toISOString() });
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'cmd-attach' });
  await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 'cmd-start' });
  const commandId = store.getPlanBinding('t-1').dispatchCommandId;

  const result = await service.turnSettled({
    taskId: 't-1', commandId,
    checkpoint: {
      planId: 'p-api', revision: 1, cycleId: 'c-1', decision: 'CONTINUE',
      completedStepIds: ['S-001'], evidence: [{ stepId: 'S-001', kind: 'run', ref: 'run-1', summary: 'шаг выполнен' }]
    }
  });
  // The hop is prepared, not sent: the turn's terminal commit decides (FP-UX-02E).
  assert.equal(result.code, 'DISPATCH_READY');
  assert.equal(result.stepId, 'S-002');
  assert.equal(manager.dispatched.length, 1, 'ничего не отправлено до фиксации хода');
  const committed = await service.turnCommitted({ taskId: 't-1' });
  assert.equal(committed.code, 'DISPATCHED');
  assert.equal(committed.stepId, 'S-002');
  const written = await readPlanFile(workspace, planPath);
  assert.equal(written.steps[0].status, 'DONE');
  assert.equal(written.steps[0].result, '[MODEL_REPORTED] шаг выполнен');
  assert.equal(written.revision, 2);
  assert.equal(manager.dispatched.length, 2);
  assert.match(manager.dispatched[1].text, /revision 2/);
  assert.ok(manager.events.some(event => event.type === 'PLAN_STEP_CHECKPOINT' && event.data.decision === 'CONTINUE'));
});

test('evidence pointing at a missing or foreign run is stripped, so COMPLETE is refused', async t => {
  const { service, manager, store, workspace, planPath } = await setup(t);
  store.recordRun({ id: 'run-foreign', taskId: 't-OTHER', sessionId: 't-OTHER', kind: 'prompt', status: 'RUNNING', startedAt: new Date().toISOString() });
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'cmd-attach' });
  await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 'cmd-start' });
  const commandId = store.getPlanBinding('t-1').dispatchCommandId;

  const result = await service.turnSettled({
    taskId: 't-1', commandId,
    checkpoint: {
      planId: 'p-api', revision: 1, cycleId: 'c-1', decision: 'COMPLETE',
      completedStepIds: ['S-001', 'S-002'],
      evidence: [
        { stepId: 'S-001', kind: 'run', ref: '00000000-0000-4000-8000-000000000000', summary: 'нет такого прогона' },
        { stepId: 'S-002', kind: 'run', ref: 'run-foreign', summary: 'чужой прогон' }
      ]
    }
  });
  // Отказ проверки — свой код: ссылки не подтвердились, шаг не закрыт.
  assert.equal(result.code, 'PLAN_CHECKPOINT_REJECTED');
  const written = await readPlanFile(workspace, planPath);
  assert.deepEqual(written.steps.map(step => step.status), ['TODO', 'TODO'], 'nothing was written on unverified evidence');
  const checkpoint = manager.events.find(event => event.type === 'PLAN_STEP_CHECKPOINT');
  assert.equal(checkpoint.data.evidenceProblems.length, 2);
  assert.match(checkpoint.data.evidenceProblems.join('\n'), /не найден/);
  assert.match(checkpoint.data.evidenceProblems.join('\n'), /другой сессии/);
});

test('a human edit during the cycle is a conflict, not an overwrite', async t => {
  const { service, manager, store, workspace, planPath } = await setup(t);
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'cmd-attach' });
  await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 'cmd-start' });
  const commandId = store.getPlanBinding('t-1').dispatchCommandId;
  const edited = PLAN.replace('Второй', 'Второй (правка человека)');
  await fs.writeFile(path.join(workspace, planPath), edited, 'utf8');

  const result = await service.turnSettled({
    taskId: 't-1', commandId,
    checkpoint: { planId: 'p-api', revision: 1, cycleId: 'c-1', decision: 'CONTINUE', completedStepIds: [], evidence: [] }
  });
  assert.equal(result.code, 'PLAN_REVISION_CONFLICT');
  assert.equal(await fs.readFile(path.join(workspace, planPath), 'utf8'), edited);
  assert.ok(manager.events.some(event => event.type === 'PLAN_CONFLICT'));
  assert.equal(store.getPlanBinding('t-1').state, 'PAUSED_REVIEW');
});

test('STOP bumps the epoch, cancels the command and no later settle starts a turn', async t => {
  const { service, manager, store, planPath } = await setup(t);
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'cmd-attach' });
  await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 'cmd-start' });
  const commandId = store.getPlanBinding('t-1').dispatchCommandId;

  await service.stop({ taskId: 't-1', commandId: 'cmd-stop' });
  assert.equal(store.planCancelEpoch('t-1'), 1);
  assert.equal(manager.cancelled.length, 1);
  assert.match(manager.cancelled[0].commandId, /:stop$/);

  const late = await service.turnSettled({
    taskId: 't-1', commandId,
    checkpoint: { planId: 'p-api', revision: 1, cycleId: 'c-1', decision: 'CONTINUE', completedStepIds: ['S-001'], evidence: [{ stepId: 'S-001', kind: 'file', ref: 'docs-PLAN.md', summary: 'x' }] }
  });
  assert.equal(late.code, 'IGNORED');
  assert.equal(manager.dispatched.length, 1, 'a settle after STOP must not dispatch');
});

test('a restart with a dispatched command pauses instead of replaying it', async t => {
  const { service, manager, store, planPath } = await setup(t);
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'cmd-attach' });
  await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 'cmd-start' });

  const results = await service.recoverAll();
  assert.equal(results.length, 1);
  assert.equal(results[0].code, 'PLAN_UNKNOWN_OUTCOME');
  assert.equal(store.getPlanBinding('t-1').state, 'PAUSED_REVIEW');
  assert.equal(manager.dispatched.length, 1, 'the possibly executed turn is not sent again');
  assert.ok(manager.events.some(event => event.type === 'PLAN_PAUSED'));
});

test('two settles of one command do not start a second cycle', async t => {
  const { service, manager, store, planPath } = await setup(t);
  store.recordRun({ id: 'run-1', taskId: 't-1', sessionId: 't-1', kind: 'prompt', status: 'RUNNING', startedAt: new Date().toISOString() });
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'cmd-attach' });
  await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 'cmd-start' });
  const first = store.getPlanBinding('t-1').dispatchCommandId;
  const checkpoint = {
    planId: 'p-api', revision: 1, cycleId: 'c-1', decision: 'CONTINUE',
    completedStepIds: ['S-001'], evidence: [{ stepId: 'S-001', kind: 'run', ref: 'run-1', summary: 'ok' }]
  };
  await service.turnSettled({ taskId: 't-1', commandId: first, checkpoint });
  await service.turnCommitted({ taskId: 't-1' });
  const after = manager.dispatched.length;
  const repeat = await service.turnSettled({ taskId: 't-1', commandId: first, checkpoint });
  assert.equal(repeat.code, 'IGNORED', 'the repeated frame belongs to a command that is no longer current');
  assert.equal(manager.dispatched.length, after);
});

test('an operator edit through the API is a CAS write and a stale revision is refused', async t => {
  const { service, manager, workspace, planPath } = await setup(t);
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'cmd-attach' });

  const patched = await service.patch({
    taskId: 't-1', expectedRevision: 1,
    changes: { ops: [{ op: 'add_finding', findingId: 'F-001', priority: 'P2', summary: 'медленный лог' }] },
    commandId: 'cmd-patch'
  });
  assert.equal(patched.revision, 2);
  assert.ok(manager.events.some(event => event.type === 'PLAN_REVISED'));

  await assert.rejects(service.patch({
    taskId: 't-1', expectedRevision: 1,
    changes: { ops: [{ op: 'add_finding', findingId: 'F-002', priority: 'P2', summary: 'ещё' }] },
    commandId: 'cmd-patch-2'
  }), error => error.code === 'PLAN_REVISION_CONFLICT');
  const written = parsePlan(await fs.readFile(path.join(workspace, planPath), 'utf8'));
  assert.deepEqual(written.findings.map(finding => finding.id), ['F-001']);
});

test('adopting the operator file clears a conflict without losing text', async t => {
  const { service, store, workspace, planPath } = await setup(t);
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'cmd-attach' });
  const edited = PLAN.replace('goal: "FP-05: подключение"', 'goal: "FP-05: цель уточнена"');
  await fs.writeFile(path.join(workspace, planPath), edited, 'utf8');

  const before = await service.status('t-1');
  assert.equal(before.conflict, true, 'the API shows that the file moved');

  const adopted = await service.reconcile({ taskId: 't-1', action: 'adopt_external', commandId: 'cmd-adopt' });
  assert.equal(adopted.conflict, false);
  assert.equal(adopted.goal, 'FP-05: цель уточнена');
  assert.equal(store.getPlanBinding('t-1').hash, planHash(edited));
});

test('with the flag off the status stays readable and control is refused', async t => {
  const { service, manager, planPath } = await setup(t, { enabled: false });
  const status = await service.status('t-1');
  assert.equal(status.enabled, false);
  assert.equal(status.attached, false);
  await assert.rejects(service.attach({ taskId: 't-1', path: planPath, commandId: 'cmd' }), error => error.code === 'FOLLOW_PLAN_DISABLED');
  assert.equal(manager.dispatched.length, 0);
});

test('UX-10/UX-11: the next step goes out only after the turn is committed, and a failure drops it', async t => {
  const { service, manager, store, planPath } = await setup(t);
  store.recordRun({ id: 'run-1', taskId: 't-1', sessionId: 't-1', kind: 'prompt', status: 'SUCCEEDED', startedAt: new Date().toISOString() });
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'e-attach' });
  await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 'e-start' });
  const commandId = store.getPlanBinding('t-1').dispatchCommandId;
  const checkpoint = {
    planId: 'p-api', revision: 1, cycleId: 'c-1', decision: 'CONTINUE',
    completedStepIds: ['S-001'], evidence: [{ stepId: 'S-001', kind: 'run', ref: 'run-1', summary: 'ok' }]
  };

  const prepared = await service.turnSettled({ taskId: 't-1', commandId, checkpoint });
  assert.equal(prepared.code, 'DISPATCH_READY');
  assert.equal(manager.dispatched.length, 1, 'the previous turn is not even durable yet');
  assert.equal(store.getPlanBinding('t-1').state, 'REVIEWING', 'prepared hop is not a dispatch');

  // The turn failed before its terminal event: the prepared hop dies with it.
  await service.turnFailed({ taskId: 't-1', reason: 'FINALIZE_FAILED' });
  const afterFailure = await service.turnCommitted({ taskId: 't-1' });
  assert.equal(afterFailure.code, 'IGNORED');
  assert.equal(manager.dispatched.length, 1, 'no step is sent when the turn did not commit');
});

test('CP-06: evidence from an older run of the same session does not confirm this step', async t => {
  const { service, store, workspace, planPath } = await setup(t);
  // An earlier turn of THIS session: its run exists, but it ran before the step.
  store.recordRun({ id: 'run-old', taskId: 't-1', sessionId: 't-1', kind: 'prompt', status: 'SUCCEEDED', startedAt: '2026-10-01T10:00:00.000Z' });
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'cp06-attach' });
  await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 'cp06-start' });
  const commandId = store.getPlanBinding('t-1').dispatchCommandId;
  // The turn being settled has its own run, newer than the cited one.
  const managerRun = 'run-current';
  store.recordRun({ id: managerRun, taskId: 't-1', sessionId: 't-1', kind: 'prompt', status: 'RUNNING', startedAt: '2026-10-22T10:00:00.000Z' });
  service.manager.dispatched.length = 0;
  // getTask() reports the open run, exactly as TaskManager does.
  service.manager.getTask = id => (String(id) === 't-1' ? { id: 't-1', workspacePath: workspace, runId: managerRun } : null);

  const result = await service.turnSettled({
    taskId: 't-1', commandId,
    checkpoint: {
      planId: 'p-api', revision: 1, cycleId: 'c-1', decision: 'CONTINUE',
      completedStepIds: ['S-001'], evidence: [{ stepId: 'S-001', kind: 'run', ref: 'run-old', summary: 'старый прогон' }]
    }
  });
  // Отказ проверки называется своим кодом: «заблокировано» — это решение модели,
  // а здесь шаг не закрыт валидацией (живой прогон 2026-10-27).
  assert.equal(result.code, 'PLAN_CHECKPOINT_REJECTED');
  // The controller's own reason is reported with the checkpoint event; the
  // verdict sees the stripped ref and refuses for lack of proof.
  const checkpoint = service.manager.events.find(event => event.type === 'PLAN_STEP_CHECKPOINT');
  assert.match(checkpoint.data.evidenceProblems.join('\n'), /старше текущего хода/);
  assert.match(result.message, /без ссылки/);
  const written = await readPlanFile(workspace, planPath);
  assert.equal(written.steps[0].status, 'TODO');
});

// --- UI-02: выбор файла через системный диалог и явный путь ---------------

const base64 = text => Buffer.from(text, 'utf8').toString('base64');

test('inspect says what would happen without writing or attaching anything', async t => {
  const { service, manager, store, workspace, planPath } = await setup(t);
  const managed = await service.inspect({ taskId: 't-1', path: planPath });
  assert.equal(managed.managed, true);
  assert.equal(managed.steps, 2);
  assert.equal(managed.revision, 1);
  assert.equal(store.getPlanBinding('t-1'), null, 'inspect attaches nothing');
  assert.equal(manager.dispatched.length, 0);

  const freeForm = await service.inspect({
    taskId: 't-1', name: 'MY_NOTES.md',
    contentBase64: base64('# Мои заметки\n\n- [ ] Починить пагинацию\n- [ ] Проверить приёмку\n')
  });
  assert.equal(freeForm.managed, false);
  assert.equal(freeForm.freeForm, true);
  assert.deepEqual(freeForm.preview.steps.map(step => step.title), ['Починить пагинацию', 'Проверить приёмку']);
  assert.equal(freeForm.path, 'MY_NOTES.md');

  const broken = await service.inspect({ taskId: 't-1', name: 'PLAN.md', contentBase64: base64('---\ntaskbridge_plan: 1\n') });
  assert.equal(broken.managed, false);
  assert.ok(broken.problems.length > 0);
  assert.equal(await fs.readdir(workspace).then(list => list.filter(name => name === 'MY_NOTES.md')).then(list => list.length), 0);
});

test('a file from the system picker is written inside the project and attached', async t => {
  const { service, store, workspace } = await setup(t);
  const result = await service.importPlan({
    taskId: 't-1', name: 'PLAN.md', contentBase64: base64(PLAN), commandId: 'import-1'
  });
  assert.equal(result.needsConfirmation, false);
  assert.equal(result.status.attached, true);
  assert.equal(result.status.revision, 1);
  const written = await readPlanFile(workspace, 'PLAN.md');
  assert.equal(written.planId, 'p-api');
  assert.equal(store.getPlanBinding('t-1').path, 'PLAN.md');
});

test('a free-form file is imported only after confirmation, and then converted', async t => {
  const { service, store, workspace } = await setup(t);
  const text = '# План\n\n- [ ] Шаг один\n- [x] Шаг два\n';
  const preview = await service.importPlan({
    taskId: 't-1', name: 'NOTES.md', contentBase64: base64(text), commandId: 'import-2'
  });
  assert.equal(preview.needsConfirmation, true);
  assert.equal(preview.inspection.freeForm, true);
  assert.equal(await fs.readFile(path.join(workspace, 'NOTES.md'), 'utf8').catch(() => null), null, 'nothing written before the confirmation');
  assert.equal(store.getPlanBinding('t-1'), null);

  const confirmed = await service.importPlan({
    taskId: 't-1', name: 'NOTES.md', contentBase64: base64(text), confirmImport: true, commandId: 'import-3'
  });
  assert.equal(confirmed.needsConfirmation, false);
  assert.equal(confirmed.status.attached, true);
  const converted = await readPlanFile(workspace, 'NOTES.md');
  assert.deepEqual(converted.steps.map(step => step.title), ['Шаг один', 'Шаг два']);
  assert.equal(converted.steps[1].status, 'TODO', 'a ticked box in the source is not evidence');
});

test('an existing different file is not overwritten without confirmation', async t => {
  const { service, workspace } = await setup(t);
  await fs.writeFile(path.join(workspace, 'PLAN.md'), 'важный текст оператора\n', 'utf8');
  await assert.rejects(service.importPlan({
    taskId: 't-1', name: 'PLAN.md', contentBase64: base64(PLAN), commandId: 'import-4'
  }), error => error.code === 'PLAN_FILE_EXISTS');
  assert.equal(await fs.readFile(path.join(workspace, 'PLAN.md'), 'utf8'), 'важный текст оператора\n');

  const forced = await service.importPlan({
    taskId: 't-1', name: 'PLAN.md', contentBase64: base64(PLAN), overwrite: true, commandId: 'import-5'
  });
  assert.equal(forced.status.attached, true);
});

test('the picked file name cannot escape the workspace and must be Markdown', async t => {
  const { service, workspace } = await setup(t);
  const sneaky = await service.importPlan({
    taskId: 't-1', name: '../../evil.md', contentBase64: base64(PLAN), commandId: 'import-6'
  });
  assert.equal(sneaky.status.path, 'evil.md', 'the path is reduced to a safe file name');
  assert.equal(await fs.stat(path.join(path.dirname(workspace), 'evil.md')).then(() => true, () => false), false);

  await assert.rejects(service.importPlan({
    taskId: 't-1', name: 'PLAN.txt', contentBase64: base64(PLAN), commandId: 'import-7'
  }), error => error.code === 'PLAN_INVALID');

  await assert.rejects(service.importPlan({
    taskId: 't-1', name: 'BROKEN.md', contentBase64: Buffer.from([0xff, 0xfe, 0x00]).toString('base64'), commandId: 'import-8'
  }), error => error.code === 'PLAN_INVALID');
});

// --- UI-02: ленивый браузер проекта (телефон выбирает файл на компьютере) ---

test('browse lists one project directory at a time, folders and Markdown only', async t => {
  const { service, workspace } = await setup(t);
  await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'docs', 'PLAN.md'), PLAN, 'utf8');
  await fs.writeFile(path.join(workspace, 'docs', 'notes.txt'), 'x', 'utf8');
  await fs.mkdir(path.join(workspace, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'node_modules', 'PLAN.md'), PLAN, 'utf8');

  const root = await service.browse({ taskId: 't-1', path: '' });
  assert.equal(root.path, '');
  // The fixture's own plan file sits in the root and is a legal choice.
  assert.deepEqual(root.entries.map(entry => `${entry.isFile ? 'f' : 'd'}:${entry.name}`), ['d:docs', 'f:docs-PLAN.md']);
  assert.equal(root.entries.some(entry => entry.name === 'node_modules'), false, 'эти папки не листаются');

  const docs = await service.browse({ taskId: 't-1', path: 'docs' });
  assert.equal(docs.parent, '');
  assert.deepEqual(docs.entries.map(entry => entry.name), ['PLAN.md'], 'в папке показываются только .md');

  await assert.rejects(service.browse({ taskId: 't-1', path: '../' }), error => error.code === 'PLAN_INVALID');
  await assert.rejects(service.browse({ taskId: 't-1', path: 'missing' }), error => error.code === 'PLAN_NOT_ATTACHED');
});

test('UX-01: a file with every step DONE reads as completed, not as ready to start', async t => {
  const { service, store, workspace, planPath } = await setup(t);
  const done = PLAN
    .replace('### S-001 | TODO', '### S-001 | DONE')
    .replace('**Проверка:** run\n\n### S-002', '**Проверка:** run\n**Результат:** подтверждено\n\n### S-002')
    .replace('### S-002 | TODO', '### S-002 | DONE')
    .replace('**Проверка:** run\n\n## Обнаруженные', '**Проверка:** run\n**Результат:** подтверждено\n\n## Обнаруженные');
  await fs.writeFile(path.join(workspace, planPath), done, 'utf8');

  await service.attach({ taskId: 't-1', path: planPath, commandId: 'ux01-attach' });
  const status = await service.status('t-1');
  assert.equal(status.state, 'COMPLETED', 'the file is finished, whatever the binding says');
  assert.equal(status.attached, true);
  assert.equal(status.file.complete, true);
  assert.equal(status.file.open, 0);
  assert.equal(status.progress.done, 2);
  // The actions the dialog shows must not offer a start on a finished file.
  assert.equal(planActions(status).find(action => action.id === 'start').disabled, true);
  assert.equal(store.getPlanBinding('t-1').state, 'IDLE', 'the binding itself is untouched by the display');

  // Re-attaching the same finished file keeps the same reading (reopen/new task).
  const other = await service.attach({ taskId: 't-1', path: planPath, commandId: 'ux01-attach-2' });
  assert.equal(other.state, 'COMPLETED');
});

test('UX-12: a written-out command is reported evidence, a finished tool call is verified', async t => {
  const { service, store, workspace, planPath } = await setup(t);
  store.recordRun({ id: 'run-live', taskId: 't-1', sessionId: 't-1', kind: 'prompt', status: 'RUNNING', startedAt: new Date().toISOString() });
  service.manager.getTask = id => (String(id) === 't-1' ? { id: 't-1', workspacePath: workspace, runId: 'run-live' } : null);
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'f-attach' });
  await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 'f-start' });
  const commandId = store.getPlanBinding('t-1').dispatchCommandId;

  const prepared = await service.turnSettled({
    taskId: 't-1', commandId,
    checkpoint: {
      planId: 'p-api', revision: 1, cycleId: 'c-1', decision: 'CONTINUE',
      completedStepIds: ['S-001'],
      evidence: [
        // A sentence the model wrote: nothing in TaskBridge saw this command run.
        { stepId: 'S-001', kind: 'command', ref: 'cat docs-PLAN.md', summary: 'вывод: ok' }
      ]
    },
    toolCalls: [{ id: 'call-1', name: 'bash', isError: false }]
  });
  assert.equal(prepared.code, 'DISPATCH_READY');
  const written = await readPlanFile(workspace, planPath);
  assert.match(written.steps[0].result, /^\[MODEL_REPORTED\]/, 'a written command is not a verification');

  // A tool call of this turn that finished without an error IS a system fact.
  await service.turnCommitted({ taskId: 't-1' });
  const next = store.getPlanBinding('t-1').dispatchCommandId;
  const second = await service.turnSettled({
    taskId: 't-1', commandId: next,
    checkpoint: {
      planId: 'p-api', revision: 2, cycleId: 'c-2', decision: 'COMPLETE',
      completedStepIds: ['S-002'],
      evidence: [{ stepId: 'S-002', kind: 'command', ref: 'call-2', summary: 'тест прошёл' }]
    },
    toolCalls: [{ id: 'call-2', name: 'bash', isError: false }]
  });
  assert.equal(second.code, 'PLAN_COMPLETED', 'both steps are done, so COMPLETE closes the plan');
  const after = await readPlanFile(workspace, planPath);
  assert.match(after.steps[1].result, /^\[SYSTEM_VERIFIED\]/);
  const status = await service.status('t-1');
  assert.equal(status.steps[1].verification, 'SYSTEM_VERIFIED');
  assert.equal(status.steps[0].verification, 'MODEL_REPORTED');
  const recovered = new FollowPlanService({ manager: service.manager, store, config: { followPlan: { enabled: true } } });
  assert.equal((await recovered.status('t-1')).steps[1].verification, 'SYSTEM_VERIFIED', 'receipt survives service recreation');
  const raw = await fs.readFile(path.join(workspace, planPath), 'utf8');
  const changed = await service.writeContent({ taskId: 't-1', content: raw.replaceAll('**Критерии:** сделано.', '**Критерии:** другой критерий.'),
    expectedRevision: status.revision, expectedHash: status.hash, commandId: 'criteria-edit' });
  assert.equal(changed.steps[1].verification, 'MODEL_REPORTED', 'edited criteria invalidate the server receipt');
  assert.equal(changed.state, 'COMPLETED', 'verification labels do not change COMPLETE semantics');
});

// --- FP-UX-02C: правка содержимого того же файла -------------------------

test('a valid edit is saved on the same file, the service owns the revision', async t => {
  const { service, store, workspace, planPath } = await setup(t);
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'c-attach' });
  const before = await service.status('t-1');
  const edited = PLAN.replace('Первый', 'Первый (уточнено)').replace('revision: 1', 'revision: 99');

  const after = await service.writeContent({
    taskId: 't-1', content: edited, expectedRevision: before.revision, expectedHash: before.hash, commandId: 'c-edit'
  });
  assert.equal(after.revision, 2, 'the client revision line is ignored, the service bumps its own');
  assert.match(await fs.readFile(path.join(workspace, planPath), 'utf8'), /уточнено/);
  assert.deepEqual((await readPlanFile(workspace, planPath)).steps.map(step => step.id), ['S-001', 'S-002'], 'step ids stay');
  const events = service.manager.events.map(event => event.type);
  assert.ok(events.includes('PLAN_REVISED'));
});

test('an edit cannot silently drop a finished step, its evidence, the planId or the goal', async t => {
  const { service, workspace, planPath } = await setup(t);
  const done = PLAN
    .replace('### S-001 | TODO', '### S-001 | DONE')
    .replace('**Проверка:** run\n', '**Проверка:** run\n**Результат:** [SYSTEM_VERIFIED] тест прошёл\n');
  await fs.writeFile(path.join(workspace, planPath), done, 'utf8');
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'c2-attach' });
  const status = await service.status('t-1');
  const edit = text => service.writeContent({ taskId: 't-1', content: text, expectedRevision: status.revision, expectedHash: status.hash, commandId: `c2-${Math.random()}` });

  await assert.rejects(edit(done.replace('plan_id: p-api', 'plan_id: p-other')), error => error.code === 'PLAN_INVALID' && /planId/.test(error.message));
  await assert.rejects(edit(done.replace('goal: "FP-05: подключение"', 'goal: "другая цель"')), error => error.code === 'PLAN_INVALID' && /цель/.test(error.message));
  await assert.rejects(edit(done.replace('**Результат:** [SYSTEM_VERIFIED] тест прошёл\n', '')), error => error.code === 'PLAN_INVALID' && /подтверждени|без результата/.test(error.message));
  await assert.rejects(edit(done.replace(/### S-002[\s\S]*?(?=## Обнаруженные)/, '')), error => error.code === 'PLAN_INVALID' && /удал/.test(error.message));
  assert.equal((await readPlanFile(workspace, planPath)).steps.length, 2, 'the file is untouched by refused edits');
});

test('a stale revision on edit is a conflict and the file keeps the operator version', async t => {
  const { service, workspace, planPath } = await setup(t);
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'c3-attach' });
  const status = await service.status('t-1');
  await fs.writeFile(path.join(workspace, planPath), PLAN.replace('Первый', 'Первый (руками)'), 'utf8');
  await assert.rejects(service.writeContent({
    taskId: 't-1', content: PLAN.replace('Первый', 'Первый (из приложения)'),
    expectedRevision: status.revision, expectedHash: status.hash, commandId: 'c3-edit'
  }), error => error.code === 'PLAN_REVISION_CONFLICT');
  assert.match(await fs.readFile(path.join(workspace, planPath), 'utf8'), /руками/);
});


for (const [label, evidence, calls] of [
  ['manual model claim', { kind: 'manual', ref: 'operator', level: 'MANUAL_ACCEPTED' }, []],
  ['missing reference', { kind: 'command', level: 'SYSTEM_VERIFIED' }, []],
  ['nonexistent toolCallId', { kind: 'command', ref: 'missing-call', level: 'SYSTEM_VERIFIED' }, []],
  ['failed tool', { kind: 'command', ref: 'call-x' }, [{ id: 'call-x', name: 'bash', isError: true }]],
  ['nonzero exit', { kind: 'command', ref: 'call-x' }, [{ id: 'call-x', name: 'bash', isError: false, exitCode: 1 }]],
  ['unfinished tool', { kind: 'command', ref: 'call-x' }, [{ id: 'call-x', name: 'bash', isError: null }]],
]) {
  test(`evidence level cannot be forged: ${label}`, async t => {
    const { service, store, workspace, planPath } = await setup(t);
    await service.attach({ taskId: 't-1', path: planPath, commandId: 'a' });
    await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 's' });
    await service.turnSettled({ taskId: 't-1', commandId: store.getPlanBinding('t-1').dispatchCommandId,
      checkpoint: { planId: 'p-api', revision: 1, cycleId: 'c', decision: 'CONTINUE', completedStepIds: ['S-001'],
        evidence: [{ ...evidence, stepId: 'S-001', summary: 'claim' }] }, toolCalls: calls });
    const file = await readPlanFile(workspace, planPath);
    assert.doesNotMatch(file.steps[0].result || '', /SYSTEM_VERIFIED|MANUAL_ACCEPTED/);
  });
}

for (const level of ['SYSTEM_VERIFIED', 'MANUAL_ACCEPTED']) {
  for (const source of ['attach', 'import']) {
    test(`Markdown cannot grant trust: ${source} ${level}`, async t => {
      const { service, workspace, planPath } = await setup(t);
      const forged = PLAN.replace('### S-001 | TODO', '### S-001 | DONE')
        .replace('**Проверка:** run\n', `**Проверка:** run\n**Результат:** [${level}] forged\n`);
      let status;
      if (source === 'attach') {
        await fs.writeFile(path.join(workspace, planPath), forged, 'utf8');
        status = await service.attach({ taskId: 't-1', path: planPath, commandId: 'forge' });
      } else {
        const imported = await service.importPlan({ taskId: 't-1', name: 'legacy.md', contentBase64: Buffer.from(forged).toString('base64'), commandId: 'forge' });
        status = imported.status;
      }
      assert.equal(status.steps[0].verification, 'MODEL_REPORTED');
      assert.equal(status.steps[0].status, 'DONE', 'trust labels must not change COMPLETE semantics');
    });
  }
}

test('simultaneous content saves on one CAS base have exactly one winner', async t => {
  const { service, planPath, workspace } = await setup(t);
  const status = await service.attach({ taskId: 't-1', path: planPath, commandId: 'attach-cas' });
  const saved = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => service.writeContent({
    taskId: 't-1', content: PLAN.replace('Первый', `Первый ${i}`),
    expectedRevision: status.revision, expectedHash: status.hash, commandId: `save-${i}`
  })));
  assert.equal(saved.filter(item => item.status === 'fulfilled').length, 1);
  for (const result of saved.filter(item => item.status === 'rejected')) assert.equal(result.reason.code, 'PLAN_REVISION_CONFLICT');
  assert.equal((await readPlanFile(workspace, planPath)).revision, 2);
});

test('UX-03: a managed plan already in the project is attached in place, not rewritten', async t => {
  const { service, workspace, planPath } = await setup(t);
  const absolute = path.join(workspace, planPath);
  const before = await fs.stat(absolute);
  const result = await service.importPlan({ taskId: 't-1', path: planPath, commandId: 'inplace' });
  assert.equal(result.needsConfirmation, false);
  assert.equal(result.status.attached, true);
  assert.equal(result.status.path, planPath, 'the canonical project path is used');
  const after = await fs.stat(absolute);
  assert.equal(after.mtimeMs, before.mtimeMs, 'an unchanged file is not copied or rewritten');
  assert.equal(await fs.readFile(absolute, 'utf8'), PLAN);
});

test('UX-03: a repeat upload of identical bytes neither rewrites nor resets the active plan', async t => {
  const { service, workspace, manager } = await setup(t);
  const input = { taskId: 't-1', name: 'PICK.md', contentBase64: base64(PLAN) };
  await service.importPlan({ ...input, commandId: 'pick-1' });
  await service.start({ taskId: 't-1', expectedRevision: 1, commandId: 'pick-start' });
  const before = await fs.stat(path.join(workspace, 'PICK.md'));
  const repeated = await service.importPlan({ ...input, commandId: 'pick-2' });
  assert.equal(repeated.status.state, 'RUNNING_STEP');
  assert.equal(manager.dispatched.length, 1);
  assert.equal((await fs.stat(path.join(workspace, 'PICK.md'))).mtimeMs, before.mtimeMs);
});

test('UX-03: choosing a different file cannot replace the attached plan or write a new file', async t => {
  const { service, workspace, planPath, manager } = await setup(t);
  await service.attach({ taskId: 't-1', path: planPath, commandId: 'old-plan' });
  await assert.rejects(service.importPlan({ taskId: 't-1', name: 'NEW.md', contentBase64: base64(PLAN), commandId: 'new-plan' }),
    error => error.code === 'PLAN_ALREADY_ATTACHED' && error.message.includes(planPath) && error.attachedPath === planPath);
  assert.equal((await service.status('t-1')).path, planPath);
  assert.equal(await fs.stat(path.join(workspace, 'NEW.md')).then(() => true, () => false), false);
  assert.equal(manager.dispatched.length, 0, 'selection and attachment do not start Pi');
});

test('UX-03C: a client-supplied path is never trusted on its own', async t => {
  const { service, workspace, planPath } = await setup(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'PLAN.md'), PLAN, 'utf8');
  const bs = String.fromCharCode(92);

  // Absolute paths of any shape are refused before any filesystem access.
  const forbidden = [
    path.join(outside, 'PLAN.md'),
    `C:${bs}Windows${bs}PLAN.md`,
    `${bs}${bs}server${bs}share${bs}PLAN.md`,
    '/etc/PLAN.md',
    ''
  ];
  for (const bad of forbidden) {
    await assert.rejects(service.importPlan({ taskId: 't-1', path: bad, commandId: `abs-${Math.random()}` }),
      error => error.code === 'PLAN_INVALID', `accepted ${JSON.stringify(bad)}`);
  }

  // Traversal is refused too, and nothing is written next to the workspace.
  await assert.rejects(service.importPlan({ taskId: 't-1', path: '../outside-PLAN.md', commandId: 'trav' }),
    error => error.code === 'PLAN_INVALID');
  assert.equal(await fs.stat(path.join(path.dirname(workspace), 'outside-PLAN.md')).then(() => true, () => false), false);

  // A junction/symlink pointing out of the workspace is refused even though the
  // path itself looks relative and innocent.
  const link = path.join(workspace, 'linked');
  const made = await fs.symlink(outside, link, 'junction').then(() => true, () => false);
  if (made) {
    await assert.rejects(service.importPlan({ taskId: 't-1', path: 'linked/PLAN.md', commandId: 'junction' }),
      error => error.code === 'PLAN_INVALID');
    await assert.rejects(service.attach({ taskId: 't-1', path: 'linked/PLAN.md', commandId: 'junction-attach' }),
      error => error.code === 'PLAN_INVALID');
  }
  // The honest file still works — the checks refuse escapes, not everything.
  const ok = await service.importPlan({ taskId: 't-1', path: planPath, commandId: 'ok' });
  assert.equal(ok.status.attached, true);
});
