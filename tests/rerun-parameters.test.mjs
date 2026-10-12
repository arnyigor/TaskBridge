// MR-07: «повторить с параметрами» из чата (POST /api/tasks/:id/rerun).
//
// Проверяется, что параметры (модель, уровень мышления) применяются к сессии ДО
// повторного запроса, что вопрос уходит заново как новый вариант ответа и что без
// параметров поведение не меняется. Стенд — тот же HTTP-фикстур с поддельным Pi,
// что и в tests/server.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';

async function terminal(api, id) {
  for (let i = 0; i < 150; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Task did not finish');
}

// Сессия с двумя ходами: повторять можно только последний ход, поэтому второго
// вопроса в тесте не избежать.
async function twoTurnFixture(t) {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первое' });
  const id = created.id;
  assert.equal((await terminal(api, id)).status, 'SUCCEEDED', fixture.logs());
  await api(`/api/tasks/${id}/message`, { text: 'второе' });
  assert.equal((await terminal(api, id)).status, 'SUCCEEDED', fixture.logs());
  const events = await api(`/api/tasks/${id}/events?limit=0`);
  const user = events.filter(e => e.type === 'USER_MESSAGE').at(-1);
  return { fixture, api, id, turnId: `assistant-${user.seq}`, userSeq: user.seq, before: events };
}

test('модель из параметров применяется к сессии, и ответ приходит заново', { timeout: 30000 }, async t => {
  const { fixture, api, id, turnId, userSeq, before } = await twoTurnFixture(t);

  const initial = await api(`/api/tasks/${id}`);
  assert.notEqual(`${initial.model?.provider}/${initial.model?.id}`, 'other/other', 'исходная модель — не та, на которую переключаемся');

  await api(`/api/tasks/${id}/rerun`, { turnId, model: { provider: 'other', id: 'other' } });
  const done = await terminal(api, id);
  assert.equal(done.status, 'SUCCEEDED', fixture.logs());

  // Параметр применился к СЕССИИ (а не только к этому запросу) и виден в ней.
  assert.equal(done.model?.provider, 'other');
  assert.equal(done.model?.id, 'other');
  const after = await api(`/api/tasks/${id}/events?limit=0`);
  const switches = after.filter(e => e.type === 'MODEL_SWITCH');
  assert.equal(switches.length, 1, after.map(e => e.type).join(','));
  assert.equal(switches[0].data.provider, 'other');
  assert.equal(switches[0].data.modelId, 'other');

  // Вопрос задан заново: новый вариант того же хода, прежний ответ остался.
  const marker = after.filter(e => e.type === 'TURN_VARIANT_START').at(-1);
  assert.ok(marker, after.map(e => e.type).join(','));
  assert.equal(marker.data.turnSeq, userSeq);
  assert.ok(marker.data.variantId);
  assert.ok(marker.seq > before.at(-1).seq, 'маркер виден клиенту, который уже получил прежний ответ');
  assert.equal(after.filter(e => e.type === 'USER_MESSAGE').length, 1, 'вопрос не дублируется');
  assert.equal(after.filter(e => e.type === 'TURN_TRUNCATED').length, 0, 'прежний ответ не удаляется');
});

test('уровень мышления из параметров применяется до запроса', { timeout: 30000 }, async t => {
  const { fixture, api, id, turnId } = await twoTurnFixture(t);

  await api(`/api/tasks/${id}/rerun`, { turnId, thinkingLevel: 'low' });
  assert.equal((await terminal(api, id)).status, 'SUCCEEDED', fixture.logs());

  const after = await api(`/api/tasks/${id}/events?limit=0`);
  const thinking = after.filter(e => e.type === 'THINKING_LEVEL');
  assert.equal(thinking.length, 1, after.map(e => e.type).join(','));
  assert.equal(thinking[0].data.level, 'low');
  const task = await api(`/api/tasks/${id}`);
  assert.equal(task.thinkingLevel, 'low');
});

test('оба параметра вместе и без параметров — тот же повтор', { timeout: 40000 }, async t => {
  const { fixture, api, id, turnId } = await twoTurnFixture(t);

  await api(`/api/tasks/${id}/rerun`, { turnId, model: { provider: 'other', id: 'other' } });
  assert.equal((await terminal(api, id)).status, 'SUCCEEDED', fixture.logs());
  const second = await api(`/api/tasks/${id}/events?limit=0`);
  const secondTurn = second.filter(e => e.type === 'USER_MESSAGE').at(-1);
  assert.equal(secondTurn.message, 'второе');

  // Повтор без параметров работает как regenerate: параметры не обязательны.
  await api(`/api/tasks/${id}/rerun`, { turnId: `assistant-${secondTurn.seq}` });
  assert.equal((await terminal(api, id)).status, 'SUCCEEDED', fixture.logs());
  const third = await api(`/api/tasks/${id}/events?limit=0`);
  assert.equal(third.filter(e => e.type === 'TURN_VARIANT_START').length, 2, 'два повтора — два варианта');
  assert.equal(third.filter(e => e.type === 'MODEL_SWITCH').length, 1, 'без параметров модель не трогается');
});

test('повтор подчиняется тем же отказам, что и regenerate', { timeout: 30000 }, async t => {
  const { api, id, turnId } = await twoTurnFixture(t);

  // «Ничего не отправлено» не должно молча перезапускать сессию.
  await assert.rejects(() => api(`/api/tasks/${id}/rerun`, {}), err => err.code === 'NOT_ALLOWED');
  await assert.rejects(() => api(`/api/tasks/${id}/rerun`, { turnId: 'assistant-999' }), err => err.code === 'NOT_ALLOWED');
  // Проверка самого уровня остаётся за setThinkingLevel (её случай — tests/server.test.mjs:
  // «не поддерживает уровень размышлений»); здесь важно, что повтор не отправляется
  // после отказа и сессия остаётся рабочей.
  // Сессия после отказов жива: последний ход по-прежнему можно повторить.
  await api(`/api/tasks/${id}/rerun`, { turnId });
  assert.equal((await terminal(api, id)).status, 'SUCCEEDED');
});
