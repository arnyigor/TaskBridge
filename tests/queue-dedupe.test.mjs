import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/manager-fixture.mjs';

// REL-01E: two identical texts must not both park in one session's queue.
// Journal 2026-11-22 08:18: a slow delivery (Pi 1.5.2 silent cold start) made
// the operator resend; the server parked both copies and the pump delivered
// the same message twice (prompt, then steer).
test('a second identical text is refused while one copy waits in the queue', async t => {
  const cleanups = [];
  const f = await fixture({ after(fn) { cleanups.push(fn); } }, true);
  try {
    f.state.isStreaming = true; // Session busy: prompts park when queue=true.
    await f.manager.message('a', 'дубль текста', 'auto', [], null, { queue: true });
    for (let i = 0; i < 200 && !(f.task.pendingPrompts || []).length; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal((f.task.pendingPrompts || []).length, 1, 'the first copy parks');
    await assert.rejects(
      () => f.manager.message('a', 'дубль текста', 'auto', [], null, { queue: true }),
      error => {
        console.log('second send ->', error.code, error.message);
        return error.code === 'ALREADY_QUEUED';
      },
      'an identical text must not park twice',
    );
    assert.deepEqual((f.task.pendingPrompts || []).map(p => p.text), ['дубль текста']);
  } finally {
    for (const waiter of f.runtime.settleResolvers.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
    for (const cleanup of cleanups) await cleanup();
  }
});
