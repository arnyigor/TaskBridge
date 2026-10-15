import test from 'node:test';
import assert from 'node:assert/strict';
import { SseWriter, SSE_PENDING_LIMIT } from '../src/sse-writer.mjs';

// Шаг C-B: backpressure в SSE. `res.write()` возвращает false, когда буфер сокета
// полон (телефон в плохой сети); раньше результат игнорировался и события копились
// в буферах без предела.

/** Фейковый сокет: write() отдаёт заранее заданную последовательность ответов. */
function fakeRes(answers = []) {
  const writes = [];
  const handlers = new Map();
  return {
    writes,
    ended: 0,
    ends: [],
    write(chunk) {
      writes.push(chunk);
      const next = answers.length ? answers.shift() : true;
      if (next instanceof Error) throw next;
      return next;
    },
    end() { this.ended += 1; },
    once(event, handler) { handlers.set(event, handler); },
    emit(event) { const handler = handlers.get(event); handlers.delete(event); handler?.(); }
  };
}

const event = seq => ({ seq, type: 'PI_EVENT', message: `#${seq}` });

test('a full socket pauses the client and drain replays queued events in order', () => {
  // Первая запись проходит, вторая возвращает false (буфер полон), затем сокет готов.
  const res = fakeRes([true, false, true, true]);
  const writer = new SseWriter(res);
  assert.equal(writer.send(event(1)), true);
  assert.equal(writer.send(event(2)), true, 'событие принято в буфер — оно не потеряно');
  assert.equal(writer.backedUp, true, 'клиент на паузе до drain');
  assert.equal(writer.send(event(3)), true);
  assert.equal(writer.send(event(4)), true);
  assert.equal(res.writes.length, 2, 'на паузе в сокет ничего не пишется');
  res.emit('drain');
  assert.equal(writer.backedUp, false);
  // В сокет ушли все четыре и ровно по разу: отказавшая запись уже принята буфером,
  // а очередь разошлась в порядке поступления.
  assert.deepEqual(res.writes, [1, 2, 3, 4].map(seq => `id: ${seq}\ndata: ${JSON.stringify(event(seq))}\n\n`));
  assert.deepEqual(writer.queued, []);
});

test('a client that never drains is dropped instead of growing memory', () => {
  const res = fakeRes([false]);
  const writer = new SseWriter(res, { limit: 3 });
  assert.equal(writer.send(event(1)), true, 'сокет отказал — событие на паузу');
  // Лимит — размер очереди: три события ждут drain.
  for (const seq of [2, 3, 4]) assert.equal(writer.send(event(seq)), true, `#${seq} ещё в пределах очереди`);
  // Четвёртое в очереди выходит за лимит: стрим обрывается, хвост придёт из store
  // при переподключении с after=<курсор клиента>.
  assert.equal(writer.send(event(5)), false, 'переполнение = сигнал убрать клиента из фан-аута');
  assert.equal(writer.dropped, true);
  assert.equal(res.ended, 1);
  assert.deepEqual(writer.queued, []);
  assert.equal(writer.send(event(6)), false, 'после обрыва не пишем');
});

test('a closed socket does not break the fan-out, and the default limit is bounded', () => {
  const res = fakeRes([new Error('write after end')]);
  const writer = new SseWriter(res);
  assert.equal(writer.send(event(1)), true, 'ошибка сокета не должна валить рассылку другим клиентам');
  assert.ok(SSE_PENDING_LIMIT > 0 && Number.isFinite(SSE_PENDING_LIMIT));
  let overflow = 0;
  const tight = new SseWriter(fakeRes([false]), { limit: 1, onOverflow: () => { overflow += 1; } });
  tight.send(event(1));
  tight.send(event(2));
  tight.send(event(3));
  assert.equal(overflow, 1, 'переполнение сообщается один раз');
});
