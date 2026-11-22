import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';

// A separate module instance keeps this bounded-buffer test out of the server fixtures.
test('lifecycle trace is opt-in, bounded, monotonic and omits arbitrary payloads', async t => {
  const saved = process.env.TASKBRIDGE_LIFECYCLE_TRACE;
  t.after(() => { if (saved === undefined) delete process.env.TASKBRIDGE_LIFECYCLE_TRACE; else process.env.TASKBRIDGE_LIFECYCLE_TRACE = saved; });
  const trace = await import('../src/lifecycle-trace.mjs?unit');
  delete process.env.TASKBRIDGE_LIFECYCLE_TRACE;
  assert.equal(trace.beginStopTrace('t', 'c', 1), null);
  assert.deepEqual(trace.lifecycleTraceSnapshot(), { enabled: false, records: [] });
  process.env.TASKBRIDGE_LIFECYCLE_TRACE = '1';
  const span = trace.beginStopTrace('t', 'c', 1);
  for (let i = 0; i < 300; i++) trace.recordStopTrace('t', 'probe', { eventSeq: i, prompt: 'DO_NOT_RETAIN', token: 'DO_NOT_RETAIN' });
  trace.endStopTrace('t', span);
  const rows = trace.lifecycleTraceSnapshot().records;
  assert.equal(rows.length, 256);
  assert.ok(rows.every((row, i) => row.elapsedMs >= 0 && (!i || row.elapsedMs >= rows[i - 1].elapsedMs)));
  assert.equal(JSON.stringify(rows).includes('DO_NOT_RETAIN'), false);
  const count = rows.length;
  trace.recordStopTrace('t', 'after-end');
  assert.equal(trace.lifecycleTraceSnapshot().records.length, count);
});

for (const enabled of [false, true]) {
  test(`isolated STOP diagnostics through HTTP and persisted terminal (enabled=${enabled})`, async t => {
    const f = await startFixture(0, { env: enabled ? { TASKBRIDGE_LIFECYCLE_TRACE: '1' } : {} });
    t.after(() => f.close());
    const created = await f.api('/api/tasks', { projectId: 'fixture', prompt: 'slow' });
    let started = false;
    for (let i = 0; i < 200 && !started; i++) {
      const events = await f.api(`/api/tasks/${created.id}/events?limit=0`);
      started = events.some(e => e.type === 'PI_EVENT' && e.data?.pi?.type === 'agent_start');
      if (!started) await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(started, true);
    const stopped = await f.api(`/api/tasks/${created.id}/cancel`, { commandId: 'stop-diag-1', clientId: 'test', hard: true });
    assert.equal(stopped.status, 'CANCELLED');
    const result = await f.api('/api/diagnostics/lifecycle');
    assert.equal(result.enabled, enabled);
    assert.ok(result.bootId);
    if (!enabled) return assert.deepEqual(result.records, []);
    const rows = result.records.filter(row => row.commandId === 'stop-diag-1');
    const phases = rows.map(row => row.phase);
    for (const phase of ['stop-received', 'pi-stop-started', 'pi-stop-returned', 'eventchain-drained', 'terminal-committed', 'sse-enqueued', 'stop-handler-finished']) assert.ok(phases.includes(phase), phase);
    assert.ok(phases.indexOf('terminal-committed') < phases.indexOf('sse-enqueued'));
    const events = await f.api(`/api/tasks/${created.id}/events?limit=0`);
    const terminal = events.find(e => e.type === 'TASK_CANCELLED');
    assert.equal(terminal.data.stopCommandId, 'stop-diag-1');
    assert.equal(rows.find(row => row.phase === 'terminal-committed').eventSeq, terminal.seq);
    assert.ok(rows.every(row => row.taskId === created.id));
  });
}
