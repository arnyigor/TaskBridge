import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { EventMux } from '../src/events/event-mux.mjs';

for (const asyncFailure of [false, true]) {
  test(`EventMux isolates ${asyncFailure ? 'asynchronous' : 'synchronous'} transport failure`, async () => {
    const logs = [];
    const delivered = [];
    const observed = [];
    const mux = new EventMux({ machineId: 'machine', logger: (...entry) => logs.push(entry) });
    const fail = () => { throw new Error('transport unavailable'); };
    mux.addTransport({ publishEvents: asyncFailure ? async () => fail() : fail });
    mux.addTransport({ publishEvents: events => delivered.push(...events) });
    mux.on('event', event => observed.push(event));
    const published = mux.publishLocal('session', 'task_finished', { status: 'SUCCEEDED' });
    await setImmediate();
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'warn');
    assert.equal(logs[0][1].event, 'transport_failed');
    assert.equal(logs[0][1].message, 'transport unavailable');
    assert.deepEqual(delivered, published);
    assert.deepEqual(observed, published);
    assert.equal(published.length, 1);
  });
}
