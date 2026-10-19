import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { shrinkSession, shrinkSessionFile, describeShrink } from '../src/session-shrink.mjs';

// A provider refuses a request body over ~50 MB (api.deepseek.com, measured
// 2026-10-19: 50.3 MB accepted, 50.4 MB refused) — a transcript made of base64
// screenshots reaches that and the session can never start again. Repair must
// drop the OLD images from the request, keep the originals on disk, and leave
// everything else in the transcript untouched.

const line = record => JSON.stringify(record);

const toolResultWithImage = (id, bytes, shaHint = id) => line({
  type: 'message',
  id,
  parentId: `parent-${id}`,
  message: {
    role: 'toolResult',
    toolCallId: `call_${id}`,
    toolName: 'read',
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: Buffer.from(`${shaHint}`.padEnd(bytes, 'A')).toString('base64'), mimeType: 'image/png' }
    ]
  }
});

const userText = text => line({ type: 'message', id: `u-${text}`, parentId: 'root', message: { role: 'user', content: [{ type: 'text', text }] } });
const sessionHeader = line({ type: 'session', version: 1, id: 'fixture' });

test('keeps the newest N images and replaces older ones with a placeholder', () => {
  const session = [sessionHeader, userText('start'), toolResultWithImage('a', 4096), toolResultWithImage('b', 4096), toolResultWithImage('c', 8192)].join('\n');
  const result = shrinkSession(session, { keepImages: 1 });
  assert.equal(result.images, 3);
  assert.equal(result.dropped, 2);
  assert.equal(result.kept, 1);
  assert.equal(result.unparsed, 0);

  const out = result.text.split('\n').map(l => JSON.parse(l));
  assert.deepEqual(out[1].message.content, [{ type: 'text', text: 'start' }]);
  assert.equal(out[2].message.content[1].type, 'text');
  assert.match(out[2].message.content[1].text, /скриншот исключён/);
  assert.equal(out[2].message.content[0].text, 'Read image file [image/png]');
  assert.equal(out[3].message.content[1].type, 'text');
  assert.equal(out[4].message.content[1].type, 'image');
});

test('history survives: ids, parent links and record types are unchanged', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const session = [
    sessionHeader,
    line({ type: 'model_change', provider: 'deepseek', modelId: 'deepseek-flash' }),
    userText('a'),
    toolResultWithImage('a', 200_000, 'first'),
    line({ type: 'message', id: 'as1', parentId: 'parent-a', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
    toolResultWithImage('b', 200_000, 'second')
  ].join('\n');
  await fs.writeFile(file, session);
  const result = await shrinkSessionFile(file, { keepImages: 1, limitBytes: 100_000 });
  assert.equal(result.changed, true);
  const before = session.split('\n').map(l => JSON.parse(l));
  const after = (await fs.readFile(file, 'utf8')).split('\n').map(l => JSON.parse(l));
  assert.deepEqual(after.map(r => r.id), before.map(r => r.id));
  assert.deepEqual(after.map(r => r.parentId), before.map(r => r.parentId));
  assert.deepEqual(after.map(r => r.type), before.map(r => r.type));
  assert.equal(after[1].modelId, 'deepseek-flash', 'model settings are not touched');
  assert.equal(after[4].message.content[0].text, 'done');
});

test('the originals are saved once, by content, and the placeholder names them', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const artifactDir = path.join(dir, 'media');
  // The same screenshot read twice: one artifact file, two placeholders.
  const session = [sessionHeader, userText('a'), toolResultWithImage('a', 5000, 'same'), toolResultWithImage('b', 5000, 'same'), toolResultWithImage('c', 5000, 'newest')].join('\n');
  await fs.writeFile(file, session);
  const result = await shrinkSessionFile(file, { keepImages: 1, limitBytes: 1000, artifactDir, artifactLabel: 'data/media' });
  assert.equal(result.changed, true);
  assert.equal(result.dropped, 2);
  assert.equal(result.artifacts, 2);
  assert.equal(result.written, 1, 'content-addressed: the duplicate image is stored once');
  const saved = await fs.readdir(artifactDir);
  assert.equal(saved.length, 1);
  assert.match(saved[0], /^[0-9a-f]{64}\.png$/);
  const artifactPath = path.join(artifactDir, saved[0]);
  const records = (await fs.readFile(file, 'utf8')).split('\n').map(l => JSON.parse(l));
  const notices = records.flatMap(r => (Array.isArray(r?.message?.content) ? r.message.content : []))
    .filter(part => part.type === 'text' && part.text.includes('оригинал:'));
  assert.equal(notices.length, 2);
  for (const notice of notices) {
    // An absolute path (Pi's read resolves it without the session's cwd).
    assert.ok(path.isAbsolute(artifactPath));
    assert.ok(notice.text.includes(artifactPath), `placeholder names the artifact: ${notice.text}`);
  }
  // The artifact really holds the removed image.
  const stored = await fs.readFile(path.join(artifactDir, saved[0]));
  assert.equal(stored.toString('utf8'), 'same'.padEnd(5000, 'A'));
});

test('a second repair of the same session changes nothing (idempotent)', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  await fs.writeFile(file, [sessionHeader, userText('a'), toolResultWithImage('a', 100_000), toolResultWithImage('b', 100_000)].join('\n'));
  const first = await shrinkSessionFile(file, { keepImages: 0, limitBytes: 1000, artifactDir: path.join(dir, 'media') });
  assert.equal(first.changed, true);
  const repaired = await fs.readFile(file, 'utf8');
  const second = await shrinkSessionFile(file, { keepImages: 0, limitBytes: 1000, artifactDir: path.join(dir, 'media') });
  assert.equal(second.changed, false, `second run: ${second.reason}`);
  assert.equal(await fs.readFile(file, 'utf8'), repaired, 'a second run never touches a repaired file');
});

test('a corrupt line is refused: nothing is rewritten', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const broken = '{"type":"message","message":{';
  const session = [sessionHeader, broken, toolResultWithImage('a', 100_000), toolResultWithImage('b', 100_000)].join('\n');
  await fs.writeFile(file, session);
  const result = await shrinkSessionFile(file, { keepImages: 0, limitBytes: 1000 });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'invalid');
  assert.equal(result.line, 2);
  assert.equal(await fs.readFile(file, 'utf8'), session);
});

test('a text-only session over the limit is reported, not edited', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const session = [sessionHeader, userText('x'.repeat(200_000))].join('\n');
  await fs.writeFile(file, session);
  const result = await shrinkSessionFile(file, { limitBytes: 1000 });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'no-images');
  assert.equal(await fs.readFile(file, 'utf8'), session);
});

test('a session under the limit is left alone', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const session = [sessionHeader, userText('a'), toolResultWithImage('a', 4096)].join('\n');
  await fs.writeFile(file, session);
  const result = await shrinkSessionFile(file, { keepImages: 0, limitBytes: 1024 * 1024 });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'under-limit');
  assert.equal(await fs.readFile(file, 'utf8'), session);
});

test('describeShrink reads as «X → Y МБ»', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  await fs.writeFile(file, [sessionHeader, userText('a'), toolResultWithImage('a', 200_000), toolResultWithImage('b', 200_000)].join('\n'));
  const result = await shrinkSessionFile(file, { keepImages: 1, limitBytes: 1000 });
  assert.match(describeShrink(result), /^\d+\.\d → \d+\.\d МБ/);
});
