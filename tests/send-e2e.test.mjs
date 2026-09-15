import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';

// End-to-end checks over the real HTTP API for everything the operator does with
// a message: send, queue, "send now", keep the order, and the per-message
// actions (regenerate, continue, edit, delete, fork, repeat). The fixture starts
// a real server with a fake Pi (tests/fake-pi.mjs), so these see the same
// events, statuses and seq cursors the browser does.

async function terminal(api, id, { tries = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Задача ${id} не завершилась`);
}

async function waitFor(check, what, { tries = 300 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Не дождались: ${what}`);
}

const eventsOf = async (api, id) => api(`/api/tasks/${id}/events?limit=0`);
const userTexts = (events) => events.filter(e => e.type === 'USER_MESSAGE').map(e => e.data?.text);
const answers = (events) => events.filter(e => e.type === 'PI_EVENT' && e.data?.pi?.type === 'message_end' && e.data.pi.message?.role === 'assistant')
  .map(e => (e.data.pi.message.content || []).filter(p => p.type === 'text').map(p => p.text).join(''));

test('two follow-ups keep their order and each gets its own answer', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первый' });
  assert.equal((await terminal(api, created.id)).status, 'SUCCEEDED', fixture.logs());

  await api(`/api/tasks/${created.id}/message`, { text: 'второе' });
  await terminal(api, created.id);
  await api(`/api/tasks/${created.id}/message`, { text: 'третье' });
  await terminal(api, created.id);

  const events = await eventsOf(api, created.id);
  assert.deepEqual(userTexts(events), ['второе', 'третье'], 'сообщения в порядке отправки, без дублей');
  const seqs = events.filter(e => e.type === 'USER_MESSAGE').map(e => e.seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, 'курсор событий монотонный');
  assert.deepEqual(answers(events).length >= 3, true, 'на каждый вопрос есть ответ');
});

test('a second message typed during a running answer still arrives, in order', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'старт' });
  await terminal(api, created.id);

  // 'slow' makes the fixture answer take 10s, so the second send lands mid-turn.
  await api(`/api/tasks/${created.id}/message`, { text: 'slow раз' });
  await waitFor(async () => (await api(`/api/tasks/${created.id}`)).status === 'RUNNING', 'первый ответ начался');
  await api(`/api/tasks/${created.id}/message`, { text: 'второе во время ответа' });

  await waitFor(async () => {
    const events = await eventsOf(api, created.id);
    return userTexts(events).includes('второе во время ответа');
  }, 'второе сообщение доставлено');
  const events = await eventsOf(api, created.id);
  assert.deepEqual(userTexts(events), ['slow раз', 'второе во время ответа'], 'порядок сохранён');
  const task = await api(`/api/tasks/${created.id}`);
  assert.notEqual(task.status, 'QUEUED', `статус не залипает в очереди: ${task.status}`);
});

test('a queued follow-up waits for the running answer instead of cutting into it', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'старт' });
  await terminal(api, created.id);

  await api(`/api/tasks/${created.id}/message`, { text: 'slow ответ' });
  await waitFor(async () => (await api(`/api/tasks/${created.id}`)).status === 'RUNNING', 'ответ начался');
  const parked = await api(`/api/tasks/${created.id}/message`, { text: 'должно подождать', queue: true });
  assert.deepEqual((parked.pendingPrompts || []).map(p => p.text), ['должно подождать'], 'текст лежит в очереди');
  // The session that owns the slot keeps RUNNING: it is the one generating. The
  // waiting itself is visible as the queued prompt (the «В очереди» badge is
  // built from pendingPrompts), not as a status flip.
  assert.equal(parked.status, 'RUNNING', `генерация хозяина слота не прерывается: ${parked.status}`);

  // While the answer is still streaming the queued text must not cut into it.
  await new Promise(resolve => setTimeout(resolve, 1500));
  const during = await eventsOf(api, created.id);
  assert.equal(userTexts(during).includes('должно подождать'), false, 'очередь не вклинивается в текущий ответ');
  assert.deepEqual((await api(`/api/tasks/${created.id}`)).pendingPrompts.map(p => p.text), ['должно подождать'],
    'сообщение всё ещё ждёт — очередь не опустела в ту же секунду');

  // Once the turn ends, the queue delivers it as its own turn.
  await waitFor(async () => {
    const events = await eventsOf(api, created.id).catch(() => []);
    return userTexts(events).includes('должно подождать');
  }, 'сообщение из очереди доставлено', { tries: 800 });
  assert.deepEqual((await api(`/api/tasks/${created.id}`)).pendingPrompts, [], 'очередь опустела после доставки');
});

