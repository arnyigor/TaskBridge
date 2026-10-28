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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-composition-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const file = path.join(root, 'session.jsonl');
  const header = { type: 'session', version: 3, id: 'composition', timestamp: '2026-10-28T10:00:00.000Z', cwd: project };
  const message = (id, parentId, role, content) => ({ type: 'message', id, parentId, timestamp: '2026-10-28T10:00:00.000Z', message: { role, content, timestamp: 1 } });
  const write = entries => fs.writeFile(file, [header, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  return { root, project, file, write, message };
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
  assert.match(report.note, /buildSessionContext/);
  // Активный контекст: сводка + сохранённый вопрос + всё после.
  assert.equal(report.active.total.messages, 5);
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

  const task = { id: 'ctx', createdAt: new Date().toISOString(), status: 'SUCCEEDED', workspacePath: project, prompt: 'p', files: [], compaction: { count: 1, last: { estimatedTokensAfter: 900, at: '2026-10-28T10:01:00.000Z' } }, piSessionFile: file };
  await store.create(task);
  manager.tasks.set('ctx', task);
  const report = await manager.contextReport('ctx');
  assert.equal(report.session.available, true);
  assert.equal(report.session.method, 'session-file-projection');
  assert.equal(report.session.compaction.tokensBefore, 5000);
  assert.equal(report.session.compaction.summaryChars, 'Сводка для проверки'.length);
  assert.equal(JSON.stringify(report.session).includes('Сводка для проверки'), false);
  assert.equal(JSON.stringify(report.session).includes('ответ после'), false);

  // A session file that belongs to another project is not read silently.
  const other = path.join(root, 'elsewhere.jsonl');
  await fs.writeFile(other, JSON.stringify({ ...header, id: 'x', cwd: root }) + String.fromCharCode(10));
  task.piSessionFile = other;
  const foreign = await manager.contextReport('ctx');
  assert.equal(foreign.session.available, false);
  assert.match(foreign.session.reason, /different project/);
});
