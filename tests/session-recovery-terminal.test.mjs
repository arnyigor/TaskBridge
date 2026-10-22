import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { restoreSessions } from '../src/application/session-recovery.mjs';

// STAB-02D: падение с потерей сессии — это терминальное состояние, значит оно
// обязано быть в журнале, а не только в снимке задачи. SSE-клиент, вернувшийся по
// курсору, узнаёт о падении только из события TASK_FAILED; снимок и событие
// пишутся одной транзакцией, поэтому «FAILED без TASK_FAILED» невозможно.

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-recovery-02d-'));
  const store = new TaskStore(root);
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const enqueued = [];
  return { root, store, enqueued };
}

// restoreSessions принимает тот же список, что manager.init берёт из store.list().
const previousOf = async store => (await store.list()).map(task => ({ ...task }));
const restore = async (store, helpers) => restoreSessions(await previousOf(store), {
  store,
  enqueue: id => helpers.enqueued.push(id),
  restorePendingFiles: async () => {},
  onRestored: () => {},
  continuePrompt: 'продолжай'
});

const base = (overrides = {}) => ({
  id: 'lost-session',
  prompt: 'первый ход',
  status: 'RUNNING',
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 60_000).toISOString(),
  assistantText: 'частичный ответ',
  thinkingText: '',
  workspacePath: '/tmp/does-not-matter',
  ...overrides
});

const eventsOf = async (store, id) => (await store.readEvents(id, 100, 0)) || [];

test('REC-01: потерян файл сессии — FAILED/SESSION_LOST и ровно одно TASK_FAILED', { timeout: 30000 }, async t => {
  const { root, store, enqueued } = await fixture(t);
  await store.create(base({ piSessionFile: path.join(root, 'pi-sessions', 'lost.jsonl') }));

  await restore(store, { enqueued });

  const [task] = await store.list();
  assert.equal(task.status, 'FAILED');
  assert.equal(task.errorCode, 'SESSION_LOST');
  assert.equal(enqueued.length, 0, 'ход не перезапускается');

  const events = await eventsOf(store, task.id);
  const terminal = events.filter(event => event.type === 'TASK_FAILED');
  assert.equal(terminal.length, 1, `события: ${events.map(event => event.type).join(',')}`);
  assert.equal(terminal[0].data.errorCode, 'SESSION_LOST');
  assert.equal(terminal[0].message, task.error);
  assert.equal(terminal[0].seq, task.snapshotSeq, 'снимок версионирован тем же событием');
});

test('REC-02: файл сессии цел, продолжать нечего — FAILED_RECOVERY и терминальное событие', { timeout: 30000 }, async t => {
  const { root, store } = await fixture(t);
  const file = path.join(root, 'pi-sessions', 'intact.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{"type":"session"}\n');
  await store.create(base({ piSessionFile: file }));

  await restore(store, { enqueued: [] });

  const [task] = await store.list();
  assert.equal(task.status, 'FAILED');
  assert.equal(task.errorCode, 'FAILED_RECOVERY');
  const terminal = (await eventsOf(store, task.id)).filter(event => event.type === 'TASK_FAILED');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].data.errorCode, 'FAILED_RECOVERY');
});

test('REC-03: повторный рестарт не пишет второе TASK_FAILED и не трогает Runs', { timeout: 30000 }, async t => {
  const { root, store, enqueued } = await fixture(t);
  await store.create(base({ piSessionFile: path.join(root, 'pi-sessions', 'lost.jsonl') }));
  await restore(store, { enqueued });
  const runsBefore = await store.listRuns('lost-session', 50);

  await restore(store, { enqueued });

  const tasks = await store.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'FAILED');
  const terminal = (await eventsOf(store, 'lost-session')).filter(event => event.type === 'TASK_FAILED');
  assert.equal(terminal.length, 1, 'второго события нет');
  assert.deepEqual(await store.listRuns('lost-session', 50), runsBefore, 'Runs не изменились');
});

