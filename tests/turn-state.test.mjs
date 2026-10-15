import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';

// Шаг C-A: машина состояний хода QUEUED → DISPATCHING → ACKED → PROGRESS →
// SETTLED/FAILED/CANCELLED. Публикуется лёгким событием TURN_STATE в общей
// ленте (аддитивно: старые клиенты игнорируют неизвестный тип). Терминальный
// TURN_STATE идёт перед TASK_*: потребители, закрывающиеся на TASK_*, должны
// увидеть фазу хода.

const ACTIVE = ['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'VERIFYING', 'CANCELLING'];

async function settle(api, id, { tries = 200, delay = 50 } = {}) {
  let task;
  for (let i = 0; i < tries; i++) {
    task = await api(`/api/tasks/${id}`);
    if (!ACTIVE.includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(`task stayed ${task.status}`);
}

function phases(events, turn = null) {
  return events
    .filter(event => event.type === 'TURN_STATE' && (turn === null || event.data?.turn === turn))
    .map(event => event.data?.phase);
}

// Фаза может не успеть записаться (кадр Pi опередил ACK), но откатываться назад
// она не должна: клиент не может снова увидеть «ждём первый кадр» после ответа.
const RANK = { DISPATCHING: 1, ACKED: 2, PROGRESS: 3, SETTLED: 4, FAILED: 4, CANCELLED: 4 };

function assertMonotonic(list) {
  const ranks = list.map(phase => RANK[phase]);
  assert.ok(ranks.every(rank => rank !== undefined), `unknown phase in ${list.join('→')}`);
  for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i] >= ranks[i - 1], `phase went back: ${list.join('→')}`);
}

test('a completed turn publishes DISPATCHING→ACKED→PROGRESS→SETTLED before TASK_SUCCEEDED', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'turn-state' });
  const done = await settle(api, task.id);
  assert.equal(done.status, 'SUCCEEDED', done.error || '');

  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  const list = phases(events, 1);
  assert.equal(list[0], 'DISPATCHING');
  assert.equal(list.at(-1), 'SETTLED');
  assertMonotonic(list);
  const succeededIdx = events.findIndex(event => event.type === 'TASK_SUCCEEDED');
  const settledIdx = events.findIndex(event => event.type === 'TURN_STATE' && event.data?.phase === 'SETTLED');
  assert.ok(settledIdx !== -1 && settledIdx < succeededIdx, 'SETTLED must precede TASK_SUCCEEDED');

  // Снимок: фаза терминальная, тишина не сообщается.
  assert.equal(done.turnState.phase, 'SETTLED');
  assert.equal(done.turnState.turn, 1);
  assert.equal(done.turnState.silentMs, null);
});

test('a follow-up starts a new turn with its own phases', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'turn-state-follow-up' });
  await settle(api, task.id);
  await api(`/api/tasks/${task.id}/message`, { text: 'continue' });
  const done = await settle(api, task.id);
  assert.equal(done.status, 'SUCCEEDED', done.error || '');

  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  const list = phases(events, 2);
  assert.equal(list[0], 'DISPATCHING');
  assert.equal(list.at(-1), 'SETTLED');
  assertMonotonic(list);
  assert.equal(done.turnState.turn, 2);
});

test('snapshotSeq versions the task snapshot by its last event (C-B)', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'snapshot-seq' });
  const done = await settle(api, task.id);
  assert.equal(done.status, 'SUCCEEDED', done.error || '');

  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  const lastSeq = events.at(-1).seq;
  // Версия снимка = seq последнего события сессии: по ней клиент отличает
  // свежие метаданные от ответа, прочитанного до более нового события.
  assert.equal(done.snapshotSeq, lastSeq);

  // Новое событие поднимает версию: старый ответ становится отличимым.
  await api(`/api/tasks/${task.id}/message`, { text: 'continue' });
  const again = await settle(api, task.id);
  const events2 = await api(`/api/tasks/${task.id}/events?limit=0`);
  assert.ok(again.snapshotSeq > done.snapshotSeq, `${again.snapshotSeq} > ${done.snapshotSeq}`);
  assert.equal(again.snapshotSeq, events2.at(-1).seq);
});

test('STOP publishes CANCELLED for the stopped turn', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-hang turn-state-stop' });
  await new Promise(resolve => setTimeout(resolve, 1500));
  await api(`/api/tasks/${task.id}/cancel`, {});
  const done = await settle(api, task.id);
  assert.equal(done.status, 'CANCELLED', done.error || fixture.logs());

  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  const cancelIdx = events.findIndex(event => event.type === 'TASK_CANCELLED');
  const cancelledIdx = events.findIndex(event => event.type === 'TURN_STATE' && event.data?.phase === 'CANCELLED');
  assert.ok(cancelledIdx !== -1 && cancelledIdx < cancelIdx, 'CANCELLED must precede TASK_CANCELLED');
});
