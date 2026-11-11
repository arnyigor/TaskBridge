import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFixture } from './server-fixture.mjs';

test('Codex reset requires explicit confirmation and valid request ID before contacting upstream', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const post = body => fetch(`${fixture.base}/api/providers/openai-codex/reset`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const body of [{}, { confirmed: false }, { confirmed: true, requestId: 'invalid' }]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INPUT_INVALID');
  }
});
