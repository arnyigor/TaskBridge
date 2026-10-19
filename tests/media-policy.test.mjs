import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyMediaPolicy,
  applyToolResultPolicy,
  createFileStore,
  imagePayload,
  parseMarker,
  projectContext,
  redactStructured,
  referenceText,
  trimPayloadImages
} from '../pi-extension/taskbridge-media.js';

// The media policy keeps base64 screenshots out of the transcript and out of
// the request (2026-10-19: 39 images = 47.6 MB of a 48.6 MB history, 413 on
// every request). These tests pin the parts that do not need Pi: archiving a
// tool result, projecting the context, and the provider payload guard.

const sha = 'b'.repeat(64);

// Stand-in for the file store: content-addressed by the sha the test chooses.
function memoryStore(bytesOf = new Map()) {
  return {
    saved: [],
    async save(base64, mimeType) {
      const bytes = Buffer.from(base64, 'base64');
      const created = { sha: sha, bytes: bytes.length, mimeType, written: true };
      bytesOf.set(sha, bytes);
      this.saved.push(created);
      return created;
    },
    async load(id) {
      const bytes = bytesOf.get(id);
      return bytes ? { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' } : null;
    },
    async size(id) {
      return bytesOf.get(id)?.length ?? 0;
    }
  };
}

const imagePart = (text, mimeType = 'image/png') => ({ type: 'image', data: Buffer.from(text).toString('base64'), mimeType });

test('a tool result image becomes a reference, not base64', async () => {
  const store = memoryStore();
  const result = await applyToolResultPolicy([{ type: 'text', text: 'Read image' }, imagePart('shot-bytes')],
    { save: (base64, mimeType) => store.save(base64, mimeType) });
  assert.equal(result.changed, true);
  assert.equal(result.archived.length, 1);
  assert.equal(result.content[0].text, 'Read image', 'the tool text survives');
  assert.equal(result.content[1].type, 'text');
  assert.equal(parseMarker(result.content[1].text), sha);
  assert.equal(result.content.some(part => part.type === 'image'), false, 'no base64 left in the transcript');
  assert.equal(store.saved.length, 1);
});

test('a text-only tool result is returned untouched', async () => {
  const store = memoryStore();
  const content = [{ type: 'text', text: 'plain output' }];
  const result = await applyToolResultPolicy(content, { save: (base64, mimeType) => store.save(base64, mimeType) });
  assert.equal(result.changed, false);
  assert.equal(result.content, content, 'same array, nothing rewritten');
});

test('provider payloads in structuredContent are redacted, the rest survives', () => {
  const structured = { summary: 'scene', frames: [{ type: 'image', data: 'A'.repeat(400), mimeType: 'image/png' }], count: 1 };
  const redacted = redactStructured(structured);
  assert.equal(redacted.summary, 'scene');
  assert.equal(redacted.count, 1);
  assert.equal(redacted.frames[0].type, 'text');
  assert.equal(JSON.stringify(redacted).includes('AAAA'), false);
});

test('context keeps the newest image and archives the rest', async () => {
  const store = memoryStore();
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'start' }] },
    { role: 'toolResult', content: [{ type: 'image', data: Buffer.from('old').toString('base64'), mimeType: 'image/png' }] },
    { role: 'toolResult', content: [{ type: 'image', data: Buffer.from('new').toString('base64'), mimeType: 'image/png' }] }
  ];
  const result = await projectContext(messages, { store, keepImages: 1, imageBudgetBytes: 1024 * 1024 });
  assert.equal(result.archived, 2);
  assert.equal(result.hydrated, 1, 'only the newest image is sent');
  const last = result.messages[2].content;
  assert.deepEqual(last.map(part => part.type), ['text', 'image'], 'reference + restored image');
  assert.equal(parseMarker(last[0].text), sha);
  assert.equal(Buffer.from(last[1].data, 'base64').toString(), 'new');
  // The original array is not mutated: Pi keeps its own history.
  assert.equal(messages[2].content.length, 1);
  assert.equal(messages[2].content[0].type, 'image');
});

test('an existing reference is hydrated again on the next turn', async () => {
  const bytesOf = new Map([[sha, Buffer.from('archived-image')]]);
  const store = memoryStore(bytesOf);
  const messages = [{ role: 'toolResult', content: [{ type: 'text', text: referenceText(sha, 14, 'image/png') }] }];
  const result = await projectContext(messages, { store, keepImages: 2, imageBudgetBytes: 1024 * 1024 });
  assert.equal(result.archived, 0, 'nothing to archive: it is already a reference');
  assert.equal(result.hydrated, 1);
  assert.deepEqual(result.messages[0].content.map(part => part.type), ['text', 'image']);
  assert.equal(Buffer.from(result.messages[0].content[1].data, 'base64').toString(), 'archived-image');
});

test('a missing artifact leaves the reference inspectable rather than failing', async () => {
  const store = memoryStore();
  const messages = [{ role: 'toolResult', content: [{ type: 'text', text: referenceText('c'.repeat(64), 14, 'image/png') }] }];
  const result = await projectContext(messages, { store, keepImages: 2, imageBudgetBytes: 1024 * 1024 });
  assert.equal(result.hydrated, 0);
  assert.deepEqual(result.messages[0].content.map(part => part.type), ['text']);
});

test('without a store the inline images are trimmed as before', () => {
  const messages = [{ role: 'toolResult', content: [imagePart('a'), imagePart('b'), imagePart('c')] }];
  const result = applyMediaPolicy(messages, { keepImages: 1, imageBudgetBytes: 1024 * 1024 });
  assert.equal(result.dropped, 2);
  assert.equal(result.kept, 1);
  assert.equal(result.messages[0].content.filter(part => part.type === 'image').length, 1);
});

test('the provider payload guard drops images only when the body is over budget', () => {
  const payload = { messages: [{ content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(4000)}` } }] }] };
  const under = trimPayloadImages(structuredClone(payload), 1024 * 1024);
  assert.equal(under.dropped, 0, 'a small body is left alone');
  const over = trimPayloadImages(structuredClone(payload), 1000);
  assert.equal(over.dropped, 1);
  assert.ok(over.sizeAfter < over.size);
  assert.equal(over.payload.messages[0].content[0].type, 'text');
});

test('image payloads are recognised in the shapes providers use', () => {
  assert.equal(imagePayload({ type: 'image', data: 'AAA', mimeType: 'image/png' }).mimeType, 'image/png');
  assert.equal(imagePayload({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } }).base64, 'BBB');
  assert.equal(imagePayload({ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'CCC' } }).mimeType, 'image/webp');
  assert.equal(imagePayload({ type: 'text', text: 'no image here' }), null);
});

test('the file store is content-addressed: the same bytes are written once', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-media-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createFileStore(path.join(dir, 'media'));
  const base64 = Buffer.from('same picture').toString('base64');
  const first = await store.save(base64, 'image/png');
  const second = await store.save(base64, 'image/png');
  assert.equal(first.sha, second.sha);
  assert.equal(first.written, true);
  assert.equal(second.written, false, 'second write is a no-op');
  assert.equal((await fs.readdir(path.join(dir, 'media'))).length, 1);
  assert.equal((await store.load(first.sha)).data, base64);
  assert.equal(await store.size(first.sha), Buffer.byteLength('same picture'));
  assert.equal(await store.load('d'.repeat(64)), null);
});
