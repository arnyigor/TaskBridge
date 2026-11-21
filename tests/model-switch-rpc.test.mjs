import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './helpers/manager-fixture.mjs';

// P0 2026-11-20: «Pi RPC timeout for get_state … it looks hung» при выборе модели.
// Диагностический get_state шёл с 15-секундным бюджетом и на таймауте вызывал
// #recoverRpcFailure: активный ход падал, процесс убивался, а выбор модели терялся.
// Теперь бюджет — PROBE_TIMEOUT_MS (медленный, но живой Pi проходит), а на отказе
// RPC выбор СОХРАНЯЕТСЯ для следующего запуска, не разрушая идущий ход.

const hung = () => Object.assign(new Error('no output from the Pi process for 60000ms - it looks hung'), { code: 'PI_RPC_HUNG' });

test('переключение модели читает состояние с бюджетом PROBE_TIMEOUT_MS, а не 15 с', async t => {
  const f = await fixture(t, false);
  const seen = [];
  const realGetState = f.runtime.pi.getState;
  f.runtime.pi.getState = async timeoutMs => { seen.push(timeoutMs); return realGetState(); };
  f.runtime.pi.setModel = async (provider, modelId) => ({ provider, id: modelId });
  await f.manager.setModel('a', 'deepseek', 'deepseek-flash');
  assert.equal(seen[0], 60_000, `get_state при смене модели: ${JSON.stringify(seen)}`);
});

test('молчащий Pi во время хода: модель сохраняется, ход и процесс не убиваются', async t => {
  const f = await fixture(t, true); // сессия RUNNING: идёт ход
  f.runtime.pi.getState = async () => { throw hung(); };
  let killed = false;
  f.runtime.pi.killTree = async () => { killed = true; };

  const task = await f.manager.setModel('a', 'deepseek', 'deepseek-flash');

  assert.deepEqual(task.requestedModel, { provider: 'deepseek', id: 'deepseek-flash' }, 'выбор не потерян');
  assert.equal(task.status, 'RUNNING', 'идущий ход не превращён в ошибку');
  assert.equal(killed, false, 'Pi не убит из-за диагностического get_state');
  assert.equal(f.manager.runtimes.get('a'), f.runtime, 'живой runtime не выброшен');

  const events = await f.store.readEvents('a', 0);
  const switchEvent = events.filter(e => e.type === 'MODEL_SWITCH').at(-1);
  assert.match(switchEvent.message, /применится при следующем запуске/, 'оператору сказано, что модель применена позже');
});

test('молчащий Pi без активного хода: выбор сохранён, runtime выведен, очередь не тронута', async t => {
  const f = await fixture(t, false); // сессия SUCCEEDED, хода нет
  f.runtime.pi.getState = async () => { throw hung(); };
  const pending = { text: 'следующий вопрос', commandId: 'cmd-1' };
  f.task.pendingPrompts = [pending];

  const task = await f.manager.setModel('a', 'deepseek', 'deepseek-flash');

  assert.deepEqual(task.requestedModel, { provider: 'deepseek', id: 'deepseek-flash' });
  assert.notEqual(f.manager.runtimes.get('a'), f.runtime, 'мёртвый процесс выведен из runtime-таблицы');
  assert.equal(task.status, 'SUCCEEDED', 'сессия остаётся рабочей');
  const saved = f.manager.tasks.get('a').pendingPrompts;
  assert.deepEqual(saved.map(p => p.text), ['следующий вопрос'], 'сообщение не потеряно');
});

test('закрытый Pi: модель сохраняется для следующего запуска без RPC', async t => {
  const f = await fixture(t, false);
  f.runtime.pi.closed = true;
  let called = false;
  f.runtime.pi.getState = async () => { called = true; return {}; };
  const task = await f.manager.setModel('a', 'deepseek', 'deepseek-flash');
  assert.equal(called, false, 'к закрытому процессу не обращаемся');
  assert.deepEqual(task.requestedModel, { provider: 'deepseek', id: 'deepseek-flash' });
});
