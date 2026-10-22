import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';

// STAB-02B: настоящий маршрут GET /api/tasks/:id/stream, а не снимок через GET.
//
// Здесь проверяются случаи, которых нет в соседнем sse-reconnect-02b: перезапуск
// тестового сервера между обрывом и восстановлением, STOP сразу после обрыва с
// проверкой непрерывности seq, и повтор команды с тем же commandId уже после
// рестарта. Курсор из заголовка `last-event-id` — единственный источник истины:
// клиент не имеет права терять терминальное событие и не должен получать уже
// виденное второй раз.

const ACTIVE = ['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING'];

async function settle(api, id, { tries = 400, delay = 50 } = {}) {
  let task;
  for (let i = 0; i < tries; i++) {
    task = await api(`/api/tasks/${id}`);
    if (!ACTIVE.includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(`task stayed ${task.status}`);
}

function openStream(base, id, { lastEventId = null } = {}) {
  const controller = new AbortController();
  const events = [];
  const headers = lastEventId ? { 'last-event-id': String(lastEventId) } : {};
  const done = fetch(`${base}/api/tasks/${id}/stream`, { headers, signal: controller.signal })
    .then(async response => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const chunk = await reader.read().catch(() => ({ done: true }));
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const idMatch = /^id: (\d+)$/m.exec(frame);
          const dataMatch = /^data: (.*)$/m.exec(frame);
          if (!dataMatch) continue;
          let payload = null;
          try { payload = JSON.parse(dataMatch[1]); } catch { payload = null; }
          events.push({ seq: idMatch ? Number(idMatch[1]) : null, payload });
        }
      }
    })
    .catch(() => null);
  const seqs = () => events.filter(event => event.seq !== null).map(event => event.seq);
  return {
    events,
    close: () => controller.abort(),
    done,
    seqs,
    cursor: () => (seqs().length ? Math.max(...seqs()) : 0),
    waitFor: async (predicate, { tries = 300, delay = 50 } = {}) => {
      for (let i = 0; i < tries; i++) {
        const hit = events.find(predicate);
        if (hit) return hit;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      return null;
    }
  };
}

const types = client => client.events.map(event => event.payload?.type);
const userMessages = client => client.events.filter(event => event.payload?.type === 'USER_MESSAGE');

// Поток после курсора не повторяет виденное и не теряет порядок. Пропуски номеров —
// норма: pruneStreamingDeltas удаляет уже перекрытые message_update, а seq
// выдаётся До записи, поэтому дыра в номерах не означает потерю события.
function assertResumedAfter(client, cursor, label) {
  const seqs = client.seqs();
  assert.ok(seqs.length > 0, `${label}: поток пуст`);
  assert.ok(seqs[0] > cursor, `${label}: повтор уже виденного seq ${seqs[0]} ≤ ${cursor}`);
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i] > seqs[i - 1], `${label}: seq не растёт (${seqs[i - 1]} → ${seqs[i]})`);
  }
  assert.equal(new Set(seqs).size, seqs.length, `${label}: seq повторяются`);
}

