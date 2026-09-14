import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';
import { createReverseProxy } from '../src/proxy.mjs';
import { API_ROUTES, API_VERSION } from '../src/api-contract.mjs';

// The point of variant B (docs/agent-host-separation.md §12) is that the proxy
// adds a door, not a second API. So the contract does not get a second
// implementation to check — the *same* published contract is driven through the
// proxy, and parity is a property of the whole surface rather than of the six
// routes someone remembered to port.

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

async function withProxy(t) {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const upstreamPort = Number(new URL(fixture.base).port);
  const proxy = createReverseProxy({ upstreamPort, port: 0, host: '127.0.0.1', logger: { error: () => {} } });
  await proxy.listen();
  t.after(() => proxy.close());
  return { fixture, proxy, base: `http://127.0.0.1:${proxy.port}` };
}

test('the proxy reports the real build, not a placeholder of its own', { timeout: 30000 }, async t => {
  const { base, fixture } = await withProxy(t);

  const direct = await (await fetch(`${fixture.base}/api/info`)).json();
  const proxied = await (await fetch(`${base}/api/info`)).json();

  // The gateway's stub answered `version: 'gateway'`; a pass-through must not.
  assert.notEqual(proxied.build.version, 'gateway');
  assert.equal(proxied.build.version, direct.build.version);
  assert.equal(proxied.apiVersion, API_VERSION);
  assert.equal(proxied.build.commit, direct.build.commit);
});

test('every published route answers through the proxy as it does directly', { timeout: 60000 }, async t => {
  const { base, fixture } = await withProxy(t);
  const created = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'proxy parity' });

  // Deleting routes go last, so the id the other probes need survives.
  const ordered = [...API_ROUTES].sort((a, b) => Number(a.method === 'DELETE') - Number(b.method === 'DELETE'));
  const missing = [];
  for (const route of ordered) {
    if (route.sse) continue; // a live stream never ends on its own
    const path = fill(route.path, { taskId: created.id, projectId: 'fixture' });
    const response = await fetch(base + path, {
      method: route.method,
      signal: AbortSignal.timeout(15000),
      ...(route.method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: '{}' }),
    });
    const body = await response.json().catch(() => null);
    if (NOT_ROUTED(response.status, body)) missing.push(`${route.method} ${route.path}`);
  }

  assert.deepEqual(missing, [], `routes the proxy does not carry through:\n  ${missing.join('\n  ')}`);
});

test('a live event stream crosses the proxy and starts before the task finishes', { timeout: 40000 }, async t => {
  const { base, fixture } = await withProxy(t);
  const created = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'stream through proxy' });

  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/api/tasks/${created.id}/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

  // One real frame is enough: it proves the replay crossed the proxy as SSE and
  // not as a buffered body the client would only see at the end.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  try {
    while (!/data:/.test(seen)) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('no SSE frame within 15s')), 15000)),
      ]);
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
  }
  assert.match(seen, /data: /);
});
