import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';
import { API_ROUTES, API_VERSION } from '../src/api-contract.mjs';

// The published contract is only worth having if a client can trust it, so this
// test drives every route in src/api-contract.mjs against a real server.
//
// "The route exists" is checked by the *body*, not the status: an unknown path
// and a missing session both answer 404, but only the former says
// `{ error: 'Not found' }`. A route that answers any other way is present, even
// if it refuses the empty body these probes send.
const NOT_ROUTED = (status, body) => status === 404 && body?.error === 'Not found';

const FILE_ID = '00000000-0000-0000-0000-000000000000';

function fill(path, { taskId, projectId }) {
  return path
    .replace('/api/projects/:id', `/api/projects/${projectId}`)
    .replaceAll(':fileId', FILE_ID)
    .replaceAll(':turnId', 'turn-1')
    .replaceAll(':name', 'result.md')
    .replaceAll(':toolCallId', 'tool-1')
    .replaceAll(':approvalId', 'appr-1')
    .replaceAll(':commandId', 'cmd-1')
    .replaceAll(':id', taskId);
}

test('every published route is really served, and none answers "Not found"', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const created = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'contract probe' });

  // Deleting routes go last: DELETE /api/tasks/:id would remove the id the other
  // probes need, and every later route would then fail for the wrong reason.
  const ordered = [...API_ROUTES].sort((a, b) => Number(a.method === 'DELETE') - Number(b.method === 'DELETE'));

  const missing = [];
  for (const route of ordered) {
    if (route.sse) continue; // a live stream never ends on its own
    const url = fixture.base + fill(route.path, { taskId: created.id, projectId: 'fixture' });
    const response = await fetch(url, {
      method: route.method,
      signal: AbortSignal.timeout(15000),
      ...(route.method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: '{}' }),
    });
    const body = await response.json().catch(() => null);
    if (NOT_ROUTED(response.status, body)) missing.push(`${route.method} ${route.path}`);
  }

  assert.deepEqual(missing, [], `routes in the contract that the server does not answer:\n  ${missing.join('\n  ')}`);
});

test('the running server announces the contract version it implements', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  // Clients key their behaviour off this number, so it must be present and it
  // must be the same one the contract file (and docs/api-contract.md) declares.
  const info = await fixture.api('/api/info');
  assert.equal(info.apiVersion, API_VERSION);
});
