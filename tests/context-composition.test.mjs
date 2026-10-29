import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPiSession } from '../src/pi-session-index.mjs';
import { summarizeSessionContext } from '../src/context-composition.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';

async function session(t) {
  await fs.mkdir('.local/ctx-tests', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.local/ctx-tests/session-'));
  const cleanups = [];
  t.after(async () => {
    for (const close of cleanups) await close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const file = path.join(root, 'session.jsonl');
  const header = { type: 'session', version: 3, id: 'composition', timestamp: '2026-10-28T10:00:00.000Z', cwd: project };
  const message = (id, parentId, role, content) => ({ type: 'message', id, parentId, timestamp: '2026-10-28T10:00:00.000Z', message: { role, content, timestamp: 1 } });
  const write = entries => fs.writeFile(file, [header, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  return { root, project, file, write, message, cleanup: close => cleanups.push(close) };
}

const text = value => [{ type: 'text', text: value }];

test('section sizes separate the summary, the kept history and what came after', async t => {
  const f = await session(t);
  await f.write([
    f.message('a', null, 'user', text('первый вопрос, который уже не виден')),
    f.message('b', 'a', 'assistant', text('ответ, который тоже ушёл в исключённые')),
    f.message('c', 'b', 'user', text('сохранённый вопрос')),
    { type: 'compaction', id: 'd', parentId: 'c', timestamp: '2026-10-28T10:01:00.000Z', firstKeptEntryId: 'c', summary: 'Сводка прошлого контекста', tokensBefore: 120000, reason: 'threshold' },
    f.message('e', 'd', 'assistant', text('ответ после сжатия')),
    f.message('f', 'e', 'toolResult', [{ type: 'toolResult', toolName: 'read', text: 'x'.repeat(400) }]),
    f.message('g', 'f', 'assistant', text('ещё ответ')),
  ]);
  const sessionData = await readPiSession(f.file, f.project);
  const report = summarizeSessionContext(sessionData);

  assert.equal(report.method, 'session-file-projection');
  assert.match(report.note, /Pi 1\.4\.0/);
  // Активный контекст: сводка + сохранённый вопрос + всё после.
  assert.equal(report.active.total.messages, 5);
  assert.equal(report.active.retained.messages, 1);
  assert.equal(report.active.added.messages, 3);
  assert.equal(report.compaction.summaryChars, 'Сводка прошлого контекста'.length);
  assert.equal(report.compaction.summaryAvailable, true);
  assert.equal(report.compaction.firstKeptEntryId, 'c');
  assert.equal(report.compaction.tokensBefore, 120000);
  assert.equal(report.history.userMessages, 1);
  assert.equal(report.history.assistantMessages, 2);
  assert.equal(report.history.toolResults, 1);
  assert.equal(report.history.branchMessages, 7);
  assert.equal(report.history.excludedMessages, 2);
  assert(report.history.excludedChars > 0);
  // Никакого текста сообщений или сводки в отчёте нет.
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('Сводка прошлого контекста'), false);
  assert.equal(serialized.includes('сохранённый вопрос'), false);
  assert.equal(serialized.includes('x'.repeat(50)), false);
});

test('a session without compaction reports the whole branch and no summary section', async t => {
  const f = await session(t);
  await f.write([
    f.message('a', null, 'user', text('вопрос')),
    f.message('b', 'a', 'assistant', [{ type: 'toolCall', toolName: 'read', toolCallId: 't1' }, { type: 'text', text: 'готово' }]),
  ]);
  const report = summarizeSessionContext(await readPiSession(f.file, f.project));
  assert.equal(report.compaction, null);
  assert.equal(report.active.total.messages, 2);
  assert.equal(report.active.total.toolCalls, 1);
  assert.equal(report.history.excludedMessages, 0);
  assert.equal(report.history.excludedChars, 0);
});

test('only the latest compaction defines the boundary', async t => {
  const f = await session(t);
  await f.write([
    f.message('a', null, 'user', text('старое')),
    { type: 'compaction', id: 'b', parentId: 'a', timestamp: '2026-10-28T10:01:00.000Z', firstKeptEntryId: 'a', summary: 'первая сводка', tokensBefore: 1000 },
    f.message('c', 'b', 'user', text('новое')),
    { type: 'compaction', id: 'd', parentId: 'c', timestamp: '2026-10-28T10:02:00.000Z', firstKeptEntryId: 'c', summary: 'вторая сводка', tokensBefore: 2000 },
    f.message('e', 'd', 'assistant', text('после')),
  ]);
  const data = await readPiSession(f.file, f.project);
  const report = summarizeSessionContext(data);
  assert.equal(report.compaction.firstKeptEntryId, 'c');
  assert.equal(report.compaction.tokensBefore, 2000);
  assert.equal(report.compaction.summaryChars, 'вторая сводка'.length);
  // Сводка + сохранённый вопрос + ответ после.
  assert.deepEqual(data.messages.map(m => m.role), ['compactionSummary', 'user', 'assistant']);
  assert.equal(data.compaction.ignoredEntries, 2);
});

test('the session context endpoint carries the composition, never the text', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-composition-report-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const store = new TaskStore(root);
  const manager = new TaskManager({ projects: [] }, root, store);
  t.after(async () => {
    await manager.close().catch(() => {});
    store.close();
    for (let i = 0; i < 10; i++) {
      try { await fs.rm(root, { recursive: true, force: true }); return; }
      catch { await new Promise(r => setTimeout(r, 60)); }
    }
  });
  const file = path.join(root, 'session.jsonl');
  const header = { type: 'session', version: 3, id: 'ctx', timestamp: '2026-10-28T10:00:00.000Z', cwd: project };
  const message = (id, parentId, role, content) => ({ type: 'message', id, parentId, timestamp: '2026-10-28T10:00:00.000Z', message: { role, content, timestamp: 1 } });
  const lines = [
    header,
    message('a', null, 'user', text('вопрос до сжатия')),
    { type: 'compaction', id: 'b', parentId: 'a', timestamp: '2026-10-28T10:01:00.000Z', firstKeptEntryId: 'a', summary: 'Сводка для проверки', tokensBefore: 5000 },
    message('c', 'b', 'assistant', text('ответ после')),
  ];
  await fs.writeFile(file, lines.map(line => JSON.stringify(line)).join(String.fromCharCode(10)) + String.fromCharCode(10));

  const task = { id: 'ctx', createdAt: new Date().toISOString(), status: 'SUCCEEDED', workspacePath: project, prompt: 'p', files: [], compaction: { count: 1, last: { estimatedTokensAfter: 900, at: '2026-10-28T10:01:00.000Z', summary: 'Сводка для проверки' } }, piSessionFile: file };
  await store.create(task);
  manager.tasks.set('ctx', task);
  const report = await manager.contextReport('ctx');
  assert.equal(report.session.available, true);
  assert.equal(report.session.method, 'session-file-projection');
  assert.equal(report.session.compaction.tokensBefore, 5000);
  assert.equal(report.session.compaction.summaryChars, 'Сводка для проверки'.length);
  assert.equal(JSON.stringify(report.session).includes('Сводка для проверки'), false);
  assert.equal(JSON.stringify(report.session).includes('ответ после'), false);
  assert.equal(JSON.stringify(report).includes('Сводка для проверки'), false);
  const bytesBefore = await fs.readFile(file);
  const summary = await manager.contextSummary('ctx');
  assert.equal(summary.available, true);
  assert.equal(summary.summary, 'Сводка для проверки');
  assert.deepEqual(await fs.readFile(file), bytesBefore, 'diagnostics do not modify the source');

  // A session file that belongs to another project is not read silently.
  const other = path.join(root, 'elsewhere.jsonl');
  await fs.writeFile(other, JSON.stringify({ ...header, id: 'x', cwd: root }) + String.fromCharCode(10));
  task.piSessionFile = other;
  const foreign = await manager.contextReport('ctx');
  assert.equal(foreign.session.available, false);
  assert.match(foreign.session.reason, /different project/);
  assert.equal((await manager.contextSummary('ctx')).available, false);
});

test('character totals include summary, thinking and tool arguments, not just visible text', () => {
  const report = summarizeSessionContext({ messages: [
    { role: 'compactionSummary', summary: 'abcd' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'xy' }, { type: 'toolCall', arguments: { x: 1 } }, { type: 'text', text: 'z' }] },
    { role: 'toolResult', content: text('result') },
  ] });
  assert.equal(report.active.total.chars, 4 + 2 + JSON.stringify({ x: 1 }).length + 1 + 6);
  assert.equal(report.active.total.toolCalls, 1);
  assert.equal(report.active.total.toolResults, 1);
});

test('a discarded branch never contributes its compaction, summary or context_edit', async t => {
  const f = await session(t);
  await f.write([
    f.message('a', null, 'user', text('root')),
    f.message('b', 'a', 'user', text('discarded '.repeat(100))),
    { type: 'context_edit', id: 'edit', parentId: 'b' },
    { type: 'compaction', id: 'c', parentId: 'edit', firstKeptEntryId: 'b', summary: 'wrong branch' },
    f.message('d', 'a', 'assistant', text('selected branch')),
  ]);
  const report = summarizeSessionContext(await readPiSession(f.file, f.project));
  assert.equal(report.compaction, null);
  assert.equal(report.active.total.messages, 2);
  assert.equal(report.active.total.chars, 'rootselected branch'.length);
});

test('native context_edit removes and replaces messages without modifying chat history', async t => {
  const f = await session(t);
  await f.write([
    f.message('a', null, 'user', text('private content')),
    f.message('b', 'a', 'assistant', text('old long answer')),
    { type: 'context_edit', id: 'c', parentId: 'b', targetId: 'a', replacement: null },
    { type: 'context_edit', id: 'd', parentId: 'c', targetId: 'b', replacement: { content: 'short' } },
  ]);
  const data = await readPiSession(f.file, f.project);
  const report = summarizeSessionContext(data);
  assert.deepEqual(data.messages.map(m => m.content), [text('short')]);
  assert.equal(data.branchMessages.length, 2, 'original chat history is unchanged');
  assert.equal(report.active.total.messages, 1);
  assert.equal(report.active.total.chars, 5);
  assert.equal(report.history.excludedMessages, 1);
  assert(!JSON.stringify(report).includes('private content'));
});

test('statistics from another Pi session are never attributed to this task', async t => {
  const f = await session(t);
  await f.write([f.message('a', null, 'user', text('one'))]);
  const store = new TaskStore(f.root);
  const manager = new TaskManager({ projects: [] }, f.root, store);
  f.cleanup(async () => { manager.runtimes.clear(); await manager.close(); store.close(); });
  const task = { id: 'one', status: 'SUCCEEDED', workspacePath: f.project, piSessionFile: f.file };
  manager.tasks.set('one', task);
  const pi = { closed: false, getSessionStats: async () => ({ sessionFile: path.join(f.root, 'other.jsonl'), contextUsage: { tokens: 999999 } }) };
  manager.runtimes.set('one', { pi });
  let report = await manager.contextReport('one');
  assert.equal(report.totalTokens, null);
  assert.equal(report.usage.sessionId, null);
  assert.match(report.usage.unavailableReason, /другой сессии/);
  pi.getSessionStats = async () => ({ sessionFile: f.file, contextUsage: { tokens: 42 } });
  report = await manager.contextReport('one');
  assert.equal(report.totalTokens, 42);
  assert.equal(report.usage.sessionId, f.file);
});

test('switching a session file while statistics are in flight discards the old measurement', async t => {
  const f = await session(t);
  const store = new TaskStore(f.root);
  const manager = new TaskManager({ projects: [] }, f.root, store);
  f.cleanup(async () => { manager.runtimes.clear(); await manager.close(); store.close(); });
  const task = { id: 'one', status: 'RUNNING', workspacePath: f.project, piSessionFile: f.file };
  manager.tasks.set('one', task);
  manager.runtimes.set('one', { pi: { closed: false, getSessionStats: async () => {
    task.piSessionFile = path.join(f.root, 'new-session.jsonl');
    return { sessionFile: f.file, contextUsage: { tokens: 999 } };
  } } });
  const report = await manager.contextReport('one');
  assert.equal(report.totalTokens, null);
  assert.match(report.usage.unavailableReason, /другой сессии/);
});

const nativeProjection = JSON.parse(await fs.readFile(new URL('./fixtures/context/pi-1.4.0-projection.json', import.meta.url), 'utf8'));
for (const sample of nativeProjection.cases) {
  test(`Pi 1.4.0 native golden: ${sample.name}`, async t => {
    const f = await session(t);
    await f.write(sample.entries);
    const before = await fs.readFile(f.file);
    const data = await readPiSession(f.file, f.project, Object.hasOwn(sample, 'leafId') ? { leafId: sample.leafId } : {});
    assert.deepEqual(data.messages, sample.expected);
    assert.deepEqual(await fs.readFile(f.file), before);
  });
}

test('context report and opt-in summary follow RPC leafId instead of the file tail', async t => {
  const f = await session(t);
  await f.write([
    f.message('a', null, 'user', text('keep')),
    { type: 'compaction', id: 'b', parentId: 'a', firstKeptEntryId: 'a', summary: 'selected summary', tokensBefore: 1000, timestamp: '2026-10-29T00:00:00Z' },
    f.message('c', 'b', 'assistant', text('selected answer')),
    { type: 'compaction', id: 'd', parentId: 'a', firstKeptEntryId: 'a', summary: 'unselected summary', tokensBefore: 999999, timestamp: '2026-10-29T00:01:00Z' },
  ]);
  const before = await fs.readFile(f.file);
  const store = new TaskStore(f.root);
  const manager = new TaskManager({ projects: [] }, f.root, store);
  f.cleanup(async () => { manager.runtimes.clear(); await manager.close(); store.close(); });
  const task = { id: 'leaf', status: 'SUCCEEDED', workspacePath: f.project, piSessionFile: f.file };
  manager.tasks.set(task.id, task);
  const commands = [];
  const pi = { closed: false,
    getSessionStats: async () => ({ sessionFile: f.file, contextUsage: { tokens: 90 } }),
    getState: async () => ({ sessionFile: f.file }),
    request: async command => { commands.push(command); return { success: true, data: { leafId: 'c', entries: [] } }; },
  };
  manager.runtimes.set(task.id, { pi });
  const report = await manager.contextReport(task.id);
  assert.equal(report.session.available, true);
  assert.equal(report.session.branchSource, 'pi-leaf');
  assert.equal(report.session.leafId, 'c');
  assert.equal(report.session.compaction.tokensBefore, 1000);
  assert.equal(report.session.active.retained.messages, 1);
  assert.equal(report.session.active.added.messages, 1);
  assert(!JSON.stringify(report).includes('selected summary'));
  assert.equal((await manager.contextSummary(task.id)).summary, 'selected summary');
  assert.deepEqual(commands, [{ type: 'get_entries', since: 'd' }, { type: 'get_entries', since: 'd' }]);
  // Missing leaf is an explained failure, never a silent fall-back to the wrong branch.
  pi.request = async () => ({ success: true, data: { leafId: 'not-in-file' } });
  const unavailable = await manager.contextReport(task.id);
  assert.equal(unavailable.session.available, false);
  assert.match(unavailable.session.reason, /active leaf/);
  pi.closed = true;
  const closed = await manager.contextReport(task.id);
  assert.equal(closed.totalTokens, null);
  assert.equal(closed.session.branchSource, 'file-tail');
  assert.match(closed.session.note, /последняя запись файла/);
  assert.deepEqual(await fs.readFile(f.file), before);
});

test('a session switch during the leaf RPC discards both the old composition and old statistics', async t => {
  const f = await session(t);
  await f.write([f.message('a', null, 'user', text('original'))]);
  const store = new TaskStore(f.root);
  const manager = new TaskManager({ projects: [] }, f.root, store);
  f.cleanup(async () => { manager.runtimes.clear(); await manager.close(); store.close(); });
  const task = { id: 'race', status: 'RUNNING', workspacePath: f.project, piSessionFile: f.file };
  manager.tasks.set(task.id, task);
  manager.runtimes.set(task.id, { pi: { closed: false,
    getState: async () => ({ sessionFile: f.file }),
    getSessionStats: async () => ({ sessionFile: f.file, contextUsage: { tokens: 123 } }),
    request: async () => { task.piSessionFile = path.join(f.root, 'another.jsonl'); return { data: { leafId: 'a' } }; },
  } });
  const report = await manager.contextReport(task.id);
  assert.equal(report.totalTokens, null);
  assert.equal(report.session.available, false);
  assert.match(report.usage.unavailableReason, /другой сессии/);
});

test('a system checkpoint with empty content and structured sections has a nonzero serialized size', async t => {
  const f = await session(t);
  const systemMessage = { role: 'system', content: '', sections: [{ id: 'instructions', text: 'public instructions' }], toolsAdded: [{ name: 'read' }] };
  await f.write([f.message('a', null, 'user', text('question')),
    { type: 'compaction', id: 'b', parentId: 'a', firstKeptEntryId: 'a', summary: 'summary', systemMessage }]);
  const report = summarizeSessionContext(await readPiSession(f.file, f.project));
  assert.equal(report.checkpoint.messages, 1);
  assert.equal(report.checkpoint.chars, JSON.stringify(systemMessage).length);
  assert(report.checkpoint.chars > 0);
  assert(!JSON.stringify(report).includes('public instructions'));
});
