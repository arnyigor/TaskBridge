// A Pi that acknowledges the prompt and then says nothing at all: no
// agent_start, no deltas, no tool frames. On 2026-11-17 three sessions were left
// RUNNING like this, the operator cancelled by hand and the next attempt worked
// only because STOP had killed the mute process. The chat said «Ответ не был
// получен.», and the same text had to be typed again.
//
// The watchdog turns that silence into a visible failure, puts the text back into
// the queue so the next delivery goes to a fresh process, and stops after one
// automatic re-delivery so a systemically mute Pi cannot replay it for ever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitTerminal(api, id, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await sleep(100);
  }
  throw new Error('сессия не завершилась');
}

const typesOf = events => events.map(event => event.type);

test('a mute Pi is stopped by the silence watchdog and the prompt is re-delivered once', { timeout: 90_000 }, async t => {
  // stallMs is tiny on purpose: the fixture answers instantly, so 1.5 s of true
  // silence is already abnormal.
  const fixture = await startFixture(undefined, { root: { delivery: { stallMs: 1500 } } });
  t.after(() => fixture.close());
  const api = fixture.api;

  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-mute первый' });
  const failed = await waitTerminal(api, created.id);
  assert.equal(failed.status, 'FAILED', fixture.logs());
  assert.equal(failed.errorCode, 'PI_STALLED', 'причина названа: молчание, а не «модель отказала»');
  assert.match(String(failed.error || ''), /молчит/);

  const events = (await api(`/api/tasks/${created.id}/events?tail=200`)).events;
  const types = typesOf(events);
  assert.ok(types.includes('STALL_DETECTED'), types.join(','));
  // The text is not lost: it goes back to the queue for the next delivery.
  const queued = events.filter(event => event.type === 'PROMPT_QUEUED');
  assert.ok(queued.length >= 1, 'сообщение возвращено в очередь, а не потеряно');

  // The re-delivery is mute again: the second silence is reported and NOT
  // re-queued, otherwise a broken Pi would replay the same text for ever.
  let stalls = [];
  for (let attempt = 0; attempt < 300; attempt += 1) {
    stalls = (await api(`/api/tasks/${created.id}/events?tail=300`)).events.filter(event => event.type === 'STALL_DETECTED');
    if (stalls.length >= 2) break;
    await sleep(100);
  }
  assert.ok(stalls.length >= 2, `ожидался один автоматический повтор, срывов: ${stalls.length}`);
  assert.equal(stalls[0].data?.requeue, true, 'первое молчание возвращает текст в очередь');
  assert.equal(stalls[stalls.length - 1].data?.requeue, false, 'второй раз текст в очередь не возвращается');
  const final = await waitTerminal(api, created.id, { timeoutMs: 30_000 });
  assert.equal(final.status, 'FAILED');
  assert.equal(final.errorCode, 'PI_STALLED');
  assert.deepEqual(final.pendingPrompts, [], 'очередь пуста: бесконечного цикла нет');
});

test('a Pi that already talked gets a long silence budget instead of the cold-start one', { timeout: 90_000 }, async t => {
  // Регресс 2026-11-19 (PSB): ход после тяжёлого bash убивался ровно через
  // stallMs тишины, хотя модель легально ждала первый токен от провайдера.
  // Watchdog обязан отличать «никогда не говоривший Pi» от «говорил и думает»:
  // для второго бюджет в 5 раз больше.
  const fixture = await startFixture(undefined, { root: { delivery: { stallMs: 400 } } });
  t.after(() => fixture.close());
  const api = fixture.api;

  // Первый ход живой — процесс доказал, что умеет говорить.
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'обычный первый вопрос' });
  assert.equal((await waitTerminal(api, created.id)).status, 'SUCCEEDED', fixture.logs());

  // Второй ход молчит: старый порог (400 мс) обязан быть превышен, но ход
  // не должен признаваться зависшим раньше 5 * 400 = 2000 мс.
  await api(`/api/tasks/${created.id}/message`, { text: 'fault-mute второй' });
  await sleep(1_200);
  const early = (await api(`/api/tasks/${created.id}/events?tail=100`)).events;
  assert.equal(early.filter(event => event.type === 'STALL_DETECTED').length, 0,
    'живой Pi не срывается на короткой тишине — ' + fixture.logs());

  // Дальше прежняя защита работает: настоящая тишина всё равно ловится.
  const failed = await waitTerminal(api, created.id, { timeoutMs: 30_000 });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'PI_STALLED');
});

test('a turn that keeps sending frames is never treated as stalled', { timeout: 60_000 }, async t => {
  const fixture = await startFixture(undefined, { root: { delivery: { stallMs: 1000 } } });
  t.after(() => fixture.close());
  const api = fixture.api;

  // A slow but alive turn: the fixture streams deltas for longer than stallMs.
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-slow-stream живой ответ' });
  const done = await waitTerminal(api, created.id, { timeoutMs: 60_000 });
  assert.equal(done.status, 'SUCCEEDED', fixture.logs());
  const events = (await api(`/api/tasks/${created.id}/events?tail=200`)).events;
  assert.equal(events.filter(event => event.type === 'STALL_DETECTED').length, 0, 'живой ход не считается зависшим');
});

test('a Pi that goes mute right after a model switch is retired, not reused', { timeout: 120_000 }, async t => {
  // The three sessions of 2026-11-17 all went silent within seconds of a model
  // switch: the switch itself was applied, then the process answered nothing and
  // the next prompt died in it. The switch must not leave such a process as the
  // owner of the session.
  const fixture = await startFixture(undefined, { env: { FAKE_PI_MUTE_AFTER_MODEL: '1' }, root: { delivery: { stallMs: 60_000 } } });
  t.after(() => fixture.close());
  const api = fixture.api;

  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первый' });
  assert.equal((await waitTerminal(api, created.id)).status, 'SUCCEEDED', fixture.logs());

  const switched = await api(`/api/tasks/${created.id}/model`, { provider: 'other', id: 'other' });
  assert.equal(switched.model.id, 'other', 'выбор сохранён');
  const events = (await api(`/api/tasks/${created.id}/events?tail=100`)).events;
  const switchEvent = events.filter(event => event.type === 'MODEL_SWITCH').pop();
  assert.equal(switchEvent?.data?.runtimeRetired, true, 'зависший процесс снят, а не оставлен владельцем сессии');

  // The point of retiring it: the next message is delivered, not swallowed.
  await api(`/api/tasks/${created.id}/message`, { text: 'второй' });
  const second = await waitTerminal(api, created.id, { timeoutMs: 60_000 });
  assert.equal(second.status, 'SUCCEEDED', second.error || 'сообщение доставлено в свежий процесс');
});
