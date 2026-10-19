import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

// What a session looks like to a client when Pi misbehaves (backend plan B0:
// characterisation before the runtime refactor). Failure modes: tests/fake-pi.mjs.

const ACTIVE = ['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'VERIFYING', 'CANCELLING'];

async function settle(api, id, { tries = 200, delay = 50 } = {}) {
  let task;
  for (let i = 0; i < tries; i++) {
    task = await api(`/api/tasks/${id}`);
    if (!ACTIVE.includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(`task stayed ${task.status}`);
}

async function until(check, { tries = 200, delay = 50 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error('condition not met in time');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

test('Pi crashing mid tool call fails the turn with the reason, and the next message resumes', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-crash now' });

  const failed = await settle(api, task.id);
  assert.equal(failed.status, 'FAILED', 'not stuck in RUNNING');
  assert.equal(failed.errorCode, 'PI_SESSION_FAILED');
  assert.match(failed.error, /code=3/);
  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  assert.ok(events.some(event => event.type === 'PI_STDERR' && /simulated crash/.test(event.message || JSON.stringify(event.data))),
    'the stderr tail is kept with the session');

  await api(`/api/tasks/${task.id}/message`, { text: 'снова' });
  const resumed = await settle(api, task.id);
  assert.equal(resumed.status, 'SUCCEEDED', resumed.error || '');
});

test('a steer Pi accepted but died before consuming is re-queued, not lost', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  // A hung tool keeps the session streaming, so the next message goes in as a steer.
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-hang' });
  await until(async () => {
    const events = await api(`/api/tasks/${task.id}/events?limit=0`);
    return events.some(event => event.type === 'PI_EVENT' && JSON.stringify(event.data || '').includes('tool_execution_start'));
  });

  // The steer Pi accepts into its own queue and dies before consuming it.
  await api(`/api/tasks/${task.id}/message`, { text: 'fault-queue-crash' });
  const failed = await settle(api, task.id);
  assert.equal(failed.status, 'FAILED', 'not stuck in RUNNING');
  assert.equal(failed.errorCode, 'PI_SESSION_FAILED');
  assert.equal((failed.pendingPrompts || []).length, 1, 'the unconsumed steer is re-queued, not lost');
  assert.equal(failed.pendingPrompts[0].text, 'fault-queue-crash');
  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  const failedSeq = events.filter(event => event.type === 'TASK_FAILED').at(-1).seq;
  assert.ok(events.some(event => event.type === 'PROMPT_QUEUED' && event.seq < failedSeq),
    'PROMPT_QUEUED is published before the terminal event');

  // The queue line delivers it via «Сейчас» or the next message; here the
  // restored prompt is dropped and a clean message resumes the session. The
  // fixture cannot verify the re-delivery itself: its fault fires per process,
  // and a restart starts a fresh one (same text → same fault).
  await api(`/api/tasks/${task.id}/pending`, null, 'DELETE');
  await api(`/api/tasks/${task.id}/message`, { text: 'снова' });
  const resumed = await settle(api, task.id);
  assert.equal(resumed.status, 'SUCCEEDED', resumed.error || '');
});

test('a hung session is restarted by request, and the next message resumes it', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-hang' });
  await until(async () => {
    const events = await api(`/api/tasks/${task.id}/events?limit=0`);
    return events.some(event => event.type === 'PI_EVENT' && JSON.stringify(event.data || '').includes('tool_execution_start'));
  });

  const restarted = await api(`/api/tasks/${task.id}/session/restart`, {});
  assert.equal(restarted.status, 'FAILED');
  assert.equal(restarted.errorCode, 'FAILED_RECOVERY');
  assert.match(restarted.error, /перезапущена/);

  // A dead Pi must not make the session unfixable: the model switch is
  // persisted and applies at the next start.
  const switched = await api(`/api/tasks/${task.id}/model`, { provider: 'other', id: 'other' });
  assert.equal(switched.model.id, 'other');

  await api(`/api/tasks/${task.id}/message`, { text: 'снова' });
  const resumed = await settle(api, task.id);
  assert.equal(resumed.status, 'SUCCEEDED', resumed.error || '');
});

test('garbage on Pi stdout is recorded and the turn still completes', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-garbage' });
  const done = await settle(api, task.id);
  assert.equal(done.status, 'SUCCEEDED', done.error || '');
  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  assert.equal(events.filter(event => event.type === 'PI_PROTOCOL_ERROR').length, 2);
});

// Pi answers the abort and then starts another turn half a second later (the tail
// it had already queued). Those frames used to be handled like any other:
// `agent_start` flipped the just-cancelled task back to RUNNING and the thinking
// delta went into the chat, so the operator saw reasoning continue after STOP.
test('STOP sticks: the frames Pi sends after abort do not revive the turn', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-abort-tail' });
  await until(async () => (await api(`/api/tasks/${task.id}`)).status === 'RUNNING');
  await api(`/api/tasks/${task.id}/cancel`, {});
  const stopped = await settle(api, task.id, { tries: 400 });
  assert.equal(stopped.status, 'CANCELLED', stopped.error || '');
  const thinking = stopped.thinkingText || '';
  // The tail arrives ~0.5 s after the abort response; 0.5 s later it must still
  // be ignored — no status flip and no reasoning added to the answer.
  await new Promise(resolve => setTimeout(resolve, 1200));
  const after = await api(`/api/tasks/${task.id}`);
  assert.equal(after.status, 'CANCELLED', 'the late agent_start must not set RUNNING');
  assert.equal(after.thinkingText || '', thinking, 'no reasoning may be appended after STOP');
});

