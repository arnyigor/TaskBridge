// CORE-03/04: применение ровно один раз и согласование binding ↔ Markdown.
//
// CORE-03: повторный settle (в том числе после рестарта сервера) не должен
// применять одно и то же завершение дважды; атрибуция записи не должна
// переезжать из одного цикла в другой.
// CORE-04: после успешной записи binding обязан совпадать с файлом (revision/hash),
// иначе следующая проверка даёт ложный REVISION_CONFLICT.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { parsePlan, serializePlan, applyChanges, planHash } from '../src/application/plan-file.mjs';
import { PlanFollower } from '../src/application/plan-follower.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-exactly-once
revision: 1
goal: "CORE-03/04: ровно один раз"
---

# План: ровно один раз

## Шаги

### S-001 | TODO | P1 | Первый шаг
**Критерии:** шаг закрыт.
**Проверка:** read PLAN.md

### S-002 | TODO | P1 | Второй шаг
**Критерии:** шаг закрыт.
**Проверка:** read PLAN.md

## Обнаруженные проблемы
`;

function fakePlans(initial = PLAN) {
  const state = { text: initial, writes: 0 };
  return {
    state,
    async read() {
      return { plan: parsePlan(state.text), hash: planHash(state.text), realPath: 'PLAN.md' };
    },
    async update({ expectedRevision, expectedHash, changes }) {
      if (expectedHash && expectedHash !== planHash(state.text)) {
        throw Object.assign(new Error('conflict'), { code: 'PLAN_REVISION_CONFLICT' });
      }
      const plan = parsePlan(state.text);
      if (expectedRevision != null && plan.revision !== expectedRevision) {
        throw Object.assign(new Error('conflict'), { code: 'PLAN_REVISION_CONFLICT' });
      }
      const next = applyChanges(plan, changes);
      next.revision = plan.revision + 1;
      state.text = serializePlan(next);
      state.writes += 1;
      return { plan: next, hash: planHash(state.text), text: state.text };
    }
  };
}

const setup = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-once-'));
  const store = new TaskStore(dir);
  t.after(async () => {
    store.close?.();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  const plans = fakePlans();
  const dispatched = [];
  const makeFollower = () => new PlanFollower({
    store,
    plans,
    dispatch: async input => { dispatched.push(input); return { id: input.commandId }; },
    cancel: async () => {}
  });
  const follower = makeFollower();
  await follower.attach({ taskId: 't-1', path: 'PLAN.md' });
  return { store, plans, dispatched, follower, makeFollower };
};

const settle = (store, { commandId, completedStepIds = [], evidenceRef = 'call-1', cycleId = null, revision = null } = {}) => {
  const binding = store.getPlanBinding('t-1');
  return {
    taskId: 't-1',
    commandId: commandId ?? binding.dispatchCommandId,
    checkpoint: {
      planId: 'p-exactly-once',
      revision: revision ?? binding.expectedRevision,
      cycleId: cycleId ?? binding.cycleId,
      decision: 'CONTINUE',
      completedStepIds,
      findings: [],
      evidence: completedStepIds.map(stepId => ({ stepId, kind: 'command', ref: evidenceRef, summary: 'тест зелёный' }))
    }
  };
};


/** Сервис с настоящим workspace: нужен для чтения/записи файлов проекта. */
async function discovery(t) {
  const { FollowPlanService } = await import('../src/follow-plan-service.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-fp-repair-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });
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
  return { root, workspace, store, service };
}

test('CORE-03: повторный settle после рестарта не применяет завершение второй раз', async t => {
  const { store, plans, follower, makeFollower } = await setup(t);
  const start = await follower.start({ taskId: 't-1', commandId: 'cmd-start' });
  const args = settle(store, { completedStepIds: ['S-001'] });
  const first = await follower.onSettled(args);
  assert.equal(first.outcome, 'APPLIED');
  const revisionAfterFirst = parsePlan(plans.state.text).revision;
  assert.equal(revisionAfterFirst, 2);
  assert.equal(plans.state.writes, 1);

  // «Рестарт»: новый экземпляр follower, пустая память (settledTurns, lastApply).
  const restarted = makeFollower();
  const duplicate = await restarted.onSettled(args);

  assert.notEqual(duplicate.outcome, 'APPLIED', 'повтор не считается применением');
  assert.equal(parsePlan(plans.state.text).revision, revisionAfterFirst, 'файл не переписан повторно');
  assert.equal(plans.state.writes, 1, 'ровно одна запись за всё время');
  assert.equal(parsePlan(plans.state.text).steps[0].status, 'DONE');
  assert.equal(start.commandId, args.commandId, 'санитарная проверка: settle относится к выданному ходу');
});

test('CORE-03: атрибуция записи не переезжает из одного шага в другой', async t => {
  const { store, follower } = await setup(t);
  await follower.start({ taskId: 't-1', commandId: 'cmd-start' });
  const first = await follower.onSettled(settle(store, { completedStepIds: ['S-001'] }));
  assert.deepEqual(first.appliedStepIds, ['S-001']);
  // Ход S-002 (подготовлен предыдущим settle).
  const second = await follower.onSettled(settle(store, { completedStepIds: ['S-002'] }));
  assert.deepEqual(second.appliedStepIds, ['S-002'], 'во второй записи только S-002');
  assert.deepEqual(second.confirmedStepIds, ['S-002']);
  assert.equal(second.completionApplied, true);
});

test('CORE-04: после записи binding совпадает с файлом', async t => {
  const { store, plans, follower } = await setup(t);
  await follower.start({ taskId: 't-1', commandId: 'cmd-start' });
  await follower.onSettled(settle(store, { completedStepIds: ['S-001'] }));

  const binding = store.getPlanBinding('t-1');
  const file = parsePlan(plans.state.text);
  const hash = planHash(plans.state.text);
  // То, что проверяет следующая запись: ожидание должно указывать на текущий файл.
  assert.equal(binding.expectedRevision, file.revision, `expectedRevision ${binding.expectedRevision} ≠ ${file.revision}`);
  assert.equal(binding.expectedHash, hash, 'expectedHash совпадает с файлом');

  // И следующее завершение не падает на ложном конфликте.
  const second = await follower.onSettled(settle(store, { completedStepIds: ['S-002'] }));
  assert.notEqual(second.code, 'PLAN_REVISION_CONFLICT', `ложный конфликт: ${second.message}`);
  assert.equal(second.outcome, 'APPLIED');
});

test('CORE-04: инструкция шага запрещает агенту править файл плана', async t => {
  const { stepInstruction } = await import('../src/application/plan-follower.mjs');
  const instruction = stepInstruction({ path: 'PLAN.md', planId: 'p-x', revision: 1, cycleId: 'c-1', stepId: 'S-001' });
  // Живой прогон 2026-10-26: edit по PLAN.md развёл хэш с ожидаемым, и settle
  // получил REVISION_CONFLICT. Инструкция должна прямо запрещать такую правку.
  assert.match(instruction, /PLAN\.md/);
  assert.match(instruction, /не редактируй|не переписывай/i, 'запрет правки файла плана сформулирован');
  assert.match(instruction, /taskbridge_plan_checkpoint/, 'изменения передаются через checkpoint');
});

// --- «Исправить формат»: чтение и сохранение выбранного файла -----------------

test('исправление формата: невалидный текст не пишется, исходник цел', async t => {
  const { root, workspace, service } = await discovery(t);
  await fs.writeFile(path.join(workspace, 'docs', 'NOTES.md'), '# Просто заметки\n', 'utf8');
  const read = await service.readFile({ taskId: 't-1', path: 'docs/NOTES.md' });
  assert.equal(read.text, '# Просто заметки\n');
  assert.ok(read.hash);

  await assert.rejects(
    service.saveFile({ taskId: 't-1', path: 'docs/NOTES.md', content: '# Всё ещё заметки\n', expectedHash: read.hash, overwrite: true }),
    error => error.code === 'PLAN_INVALID'
  );
  assert.equal(await fs.readFile(path.join(workspace, 'docs', 'NOTES.md'), 'utf8'), '# Просто заметки\n', 'исходник не тронут');
  assert.ok(root);
});

test('исправление формата: валидный текст сохраняется с CAS, чужой хэш отклоняется', async t => {
  const { workspace, service } = await discovery(t);
  await fs.writeFile(path.join(workspace, 'docs', 'NOTES.md'), '# Просто заметки\n', 'utf8');
  const read = await service.readFile({ taskId: 't-1', path: 'docs/NOTES.md' });
  const fixed = PLAN;

  // Чужой (устаревший) хэш: файл изменился после открытия — отказ.
  await assert.rejects(
    service.saveFile({ taskId: 't-1', path: 'docs/NOTES.md', content: fixed, expectedHash: 'deadbeef', overwrite: true }),
    error => error.code === 'PLAN_REVISION_CONFLICT'
  );

  const saved = await service.saveFile({ taskId: 't-1', path: 'docs/NOTES.md', content: fixed, expectedHash: read.hash, overwrite: true });
  assert.equal(saved.verdict, 'VALID_MANAGED');
  assert.equal(saved.revision, 1);
  assert.equal(await fs.readFile(path.join(workspace, 'docs', 'NOTES.md'), 'utf8'), fixed);

  // И теперь файл подключается обычным путём с тем же хэшем.
  const attached = await service.importPlan({ taskId: 't-1', path: 'docs/NOTES.md', expectedHash: saved.hash, commandId: 'attach-fixed' });
  assert.equal(attached.status.attached, true);
  assert.equal(attached.status.path, 'docs/NOTES.md');
});

test('исправление формата: чужой файл без подтверждения не перезаписывается', async t => {
  const { workspace, service } = await discovery(t);
  await fs.writeFile(path.join(workspace, 'docs', 'NOTES.md'), '# Просто заметки\n', 'utf8');
  await assert.rejects(
    service.saveFile({ taskId: 't-1', path: 'docs/NOTES.md', content: PLAN, expectedHash: null, overwrite: false }),
    error => error.code === 'PLAN_FILE_EXISTS'
  );
  assert.equal(await fs.readFile(path.join(workspace, 'docs', 'NOTES.md'), 'utf8'), '# Просто заметки\n');
});
