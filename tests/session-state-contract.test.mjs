// Контракт состояния сессии (S-002, docs/session-state-contract.md): два
// независимых клиента на одном сервере обязаны видеть одно и то же состояние
// чата и плана, а второй поток событий не должен создавать второй запуск.
//
// Здесь проверяются инварианты I-1…I-5 из документа. Это не UI-тесты: клиенты
// изображаются двумя независимыми HTTP-сессиями с разными clientId — именно так
// сервер их и различает.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-contract
revision: 1
goal: "Контракт состояния: два шага"
---

# План: контракт состояния

## Шаги

### S-001 | TODO | P1 | Первый шаг
**Критерии:** шаг виден обоим клиентам.
**Проверка:** read PLAN.md

### S-002 | TODO | P1 | Второй шаг
**Критерии:** шаг виден обоим клиентам.
**Проверка:** read PLAN.md

## Обнаруженные проблемы
`;

/** Независимый клиент: своё соединение, свой clientId, свой журнал команд. */
function client(fixture, clientId) {
  const call = async (route, body) => {
    const response = await fetch(fixture.base + route, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json', 'x-taskbridge-client': clientId } : {},
      body: body ? JSON.stringify({ ...body, clientId }) : undefined
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(data?.error || 'request failed'), { code: data?.code, status: response.status });
    return data;
  };
  return { clientId, call };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitSettled(call, taskId) {
  for (let index = 0; index < 200; index += 1) {
    const status = (await call(`/api/tasks/${taskId}`)).status;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status)) return status;
    await sleep(100);
  }
  throw new Error('сессия не завершила ход');
}

/** Поля, которые обязаны совпасть у двух клиентов (контракт §1). */
const planShape = plan => ({
  attached: plan.attached,
  state: plan.state,
  path: plan.path,
  revision: plan.revision,
  hash: plan.hash,
  stepId: plan.stepId,
  progress: plan.progress,
  findings: (plan.findings || []).map(finding => finding.id).sort()
});

test('I-1/I-2: two independent clients see the same chat and plan state', { timeout: 90000 }, async t => {
  const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
  t.after(() => fixture.close());
  await fs.writeFile(path.join(fixture.root, 'PLAN.md'), PLAN, 'utf8');

  const phone = client(fixture, 'client-phone');
  const desktop = client(fixture, 'client-desktop');

  const created = await phone.call('/api/tasks', { projectId: 'fixture', prompt: 'контракт состояния' });
  await waitSettled(phone.call, created.id);

  // Привязка плана сделана ОДНИМ клиентом — второй обязан её видеть.
  await phone.call(`/api/tasks/${created.id}/plan/attach`, { path: 'PLAN.md', commandId: 'attach-a' });

  const [taskA, taskB] = await Promise.all([
    desktop.call(`/api/tasks/${created.id}`),
    phone.call(`/api/tasks/${created.id}`)
  ]);
  assert.equal(taskA.status, taskB.status, 'статус одинаков у обоих клиентов');
  assert.equal(taskA.snapshotSeq, taskB.snapshotSeq, 'snapshotSeq одинаков');
  assert.equal(taskA.turnState?.phase ?? null, taskB.turnState?.phase ?? null);

  const [planA, planB] = await Promise.all([
    desktop.call(`/api/tasks/${created.id}/plan`),
    phone.call(`/api/tasks/${created.id}/plan`)
  ]);
  assert.deepEqual(planShape(planA), planShape(planB), 'план одинаков у обоих клиентов');
  assert.equal(planA.attached, true);
  assert.equal(planA.path, 'PLAN.md');
  assert.equal(planA.progress.total, 2);

  // Отключение, сделанное вторым клиентом, обязано быть видно первому.
  await desktop.call(`/api/tasks/${created.id}/plan/detach`, { commandId: 'detach-b' });
  const afterDetach = await phone.call(`/api/tasks/${created.id}/plan`);
  assert.equal(afterDetach.attached, false, 'detach второго клиента виден первому');
  assert.equal(afterDetach.state, 'NOT_ATTACHED');
});

test('I-3: the event log has one monotonic seq sequence for every reader', { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const phone = client(fixture, 'client-phone');
  const desktop = client(fixture, 'client-desktop');

  const created = await phone.call('/api/tasks', { projectId: 'fixture', prompt: 'контракт seq' });
  await waitSettled(phone.call, created.id);
  await desktop.call(`/api/tasks/${created.id}/message`, { text: 'второе сообщение', commandId: 'msg-b' });
  await waitSettled(phone.call, created.id);

  const [fromPhone, fromDesktop] = await Promise.all([
    phone.call(`/api/tasks/${created.id}/events?limit=500`),
    desktop.call(`/api/tasks/${created.id}/events?limit=500`)
  ]);
  const seqsOf = events => (Array.isArray(events) ? events : events.events || []).map(event => event.seq);
  const first = seqsOf(fromPhone);
  const second = seqsOf(fromDesktop);
  assert.deepEqual(first, second, 'оба клиента получают одну и ту же последовательность seq');
  for (let index = 1; index < first.length; index += 1) {
    assert.ok(first[index] > first[index - 1], `seq монотонен: ${first[index - 1]} → ${first[index]}`);
  }
  const tail = await phone.call(`/api/tasks/${created.id}/events?after=${first[first.length - 1]}`);
  assert.deepEqual(seqsOf(tail), [], 'после последнего seq новых событий нет');

  const snapshot = await phone.call(`/api/tasks/${created.id}`);
  assert.ok(snapshot.snapshotSeq >= first[first.length - 1], 'snapshotSeq не отстаёт от журнала');
});

test('I-4: a different store is a different identity, so caches cannot be reused', { timeout: 120000 }, async t => {
  const first = await startFixture();
  const second = await startFixture();
  t.after(() => Promise.all([first.close(), second.close()]));

  const infoA = await first.api('/api/info');
  const infoB = await second.api('/api/info');
  assert.ok(infoA.storeId && infoB.storeId, 'оба сервера публикуют storeId');
  assert.notEqual(infoA.storeId, infoB.storeId, 'у разных баз разный storeId');
  assert.notEqual(infoA.bootId, infoB.bootId, 'у разных процессов разный bootId');
  assert.equal(infoA.apiVersion, infoB.apiVersion, 'версия контракта одна и та же');

  // Рестарт того же сервера: storeId прежний, bootId новый — клиент сбрасывает
  // только курсоры SSE, но не историю.
  const before = await first.api('/api/info');
  await first.restart();
  const after = await first.api('/api/info');
  assert.equal(after.storeId, before.storeId, 'storeId переживает рестарт');
  assert.notEqual(after.bootId, before.bootId, 'bootId меняется при рестарте');
});

test('I-5: a second event stream does not create a second run', { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const phone = client(fixture, 'client-phone');

  const created = await phone.call('/api/tasks', { projectId: 'fixture', prompt: 'контракт одного runner' });
  await waitSettled(phone.call, created.id);
  const runsBefore = (await phone.call(`/api/tasks/${created.id}/runs`)).runs.length;

  // Два независимых SSE-потока на одну задачу, как два открытых клиента.
  const controllers = [new AbortController(), new AbortController()];
  const streams = controllers.map(controller => fetch(`${fixture.base}/api/tasks/${created.id}/events`, {
    headers: { accept: 'text/event-stream' }, signal: controller.signal
  }).catch(() => null));
  await sleep(1500);

  const runsDuring = (await phone.call(`/api/tasks/${created.id}/runs`)).runs.length;
  assert.equal(runsDuring, runsBefore, 'второй поток не запускает новый ход');
  const deliveries = (await fs.readFile(path.join(fixture.root, 'pi-deliveries.ndjson'), 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean);
  const beforeDeliveryCount = deliveries.length;
  await sleep(500);
  const afterDeliveries = (await fs.readFile(path.join(fixture.root, 'pi-deliveries.ndjson'), 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).length;
  assert.equal(afterDeliveries, beforeDeliveryCount, 'открытые потоки не отправляют промптов в Pi');

  for (const controller of controllers) controller.abort();
  await Promise.all(streams);
});
