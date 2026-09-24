import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ToolOutputWindow, tailBytes, toolResultText } from '../src/tool-output.mjs';
import { EventNormalizer } from '../src/events/event-normalizer.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { CommandDispatcher, CommandLedger } from '../src/cloud/command-dispatcher.mjs';

test('tool output window streams deltas below the limit', () => {
  const window = new ToolOutputWindow({ rollingBytes: 100, tailBytes: 100, snapshotMs: 0 });
  assert.deepEqual(window.append('hello '), { mode: 'delta', output: 'hello ', truncated: false });
  assert.deepEqual(window.append('world'), { mode: 'delta', output: 'world', truncated: false });
  const final = window.final();
  assert.equal(final.tail, 'hello world');
  assert.equal(final.truncated, false);
  assert.equal(final.fullLogAvailable, true);
});

test('tool output window switches to bounded rolling snapshots', () => {
  let clock = 0;
  const window = new ToolOutputWindow({ rollingBytes: 10, tailBytes: 8, snapshotMs: 100, now: () => clock });
  window.append('0123456789');            // exactly at the limit → delta
  const first = window.append('abcdefgh'); // over the limit → snapshot
  assert.equal(first.mode, 'snapshot');
  assert.equal(first.truncated, true);
  assert.equal(Buffer.byteLength(first.output, 'utf8') <= 10, true);

  // Intermediate chunks are dropped until the snapshot interval elapses.
  clock = 50;
  assert.equal(window.append('dropped'), null);
  clock = 150;
  const second = window.append('more');
  assert.equal(second.mode, 'snapshot');
  assert.ok(Buffer.byteLength(second.output, 'utf8') <= 10);

  const final = window.final();
  assert.equal(final.truncated, true);
  assert.ok(Buffer.byteLength(final.tail, 'utf8') <= 8);
  assert.equal(final.outputBytes, 10 + 8 + 7 + 4);
  assert.equal(final.droppedBytes, 7);
  assert.equal(final.fullLogAvailable, true);
});

test('tailBytes never splits a multi-byte character', () => {
  const text = 'Привет мир, это длинный текст';
  const tail = tailBytes(text, 10);
  assert.ok(Buffer.byteLength(tail, 'utf8') <= 10);
  assert.ok(text.endsWith(tail));
  assert.equal(tail.includes('\uFFFD'), false);
});

test('normalizer bounds tool updates and reports a durable tail', () => {
  const normalizer = new EventNormalizer({ toolOutput: { rollingKb: 1, tailKb: 1, snapshotMs: 0 } });
  normalizer.normalizePiFrame('t', { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} });
  const small = normalizer.normalizePiFrame('t', { type: 'tool_execution_update', toolCallId: 'c1', output: 'ok\n' });
  assert.equal(small[0].payload.mode, 'delta');
  assert.equal(small[0].payload.truncated, false);

  const big = normalizer.normalizePiFrame('t', { type: 'tool_execution_update', toolCallId: 'c1', output: 'x'.repeat(4096) });
  assert.equal(big[0].payload.mode, 'snapshot');
  assert.equal(big[0].payload.truncated, true);
  assert.ok(big[0].payload.output.length <= 1024);

  const end = normalizer.normalizePiFrame('t', { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', exitCode: 0 })[0];
  assert.equal(end.type, 'tool_finished');
  assert.equal(end.payload.fullLogAvailable, true);
  assert.equal(end.payload.localLogId, 'c1');
  assert.equal(end.payload.truncated, true);
  assert.ok(Buffer.byteLength(end.payload.tail, 'utf8') <= 1024);
});

test('full tool output is written locally and fetched as a bounded payload', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-tool-output-'));
  const store = new TaskStore(dataRoot);
  t.after(async () => { store.close(); await fs.rm(dataRoot, { recursive: true, force: true }); });
  // 1 KB cap so the bounded-slice behaviour is observable with a tiny fixture.
  const manager = new TaskManager({ projects: [], cloud: { toolOutput: { maxFullMb: 0.001 } } }, dataRoot, store);
  const task = { id: 'a', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'RUNNING', workspacePath: dataRoot, files: [], attachments: [], outputFiles: [], compaction: { count: 0 }, assistantText: '', thinkingText: '' };
  await store.create(task);
  manager.tasks.set('a', task);

  await assert.rejects(manager.fetchToolOutput('a', 'c1'), { code: 'NOT_FOUND' });

  await store.appendRaw('a', 'tool-c1.log', 'line one\nline two\nline three\n');
  const result = await manager.fetchToolOutput('a', 'c1');
  assert.match(result.text, /line three/);
  assert.equal(result.bytes, Buffer.byteLength('line one\nline two\nline three\n'));

  // A log larger than the cap is served as its bounded tail.
  await store.appendRaw('a', 'tool-c2.log', 'y'.repeat(5000));
  const capped = await manager.fetchToolOutput('a', 'c2');
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.text, 'utf8') <= 1048, 'the uploaded slice is capped by maxFullMb');

  // The explicit remote fetch publishes one durable event through the local stream.
  const events = [];
  manager.on('task-event', event => events.push(event));
  await manager.fetchToolOutput('a', 'c1', { emit: true });
  const outputEvent = events.find(event => event.type === 'TOOL_OUTPUT');
  assert.ok(outputEvent, 'TOOL_OUTPUT is published for the remote UI');
  assert.equal(outputEvent.data.toolCallId, 'c1');
});

