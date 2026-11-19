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
  let releaseSlot;
  const gate = new Promise(resolve => { releaseSlot = resolve; });
  const originalAdmit = f.manager.admissionKeys;
  f.manager.admissionKeys.add('a');
  const waiters = [];
  // message() ждёт до 30 с: отпускаем слот через 2 с.
  setTimeout(() => { originalAdmit.delete('a'); releaseSlot(); }, 2000);

  const sent = f.manager.message('a', 'проверь').then(
    ok => ({ ok }),
    error => ({ error }),
  );
  waiters.push(sent);
  const result = await Promise.race([
    sent,
    new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 15_000)),
  ]);
  assert.ok(!result.timeout, 'повтор не должен ждать вечно');
  assert.ok(!result.error, `BUSY не должен проваливать отправку: ${result.error?.message}`);
  assert.ok(result.ok, 'сообщение доставлено после освобождения слота');
  // Доставка действительно дошла до Pi (fake-pi пишет в sent).
  assert.ok(f.sent.includes('проверь'), `отправлено в Pi: ${JSON.stringify(f.sent)}`);
});
