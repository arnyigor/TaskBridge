import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listPiSessions, readPiSession } from '../src/pi-session-index.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-pi-index-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'Проект с пробелами');
  const sessions = path.join(root, 'sessions');
  await fs.mkdir(project);
  await fs.mkdir(sessions);
  const header = { type: 'session', version: 3, id: 'native-session', timestamp: '2026-09-09T10:00:00.000Z', cwd: project };
  const file = path.join(sessions, 'история.jsonl');
  const write = (entries, suffix = '\n') => fs.writeFile(file, [header, ...entries].map(entry => JSON.stringify(entry)).join('\n') + suffix);
  return { root, project, sessions, header, file, write };
}

const message = (id, parentId, text, role = 'user') => ({ type: 'message', id, parentId,
  timestamp: '2026-09-09T10:00:00.000Z', message: { role, content: [{ type: 'text', text }], timestamp: 123 } });

test('listing only reads headers, handles Unicode cwd, deduplicates roots and returns opaque stable keys', async t => {
  const f = await fixture(t);
  await f.write([], '\nTHIS BODY IS INTENTIONALLY NOT JSON');
  const nested = path.join(f.sessions, 'nested');
  await fs.mkdir(nested);
  const other = path.join(nested, 'other.jsonl');
  await fs.writeFile(other, JSON.stringify({ ...f.header, id: 'other', name: 'Named session' }) + '\n');
  await fs.utimes(f.file, new Date(1000), new Date(1000));
  await fs.utimes(other, new Date(2000), new Date(2000));
  const sessions = await listPiSessions({ path: path.join(f.project, '.') }, [f.sessions, nested, path.join(f.root, 'missing')]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].name, 'Named session');
  assert.equal(sessions[1].cwd, f.project);
  assert.match(sessions[1].key, /^[a-f0-9]{64}$/);
  assert.equal(sessions[1].file, await fs.realpath(f.file));
  assert.equal((await listPiSessions({ path: f.project }, [f.sessions]))[1].key, sessions[1].key);
});

test('listing excludes malformed, oversized, obsolete and unrelated headers', async t => {
  const f = await fixture(t);
  const records = ['{broken', { ...f.header, cwd: f.root }, { ...f.header, version: 2 },
    { ...f.header, cwd: 'relative' }, { ...f.header, timestamp: 'invalid' },
    { ...f.header, padding: 'x'.repeat(65 * 1024) }];
  for (let i = 0; i < records.length; i++) {
    await fs.writeFile(path.join(f.sessions, `${i}.jsonl`), typeof records[i] === 'string' ? records[i] : JSON.stringify(records[i]));
  }
  assert.deepEqual(await listPiSessions({ path: f.project }, [f.sessions]), []);
  await f.write([]);
  await assert.rejects(readPiSession(f.file, f.root), /different project/);
});

test('reader preserves all entries but displays only the selected parent branch including tool data', async t => {
  const f = await fixture(t);
  const entries = [message('a', null, 'start'), message('old', 'a', 'abandoned answer', 'assistant'),
    message('b', 'a', 'selected answer', 'assistant'),
    { ...message('c', 'b', 'tool output', 'toolResult'), message: { role: 'toolResult', toolCallId: 'tool1', toolName: 'read', content: [{ type: 'text', text: 'tool output' }], details: { file: 'résumé.txt' } } },
    { type: 'session_info', id: 'name', parentId: 'c', name: 'New name' }];
  await f.write(entries);
  const result = await readPiSession(f.file, f.project);
  assert.deepEqual(result.entries, [f.header, ...entries]);
  assert.deepEqual(result.messages, [entries[0].message, entries[2].message, entries[3].message]);
  assert.deepEqual(result.branchMessages, result.messages);
});

test('compaction context matches Pi while branchMessages retains chat history and native summary roles', async t => {
  const f = await fixture(t);
  const entries = [message('a', null, 'summarized question'), message('b', 'a', 'kept question'),
    message('c', 'b', 'kept answer', 'assistant'),
    { type: 'compaction', id: 'd', parentId: 'c', timestamp: f.header.timestamp, firstKeptEntryId: 'b', summary: 'Earlier context', tokensBefore: 1000 },
    { type: 'branch_summary', id: 'e', parentId: 'd', timestamp: f.header.timestamp, fromId: 'old', summary: 'Other branch' },
    message('f', 'e', 'new question')];
  await f.write(entries);
  const result = await readPiSession(f.file, f.project);
  assert.deepEqual(result.messages.map(x => x.role), ['compactionSummary', 'user', 'assistant', 'branchSummary', 'user']);
  assert.equal(result.messages[0].summary, 'Earlier context');
  assert.equal(result.messages[0].tokensBefore, 1000);
  assert.equal(result.messages[0].timestamp, Date.parse(f.header.timestamp));
  assert.equal(result.messages[1].content[0].text, 'kept question');
  assert.equal(result.branchMessages[0].content[0].text, 'summarized question');
  assert.equal(result.entries.length, 7);
});

test('latest compaction is selected and missing first-kept marker keeps only subsequent context', async t => {
  const f = await fixture(t);
  await f.write([message('a', null, 'old'),
    { type: 'compaction', id: 'b', parentId: 'a', firstKeptEntryId: 'a', summary: 'old summary' },
    message('c', 'b', 'newer'),
    { type: 'compaction', id: 'd', parentId: 'c', firstKeptEntryId: 'unavailable', summary: 'latest summary' },
    message('e', 'd', 'current')]);
  const result = await readPiSession(f.file, f.project);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].summary, 'latest summary');
  assert.equal(result.messages[1].content[0].text, 'current');
});

test('torn final line is discarded, malformed complete records and broken chains are rejected', async t => {
  const f = await fixture(t);
  await f.write([message('a', null, 'complete')], '\n{"type":"message","id":');
  assert.equal((await readPiSession(f.file, f.project)).messages.length, 1);
  await f.write([message('a', null, 'complete')], '\n{broken}\n');
  await assert.rejects(readPiSession(f.file, f.project), /Malformed/);
  await f.write([message('a', 'missing', 'orphan')]);
  await assert.rejects(readPiSession(f.file, f.project), /parent chain/);
  await f.write([message('a', null, 'first'), message('a', 'a', 'duplicate')]);
  await assert.rejects(readPiSession(f.file, f.project), /parent chain/);
});

test('reader rejects traversal, directories and oversized files', async t => {
  const f = await fixture(t);
  await f.write([]);
  await assert.rejects(readPiSession(`${f.sessions}${path.sep}..${path.sep}sessions${path.sep}история.jsonl`, f.project), /Invalid session file path/);
  await assert.rejects(readPiSession(f.sessions, f.project), /regular file/);
  await fs.truncate(f.file, 64 * 1024 * 1024 + 1);
  await assert.rejects(readPiSession(f.file, f.project), /64 MiB/);
});

test('directory symlinks and junctions are never scanned or imported', async t => {
  const f = await fixture(t);
  const external = path.join(f.root, 'external');
  await fs.mkdir(external);
  const target = path.join(external, 'private.jsonl');
  await fs.writeFile(target, JSON.stringify(f.header) + '\n');
  const link = path.join(f.sessions, 'linked');
  try { await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Symlink creation unavailable'); return; }
    throw error;
  }
  assert.deepEqual(await listPiSessions({ path: f.project }, [f.sessions, link]), []);
  await assert.rejects(readPiSession(path.join(link, 'private.jsonl'), f.project), /Symbolic links/);
});
