import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';
import { createLocalTransport } from '../web/transport.mjs';
import { ChatState } from '../web/chat-state.mjs';

// STAB-02C: короткая интеграционная приёмка клиента.
//
// Проверяется production-код клиента, а не только серверный SSE: транспорт
// `web/transport.mjs` (курсор, дедупликация, статус переподключения) и редьюсер
// `web/chat-state.mjs` — на настоящем HTTP/SSE против отдельного тестового сервера.
// Браузерный EventSource в Node отсутствует, поэтому обёртка ниже повторяет только
// его контракт (onmessage/onerror/close); обрыв делается смертью процесса сервера —
// это настоящий разрыв TCP, а не закрытие сокета на стороне клиента.

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

async function waitFor(check, { tries = 300, delay = 50, what = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(`not reached: ${what}`);
}

const history = async (api, id) => {
  const list = await api(`/api/tasks/${id}/events?limit=1000`);
  return Array.isArray(list) ? list : list.events || [];
};
const userMessages = events => events.filter(event => event.type === 'USER_MESSAGE');

// Минимальный EventSource: только то, чем пользуется транспорт.
function eventSourceClass() {
  return class LocalEventSource {
    constructor(url) {
      this.onmessage = null;
      this.onerror = null;
      this.onopen = null;
      this.closed = false;
      this.controller = new AbortController();
      this.#run(url);
    }
    async #run(url) {
      try {
        const response = await fetch(url, { signal: this.controller.signal, headers: { accept: 'text/event-stream' } });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        this.onopen?.();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const data = /^data: (.*)$/m.exec(frame);
            if (data) this.onmessage?.({ data: data[1] });
          }
        }
        if (!this.closed) this.onerror?.();
      } catch {
        if (!this.closed) this.onerror?.();
      }
    }
    close() { this.closed = true; this.controller.abort(); }
  };
}

test('INT-03: обрыв сети (падение сервера) и восстановление — без повторов сообщений и команд', { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первый ход' });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');

  const transport = createLocalTransport({ base, EventSourceImpl: eventSourceClass() });
  t.after(() => transport.close());
  const events = [];
  const statuses = [];
  let handle = transport.open(id, { onEvent: event => events.push(event), onStatus: status => statuses.push(status) });
  await waitFor(() => handle.cursor > 0, { what: 'поток отдал историю' });

  const commandId = 'int-03-cmd-1';
  await transport.request('POST', `/api/tasks/${id}/message`, { text: 'fault-slow-stream', commandId });
  await waitFor(() => events.some(event => event.type === 'USER_MESSAGE'), { what: 'ход начался' });
  const cursor = handle.cursor;
  assert.ok(cursor > 0);

  // Настоящий разрыв: процесс тестового сервера умирает, соединение рвётся.
  await fixture.restart();
  await waitFor(() => statuses.includes('reconnecting'), { what: 'транспорт увидел обрыв' });
  const afterRestart = await settle(api, id);
  // Ход прерван падением сервера — важен не именно SUCCEEDED, а честный терминал
  // (сессия не висит в RUNNING) и отсутствие повторной доставки.
  assert.ok(['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(afterRestart.status), afterRestart.status);

  // Клиент возвращается с последним полученным курсором, как это делает Web.
  handle.close();
  events.length = 0;
  handle = transport.open(id, { after: cursor, onEvent: event => events.push(event), onStatus: status => statuses.push(status) });
  t.after(() => handle.close());
  await waitFor(() => events.length > 0, { what: 'поток продолжился после переподключения' });
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(userMessages(events).length, 0, 'курсор не повторяет уже виденное сообщение');
  assert.ok(events.every(event => !Number.isSafeInteger(event.seq) || event.seq > cursor), 'поток не откатывается назад');
  // Терминальное состояние восстанавливается либо потоком, либо снимком сессии:
  // после падения процесса запись TASK_FAILED делает только снимок
  // (session-recovery сохраняет статус без события), поэтому клиент обязан
  // уметь взять статус из GET /api/tasks/:id. См. отчёт STAB-02C.
  const streamTerminal = events.some(event => ['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_CANCELLED'].includes(event.type));
  const snapshot = await api(`/api/tasks/${id}`);
  assert.ok(streamTerminal || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(snapshot.status),
    `терминальное состояние не восстановилось: ни поток, ни снимок (${snapshot.status})`);

  // «Действие» повторено с тем же commandId: второй ход не создаётся.
  const before = userMessages(await history(api, id)).length;
  await transport.request('POST', `/api/tasks/${id}/message`, { text: 'fault-slow-stream', commandId });
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(userMessages(await history(api, id)).length, before, 'повтор команды после обрыва создал второй ход');
});

test('INT-06: два клиента одной сессии видят согласованные события без дублей', { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первый ход' });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');

  const desktop = createLocalTransport({ base, EventSourceImpl: eventSourceClass() });
  const phone = createLocalTransport({ base, EventSourceImpl: eventSourceClass() });
  t.after(() => { desktop.close(); phone.close(); });
  const seen = { desktop: [], phone: [] };
  const desktopStream = desktop.open(id, { onEvent: event => seen.desktop.push(event) });
  const phoneStream = phone.open(id, { onEvent: event => seen.phone.push(event) });
  t.after(() => { desktopStream.close(); phoneStream.close(); });
  await waitFor(() => desktopStream.cursor > 0 && phoneStream.cursor > 0, { what: 'оба клиента подключены' });

  await desktop.request('POST', `/api/tasks/${id}/message`, { text: 'общий ход', commandId: 'int-06-cmd-1', clientId: 'desktop' });
  await waitFor(() => seen.desktop.some(event => event.type === 'USER_MESSAGE') && seen.phone.some(event => event.type === 'USER_MESSAGE'),
    { what: 'сообщение дошло до обоих клиентов' });
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');
  await waitFor(() => ['TASK_SUCCEEDED', 'TASK_FAILED'].includes(seen.desktop.at(-1)?.type), { what: 'терминал у desktop' });
  await waitFor(() => ['TASK_SUCCEEDED', 'TASK_FAILED'].includes(seen.phone.at(-1)?.type), { what: 'терминал у phone' });

  for (const [name, list] of Object.entries(seen)) {
    const userSeq = list.find(event => event.type === 'USER_MESSAGE')?.seq ?? 0;
    assert.equal(userMessages(list).length, 1, `${name}: одно сообщение оператора`);
    assert.equal(list.filter(event => event.type === 'TASK_SUCCEEDED' && event.seq > userSeq).length, 1,
      `${name}: один терминал второго хода`);
    const seqs = list.map(event => event.seq).filter(Number.isSafeInteger);
    assert.deepEqual(seqs, [...new Set(seqs)], `${name}: seq не повторяются`);
  }
  // Второй клиент повторяет ту же команду (потерянный ответ): второй ход не появляется.
  await phone.request('POST', `/api/tasks/${id}/message`, { text: 'общий ход', commandId: 'int-06-cmd-1', clientId: 'desktop' });
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(userMessages(await history(api, id)).length, 1);
});

