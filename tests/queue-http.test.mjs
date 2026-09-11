import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startFixture } from './server-fixture.mjs';

// A llama.cpp router stand-in whose slots can be made "processing", which is what
// TaskBridge reads to decide that the local model is busy.
async function fakeRouter(t) {
  let processing = true;
  const loaded = new Set(['qwen-27b']);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/health') return res.end('{"status":"ok"}');
    if (req.method === 'GET' && url.pathname === '/models') {
      return res.end(JSON.stringify({
        data: [...loaded].map(id => ({ id, status: { value: 'loaded' }, meta: { n_ctx: 33792 } }))
      }));
    }
    if (url.pathname === '/slots') {
      return res.end(JSON.stringify([{ model: 'qwen-27b', is_processing: processing }]));
    }
    if (req.method === 'POST' && url.pathname === '/models/load') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => { loaded.add(JSON.parse(body).model); res.end('{}'); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/models/unload') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => { loaded.delete(JSON.parse(body).model); res.end('{}'); });
      return;
    }
    if (url.pathname === '/models/sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(': ok\n\n'); }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, free: () => { processing = false; } };
}

async function fixtureWithLocalModel(t) {
  const router = await fakeRouter(t);
  const fixture = await startFixture(0, {
    root: {
      localRuntime: { provider: 'llama.cpp', healthUrl: `${router.base}/health`, router: { enabled: true } },
      queue: { pollMs: 50 }
    }
  });
  t.after(() => fixture.close());
  return { fixture, router };
}

const LOCAL_MODEL = { provider: 'llama.cpp', id: 'qwen-27b' };

async function waitFor(fn, { tries = 200, delay = 50 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn().catch(error => ({ error }));
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(`condition not met: ${JSON.stringify(last)}`);
}

test('while the model is busy a prompt is queued, not refused, and it is visible', { timeout: 40000 }, async t => {
  const { fixture } = await fixtureWithLocalModel(t);

  // The model is busy: the session is accepted and waits instead of failing.
  const created = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'первое', model: LOCAL_MODEL });
  assert.equal(created.status, 'QUEUED', JSON.stringify(created).slice(0, 300));
  assert.equal(created.queueReason, 'MODEL_BUSY');

  // A follow-up typed while it waits joins the same queue, in order.
  const queued = await fixture.api(`/api/tasks/${created.id}/message`, { text: 'второе', queue: true });
  assert.equal(queued.queueReason, 'MODEL_BUSY');
  assert.deepEqual(queued.pendingPrompts.map(entry => entry.text), ['второе']);
  assert.equal(queued.workspacePath, null, 'nothing is prepared while waiting');

  // And nothing was sent to Pi behind the operator's back.
  const events = await fixture.api(`/api/tasks/${created.id}/events?limit=0`);
  assert.equal(events.some(event => event.type === 'USER_MESSAGE'), false);

  // "Отправить сейчас" cannot start a second generation: it says who owns the
  // machine and leaves the prompt in the queue.
  await assert.rejects(
    fixture.api(`/api/tasks/${created.id}/pending/send`, {}),
    error => /занят/i.test(error.message) && ['BUSY', 'MODEL_BUSY'].includes(error.code),
    'send now must explain that the model is still held');
  const after = await fixture.api(`/api/tasks/${created.id}`);
  assert.deepEqual(after.pendingPrompts.map(entry => entry.text), ['второе'], 'the prompt is not lost');
});

test('the queued prompt is delivered by itself when the model frees up', { timeout: 40000 }, async t => {
  const { fixture, router } = await fixtureWithLocalModel(t);

  const created = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'из очереди', model: LOCAL_MODEL });
  assert.equal(created.status, 'QUEUED');
  await fixture.api(`/api/tasks/${created.id}/message`, { text: 'второе', queue: true });
  await fixture.api(`/api/tasks/${created.id}/message`, { text: 'третье', queue: true });

  // The initial prompt lives in task.prompt until the session starts; the
  // follow-ups wait in pendingPrompts, in the order they were typed.
  const before = await fixture.api(`/api/tasks/${created.id}`);
  assert.equal(before.status, 'QUEUED');
  assert.equal(before.prompt, 'из очереди');
  assert.deepEqual(before.pendingPrompts.map(entry => entry.text), ['второе', 'третье']);

  // The operator does nothing: the model just becomes free.
  router.free();

  const finished = await waitFor(async () => {
    const task = await fixture.api(`/api/tasks/${created.id}`);
    return ['SUCCEEDED', 'FAILED'].includes(task.status) ? task : null;
  }, { tries: 300, delay: 100 });
  assert.equal(finished.status, 'SUCCEEDED', finished.error || '');
  assert.equal((finished.pendingPrompts || []).length, 0, 'the queue drained');

  // The initial prompt starts the session (it is the run's input, not a
  // USER_MESSAGE event), and both queued follow-ups reached Pi in order.
  const events = await fixture.api(`/api/tasks/${created.id}/events?limit=0`);
  const userMessages = events.filter(event => event.type === 'USER_MESSAGE').map(event => event.data?.text);
  assert.deepEqual(userMessages, ['второе', 'третье'], `delivery order: ${JSON.stringify(userMessages)}`);
  // Pi saw all three prompts: the run itself used the initial prompt, and both
  // queued follow-ups were replayed into the same session.
  const { state } = await fixture.api(`/api/tasks/${created.id}/state`);
  assert.ok(state.messageCount >= 3, `Pi message count: ${state.messageCount}`);
});
