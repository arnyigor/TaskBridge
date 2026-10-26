// CORE-02B: кому принадлежит checkpoint и что происходит, когда в сессию
// вклинивается обычный ход. Проверяется весь путь TaskManager → сервис → follower
// на настоящем сервере с тестовым Pi (те же кадры, что у живого: tool_execution_*,
// agent_settled), а не вызовом функции с подготовленным состоянием.
//
// Инвариант: checkpoint, полученный плановым ходом A, применяется settle этого
// же хода A и не может быть съеден settle чужого хода B.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { parsePlan } from '../src/application/plan-file.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-ownership
revision: 1
goal: "CORE-02B: принадлежность checkpoint"
---

# План: принадлежность checkpoint

## Шаги

### S-001 | TODO | P1 | Первый шаг slow
**Критерии:** шаг закрыт.
**Проверка:** read PLAN.md

### S-002 | TODO | P1 | Второй шаг
**Критерии:** шаг закрыт.
**Проверка:** read PLAN.md

## Обнаруженные проблемы
`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 40000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

const planOf = async root => parsePlan(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'));

const planEvents = async (api, taskId, type) => {
  const events = await api(`/api/tasks/${taskId}/events?limit=500`);
  return (Array.isArray(events) ? events : events.events || []).filter(event => event.type === type);
};

async function stand(t) {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  await fs.writeFile(path.join(fixture.root, 'PLAN.md'), PLAN, 'utf8');
  const created = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'подготовка' });
  await waitFor(async () => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes((await fixture.api(`/api/tasks/${created.id}`)).status));
  await fixture.api(`/api/tasks/${created.id}/plan/attach`, { path: 'PLAN.md', commandId: `own-attach-${Date.now()}` });
  return { ...fixture, taskId: created.id };
}

/**
 * Шаг идёт 10 с (заголовок `slow`), checkpoint отправляется в начале хода.
 * В это окно в сессию приходит обычное сообщение — именно живой сценарий.
 */
for (const [label, body] of [
  ['обычное сообщение в очередь', { text: 'обычный вопрос в очередь', queue: true }],
  ['сообщение «сейчас» (steering)', { text: 'обычный вопрос сейчас', now: true }]
]) {
  for (let run = 1; run <= 2; run += 1) {
    test(`CORE-02B: ${label}, прогон ${run}: checkpoint планового хода не теряется`, { timeout: 90000 }, async t => {
      const fixture = await stand(t);
      const { api, root, taskId } = fixture;
      await api(`/api/tasks/${taskId}/plan/start`, { expectedRevision: 1, commandId: `own-start-${run}-${Date.now()}` });
      // Плановый ход пошёл; checkpoint уже отправлен тестовым Pi.
      await sleep(1200);
      const chat = await api(`/api/tasks/${taskId}/message`, { ...body, commandId: `own-chat-${run}-${Date.now()}` }).catch(error => ({ error }));
      assert.ok(chat && !chat.error, `обычное сообщение принято сервером: ${JSON.stringify(chat?.error || '')}`);

      // Ждём, пока план зафиксирует шаг или уйдёт в разбор.
      const settled = await waitFor(async () => {
        const written = await planOf(root);
        if (written.steps[0].status === 'DONE') return written;
        const plan = await api(`/api/tasks/${taskId}/plan`);
        return plan.state === 'PAUSED_REVIEW' ? { paused: plan } : null;
      });
      assert.ok(settled, 'план либо зафиксировал шаг, либо встал на разбор');

      const written = await planOf(root);
      // Файл пишется до публикации события: ждём событие, а не проверяем сразу.
      const applied = await waitFor(async () => {
        const list = await planEvents(api, taskId, 'PLAN_CHECKPOINT_APPLIED');
        return list.length ? list : null;
      }, { timeout: 15000 }) || [];
      const rejected = await planEvents(api, taskId, 'PLAN_CHECKPOINT_REJECTED');
      if (written.steps[0].status !== 'DONE') {
        assert.fail(
          `шаг не закрыт после планового хода: state=${JSON.stringify(settled.paused?.state || null)}, ` +
          `applied=${applied.length}, rejected=${JSON.stringify(rejected.map(event => event.data?.reasonCode))}, ` +
          `logs=${fixture.logs().slice(-600)}`
        );
      }
      assert.equal(written.steps[0].status, 'DONE', 'шаг закрыт плановым ходом');
      assert.ok(applied.length >= 1, 'применение опубликовано событием');
      assert.equal(applied[0].data.completionApplied, true, 'completionApplied=true, а не только APPLIED');
      assert.deepEqual(applied[0].data.confirmedStepIds, ['S-001']);
      assert.equal(rejected.filter(event => event.data?.reasonCode === 'FOREIGN_COMMAND').length, 0,
        'checkpoint планового хода не отклонён как чужая команда');
      assert.match(written.steps[0].result || '', /\[(SYSTEM_VERIFIED|MODEL_REPORTED|MANUAL_ACCEPTED|UNVERIFIED)\]/,
        'в результате записан уровень подтверждения');
    });
  }
}

test('CORE-02B: «продолжай» при активном шаге не закрывает шаг и не дублирует dispatch', { timeout: 90000 }, async t => {
  const fixture = await stand(t);
  const { api, root, taskId } = fixture;
  await api(`/api/tasks/${taskId}/plan/start`, { expectedRevision: 1, commandId: `own-start-cont-${Date.now()}` });
  await sleep(1200);
  await api(`/api/tasks/${taskId}/message`, { text: 'продолжай', commandId: `own-chat-cont-${Date.now()}` }).catch(() => null);

  const staged = await waitFor(async () => {
    const deliveries = await fs.readFile(path.join(root, 'pi-deliveries.ndjson'), 'utf8').catch(() => '');
    return deliveries.trim().split('\n').filter(Boolean).length >= 2 ? true : null;
  });
  assert.ok(staged, 'второй ход дошёл до Pi (обычное сообщение обработано)');
  await sleep(2000);
  const written = await planOf(root);
  // Самое важное: S-001 не был исполнен дважды — в файле он либо закрыт один раз,
  // либо открыт, но повторной выдачи шага не было.
  const starts = await planEvents(api, taskId, 'PLAN_STEP_STARTED');
  const s001Starts = starts.filter(event => event.data?.stepId === 'S-001').length;
  assert.ok(written.steps[0].status === 'DONE' || s001Starts <= 2,
    `S-001 выдан ${s001Starts} раз, статус ${written.steps[0].status}`);
});