test('STOP ends a turn whose Pi ignores abort, and takes its child processes down', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-deaf fault-child' });
  await until(async () => (await api(`/api/tasks/${task.id}`)).status === 'RUNNING');
  const childPid = await until(async () => {
    const events = await api(`/api/tasks/${task.id}/events?limit=0`);
    const line = events.filter(event => event.type === 'PI_STDERR').map(event => event.message || JSON.stringify(event.data)).join('\n');
    const match = line.match(/fake-pi child (\d+)/);
    return match ? Number(match[1]) : null;
  });
  t.after(() => { try { process.kill(childPid, 'SIGKILL'); } catch {} });

  await api(`/api/tasks/${task.id}/cancel`, {});
  const stopped = await settle(api, task.id, { tries: 400 });
  assert.equal(stopped.status, 'CANCELLED', stopped.error || '');
  if (process.platform !== 'win32') {
    await until(async () => !alive(childPid), { tries: 100 }).catch(() => {});
    assert.equal(alive(childPid), false, `child ${childPid} outlived STOP`);
  }
});

// While a model is being retried, Pi's own retry/limits-wait notices say «…
// retrying after error in 0m 05s. Error: Connection error.» — an error the agent
// DOES NOT have: it is still alive and will retry. Rendered verbatim in the chat
// they turned a working turn into a wall of failures (reported 2026-09-29). The
// retry-in-progress notices are dropped from the chat; a genuine failure notice
// and the raw frames (pi-events.jsonl) stay.
test('retry-in-progress notices are not shown as errors while the model is working', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-notices' });
  const done = await settle(api, task.id);
  assert.equal(done.status, 'SUCCEEDED', done.error || '');

  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  const notices = events.filter(event => event.type === 'UI_NOTIFY').map(event => event.message || '');
  assert.deepEqual(notices, ['Smart compaction failed safely and was cancelled: Connection error.'],
    'only the genuine failure may reach the chat');

  // Dropped from the chat, not from the record: the frame is still on disk, so a
  // retry loop stays diagnosable.
  const raw = await fs.readFile(path.join(fixture.root, 'data', 'tasks', task.id, 'artifacts', 'pi-events.jsonl'), 'utf8');
  assert.match(raw, /retrying after error in 0m 05s/);
});

