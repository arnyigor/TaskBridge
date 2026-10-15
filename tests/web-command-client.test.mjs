import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandClient } from '../web/command-client.mjs';

test('unknown command outcomes stay ambiguous without another POST', async () => {
  for (const code of ['UNKNOWN_AFTER_CRASH', 'UNKNOWN_OUTCOME']) {
    let effects = 0;
    const client = createCommandClient({
      transport: { request: async method => {
        if (method === 'POST') { effects++; throw Object.assign(new Error('unknown'), { code }); }
        return { status: 'UNKNOWN_AFTER_CRASH', done: false };
      } },
    });
    await assert.rejects(client.commandApi('/api/tasks/t/message', { text: 'once' }), error =>
      error.ambiguous === true && error.cause.code === code && Boolean(error.commandId));
    assert.equal(effects, 1);
  }
});
