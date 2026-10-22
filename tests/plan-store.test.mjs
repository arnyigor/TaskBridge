// FP-01 (part 2): runtime binding для Follow Plan — только техсостояние цикла.
//
// Содержимое плана живёт в Markdown-файле (tests/plan-file.test.mjs). Здесь
// проверяется то, что должно пережить перезапуск сервера: привязка сессии к
// файлу, ревизия/хэш на момент выдачи хода, dispatch intent, lease и счётчик
// отмены (STOP), по которому поздний checkpoint распознаётся как устаревший.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';

const tempRoot = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-plan-store-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
};

const binding = (overrides = {}) => ({
  taskId: 't-1',
  planId: 'p-uuid',
  path: 'docs/IMPLEMENTATION_PLAN.md',
  revision: 7,
  hash: 'a'.repeat(64),
  state: 'IDLE',
  cycleId: 'c-12',
  expectedRevision: 7,
  expectedHash: 'a'.repeat(64),
  dispatchCommandId: 'cmd-1',
  dispatchStepId: 'S-003',
  leaseUntil: 1_700_000_000_000,
  settledSeq: 42,
  budget: { cycles: 3, noProgress: 2 },
  ...overrides
});

test('the binding keeps only runtime state and round-trips through SQLite', async t => {
  const store = new TaskStore(await tempRoot(t));
  assert.equal(store.getPlanBinding('t-1'), null);

  store.savePlanBinding(binding());
  const read = store.getPlanBinding('t-1');
  assert.equal(read.planId, 'p-uuid');
  assert.equal(read.path, 'docs/IMPLEMENTATION_PLAN.md');
  assert.equal(read.revision, 7);
  assert.equal(read.hash, 'a'.repeat(64));
  assert.equal(read.state, 'IDLE');
  assert.equal(read.cycleId, 'c-12');
  assert.equal(read.expectedRevision, 7);
  assert.equal(read.dispatchCommandId, 'cmd-1');
  assert.equal(read.dispatchStepId, 'S-003');
  assert.equal(read.settledSeq, 42);
  assert.deepEqual(read.budget, { cycles: 3, noProgress: 2 });
  assert.ok(read.updatedAt);

  // Upsert by task: one active binding per session/task.
  store.savePlanBinding(binding({ revision: 8, state: 'RUNNING_STEP', cycleId: 'c-13' }));
  assert.equal(store.getPlanBinding('t-1').revision, 8);
  assert.equal(store.getPlanBinding('t-1').state, 'RUNNING_STEP');
  assert.equal(store.deletePlanBinding('t-1'), 1);
  assert.equal(store.getPlanBinding('t-1'), null);
  store.close?.();
});

test('the cancel epoch grows monotonically and survives a restart', async t => {
  const root = await tempRoot(t);
  const store = new TaskStore(root);
  store.savePlanBinding(binding());

  const first = store.bumpPlanCancelEpoch('t-1');
  const second = store.bumpPlanCancelEpoch('t-1');
  assert.equal(first, 1);
  assert.equal(second, 2);
  // STOP marks the cycle as needing review instead of leaving it running.
  assert.equal(store.planCancelEpoch('t-1'), 2, 'the epoch is durable and separate from the binding');
  store.close?.();

  const reopened = new TaskStore(root);
  assert.equal(reopened.planCancelEpoch('t-1'), 2, 'a late checkpoint from epoch 1 is still stale after a restart');
  assert.equal(reopened.getPlanBinding('t-1').state, 'IDLE', 'bumping the epoch does not invent a state transition');
  assert.equal(reopened.bumpPlanCancelEpoch('t-1'), 3);
  reopened.close?.();
});

test('a STOP before the first attach still creates a recognisable epoch', async t => {
  const store = new TaskStore(await tempRoot(t));
  assert.equal(store.getPlanBinding('t-2'), null);
  assert.equal(store.bumpPlanCancelEpoch('t-2'), 1);
  assert.equal(store.planCancelEpoch('t-2'), 1);
  assert.equal(store.getPlanBinding('t-2'), null, 'no placeholder binding is created');
  store.close?.();
});