test('a message sent while another session owns the model waits in the queue and is delivered later', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const busy = await api('/api/tasks', { projectId: 'fixture', prompt: 'slow держит машину' });
  await waitFor(async () => (await api(`/api/tasks/${busy.id}`)).status === 'RUNNING', 'первая сессия работает');

  const second = await api('/api/tasks', { projectId: 'fixture', prompt: 'ждёт очереди' });
  const queued = await api(`/api/tasks/${second.id}`);
  assert.equal(queued.status, 'QUEUED', `вторая сессия ждёт: ${queued.status}`);
  assert.equal(queued.prompt, 'ждёт очереди', 'текст сохранён в самой сессии, а не потерян');
  assert.ok(queued.queueReason, `причина очереди названа: ${queued.queueReason}`);

  // The queue drains by itself once the machine frees up: its own prompt is
  // delivered then (a new session's first message lives in task.prompt, only
  // follow-ups wait in pendingPrompts).
  await waitFor(async () => (await api(`/api/tasks/${second.id}`)).status === 'RUNNING'
    || (await api(`/api/tasks/${second.id}`)).status === 'SUCCEEDED', 'сессия из очереди запущена', { tries: 600 });
});

test('a queued follow-up waits, and «Отправить сейчас» never errors on an empty queue', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  // A settled session whose follow-up can be parked…
  const target = await api('/api/tasks', { projectId: 'fixture', prompt: 'целевая сессия' });
  await terminal(api, target.id);
  // …while another session owns the machine.
  const busy = await api('/api/tasks', { projectId: 'fixture', prompt: 'slow держит машину' });
  await waitFor(async () => (await api(`/api/tasks/${busy.id}`)).status === 'RUNNING', 'вторая сессия работает');

  const parked = await api(`/api/tasks/${target.id}/message`, { text: 'в очередь', queue: true });
  assert.equal(parked.status, 'QUEUED', `сообщение встало в очередь: ${parked.status}`);
  assert.deepEqual((parked.pendingPrompts || []).map(p => p.text), ['в очередь'], 'текст лежит в очереди');

  // "Send now" cannot mean a second generation in parallel: it must refuse with
  // a reason and leave the prompt queued — never lose it and never report an
  // empty queue for a text that is still waiting.
  let refused = null;
  try {
    await api(`/api/tasks/${target.id}/pending/send`, {});
  } catch (error) {
    refused = error;
  }
  assert.ok(refused, '«Отправить сейчас» отказал, пока машина занята');
  assert.match(refused.message, /занят/i, `отказ объясняет причину: ${refused.message}`);
  assert.deepEqual((await api(`/api/tasks/${target.id}`)).pendingPrompts.map(p => p.text), ['в очередь'], 'отказ не потерял сообщение');

  // The pump delivers it once the machine frees up.
  await waitFor(async () => {
    const events = await eventsOf(api, target.id).catch(() => []);
    return userTexts(events).includes('в очередь');
  }, 'сообщение из очереди доставлено', { tries: 800 });
  const after = await api(`/api/tasks/${target.id}`);
  assert.deepEqual(after.pendingPrompts, [], 'очередь пуста после доставки');

  // And now an empty queue is not an error (the pump may have just delivered it).
  const idle = await api(`/api/tasks/${target.id}/pending/send`, {});
  assert.equal(idle.id, target.id, 'пустая очередь отвечает без ошибки');
});

test('regenerate keeps the previous answer as a variant, and the variant can be switched', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'вопрос' });
  await terminal(api, created.id);
  const before = await eventsOf(api, created.id);
  const firstAnswer = answers(before).at(-1);

  await api(`/api/tasks/${created.id}/regenerate`, { turnId: 'assistant-initial' });
  await terminal(api, created.id);
  const after = await eventsOf(api, created.id);

  const marker = after.find(e => e.type === 'TURN_VARIANT_START');
  assert.ok(marker, `вариант создан: ${after.map(e => e.type).join(',')}`);
  assert.equal(after.some(e => e.type === 'TURN_TRUNCATED'), false, 'старый ответ не удалён');
  assert.ok(answers(after).includes(firstAnswer), 'прежний ответ остался в истории');
  assert.equal(answers(after).length >= 2, true, 'ответов стало два');

  const switched = await api(`/api/tasks/${created.id}/variant`, { turnSeq: 0, variantId: 'initial' });
  assert.equal(switched.ok, true, 'переключение варианта принято');
  const chosen = (await eventsOf(api, created.id)).at(-1);
  assert.equal(chosen.type, 'TURN_VARIANT_SELECTED');
});

