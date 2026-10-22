import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';

// STAB-02B: настоящий SSE reconnect. Проверяется не только снимок задачи через GET,
// а живой поток событий: обрыв, переподключение с курсором, два клиента, STOP,
// который клиент пропустил.

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

// Минимальный SSE-клиент: читает поток, складывает события с их seq и умеет
// закрыться, чтобы изобразить обрыв.
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
          if (dataMatch) {
            let payload = null;
            try { payload = JSON.parse(dataMatch[1]); } catch { payload = null; }
            events.push({ seq: idMatch ? Number(idMatch[1]) : null, payload, raw: frame });
          }
        }
      }
    })
    .catch(() => null);
  return {
    events,
    close: () => controller.abort(),
    done,
    waitFor: async (predicate, { tries = 300, delay = 50 } = {}) => {
      for (let i = 0; i < tries; i++) {
        const hit = events.find(predicate);
        if (hit) return hit;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      return null;
    },
  };
}

const countUserMessages = events => events.filter(event => event.payload?.type === 'USER_MESSAGE').length;

test('STAB-02B: обрыв во время генерации и переподключение с курсором', { timeout: 180000 }, async t => {
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
  // Обрыв посреди генерации: клиент не увидит её конца.
  const seen = await first.waitFor(event => event.payload?.type === 'USER_MESSAGE');
  assert.ok(seen, 'поток отдал начало хода');
  const cursor = Math.max(...first.events.filter(event => event.seq !== null).map(event => event.seq));
  first.close();
  assert.ok(cursor > 0);

  const finished = await settle(api, id);
  assert.equal(finished.status, 'SUCCEEDED', finished.error || '');

  // Переподключение с курсором: терминальное событие должно дойти, а сообщение
  // оператора — не продублироваться.
  const second = openStream(base, id, { lastEventId: cursor });
  t.after(() => second.close());
  const terminal = await second.waitFor(event => ['TASK_SUCCEEDED', 'TASK_FAILED'].includes(event.payload?.type));
  assert.ok(terminal, `после переподключения доехало терминальное событие: ${second.events.map(e => e.payload?.type).join(',')}`);
  assert.equal(countUserMessages(second.events), 0, 'переподключение не повторяет USER_MESSAGE');
  const seqs = second.events.filter(event => event.seq !== null).map(event => event.seq);
  assert.ok(seqs.every(seq => seq > cursor), 'поток продолжен с курсора, без повторов');
});

test('STAB-02B: STOP, пропущенный клиентом, виден после переподключения', { timeout: 180000 }, async t => {
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
  const cursor = Math.max(...stream.events.filter(event => event.seq !== null).map(event => event.seq));
  // Клиент отваливается одновременно со STOP.
  stream.close();
  await api(`/api/tasks/${id}/cancel`, {}).catch(() => null);

  const reconnected = openStream(base, id, { lastEventId: cursor });
  t.after(() => reconnected.close());
  const cancelled = await reconnected.waitFor(event => event.payload?.type === 'TASK_CANCELLED');
  assert.ok(cancelled, `отмена видна в потоке: ${reconnected.events.map(e => e.payload?.type).join(',')}`);
  const task = await api(`/api/tasks/${id}`);
  assert.equal(task.status, 'CANCELLED');
  assert.equal(countUserMessages(reconnected.events), 0, 'повторной доставки сообщения нет');
});

test('STAB-02B: два клиента одной сессии и повтор команды с commandId', { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первый ход' });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');

  const left = openStream(base, id);
  const right = openStream(base, id);
  t.after(() => { left.close(); right.close(); });
  await left.waitFor(event => event.seq !== null);
  await right.waitFor(event => event.seq !== null);

  const commandId = 'cmd-02b-1';
  await api(`/api/tasks/${id}/message`, { text: 'общий ход', commandId });
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');

  // Сеть «потеряла» ответ: клиент повторяет ту же команду после переподключения.
  const replay = openStream(base, id);
  t.after(() => replay.close());
  await api(`/api/tasks/${id}/message`, { text: 'общий ход', commandId }).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 800));

  for (const [name, client] of [['left', left], ['right', right], ['replay', replay]]) {
    assert.equal(countUserMessages(client.events), 1, `${name}: одно сообщение в потоке`);
  }
  const all = await api(`/api/tasks/${id}/events?limit=0`);
  // Первый (создающий) запрос публикуется как PROMPT_ACCEPTED, а не USER_MESSAGE:
  // в истории ровно одно сообщение оператора и его повтор не добавил второго.
  assert.equal(all.filter(event => event.type === 'USER_MESSAGE').length, 1, 'повтор команды не создал второго хода');
});