test('FETCH_TOOL_OUTPUT command is routed and acknowledged', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-tool-cmd-'));
  const store = new TaskStore(dataRoot);
  t.after(async () => { store.close(); await fs.rm(dataRoot, { recursive: true, force: true }); });
  const calls = [];
  const manager = {
    getTask: id => (id === 't1' ? { id: 't1' } : null),
    async fetchToolOutput(id, toolCallId, options) { calls.push({ id, toolCallId, options }); return { bytes: 42, truncated: false }; }
  };
  const dispatcher = new CommandDispatcher({ manager, ledger: new CommandLedger({ store }) });

  const ok = await dispatcher.handle({ commandId: 'c1', machineId: 'm', taskId: 't1', seq: 1, type: 'FETCH_TOOL_OUTPUT', payload: { toolCallId: 'call_9', maxKb: 16 } });
  assert.equal(ok.status, 'ACCEPTED');
  assert.deepEqual(calls, [{ id: 't1', toolCallId: 'call_9', options: { maxBytes: 16384, emit: true } }]);

  const missing = await dispatcher.handle({ commandId: 'c2', machineId: 'm', taskId: 't1', seq: 2, type: 'FETCH_TOOL_OUTPUT', payload: {} });
  assert.equal(missing.error.code, 'COMMAND_REJECTED');

  const unknown = await dispatcher.handle({ commandId: 'c3', machineId: 'm', taskId: 'nope', seq: 3, type: 'FETCH_TOOL_OUTPUT', payload: { toolCallId: 'x' } });
  assert.equal(unknown.error.code, 'TASK_NOT_FOUND');
});

test("Pi's tool result object reads as its text, not [object Object]", () => {
  assert.equal(toolResultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }], details: {} }), 'a\n[изображение]\nb');
  assert.equal(toolResultText({ content: [] }), '');
  assert.equal(toolResultText('plain'), 'plain');
  assert.equal(toolResultText(null), '');
});

test('a log saved as [object Object], or never saved, is rebuilt from the end event', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-tool-output-'));
  const store = new TaskStore(dataRoot);
  t.after(async () => { store.close(); await fs.rm(dataRoot, { recursive: true, force: true }); });
  const manager = new TaskManager({ projects: [] }, dataRoot, store);
  const task = { id: 'b', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'SUCCEEDED', workspacePath: dataRoot, files: [], attachments: [], outputFiles: [], compaction: { count: 0 }, assistantText: '', thinkingText: '' };
  await store.create(task);
  manager.tasks.set('b', task);
  const end = (toolCallId, text) => ({ type: 'PI_EVENT', taskId: 'b', at: new Date().toISOString(), message: 'tool done', data: { pi: { type: 'tool_execution_end', toolCallId, toolName: 'bash', result: { content: [{ type: 'text', text }] } } } });

  await store.appendRaw('b', 'tool-c1.log', '[object Object][object Object]');
  await store.appendEvent('b', end('c1', 'BUILD SUCCESSFUL'));
  assert.equal((await manager.fetchToolOutput('b', 'c1')).text, 'BUILD SUCCESSFUL');

  await store.appendEvent('b', end('c2', 'no log file'));
  assert.equal((await manager.fetchToolOutput('b', 'c2')).text, 'no log file');

  await assert.rejects(manager.fetchToolOutput('b', 'c3'), { code: 'NOT_FOUND' });
});
