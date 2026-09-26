import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startFixture } from './server-fixture.mjs';

// Stage 2 of the roadmap over real HTTP: the task SSE stream resumes without
// gaps or duplicates (R2.1/R2.2), keeps the connection alive (R2.5), and a
// message carries the paired device that sent it (`source`).

// Opens /api/tasks/:id/stream and collects events until `until(event)` or the
// timeout. Comments (heartbeats) are counted separately.
function stream(base, taskId, { headers = {}, query = '', until = () => false, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    let comments = 0;
    let buffer = '';
    const req = http.get(new URL(`/api/tasks/${taskId}/stream${query}`, base), { headers }, res => {
      if (res.statusCode !== 200) { reject(new Error(`stream status ${res.statusCode}`)); return; }
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (block.startsWith(':')) { comments += 1; if (until(null, comments)) done(); continue; }
          const id = /^id: (\d+)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!data) continue;
          const event = JSON.parse(data);
          events.push({ id: id === undefined ? null : Number(id), event });
          if (until(event, comments)) return done();
        }
      });
    });
    const timer = setTimeout(done, timeoutMs);
    function done() { clearTimeout(timer); req.destroy(); resolve({ events, comments }); }
    req.on('error', error => { if (!req.destroyed) reject(error); });
  });
}

const terminal = event => event && ['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_CANCELLED'].includes(event.type);

test('stage 2: Last-Event-ID wins over ?after and nothing at or below it is resent', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'hello' });
  const full = await stream(fixture.base, task.id, { until: terminal });
  const ids = full.events.map(item => item.id);
  assert.ok(ids.length > 5, `too few events: ${ids}`);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ids ascend');
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  for (const item of full.events) assert.equal(item.id, item.event.seq, 'the SSE id is the event seq');

  // Once the turn is over, superseded deltas are pruned from the store: a resume
  // replays what the store still holds after the cursor, nothing else.
  const stored = (await fixture.api(`/api/tasks/${task.id}/events?after=0`)).map(event => event.seq);
  const middle = stored[Math.floor(stored.length / 2)];
  const resumed = await stream(fixture.base, task.id, { headers: { 'last-event-id': String(middle) }, query: '?after=0', timeoutMs: 1500 });
  assert.deepEqual(resumed.events.map(item => item.id), stored.filter(id => id > middle), 'header beats the query and resumes right after it');

  const byQuery = await stream(fixture.base, task.id, { query: `?after=${middle}`, timeoutMs: 1500 });
  assert.deepEqual(byQuery.events.map(item => item.id), stored.filter(id => id > middle), '?after alone works too');

  const bad = await new Promise(resolve => http.get(new URL(`/api/tasks/${task.id}/stream?after=-1`, fixture.base), res => { res.resume(); resolve(res.statusCode); }));
  assert.equal(bad, 400);
});

test('stage 2: clients connecting in the middle of a stream miss nothing and see nothing twice', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'stream-many' });
  // Staggered joins while ~140 deltas are being written: each one races the
  // history read against live events.
  const joins = [];
  for (let i = 0; i < 6; i++) {
    joins.push(stream(fixture.base, task.id, { until: terminal, timeoutMs: 30000 }));
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  const results = await Promise.all(joins);
  // The store is the truth: every event persisted by the end must have reached
  // every client exactly once, in order (superseded deltas may be pruned later,
  // so a client may also hold a few the store no longer lists).
  const stored = (await fixture.api(`/api/tasks/${task.id}/events?after=0`)).map(event => event.seq);
  assert.ok(results[0].events.length > 50, `stream-many produced too few live events: ${results[0].events.length}`);
  for (const [index, result] of results.entries()) {
    const ids = result.events.map(item => item.id);
    assert.ok(terminal(result.events.at(-1)?.event), `client ${index} saw the end`);
    assert.equal(new Set(ids).size, ids.length, `client ${index}: duplicates`);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), `client ${index}: out of order`);
    const seen = new Set(ids);
    const missing = stored.filter(seq => !seen.has(seq));
    assert.deepEqual(missing, [], `client ${index} missed stored events`);
  }
});

test('stage 2: the heartbeat keeps an idle stream alive at server.sse.heartbeatSec', { timeout: 30000 }, async t => {
  const fixture = await startFixture(undefined, { server: { sse: { heartbeatSec: 1 } } });
  t.after(() => fixture.close());
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'hello' });
  const started = Date.now();
  const { comments } = await stream(fixture.base, task.id, { until: (event, count) => count >= 2, timeoutMs: 6000 });
  assert.ok(comments >= 2, `only ${comments} heartbeats`);
  assert.ok(Date.now() - started < 5000, 'heartbeats arrive about once a second');
});

test('stage 2: the paired device is the source of a session and of its messages', { timeout: 60000 }, async t => {
  const fixture = await startFixture(undefined, { server: { auth: { enabled: true } } });
  t.after(() => fixture.close());
  const request = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(route, fixture.base), { method, headers: { 'x-forwarded-for': '100.101.102.103', ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text || 'null') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  const { code } = await fixture.api('/api/auth/pairing');
  const phone = (await request('/api/auth/pair', { method: 'POST', body: { code, deviceName: 'Pixel', clientKind: 'android' } })).data;
  const bearer = { authorization: `Bearer ${phone.token}` };

  const created = await request('/api/tasks', { method: 'POST', headers: bearer, body: { projectId: 'fixture', prompt: 'hello', clientId: 'android-1234' } });
  assert.equal(created.status, 202, JSON.stringify(created.data));
  assert.deepEqual(created.data.source, { clientId: 'android-1234', deviceId: phone.deviceId });

  for (let i = 0; i < 100 && !terminal({ type: (await request(`/api/tasks/${created.data.id}`, { headers: bearer })).data.status === 'SUCCEEDED' ? 'TASK_SUCCEEDED' : '' }); i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const sent = await request(`/api/tasks/${created.data.id}/message`, { method: 'POST', headers: bearer, body: { text: 'и ещё', clientId: 'android-1234', commandId: 'cmd-source-1' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  let user = null;
  for (let i = 0; i < 100 && !user; i++) {
    const events = (await request(`/api/tasks/${created.data.id}/events?after=0`, { headers: bearer })).data;
    user = events.find(event => event.type === 'USER_MESSAGE');
    if (!user) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(user, 'USER_MESSAGE recorded');
  assert.equal(user.data.deviceId, phone.deviceId);
  assert.equal(user.data.clientId, 'android-1234');
  assert.equal(user.data.commandId, 'cmd-source-1');

  // The local PC has no device: no deviceId is invented.
  const local = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'from the pc' });
  assert.equal(local.source, undefined);
});
