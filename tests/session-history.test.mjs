import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { restoreSessionFile } from '../src/session-history.mjs';

test('recovery preserves full structured messages, tool arguments and results, then reuses the native file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-recovery-test-'));
  const store = new TaskStore(root);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
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
  const store = new TaskStore(root);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const task = { id: 'a', prompt: 'remember the code 123', assistantText: 'I remember 123', workspacePath: root, model: { id: 'fixture' } };
  await store.create(task);
  const file = await restoreSessionFile(task, store, root);
  const entries = (await fs.readFile(file, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
  assert.deepEqual(entries.slice(1).map(x => x.message.content[0].text), ['remember the code 123', 'I remember 123']);
});

// Инцидент 2026-10-14: восстановление собрало 368 547 токенов при окне 204 800 —
// первый же ход провайдер отклонил («requests are never truncated»), сессия не
// отвечала. Восстановление обязано вписывать сессию в окно модели.
test('recovery bounds the rebuilt session to the model window and says what was lost', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-recovery-window-'));
  const store = new TaskStore(root);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const task = { id: 'w', prompt: 'original', createdAt: new Date().toISOString(), workspacePath: root, model: { provider: 'strata', id: 'qwen3.8', contextWindow: 204800 } };
  await store.create(task);
  const huge = 'x'.repeat(400_000); // ≈100K токенов на сообщение
  for (let index = 0; index < 6; index++) {
    await store.appendEvent('w', { type: 'PI_EVENT', data: { pi: { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: `turn ${index} ${huge}` }] }, timestamp: 1_000 + index } } });
    await store.appendEvent('w', { type: 'PI_EVENT', data: { pi: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `answer ${index}` }] }, timestamp: 2_000 + index } } });
  }
  const file = await restoreSessionFile(task, store, root);
  const entries = (await fs.readFile(file, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
  const messages = entries.slice(1).map(x => x.message);
  const budget = Math.floor(204800 * 0.8);
  const tokens = messages.reduce((sum, m) => sum + Math.ceil(JSON.stringify(m.content).length / 4), 0);
  assert.ok(tokens <= budget, `восстановлено ${tokens} токенов, бюджет ${budget}`);
  assert.equal(messages[0].role, 'user', 'первое сообщение — честная пометка о потере');
  assert.match(messages[0].content[0].text, /потеряно/);
  // Самое свежее остаётся: последний ответ — в конце.
  assert.match(messages.at(-1).content[0].text, /answer 5/);
  // Прекомпактная история не должна переживать окно: после метки последнего сжатия старое уходит первым.
  const compactionFile = await (async () => {
    const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-recovery-compaction-'));
    const store2 = new TaskStore(root2);
    const task2 = { id: 'c', prompt: 'original', createdAt: new Date().toISOString(), workspacePath: root2, model: { provider: 's', id: 'm', contextWindow: 5000 } };
    await store2.create(task2);
    const old = { role: 'user', content: [{ type: 'text', text: 'y'.repeat(12_000) }], timestamp: Date.parse('2026-10-14T01:00:00Z') };
    const fresh = { role: 'user', content: [{ type: 'text', text: 'fresh question' }], timestamp: Date.parse('2026-10-14T03:00:00Z') };
    const answer = { role: 'assistant', content: [{ type: 'text', text: 'fresh answer' }], timestamp: Date.parse('2026-10-14T03:00:10Z') };
    await store2.appendEvent('c', { at: '2026-10-14T01:00:00Z', type: 'PI_EVENT', data: { pi: { type: 'message_end', message: old } } });
    await store2.appendEvent('c', { at: '2026-10-14T02:00:00Z', type: 'PI_EVENT', data: { pi: { type: 'compaction_end', reason: 'threshold', aborted: false } } });
    await store2.appendEvent('c', { at: '2026-10-14T03:00:00Z', type: 'PI_EVENT', data: { pi: { type: 'message_end', message: fresh } } });
    await store2.appendEvent('c', { at: '2026-10-14T03:00:10Z', type: 'PI_EVENT', data: { pi: { type: 'message_end', message: answer } } });
    const built = await restoreSessionFile(task2, store2, root2);
    const builtEntries = (await fs.readFile(built, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
    const builtMessages = builtEntries.slice(1).map(x => x.message);
    const text = builtMessages.map(m => JSON.stringify(m.content)).join('');
    assert.ok(!text.includes('y'.repeat(100)), 'прекомпактная история не воскресает при нехватке окна');
    assert.match(text, /fresh answer/);
    await store2.close();
    await fs.rm(root2, { recursive: true, force: true });
    return built;
  })();
  assert.ok(compactionFile);
});
