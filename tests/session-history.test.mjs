import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { restoreSessionFile } from '../src/session-history.mjs';

test('recovery preserves full structured messages, tool arguments and results, then reuses the native file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-recovery-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TaskStore(root);
  const task = { id: 'a', prompt: 'original', createdAt: new Date().toISOString(), workspacePath: root };
  await store.create(task);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'original plus attachment path' }], timestamp: 10 },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'toolCall', id: 'call1', name: 'read', arguments: { path: 'input.txt' } }], stopReason: 'toolUse', timestamp: 20 },
    { role: 'toolResult', toolCallId: 'call1', toolName: 'read', content: [{ type: 'text', text: 'complete file result' }], timestamp: 30 },
    { role: 'assistant', content: [{ type: 'text', text: 'previous answer' }], stopReason: 'stop', timestamp: 40 },
    { role: 'user', content: [{ type: 'text', text: 'follow-up' }], timestamp: 50 },
  ];
  for (const message of messages) await store.appendEvent('a', { type: 'PI_EVENT', data: { pi: { type: 'message_end', message } } });
  const file = await restoreSessionFile(task, store, root);
  const entries = (await fs.readFile(file, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
  assert.equal(entries[0].version, 3);
  assert.deepEqual(entries.slice(1).map(x => x.message), messages);
  for (let i = 2; i < entries.length; i++) assert.equal(entries[i].parentId, entries[i - 1].id);
  assert.equal(await restoreSessionFile(task, store, root), file);
});

test('recovery can use legacy saved prompt and answer when no message frames exist', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-recovery-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TaskStore(root);
  const task = { id: 'a', prompt: 'remember the code 123', assistantText: 'I remember 123', workspacePath: root, model: { id: 'fixture' } };
  await store.create(task);
  const file = await restoreSessionFile(task, store, root);
  const entries = (await fs.readFile(file, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
  assert.deepEqual(entries.slice(1).map(x => x.message.content[0].text), ['remember the code 123', 'I remember 123']);
});
