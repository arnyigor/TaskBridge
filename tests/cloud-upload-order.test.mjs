import test from 'node:test';
import assert from 'node:assert/strict';
import { EventUploader } from '../src/cloud/event-uploader.mjs';

test('a concurrent enqueue cannot overtake a slow earlier write or escape drain', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const records = [];
  const uploaded = [];
  const outbox = {
    async enqueue(events) { if (events[0].seq === 1) await gate; const row = { events }; records.push(row); return row; },
    enforceLimit: async () => {}, list: async () => [...records], markSending: async () => {},
    ack: async record => { records.splice(records.indexOf(record), 1); }
  };
  const reconnect = { markConnected() {}, cancel() {} };
  const uploader = new EventUploader({ outbox, reconnect, client: { uploadEvents: async events => uploaded.push(...events.map(e => e.seq)) } });
  const first = uploader.send([{ seq: 1 }]);
  const second = uploader.send([{ seq: 2 }]);
  const drained = uploader.drain();
  await Promise.resolve();
  assert.deepEqual(uploaded, []);
  release();
  await Promise.all([first, second, drained]);
  assert.deepEqual(uploaded, [1, 2]);
  assert.equal(records.length, 0);
  await uploader.stop();
  assert.equal(await uploader.send([{ seq: 3 }]), null);
});