// Тишина провайдера — не работа модели, но без разбора уведомления она выглядела
// именно работой: 2026-10-09 wormsoft ответил HTTP 429 «user reached the limit»
// с `retry-after-ms 5452000`, и сессия полтора часа показывала «Pi is working»
// без событий модели, без ошибки и без способа отличить молчащего провайдера от
// сломанного моста. Известное ожидание показывается один раз на раунд (объявление
// приходит каждые 15 с), с моментом повтора и без пузыря в чате.
test('a provider wait is reported with its retry moment and stays one note per round', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const observedStart = Date.now();
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-provider-wait' });

  const waiting = await until(async () => {
    const current = await api(`/api/tasks/${task.id}`);
    return current.providerWait ? current : null;
  });
  const wait = waiting.providerWait;
  assert.equal(wait.kind, 'rate-limit');
  assert.equal(wait.model, 'wormsoft/anthropic/claude-opus-5.5');
  assert.equal(wait.provider, 'wormsoft');
  assert.equal(wait.httpStatus, 429);
  assert.equal(wait.reason, 'user reached the limit', 'причина — словами провайдера, а не сырой строкой уведомления');
  // The machine frame carries remainingMs, computed after its planned deadline.
  // Time spent writing the preceding tool frame is real, including a few ms on
  // slower Windows runners; the remaining budget cannot exceed the plan or
  // shrink by more than the elapsed observation window.
  assert.ok(wait.waitMs <= 5_472_000 && wait.waitMs >= 5_472_000 - (Date.now() - observedStart),
    `остаток объявленного ожидания: ${wait.waitMs}`);
  const left = Date.parse(wait.retryAt) - Date.parse(wait.at);
  assert.ok(Math.abs(left - wait.waitMs) < 2000, `retryAt — абсолютный момент повтора (${left} мс)`);
  assert.equal(waiting.runtime.state, 'WORKING');
  assert.equal(waiting.runtime.activity, 'waiting_model', '«streaming» означало бы, что провайдер отвечает');
  assert.match(waiting.current, /^Ждём провайдера: HTTP 429/);

  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  const waits = events.filter(event => event.type === 'PROVIDER_WAIT');
  assert.equal(waits.length, 1, 'тик того же раунда — не второе сообщение');
  assert.match(waits[0].message, /не принял запрос: HTTP 429 «user reached the limit»/);
  assert.match(waits[0].message, /повторит через 1 ч 31 мин/);
  assert.equal(waits[0].data.retryAt, wait.retryAt);
  assert.deepEqual(events.filter(event => event.type === 'UI_NOTIFY'), [], 'объявление о повторе по-прежнему не пузырь чата');
});

// Тот же отказ, но так, как его объявляет живой Pi (2026-10-12, сессия
// openai-codex/gpt-5.6-sol): один эпизод пришёл тремя кадрами и разными словами —
// «<модель> network/timeout error for 0m 15s; waiting, then retrying. Error: fetch
// failed» (сам Pi), «⏳ pi-limits-wait: network/timeout error on <модель>; … Why:
// fetch failed» (расширение) и машинным кадром с тем же `periodId`. Раундом
// считался дедлайн, поэтому на один отказ в чат уходило три заметки: «Провайдер
// не принял запрос: fetch failed», «… через 15 с» и «Провайдер
// openai-codex/gpt-5.6-sol … через 15 с». Оператор читал это как ошибку там, где
// субагент ещё работал («немного бредово… ошибок стало больше»).
test('a retry episode stays one note, and Pi\'s own wording names the model', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-provider-flap' });
  const done = await settle(api, task.id);
  assert.equal(done.status, 'SUCCEEDED', done.error || '');
  assert.equal(done.providerWait, null, 'ожидание не переживает свой эпизод');

  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  const waits = events.filter(event => event.type === 'PROVIDER_WAIT');
  assert.equal(waits.length, 2, 'тик того же эпизода — не второе сообщение, новый период — сообщение');
  // Первый эпизод объявила проза самого Pi: модель названа, «retrying after error
  // in …» не делает моделью слово «in».
  assert.match(waits[0].message,
    /^Провайдер openai-codex\/gpt-5\.6-sol не принял запрос: fetch failed\./);
  assert.match(waits[0].message, /повторит через 15 с/, 'текст — снимок начала эпизода, а не последнего тика (5 с)');
  assert.equal(waits[0].data.model, 'openai-codex/gpt-5.6-sol');
  assert.equal(waits[0].data.reason, 'fetch failed', 'причина — из оборота «Error:/Why: …», без точки на конце');
  assert.equal(waits[0].data.waitMs, 15000, 'срок — из оборота «error for 0m 15s»');
  // Второй эпизод назвал машинный кадр — и по нему же видно, что эпизод новый.
  assert.equal(waits[1].data.periodId, 'period-flap-2');
  assert.match(waits[1].message, /повторит через 5 с/);
  assert.deepEqual(events.filter(event => event.type === 'PROVIDER_WAIT_END').map(event => event.message),
    ['Провайдер снова отвечает']);
  assert.deepEqual(events.filter(event => event.type === 'UI_NOTIFY'), [], 'объявление о повторе — не пузырь чата');
});