test('continue appends to the existing answer instead of starting a new turn', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'вопрос' });
  await terminal(api, created.id);
  const before = await eventsOf(api, created.id);
  const answersBefore = answers(before).length;
  const usersBefore = userTexts(before).length;

  await api(`/api/tasks/${created.id}/continue`, { turnId: 'assistant-initial' });
  await terminal(api, created.id);
  const after = await eventsOf(api, created.id);
  assert.equal(userTexts(after).length, usersBefore, 'вопрос не продублирован');
  assert.equal(after.some(e => e.type === 'TURN_VARIANT_START'), false, 'вариант не создаётся, ответ растёт');
  assert.ok(answers(after).length > answersBefore, 'модель дописала ответ');
});

test('editing the operator line rewrites it and re-runs the answer', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'исходный' });
  await terminal(api, created.id);
  await api(`/api/tasks/${created.id}/message`, { text: 'уточнение' });
  await terminal(api, created.id);
  const before = await eventsOf(api, created.id);
  const user = before.filter(e => e.type === 'USER_MESSAGE').at(-1);

  await api(`/api/tasks/${created.id}/turns/user-${user.seq}/edit`, { text: 'уточнение (исправлено)' });
  await terminal(api, created.id);
  const after = await eventsOf(api, created.id);
  assert.deepEqual(userTexts(after), ['уточнение (исправлено)'], 'сообщение исправлено, без дублей');
  assert.equal(after.some(e => e.type === 'TURN_TRUNCATED' && e.data?.reason === 'edit'), true, 'ответ перезапущен');
  assert.ok(after.some(e => e.type === 'TURN_EDITED' && e.data?.text === 'уточнение (исправлено)'));
});

test('deleting a message removes it together with everything after it', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'исходный' });
  await terminal(api, created.id);
  await api(`/api/tasks/${created.id}/message`, { text: 'первое' });
  await terminal(api, created.id);
  await api(`/api/tasks/${created.id}/message`, { text: 'второе' });
  await terminal(api, created.id);

  const before = await eventsOf(api, created.id);
  const first = before.filter(e => e.type === 'USER_MESSAGE')[0];
  await api(`/api/tasks/${created.id}/turns/user-${first.seq}/delete`, {});
  const after = await eventsOf(api, created.id);
  assert.deepEqual(userTexts(after), [], 'сообщение и всё после него удалено');
  assert.equal(after.some(e => e.type === 'TURN_TRUNCATED' && e.data?.reason === 'delete'), true);
});

test('a fork copies the conversation up to the chosen message and leaves the source alone', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'исходный' });
  await terminal(api, created.id);
  await api(`/api/tasks/${created.id}/message`, { text: 'уточнение' });
  await terminal(api, created.id);
  const before = await eventsOf(api, created.id);
  const user = before.filter(e => e.type === 'USER_MESSAGE')[0];

  const forked = await api(`/api/tasks/${created.id}/fork`, { turnId: `user-${user.seq}` });
  assert.notEqual(forked.id, created.id);
  const sourceAfter = await eventsOf(api, created.id);
  assert.equal(userTexts(sourceAfter).length, 1, 'источник не изменился');
  const forkEvents = await eventsOf(api, forked.id);
  assert.equal(forkEvents.length > 0, true, 'в форке есть скопированная история');
});

test('a failed answer can be taken back and the text returned', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'исходный' });
  await terminal(api, created.id);
  await api(`/api/tasks/${created.id}/message`, { text: 'model-error-empty' });
  const failed = await terminal(api, created.id);
  assert.equal(failed.status, 'FAILED', `модель упала: ${failed.error}`);

  const result = await api(`/api/tasks/${created.id}/undo-last-turn`, {});
  assert.equal(result.text, 'model-error-empty', 'текст вернулся оператору');
  const after = await eventsOf(api, created.id);
  assert.deepEqual(userTexts(after), [], 'неудачный ход удалён из истории');
  assert.equal(after.some(e => e.type === 'TURN_TRUNCATED'), true);
});
