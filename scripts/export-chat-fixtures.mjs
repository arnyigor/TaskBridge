#!/usr/bin/env node
// Golden files for the chat reducer ports (KMP client).
//
// Runs real scenarios on a throwaway TaskBridge with fake-pi, captures the
// events exactly as a client receives them (the live SSE stream, deltas
// included), and records what web/chat-state.mjs — the reference reducer —
// builds from them. The Kotlin ChatReducer replays the same events and must
// arrive at the same turns.
//
//   node scripts/export-chat-fixtures.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../tests/server-fixture.mjs';
import { ChatState } from '../web/chat-state.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'tests', 'fixtures', 'chat');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Collects every event of a session from the live stream while `run` acts.
async function capture(base, id, run) {
  const events = [];
  const controller = new AbortController();
  const response = await fetch(`${base}/api/tasks/${id}/stream?after=0`, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (data) events.push(JSON.parse(data));
        }
      }
    } catch { /* aborted */ }
  })();
  await run();
  await sleep(400);
  controller.abort();
  await pump;
  return events;
}

async function idle(api, id, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status) && !(task.pendingPrompts || []).length) return task;
    await sleep(50);
  }
  throw new Error('session did not settle');
}

function reduce(task, events) {
  const state = new ChatState(task);
  for (const event of events) state.apply(event);
  state.snapshot(task);
  return state.turns.filter((turn) => !turn.hidden).map((turn) => ({
    id: turn.id,
    role: turn.role,
    text: turn.text || '',
    thinking: turn.thinking || '',
    status: turn.status || '',
    active: Boolean(turn.active),
    final: Boolean(turn.final),
    error: turn.error || null,
    tools: (turn.tools || []).map((tool) => ({ id: tool.id, name: tool.name, state: tool.state })),
  }));
}

async function scenario(fixture, name, prompt, run = async () => {}) {
  const { api, base } = fixture;
  const task = await api('/api/tasks', { projectId: 'fixture', prompt });
  const events = await capture(base, task.id, async () => {
    await run(task.id);
    await idle(api, task.id);
  });
  const final = await api(`/api/tasks/${task.id}`);
  const expected = reduce(final, events);
  await fs.writeFile(path.join(OUT, `${name}.json`), JSON.stringify({ task: final, events, expected }, null, 2) + '\n');
  console.log(`  ${name}: ${events.length} events, ${expected.length} turns`);
}

const fixture = await startFixture();
try {
  await fs.mkdir(OUT, { recursive: true });
  const { api } = fixture;
  const newestAnswer = async (id) => {
    const task = await api(`/api/tasks/${id}`);
    const events = await api(`/api/tasks/${id}/events?limit=0`);
    const state = new ChatState(task);
    for (const event of events) state.apply(event);
    return [...state.turns].reverse().find((turn) => turn.role === 'assistant' && !turn.hidden).id;
  };

  await scenario(fixture, 'basic', 'Прочитай example.txt');

  await scenario(fixture, 'follow-up', 'первый', async (id) => {
    await idle(api, id);
    await api(`/api/tasks/${id}/message`, { text: 'второй вопрос', commandId: 'chat-f-1', clientId: 'android-test' });
  });

  await scenario(fixture, 'queued', 'slow — длинный ход', async (id) => {
    await sleep(300);
    await api(`/api/tasks/${id}/message`, { text: 'в очередь', queue: true, commandId: 'chat-q-1', clientId: 'desktop-test' });
  });

  await scenario(fixture, 'steer', 'slow — долго думаю', async (id) => {
    await sleep(300);
    await api(`/api/tasks/${id}/message`, { text: 'уточнение по ходу' });
  });

  await scenario(fixture, 'cancel', 'slow — отменят', async (id) => {
    await sleep(300);
    await api(`/api/tasks/${id}/cancel`, {});
  });

  await scenario(fixture, 'send-now', 'slow — перебьют', async (id) => {
    await sleep(300);
    await api(`/api/tasks/${id}/message`, { text: 'срочно', now: true });
  });

  await scenario(fixture, 'regenerate', 'вопрос для перегенерации', async (id) => {
    await idle(api, id);
    await api(`/api/tasks/${id}/regenerate`, { turnId: await newestAnswer(id) });
  });

  await scenario(fixture, 'edit-answer', 'вопрос для правки', async (id) => {
    await idle(api, id);
    const answer = await newestAnswer(id);
    await api(`/api/tasks/${id}/turns/${answer}/edit`, { text: 'исправленный ответ', branch: true });
  });

  await scenario(fixture, 'delete-turn', 'первое сообщение', async (id) => {
    await idle(api, id);
    await api(`/api/tasks/${id}/message`, { text: 'удалить меня' });
    await idle(api, id);
    const events = await api(`/api/tasks/${id}/events?limit=0`);
    const user = events.filter((event) => event.type === 'USER_MESSAGE').at(-1);
    await api(`/api/tasks/${id}/turns/user-${user.seq}/delete`, {});
  });

  await scenario(fixture, 'crash-and-resume', 'fault-crash', async (id) => {
    await idle(api, id);
    await api(`/api/tasks/${id}/message`, { text: 'продолжай' });
  });

  await scenario(fixture, 'model-error', 'model-error-json');
} finally {
  await fixture.close();
}