// Отказ, после которого повтора не будет (2026-10-12). Расширение говорит об этом
// прозой («<модель> failed and pi-limits-wait is not retrying: <причина>») и машинным
// кадром `give_up`. До этой правки состояние «ждём провайдера» оставалось взведённым до
// терминального статуса сессии (то есть обещало повтор, которого не будет), а в чат
// уходила сырая английская строка без модели и причины.
test('a give-up ends the wait and reaches the chat in our own words', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-provider-give-up' });

  const notice = await until(async () => {
    const events = await api(`/api/tasks/${task.id}/events?limit=0`);
    return events.find(event => event.type === 'UI_NOTIFY' && event.data?.giveUp) || null;
  });
  assert.equal(notice.message, 'Провайдер strata-iq3/qwen3.8-flash не принял запрос и повторять не будет: Connection error.');

  // Состояние ожидания снимает сам кадр `give_up`, а не конец сессии: ход в фикстуре
  // остаётся открытым, поэтому статус ещё RUNNING.
  const cleared = await until(async () => {
    const current = await api(`/api/tasks/${task.id}`);
    return current.status === 'RUNNING' && current.providerWait === null ? current : null;
  });
  assert.equal(cleared.providerWait, null, '«ждём провайдера» после give_up — ложь');

  const events = await api(`/api/tasks/${task.id}/events?limit=0`);
  assert.equal(events.filter(event => event.type === 'PROVIDER_WAIT').length, 1, 'ожидание до отказа объявляется один раз');
  assert.deepEqual(
    events.filter(event => event.type === 'UI_NOTIFY').map(event => event.message),
    ['Провайдер strata-iq3/qwen3.8-flash не принял запрос и повторять не будет: Connection error.'],
    'сырая строка расширения в чат не попадает',
  );
});

