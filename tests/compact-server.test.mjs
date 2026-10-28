import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startFixture } from './server-fixture.mjs';
import { ChatState } from '../web/chat-state.mjs';

const projection = state => state.displayTurns.map(item => ({ id: item.id, role: item.role, text: item.text, tools: item.tools?.map(tool => tool.id) }));

test('captured Pi compact stream survives HTTP history, SSE reconnect and server restart', { timeout: 60000 }, async t => {
  const fixture = await startFixture(0, { env: { FAKE_PI_RECORDING: fileURLToPath(new URL('./fixtures/compaction/pi-1.4.0-auto.json', import.meta.url)) } });
  t.after(() => fixture.close());
  const created = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: '[compact-recording]' });
  const live = new ChatState(created);
  const received = [];
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = fetch(`${fixture.base}/api/tasks/${created.id}/stream`, { signal: controller.signal }).then(async response => {
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        const match = /^data: (.*)$/m.exec(frame);
        if (!match) continue;
        const event = JSON.parse(match[1]);
        if (!Number.isSafeInteger(event.seq)) continue;
        received.push(event);
        live.apply(event);
        if (['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_CANCELLED'].includes(event.type)) return;
      }
    }
  });
  await Promise.race([stream, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('SSE did not settle')), 20000);
    timer.unref();
    stream.finally(() => clearTimeout(timer)).catch(() => {});
  })]);
  controller.abort();
  assert.equal(received.at(-1).type, 'TASK_SUCCEEDED');
  assert(received.every((event, i) => i === 0 || event.seq > received[i - 1].seq));
  const boundary = received.find(event => event.data?.pi?.type === 'compaction_end' && event.data.pi.result);
  assert(boundary);
  assert.equal(received.filter(event => event.data?.pi?.type === 'agent_start').length, 1);
  assert.deepEqual(live.displayTurns.map(item => item.role), ['user', 'assistant', 'note', 'assistant', 'note']);
  assert.deepEqual(live.displayTurns.filter(item => item.role === 'assistant').map(item => item.text), ['BEFORE', 'AFTER']);

  const history = await fixture.api(`/api/tasks/${created.id}/events?limit=0`);
  const restored = new ChatState(created);
  history.forEach(event => restored.apply(event));
  assert.deepEqual(projection(restored), projection(live));

  // A reconnect from the successful boundary uses server-allocated sequence IDs.
  const replayController = new AbortController();
  const replayResponse = await fetch(`${fixture.base}/api/tasks/${created.id}/stream`, {
    headers: { 'last-event-id': String(boundary.seq) }, signal: replayController.signal,
  });
  const reader = replayResponse.body.getReader();
  let data = '';
  const decoder = new TextDecoder();
  try {
    while (!data.includes('TASK_SUCCEEDED')) {
      const chunk = await reader.read();
      assert(!chunk.done);
      data += decoder.decode(chunk.value, { stream: true });
    }
  } finally { replayController.abort(); }
  const resumed = [...data.matchAll(/^data: (.*)$/gm)].map(match => JSON.parse(match[1])).filter(event => Number.isSafeInteger(event.seq));
  assert(resumed.length > 0);
  assert(resumed.every(event => event.seq > boundary.seq));
  resumed.forEach(event => live.apply(event));
  assert.deepEqual(projection(live), projection(restored), 'reconnect cannot duplicate segments');

  await fixture.restart();
  const afterRestart = new ChatState(created);
  const persisted = await fixture.api(`/api/tasks/${created.id}/events?limit=0`);
  persisted.forEach(event => afterRestart.apply(event));
  assert.deepEqual(projection(afterRestart), projection(restored));
  assert.equal(persisted.filter(event => event.type === 'TASK_SUCCEEDED').length, 1);
});