test('REC-04: событие падения читается с курсора, полученного до падения', { timeout: 30000 }, async t => {
  const { root, store, enqueued } = await fixture(t);
  await store.create(base({ piSessionFile: path.join(root, 'pi-sessions', 'lost.jsonl') }));
  const before = Math.max(0, ...(await eventsOf(store, 'lost-session')).map(event => event.seq || 0));

  await restore(store, { enqueued });

  const forward = await store.readEventsForward('lost-session', 100, before);
  const types = forward.map(event => event.type);
  assert.ok(types.includes('TASK_FAILED'), `после курсора ${before}: ${types.join(',')}`);
  assert.ok(forward.every(event => event.seq > before), 'курсор не откатывается');
});

test('REC-05: сбой записи не оставляет FAILED без события', { timeout: 30000 }, async t => {
  const { root, store } = await fixture(t);
  await store.create(base({ piSessionFile: path.join(root, 'pi-sessions', 'lost.jsonl') }));
  const failing = Object.create(store);
  failing.appendEventWithTask = async () => { throw new Error('disk full'); };

  await assert.rejects(restore(failing, { enqueued: [] }), /disk full/);

  const [task] = await store.list();
  assert.equal(task.status, 'RUNNING', 'снимок не объявляет FAILED');
  assert.equal((await eventsOf(store, 'lost-session')).filter(event => event.type === 'TASK_FAILED').length, 0,
    'события тоже нет');
});

test('REC-06: queued-сессия восстанавливается по прежним правилам', { timeout: 30000 }, async t => {
  const { store, enqueued } = await fixture(t);
  await store.create(base({ id: 'queued-session', status: 'QUEUED', workspacePath: null }));

  await restore(store, { enqueued });

  const [task] = await store.list();
  assert.equal(task.status, 'QUEUED');
  assert.equal(task.queueReason, 'RESTORED');
  assert.deepEqual(enqueued, ['queued-session']);
  assert.equal((await eventsOf(store, 'queued-session')).filter(event => event.type === 'TASK_FAILED').length, 0);
});

// REC-04 (настоящий маршрут): SSE с курсором до падения получает TASK_FAILED.
test('REC-04: SSE с курсором до падения получает TASK_FAILED после рестарта', { timeout: 180000 }, async t => {
  const { startFixture } = await import('./server-fixture.mjs');
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первый ход' });
  const id = created.id;
  for (let i = 0; i < 200; i++) { const task = await api(`/api/tasks/${id}`); if (task.status === 'SUCCEEDED') break; await new Promise(r => setTimeout(r, 50)); }

  await api(`/api/tasks/${id}/message`, { text: 'fault-hang' });
  for (let i = 0; i < 200; i++) { const task = await api(`/api/tasks/${id}`); if (task.status === 'RUNNING') break; await new Promise(r => setTimeout(r, 50)); }
  const before = await api(`/api/tasks/${id}/events?limit=1000`);
  const cursor = Math.max(...(Array.isArray(before) ? before : before.events).map(event => event.seq));

  // Файл сессии пропадает, пока сервер ещё держит ход: после рестарта продолжать нечего.
  const dir = path.join(fixture.root, 'data', 'pi-sessions', id);
  await fs.rm(dir, { recursive: true, force: true });
  await fixture.restart();

  const response = await fetch(`${base}/api/tasks/${id}/stream`, { headers: { 'last-event-id': String(cursor) } });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !text.includes('TASK_FAILED')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel().catch(() => {});

  assert.match(text, /TASK_FAILED/, `поток после курсора ${cursor}: ${text.slice(0, 400)}`);
  assert.match(text, /SESSION_LOST/);
  const task = await api(`/api/tasks/${id}`);
  assert.equal(task.status, 'FAILED');
  assert.equal(task.errorCode, 'SESSION_LOST');
});
