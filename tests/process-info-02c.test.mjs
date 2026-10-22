import test from 'node:test';
import assert from 'node:assert/strict';
import { listProcesses } from '../src/process-info.mjs';

// STAB-02C: диагностика таймаута системного вызова процессов.
//
// Флейк полного набора был не «нет процессов», а «ОС не ответила вовремя»: список
// возвращается как null, а тест ждал массив и падал на `processes.some`. Здесь
// проверяется сам контракт: null — это «данные недоступны», а не «пусто», и его
// можно получить управляемо (крошечный таймаут вместо ожидания 8 секунд).

test('STAB-02C: неуспевший системный вызов — null, а не пустой список', async () => {
  // Реальный опрос с таймаутом 1 мс гарантированно не успевает: WMI отвечает ~секунду.
  const unavailable = await listProcesses({ fresh: true, timeoutMs: 1 });
  assert.equal(unavailable, null, 'таймаут обязан отличаться от «списка нет»');

  // И наоборот: обычный опрос отдаёт массив (пусть и пустой на пустой машине) —
  // null здесь означал бы, что ОС вообще отказалась отвечать.
  const list = await listProcesses({ fresh: true, timeoutMs: 60000 });
  assert.ok(Array.isArray(list), 'обычный опрос возвращает массив');
  assert.ok(list.length > 0, 'на машине с тестами список процессов не пуст');
  assert.ok(list.every(item => Number.isInteger(item.pid)), 'у каждой записи есть pid');
});
