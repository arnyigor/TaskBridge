// BUG-P0 (журнал b2451ed63c8b, 2026-11-20): сообщение, поставленное в очередь
// ВО ВРЕМЯ повторного хода после Edit, пропало — его ход завершился
// «успешно» за 1 с без единого обращения к Pi, а терминал предыдущего ответа
// был опубликован с раздутым номером поколения (18 вместо 17).
//
// Контракт: квебовое сообщение либо реально доставляется Pi, либо явно
// возвращается/отказывается; успешный терминал без обработки запрещён.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitTerminal(api, id, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await sleep(100);
  }
  throw new Error('сессия не завершилась');
}

test('a message queued during the resent turn is delivered to Pi after it settles', { timeout: 180_000 }, async t => {
  const fixture = await startFixture(undefined, { root: { delivery: { stallMs: 30_000 } } });
  t.after(() => fixture.close());
  const api = fixture.api;

  // 1. Первый ход отвечает мгновенно.
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'старт' });
  assert.equal((await waitTerminal(api, created.id)).status, 'SUCCEEDED', fixture.logs());

  // 2. Обычное сообщение: оно даёт USER_MESSAGE, который правим.
  await api(`/api/tasks/${created.id}/message`, { text: 'второй' });
  assert.equal((await waitTerminal(api, created.id)).status, 'SUCCEEDED', fixture.logs());
  const events0 = (await api(`/api/tasks/${created.id}/events?tail=500`)).events;
  const user = events0.filter(e => e.type === 'USER_MESSAGE' && e.message === 'второй').at(-1);
  assert.ok(user, 'USER_MESSAGE второго сообщения в журнале');

  // 3. Редактирование: правленый текст содержит fault-slow-stream — повторный
  // ход живёт несколько секунд (как реальная генерация), его можно прервать
  // постановкой сообщения в очередь.
  await api(`/api/tasks/${created.id}/turns/user-${user.seq}/edit`, { text: 'fault-slow-stream исправленный вопрос' });
  const afterEditSeq = (await api(`/api/tasks/${created.id}/events?tail=1`)).events.at(-1)?.seq ?? 0;

  // 3. Дождаться, пока ПОВТОРНЫЙ ход (кадры ПОСЛЕ правки) реально стримит, и
  // поставить сообщение в очередь ИМЕННО во время него.
  const streaming = await (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const events = (await api(`/api/tasks/${created.id}/events?tail=200`)).events;
      const frame = events.find(e => e.type === 'PI_EVENT' && e.seq > afterEditSeq
        && (e.data?.pi?.type === 'message_update' || e.data?.pi?.type === 'message_start'));
      if (frame) return frame;
      await sleep(200);
    }
    return null;
  })();
  assert.ok(streaming, 'повторный ход стримит');
  await api(`/api/tasks/${created.id}/message`, { text: 'очередное сообщение', queue: true });
  const queued = (await api(`/api/tasks/${created.id}/events?tail=200`)).events.filter(e => e.type === 'PROMPT_QUEUED');
  assert.ok(queued.length >= 1, `сообщение поставлено в очередь: ${fixture.logs()}`);

  // 4. Повторный ход завершается; очередь доставляется следом.
  await waitTerminal(api, created.id, { timeoutMs: 90_000 });

  // 5. Квебовое сообщение должно быть реально задано Pi: USER_MESSAGE события
  // (announce доставки из очереди) и PI-кадры НОВОГО хода после сеттла.
  const deadline = Date.now() + 60_000;
  let userMessage = null;
  let newTurnFrames = 0;
  while (Date.now() < deadline) {
    const events = (await api(`/api/tasks/${created.id}/events?tail=300`)).events;
    userMessage = events.filter(e => e.type === 'USER_MESSAGE' && String(e.message || '').includes('очередное сообщение')).at(-1) || null;
    newTurnFrames = events.filter(e => e.type === 'PI_EVENT' && (e.data?.pi?.type === 'agent_start' || e.data?.pi?.type === 'agent_settled')).length;
    if (userMessage && newTurnFrames >= 2) break;
    await sleep(250);
  }
  assert.ok(userMessage, `очередное сообщение объявлено доставкой: ${fixture.logs()}`);
  assert.ok(newTurnFrames >= 2, `ход очередного сообщения обратился к Pi (agent_start/settled): ${fixture.logs()}`);

  // 6. Терминал повторного ответа несёт корректный номер поколения: не раздут
  // постановкой в очередь. TASK_SUCCEEDED повтора < turn последующего хода.
  const all = (await api(`/api/tasks/${created.id}/events?tail=500`)).events;
  const succeeded = all.filter(e => e.type === 'TASK_SUCCEEDED').map(e => e.turn ?? e.data?.turn);
  assert.ok(succeeded.length >= 2, `терминалы: ${JSON.stringify(succeeded)}`);
  const sorted = [...succeeded].sort((a, b) => a - b);
  assert.deepEqual(succeeded, sorted, `номера ходов не раздуваны: ${JSON.stringify(succeeded)}`);
});
