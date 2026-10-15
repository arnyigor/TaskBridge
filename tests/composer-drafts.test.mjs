import test from 'node:test';
import assert from 'node:assert/strict';
import { ComposerDraftStore } from '../web/composer-drafts.mjs';

test('draft reload restores only text and keeps different sessions independent', () => {
  const values = new Map();
  const storage = () => ({ getItem: key => values.get(key),
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) });
  const store = new ComposerDraftStore({ storage });
  const file = { name: 'attachment.txt', toJSON() { throw new Error('File must not be persisted'); } };
  store.set('a', { text: 'first', files: [file] });
  store.set('b', { text: 'second', files: [] });
  assert.equal(store.get('a').files[0], file);
  const reloaded = new ComposerDraftStore({ storage });
  assert.deepEqual(reloaded.get('a'), { text: 'first', files: [] });
  assert.deepEqual(reloaded.get('b'), { text: 'second', files: [] });
});

test('unavailable or corrupt storage does not break the composer', () => {
  const store = new ComposerDraftStore({ storage: () => { throw new Error('storage unavailable'); } });
  store.set('a', { text: 'kept in memory', files: [] });
  assert.equal(store.get('a').text, 'kept in memory');
  store.delete('a');
  assert.equal(store.get('a'), undefined);
  for (const saved of ['{broken', '{"text":{"unexpected":"object"}}']) {
    const corrupt = new ComposerDraftStore({ storage: () => ({ getItem: () => saved }) });
    assert.equal(corrupt.get('a'), undefined);
  }
});
