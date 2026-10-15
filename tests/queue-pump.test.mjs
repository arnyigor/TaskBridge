import test from 'node:test';
import assert from 'node:assert/strict';
import { QueuePump } from '../src/application/queue-pump.mjs';

test('wake during blocked dispatch preserves the next dispatch without overlapping it', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let queued = 2;
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const pump = new QueuePump({
    isClosing: () => false,
    hasQueued: () => queued > 0,
    hasCapacity: () => true,
    pollMs: () => 1000,
    dispatch: async () => {
      calls++;
      maxActive = Math.max(maxActive, ++active);
      if (calls === 1) await gate;
      queued--;
      active--;
      return false; // Only the concurrent wake can trigger the next attempt.
    },
  });
  const first = pump.wake();
  await pump.wake();
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  assert.equal(queued, 0);
  assert.equal(pump.timer, null);
});

test('shutdown during dispatch drains it and cannot rearm polling', async () => {
  let closing = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const pump = new QueuePump({
    isClosing: () => closing,
    hasQueued: () => true,
    hasCapacity: () => false,
    pollMs: () => 1000,
    dispatch: async () => { calls++; await gate; return false; },
  });
  pump.schedule();
  const running = pump.wake();
  closing = true;
  pump.stopPolling();
  const drained = pump.drain(1000);
  release();
  await Promise.all([running, drained]);
  await pump.wake();
  assert.equal(calls, 1);
  assert.equal(pump.running, false);
  assert.equal(pump.timer, null);
});
