import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const action = source.slice(source.indexOf('async function runPlanAction('), source.indexOf('\nasync function detachPlan(', source.indexOf('async function runPlanAction(')));

function harness(confirmed) {
  const sent = [];
  const prompts = [];
  const context = vm.createContext({
    selectedTaskId: 'task', planNotice: '',
    planErrorText: error => error.message,
    confirm: message => { prompts.push(message); return confirmed; },
    planSend: async (name, extra) => {
      sent.push({ name, extra });
      if (sent.length === 1) throw Object.assign(new Error('Time budget exhausted'), { code: 'PLAN_BUDGET_EXCEEDED' });
    },
    loadPlanStatus: async () => {},
  });
  vm.runInContext(action, context);
  return { context, sent, prompts };
}

test('Web resume asks before renewing time and sends the opt-in only after confirmation', async () => {
  const { context, sent, prompts } = harness(true);
  await context.runPlanAction('resume');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].extra, undefined);
  assert.equal(sent[1].extra.renewBudget, true);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /общий счётчик сохранятся/);
  assert.equal(context.planNotice, '');
});

test('declining renewal keeps the plan paused and shows why resume failed', async () => {
  const { context, sent } = harness(false);
  await context.runPlanAction('resume');
  assert.equal(sent.length, 1);
  assert.equal(context.planNotice, 'Time budget exhausted');
});

test('renewal rejection is displayed without an infinite confirmation loop', async () => {
  const { context, prompts } = harness(true);
  context.planSend = async () => { throw Object.assign(new Error('Cycle budget exhausted'), { code: 'PLAN_BUDGET_EXCEEDED' }); };
  await context.runPlanAction('resume');
  assert.equal(prompts.length, 1);
  assert.equal(context.planNotice, 'Cycle budget exhausted');
});

test('no-progress pause never offers the irrelevant time/cycle renewal dialog', async () => {
  const { context, prompts } = harness(true);
  context.planSend = async () => { throw Object.assign(new Error('No progress for three cycles'), { code: 'PLAN_NO_PROGRESS' }); };
  await context.runPlanAction('resume');
  assert.equal(prompts.length, 0);
  assert.equal(context.planNotice, 'No progress for three cycles');
});
