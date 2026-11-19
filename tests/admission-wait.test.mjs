// Регресс 2026-11-19 (веб-клиент): повторная отправка сразу после отмены
// незасланного сообщения получала BUSY «Другой запрос этой сессии ещё
// отправляется» и падала красным — слот #admit занят первой (застрявшей)
// доставкой до ~30 с. Теперь message() ждёт освобождения слота до 30 с.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/manager-fixture.mjs';

test('a message sent while another delivery holds the session slot waits, not fails', async t => {
  const f = await fixture(t, false);
  // Захватываем слот сессии надолго (эмуляция застрявшей доставки/Pi-рестарта).
  f.manager.admissionKeys.add('a');
  // Отпускаем слот через 2 с.
  setTimeout(() => f.manager.admissionKeys.delete('a'), 2000);

  const result = await Promise.race([
    f.manager.message('a', 'проверь', 'auto', [], null, { admitWaitMs: 10_000 }).then(
      ok => ({ ok }),
      error => ({ error }),
    ),
    new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 15_000)),
  ]);
  assert.ok(!result.timeout, 'повтор не должен ждать вечно');
  assert.ok(!result.error, `BUSY не должен проваливать отправку: ${result.error?.message}`);
  assert.ok(result.ok, 'сообщение доставлено после освобождения слота');
  // Доставка действительно дошла до Pi (fake-pi пишет в sent).
  assert.ok(f.sent.includes('проверь'), `отправлено в Pi: ${JSON.stringify(f.sent)}`);
});

test('BUSY beyond the admission deadline fails the send without touching Pi', async t => {
  const f = await fixture(t, false);
  f.manager.admissionKeys.add('a');
  t.after(() => f.manager.admissionKeys.delete('a'));
  const sentBefore = f.sent.length;
  await assert.rejects(
    () => f.manager.message('a', 'проверь', 'auto', [], null, { admitWaitMs: 500 }),
    error => error.code === 'BUSY',
    'после дедлайна отказ честный',
  );
  assert.equal(f.sent.length, sentBefore, 'Pi ничего не получил — текст не дублируется');
});

test('STOP is never blocked by a held session slot', async t => {
  // Критерий матрицы стабилизации: отмена обязана работать, пока доставка
  // держит слот #admit (#cancel не проходит через #admit).
  const f = await fixture(t, true);
  f.manager.admissionKeys.add('a');
  const started = Date.now();
  const cancelled = await f.manager.cancel('a', { hard: true });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.ok(Date.now() - started < 2000, `STOP не ждал слот (${Date.now() - started} мс)`);
});
