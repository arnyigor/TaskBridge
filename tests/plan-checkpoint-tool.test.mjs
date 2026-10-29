// FP-02: сам checkpoint-инструмент, без Pi и без модели.
//
// Проверяется то, что решает TaskBridge: схема аргументов (Pi валидирует её до
// execute), запись checkpoint в журнал и то, что инструмент ничего не решает —
// вердикт по COMPLETE выносит src/application/plan-checkpoint.mjs после settled.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import followPlanExtension, { CHECKPOINT_PARAMETERS, CHECKPOINT_DECISIONS, normalizeCheckpoint } from '../pi-extension/taskbridge-follow-plan.js';
import { CHECKPOINT_DECISIONS as CONTROLLER_DECISIONS } from '../src/application/plan-checkpoint.mjs';
import { planRevision } from '../src/application/plan-revision.mjs';

function fakePi() {
  const tools = new Map();
  return {
    tools,
    pi: { registerTool(tool) { tools.set(tool.name, tool); }, on() { return () => {}; } }
  };
}

test('the tool registers with the decisions the controller understands', () => {
  const { pi, tools } = fakePi();
  followPlanExtension(pi);
  const tool = tools.get('taskbridge_plan_checkpoint');
  assert.ok(tool, 'the tool is registered under the documented name');
  assert.equal(tool.parameters, CHECKPOINT_PARAMETERS);
  assert.deepEqual(CHECKPOINT_PARAMETERS.properties.decision.enum, CHECKPOINT_DECISIONS);
  assert.deepEqual(CHECKPOINT_DECISIONS, [...CONTROLLER_DECISIONS], 'tool and controller must not drift apart');
  assert.deepEqual(CHECKPOINT_PARAMETERS.required, ['planId', 'revision', 'cycleId', 'decision']);
  assert.equal(CHECKPOINT_PARAMETERS.additionalProperties, false, 'undeclared fields are refused by Pi, not silently kept');
});

test('the call is appended to the log and the answer does not claim a verdict', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-plan-tool-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'checkpoints.ndjson');
  const previous = process.env.TASKBRIDGE_PLAN_CHECKPOINT_LOG;
  process.env.TASKBRIDGE_PLAN_CHECKPOINT_LOG = log;
  t.after(() => {
    if (previous === undefined) delete process.env.TASKBRIDGE_PLAN_CHECKPOINT_LOG;
    else process.env.TASKBRIDGE_PLAN_CHECKPOINT_LOG = previous;
  });

  const { pi, tools } = fakePi();
  followPlanExtension(pi);
  const result = await tools.get('taskbridge_plan_checkpoint').execute('call-1', {
    planId: 'p-fp02', revision: 4, cycleId: 'c-12', decision: 'COMPLETE',
    completedStepIds: ['S-002'], evidence: [{ stepId: 'S-002', kind: 'test', ref: 'run-123', summary: '29/29 pass' }]
  });

  assert.match(result.content[0].text, /Checkpoint received: COMPLETE/);
  assert.match(result.content[0].text, /not decided here/);
  assert.deepEqual(result.details, { decision: 'COMPLETE', completed: ['S-002'], findings: 0 });

  const lines = (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].planId, 'p-fp02');
  assert.equal(lines[0].decision, 'COMPLETE');
  assert.equal(lines[0].evidence[0].ref, 'run-123');
  await tools.get('taskbridge_plan_checkpoint').execute('call-2', { planId: 'p-fp02', revision: 4, cycleId: 'c-12', decision: 'CONTINUE', completedStepIds: ['S-002'] });
  assert.equal((await fs.readFile(log, 'utf8')).trim().split('\n').length, 2, 'one line per call, appended');
});

test('a proposed plan edit declares the fields the controller demands', () => {
  // Живой прогон 2026-10-29: схема была items:{type:'object'}, модель прислала
  // {op, priority, title, body}, plan-revision отказал без criteria/verification,
  // и шаг пропал молча. Схема обязана называть те же поля, что проверяет контроллер.
  const items = CHECKPOINT_PARAMETERS.properties.proposedChanges.items;
  assert.equal(items.additionalProperties, false, 'неизвестное поле (body) отклоняет Pi, а не тихий отказ');
  for (const field of ['op', 'stepId', 'priority', 'title', 'criteria', 'verification']) {
    assert.ok(items.required.includes(field), `${field} required`);
    assert.ok(items.properties[field], `${field} described`);
  }
  assert.deepEqual(items.properties.op.enum, ['add_step', 'insert_after'], 'only the ops the controller applies');

  const plan = {
    schema: 1, planId: 'p-fp02', revision: 4, goal: 'g', findings: [],
    steps: [
      { id: 'S-001', status: 'DONE', title: 'a', criteria: 'c', verification: 'v' },
      { id: 'S-002', status: 'TODO', title: 'b', criteria: 'c', verification: 'v' }
    ]
  };
  const proposal = { op: 'add_step', stepId: 'S-003', priority: 'P1', title: 'в-третьих', criteria: 'критерий', verification: 'проверка', before: 'S-002' };
  const revision = planRevision({ plan, findings: [], proposals: [proposal], currentStepId: 'S-002' });
  assert.equal(revision.added.length, 1, 'предложение из схемы действительно принимается');
  assert.deepEqual(revision.rejected, []);
});

test('normalisation keeps the fields the controller validates and invents nothing', () => {
  const checkpoint = normalizeCheckpoint({ planId: 'p-1', revision: '5', decision: 'CONTINUE' }, 1700000000000);
  assert.equal(checkpoint.revision, 5);
  assert.equal(checkpoint.cycleId, '', 'a missing cycleId stays empty and fails validation instead of being guessed');
  assert.deepEqual(checkpoint.completedStepIds, []);
  assert.deepEqual(checkpoint.evidence, []);
  assert.equal(checkpoint.nextStepId, null);
  assert.equal(checkpoint.receivedAt, 1700000000000);
});