// Speeds for a local model. Two measured errors, both fixed and pinned here:
//  - PP was prompt-tokens / time-to-first-token. A local engine keeps the prompt
//    in its KV cache and prefills only the new tail — Strata's own log for one
//    turn: «prompt 82996 tokens = 82643 reused + 353 read in 1982 ms», i.e.
//    178 tok/s of real prefill work while the UI claimed 32 895. Without the
//    engine's counter there is nothing to report, so PP is null, not invented.
//  - TG summed only gaps of ≤2 s between deltas and dropped the rest. A local
//    engine chunking slower than that lost most of its window: 50.4 tok/s shown
//    where the server said 36.7 (1054 generated in 28726 ms), and 100 tok/s in
//    another turn. The window is now the message's own span, first delta to end.
test('local model speeds: no invented PP, and TG over the real generation window', { timeout: 60000 }, async t => {
  const fixture = await startFixture(undefined, {
    root: { localRuntime: { externalServers: [{ provider: 'fixture', model: 'fixture', baseUrl: 'http://127.0.0.1:9' }] } }
  });
  t.after(() => fixture.close());
  const { api } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-slow-stream', model: { provider: 'fixture', id: 'fixture' } });
  const done = await settle(api, task.id);
  assert.equal(done.status, 'SUCCEEDED', done.error || '');
  const metrics = done.metrics;
  assert.equal(metrics.pp, null, 'a KV-cached local prompt has no measurable prefill rate');
  assert.equal(metrics.ppSource, null);
  assert.equal(metrics.ppApproximate, false);
  assert.equal(metrics.inputTokens, 1000, 'the prompt size is still reported');
  assert.equal(metrics.outputTokens, 8);
  // 8 tokens over the ~3.4 s window, the 3 s pause included: ~2.4 tok/s. The old
  // gap-summing arithmetic reported >10 tok/s for the very same stream.
  assert.ok(metrics.tg > 0 && metrics.tg < 5, `tg=${metrics.tg} (expected ~2.4 tok/s)`);
  assert.equal(metrics.tgSource, 'usage');
  assert.equal(metrics.source, 'usage');
  // Session speeds: one turn with TG and no PP must leave the PP average empty
  // instead of counting a zero (that is how a cache hit would drag it down).
  assert.equal(done.speeds.turns, 1);
  assert.equal(done.speeds.ppMax, null);
  assert.equal(done.speeds.ppAvg, null);
  assert.equal(done.speeds.ppTurns, 0);
  assert.equal(done.speeds.tgTurns, 1);
  assert.equal(done.speeds.tgAvg, metrics.tg);
});

for (const shape of ['notice', 'structured']) {
  test(`incompatible model/auth stops Pi retries (${shape}) and allows a corrected follow-up`, { timeout: 60000 }, async t => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: `fault-provider-incompatible ${shape}` });
    const failed = await settle(fixture.api, task.id);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.errorCode, 'MODEL_AUTH_INCOMPATIBLE');
    assert.equal(failed.retryable, false);
    assert.equal(failed.providerWait, null);
    assert.equal(failed.piPid, null);
    assert.match(failed.error, /openai-codex/);
    const events = await fixture.api(`/api/tasks/${task.id}/events?limit=0`);
    assert.equal(events.filter(e => e.type === 'TASK_FAILED').length, 1);
    assert.equal(events.filter(e => e.type === 'PROVIDER_WAIT').length, 0);
    await fixture.api(`/api/tasks/${task.id}/message`, { text: 'corrected follow-up' });
    const resumed = await settle(fixture.api, task.id);
    assert.equal(resumed.status, 'SUCCEEDED', resumed.error || '');
  });
}

for (const [failure, code] of [['invalid-auth', 'ENGINE_AUTH'], ['empty-quota', 'QUOTA_EXCEEDED'], ['body-limit', 'REQUEST_TOO_LARGE']]) {
  for (const shape of ['notice', 'structured']) {
    test(`permanent provider failure ${code} stops announced retries (${shape})`, { timeout: 60000 }, async t => {
      const fixture = await startFixture();
      t.after(() => fixture.close());
      const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: `fault-provider-incompatible ${failure} ${shape}` });
      const failed = await settle(fixture.api, task.id);
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.errorCode, code);
      assert.equal(failed.retryable, false);
      assert.equal(failed.providerWait, null);
      assert.equal(failed.piPid, null);
      const events = await fixture.api(`/api/tasks/${task.id}/events?limit=0`);
      assert.equal(events.filter(e => e.type === 'TASK_FAILED').length, 1);
      assert.equal(events.filter(e => e.type === 'PROVIDER_WAIT').length, 0);
      await fixture.api(`/api/tasks/${task.id}/message`, { text: 'corrected follow-up' });
      const resumed = await settle(fixture.api, task.id);
      assert.equal(resumed.status, 'SUCCEEDED', resumed.error || '');
    });
  }
}
