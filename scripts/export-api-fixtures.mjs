#!/usr/bin/env node
// Records real API responses as fixtures for clients (KMP plan K1).
//
// Boots a throwaway TaskBridge on fake-pi (tests/server-fixture.mjs), runs a
// few representative scenarios and writes what the server actually answered
// to tests/fixtures/api/. The Kotlin client's tests parse these files, so a
// change in the server's shapes shows up as a failing client test instead of
// a crash on the phone.
//
//   node scripts/export-api-fixtures.mjs          (re-run after changing the API)
//
// Ids and timestamps differ on every run; that is fine: the files are
// examples of the shapes, and tests assert on structure, not on values.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../tests/server-fixture.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'tests', 'fixtures', 'api');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function raw(base, route, { method = 'GET', body } = {}) {
  const response = await fetch(base + route, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function settle(api, id, { tries = 400 } = {}) {
  for (let i = 0; i < tries; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status) && !(task.pendingPrompts || []).length) return task;
    await sleep(50);
  }
  throw new Error(`task ${id} did not settle`);
}

// The SSE bytes exactly as a client receives them, for `ms` milliseconds.
async function sse(base, route, ms) {
  const controller = new AbortController();
  const response = await fetch(base + route, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch { /* aborted on purpose */ }
  clearTimeout(timer);
  return text;
}

async function write(name, data) {
  const file = path.join(OUT, name);
  await fs.writeFile(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
  console.log(`  ${path.relative(ROOT, file)}`);
}

const fixture = await startFixture();
try {
  await fs.mkdir(OUT, { recursive: true });
  const { api, base } = fixture;

  // Let the startup Pi version probe finish so /api/info carries `pi`.
  for (let i = 0; i < 100 && !(await api('/api/info')).pi; i++) await sleep(50);

  // A plain turn with a tool call.
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'Прочитай example.txt', commandId: 'fixture-create-1', clientId: 'fixture-android' });
  await write('task-created.json', created);
  const done = await settle(api, created.id);
  await write('task-succeeded.json', done);
  await write('events-turn.json', await api(`/api/tasks/${created.id}/events?limit=0`));

  // A follow-up with an origin, and a prompt queued behind a running turn.
  await api(`/api/tasks/${created.id}/message`, { text: 'slow — второй ход', commandId: 'fixture-msg-1', clientId: 'fixture-android' });
  await sleep(300);
  const queued = await api(`/api/tasks/${created.id}/message`, { text: 'из очереди', queue: true, commandId: 'fixture-msg-2', clientId: 'fixture-desktop' });
  await write('task-with-queue.json', queued);
  await settle(api, created.id);
  const all = await api(`/api/tasks/${created.id}/events?limit=0`);
  await write('events-queue.json', all);

  // Errors, as the envelope and status code a client sees.
  await write('error-not-found.json', await raw(base, '/api/tasks/does-not-exist'));
  await write('error-route-not-found.json', await raw(base, '/api/definitely-not-a-route'));
  await write('error-conflict.json', await raw(base, `/api/tasks/${created.id}/message`, {
    method: 'POST', body: { text: 'другое тело', commandId: 'fixture-msg-1', clientId: 'fixture-android' },
  }));
  await write('error-input-invalid.json', await raw(base, `/api/tasks/${created.id}/message`, { method: 'POST', body: { text: '' } }));

  // A failed turn (Pi died mid tool call).
  const crashed = await api('/api/tasks', { projectId: 'fixture', prompt: 'fault-crash now' });
  await write('task-failed.json', await settle(api, crashed.id));

  // Lists and host info last, so they include everything above.
  await write('info.json', await api('/api/info'));
  await write('projects.json', await api('/api/projects'));
  await write('tasks.json', await api('/api/tasks'));
  await write('command-status.json', await api('/api/commands/fixture-msg-1'));

  // What the chat screen needs besides the event log.
  await write('models.json', await api('/api/models'));
  await write('events-tail.json', await api(`/api/tasks/${created.id}/events?tail=2`));
  const toolCall = all.find((event) => event.data?.pi?.type === 'tool_execution_start')?.data.pi.toolCallId;
  if (toolCall) await write('tool-output.json', await raw(base, `/api/tasks/${created.id}/tools/${encodeURIComponent(toolCall)}/output`));
  const form = new FormData();
  form.append('files', new Blob(['hello from a phone'], { type: 'text/plain' }), 'заметка.txt');
  const upload = await fetch(base + '/api/uploads', { method: 'POST', headers: { 'x-taskbridge-upload': '1' }, body: form });
  await write('upload.json', { status: upload.status, body: await upload.json() });
  await write('approvals.json', await api(`/api/tasks/${created.id}/approvals`));
  await write('auth.json', await api('/api/auth'));

  // The live stream: a replay from seq 0 of the finished session.
  await write('stream-replay.sse', await sse(base, `/api/tasks/${created.id}/stream?after=0`, 1500));
} finally {
  await fixture.close();
}
