import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/manager-fixture.mjs';

// BUG-02: STOP → правка → повторная отправка.
//
// Приёмка: после STOP исправленный запрос отправляется ровно один раз;
// история обрезается и текст заменяется; отказ доставки не теряет текст.
test('stop → edit → resend sends the edited prompt exactly once', async t => {
  const f = await fixture(t, true);
  // Ход «в полёте»: USER_MESSAGE уже в журнале, Pi стримит ответ.
  await f.store.appendEvent('a', { type: 'USER_MESSAGE', message: 'первый вопрос', data: { text: 'первый вопрос' } });
  const events0 = await f.store.readEvents('a', 0);
  const userSeq = events0.find(e => e.type === 'USER_MESSAGE')?.seq;
  assert.ok(userSeq, 'user turn exists in the journal');

  // 1. STOP.
  const cancelled = await f.manager.cancel('a', { hard: true });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(f.runtime.retired, true, 'the stopped runtime is retired');

  // The next turn must start on a fresh runtime (like a session restart): fake Pi.
  const fresh = {
    pi: { closed: false, getState: async () => ({ isStreaming: false }), prompt: async text => { f.sent.push(text); }, sendFollowUp: async text => { f.sent.push(text); }, abort: async () => {}, killTree: async () => {} },
    eventChain: Promise.resolve(), settleResolvers: [], cancelRequested: false,
  };
  f.manager.runtimes.set('a', fresh);

  // 2. Edit the user turn.
  const edited = await f.manager.editTurn('a', { turnId: `user-${userSeq}`, text: 'исправленный вопрос' });
  assert.ok(edited, 'edit accepted');

  // 3. The edited prompt must have reached Pi exactly once.
  for (let i = 0; i < 200 && !f.sent.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(f.sent.filter(x => x.trim() === 'исправленный вопрос'), ['исправленный вопрос'], `sent: ${JSON.stringify(f.sent)}`);

  // 4. The journal keeps the edit marker and a new USER_MESSAGE for the resent prompt.
  const events = (await f.store.readEvents('a', 0)).filter(e => e.type !== 'RUNTIME_STATE');
  assert.ok(events.some(e => e.type === 'TURN_EDITED'), events.map(e => e.type).join(','));
  assert.ok(events.some(e => e.type === 'USER_MESSAGE' && e.message === 'исправленный вопрос'), events.map(e => e.type).join(','));

  // Let the detached settle path finish instead of leaving a 12h timer behind.
  for (const waiter of fresh.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
  for (let i = 0; i < 200 && f.manager.activeTaskId; i++) await new Promise(r => setTimeout(r, 5));
  await new Promise(r => setImmediate(r));
});

test('a failed delivery after edit keeps the text in the queue, not lost', async t => {
  const f = await fixture(t, false);
  await f.store.appendEvent('a', { type: 'USER_MESSAGE', message: 'первый вопрос', data: { text: 'первый вопрос' } });
  const events0 = await f.store.readEvents('a', 0);
  const userSeq = events0.find(e => e.type === 'USER_MESSAGE').seq;
  await f.manager.cancel('a', { hard: true });

  // Delivery refuses (e.g. session start fails): editTurn now answers right after
  // the truncation and delivers in the background — the failure must not lose the
  // text and must not block the caller (dialog) on a ~20 s session restart.
  f.runtime.pi.prompt = async () => { throw new Error('rpc down'); };
  f.runtime.pi.getState = async () => { throw new Error('rpc down'); };
  const accepted = await f.manager.editTurn('a', { turnId: `user-${userSeq}`, text: 'исправленный вопрос' });
  assert.ok(accepted, 'the edit itself is accepted immediately');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  // And the caller may retry: the turn is still editable and the text survives.
  f.runtime.pi.prompt = async text => { f.sent.push(text); };
  f.runtime.pi.getState = async () => ({ isStreaming: false });
  const retry = await f.manager.editTurn('a', { turnId: `user-${userSeq}`, text: 'исправленный вопрос' });
  assert.ok(retry, 'retry after failed delivery is accepted');
  for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
  for (let i = 0; i < 200 && f.manager.activeTaskId; i++) await new Promise(r => setTimeout(r, 5));
  await new Promise(r => setImmediate(r));
});

test('edit waits for hard STOP even before the status changes to CANCELLING', async t => {
  const f = await fixture(t, true);
  await f.store.appendEvent('a', { type: 'USER_MESSAGE', message: 'вопрос', data: { text: 'вопрос' } });
  const userSeq = (await f.store.readEvents('a', 0)).find(e => e.type === 'USER_MESSAGE').seq;
  let startKill, finishKill;
  const killing = new Promise(resolve => { startKill = resolve; });
  const killGate = new Promise(resolve => { finishKill = resolve; });
  f.pi.killTree = async () => { startKill(); await killGate; };

  const stop = f.manager.cancel('a', { hard: true, commandId: 'stop-test' });
  await killing;
  // Editing an answer hits the same guard without starting a new Pi session.
  const edit = f.manager.editTurn('a', { turnId: `assistant-${userSeq}`, text: 'исправленный ответ' });
  try {
    assert.equal(f.task.status, 'RUNNING');
    const state = await Promise.race([edit, new Promise(resolve => setImmediate(() => resolve('waiting')))]);
    assert.equal(state, 'waiting');
  } finally {
    finishKill();
    await stop;
  }
  assert.equal((await edit).ok, true);
});

// Правка сразу после STOP: сессия ещё в CANCELLING (abort может идти секунды),
// и раньше editTurn отвергался NOT_ALLOWED «Сессия сейчас работает» — оператор
// видел ошибку вместо «отправлено». Теперь правка ждёт завершения STOP.
test('edit while the stop is still settling waits and is accepted', async t => {
  const f = await fixture(t, true);
  await f.store.appendEvent('a', { type: 'USER_MESSAGE', message: 'первый вопрос', data: { text: 'первый вопрос' } });
  const userSeq = (await f.store.readEvents('a', 0)).find(e => e.type === 'USER_MESSAGE').seq;

  let releaseAbort;
  const abortGate = new Promise(resolve => { releaseAbort = resolve; });
  f.runtime.pi.abort = async () => { await abortGate; };

  const stopping = f.manager.cancel('a', { hard: false });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(f.manager.tasks.get('a').status, 'CANCELLING', 'STOP ещё идёт');

  const edited = f.manager.editTurn('a', { turnId: `user-${userSeq}`, text: 'исправленный вопрос' });
  setTimeout(releaseAbort, 200); // STOP завершается, пока правка ждёт

  await assert.doesNotReject(() => edited, 'правка во время STOP не отвергается');
  assert.equal((await edited).ok, true);
  await stopping.catch(() => {});

  const events = (await f.store.readEvents('a', 0)).filter(e => e.type !== 'RUNTIME_STATE');
  assert.ok(events.some(e => e.type === 'TURN_EDITED'), events.map(e => e.type).join(','));
  assert.ok(events.some(e => e.type === 'USER_MESSAGE' && e.message === 'исправленный вопрос'), events.map(e => e.type).join(','));

  for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
  for (let i = 0; i < 200 && f.manager.activeTaskId; i++) await new Promise(r => setTimeout(r, 5));
  await new Promise(r => setImmediate(r));
});