test('STAB-02B: перезапуск сервера между обрывом и восстановлением не теряет терминальное состояние', { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первый ход' });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');

  const first = openStream(base, id);
  t.after(() => first.close());
  await first.waitFor(event => event.seq !== null);
  await api(`/api/tasks/${id}/message`, { text: 'fault-slow-stream' });
  assert.ok(await first.waitFor(event => event.payload?.type === 'USER_MESSAGE'), 'ход начался');
  const cursor = first.cursor();
  assert.ok(cursor > 0);
  // Клиент пропал до конца хода, сервер тоже перезапускается.
  first.close();
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');
  await fixture.restart();

  const second = openStream(base, id, { lastEventId: cursor });
  t.after(() => second.close());
  const terminal = await second.waitFor(event => ['TASK_SUCCEEDED', 'TASK_FAILED'].includes(event.payload?.type));
  assert.ok(terminal, `после рестарта терминальное событие не доехало: ${types(second).join(',')}`);
  assert.equal(userMessages(second).length, 0, 'сообщение оператора повторно не доставлено');
  assertResumedAfter(second, cursor, 'после рестарта');
  assert.equal((await api(`/api/tasks/${id}`)).status, 'SUCCEEDED');
  const stored = await api(`/api/tasks/${id}/events?limit=1000`);
  const terminalRows = (Array.isArray(stored) ? stored : stored.events).filter(event => event.type === 'TASK_SUCCEEDED');
  // Два хода — два терминальных события: первый запрос и продолжение после обрыва.
  assert.equal(terminalRows.length, 2, 'каждый ход завершён ровно один раз');
  assert.deepEqual([...new Set(terminalRows.map(event => event.seq))], terminalRows.map(event => event.seq), 'дубликат терминального seq');
  assert.equal(terminal.payload.seq, Math.max(...terminalRows.map(event => event.seq)), 'поток отдал последний терминал, а не старый');
  assert.equal(second.events.filter(event => event.payload?.type === 'TASK_SUCCEEDED').length, 1, 'терминал доставлен один раз');
});

test('STAB-02B: обрыв ровно перед STOP — отмена доходит после переподключения', { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первый ход' });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');

  const stream = openStream(base, id);
  t.after(() => stream.close());
  await stream.waitFor(event => event.seq !== null);
  await api(`/api/tasks/${id}/message`, { text: 'fault-hang' });
  assert.ok(await stream.waitFor(event => event.payload?.type === 'USER_MESSAGE'), 'ход начался');

  // Курсор фиксируется до STOP: клиент не увидит ни отмену, ни её хвост.
  const cursor = stream.cursor();
  stream.close();
  await api(`/api/tasks/${id}/cancel`, {});
  const stopped = await settle(api, id);
  assert.equal(stopped.status, 'CANCELLED');

  const reconnected = openStream(base, id, { lastEventId: cursor });
  t.after(() => reconnected.close());
  const cancelled = await reconnected.waitFor(event => event.payload?.type === 'TASK_CANCELLED');
  assert.ok(cancelled, `отмена не доехала: ${types(reconnected).join(',')}`);
  assert.equal(cancelled.payload.data?.turn ?? null, cancelled.payload.turn ?? null);
  assert.equal(userMessages(reconnected).length, 0, 'отменённое сообщение не переотправлено');
  assertResumedAfter(reconnected, cursor, 'после STOP');
  assert.equal(reconnected.events.filter(event => event.payload?.type === 'TASK_CANCELLED').length, 1, 'отмена доставлена один раз');
  // Отмена не откатывается поздними кадрами: снимок и поток согласованы.
  assert.equal((await api(`/api/tasks/${id}`)).status, 'CANCELLED');
});

test('STAB-02B: повтор команды с тем же commandId после рестарта не исполняется второй раз', { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первый ход' });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');

  const stream = openStream(base, id);
  t.after(() => stream.close());
  await stream.waitFor(event => event.seq !== null);

  const commandId = 'cmd-02b-restart-1';
  await api(`/api/tasks/${id}/message`, { text: 'общий ход', commandId, clientId: 'desktop-02b' });
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');
  assert.equal(userMessages(stream).length, 1);
  const cursor = stream.cursor();
  stream.close();

  // Сервер перезапускается, клиент не получил ответ на первую попытку и повторяет
  // ту же команду с тем же идентификатором.
  await fixture.restart();
  const replay = await api(`/api/tasks/${id}/message`, { text: 'общий ход', commandId, clientId: 'desktop-02b' });
  assert.equal(replay.id, id);
  await new Promise(resolve => setTimeout(resolve, 800));

  const all = await api(`/api/tasks/${id}/events?limit=0`);
  assert.equal(all.filter(event => event.type === 'USER_MESSAGE').length, 1, 'повтор команды создал второй ход');

  const after = openStream(base, id, { lastEventId: cursor });
  t.after(() => after.close());
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(userMessages(after).length, 0, 'повтор команды виден как новое сообщение');
  assert.equal((await api(`/api/tasks/${id}`)).status, 'SUCCEEDED');
});