test('INT-07: после удаления промежуточных message_update итоговый текст полный', { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первый ход' });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');

  // Один дельта-кадр на символ: строк message_update заведомо больше десятка.
  const prompt = 'stream-many подробный ответ';
  await api(`/api/tasks/${id}/message`, { text: prompt });
  const finished = await settle(api, id);
  assert.equal(finished.status, 'SUCCEEDED', finished.error || '');

  const events = await history(api, id);
  const piFrames = events.filter(event => event.type === 'PI_EVENT').map(event => event.data?.pi).filter(Boolean);
  const deltas = piFrames.filter(frame => frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_delta');
  const ends = piFrames.filter(frame => frame.type === 'message_end' && frame.message?.role === 'assistant');
  assert.equal(ends.length, 2, 'по одному message_end на каждый ход');
  assert.equal(deltas.length, 0, 'промежуточные дельты завершённого хода удалены');

  const finalEnd = ends.at(-1).message;
  const endText = finalEnd.content.filter(part => part.type === 'text').map(part => part.text).join('');
  assert.ok(endText.length > 40, `текст в message_end: ${endText.length} символов`);

  // Снимок задачи несёт тот же текст — это запасной путь для клиента.
  // assistantText накапливает все ходы, поэтому сравниваем хвост, а не всё поле.
  assert.ok(finished.assistantText.endsWith(endText), `снимок: ${finished.assistantText.slice(-80)}`);

  // Клиентский редьюсер (production) собирает из истории тот же ответ.
  const state = new ChatState(finished, { seedInitial: true });
  for (const event of events) state.apply(event);
  const rendered = state.turns.filter(turn => turn.role === 'assistant').map(turn => turn.text);
  assert.equal(rendered.length, 2, `ответов в редьюсере: ${rendered.length}`);
  assert.equal(rendered.at(-1), endText, 'ChatState восстановил полный текст без промежуточных дельт');

  // Живой поток после подписки тоже отдаёт полный текст в message_end.
  const transport = createLocalTransport({ base, EventSourceImpl: eventSourceClass() });
  t.after(() => transport.close());
  const live = [];
  const stream = transport.open(id, { onEvent: event => live.push(event) });
  t.after(() => stream.close());
  await waitFor(() => live.length > 0, { what: 'живая подписка' });
  await api(`/api/tasks/${id}/message`, { text: 'stream-many второй ход' });
  await waitFor(() => live.some(event => event.type === 'TASK_SUCCEEDED'), { what: 'второй ход завершён' });
  const liveEnd = live.filter(event => event.type === 'PI_EVENT' && event.data?.pi?.type === 'message_end' && event.data.pi.message?.role === 'assistant').at(-1);
  const liveText = (liveEnd?.data?.pi?.message?.content || []).filter(part => part.type === 'text').map(part => part.text).join('');
  const finalTask = await api(`/api/tasks/${id}`);
  assert.ok(finalTask.assistantText.endsWith(liveText), 'живой поток и снимок согласованы');
  assert.ok(liveText.length > 40);
});
