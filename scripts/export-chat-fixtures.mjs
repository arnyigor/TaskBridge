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
  let last = null;
  for (let i = 0; i < tries; i++) {
    const task = await api(`/api/tasks/${id}`);
    last = task;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status) && !(task.pendingPrompts || []).length) return task;
    await sleep(50);
  }
  // «did not settle» alone says nothing about why: a session queued behind a busy
  // machine, a hung tool and a crash all look the same from here.
  throw new Error(`session did not settle: status=${last?.status} reason=${last?.queueReason || '—'} current=${JSON.stringify(last?.current || '')} pending=${(last?.pendingPrompts || []).length}`);
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

/**
 * Waits until the machine has nothing running or queued.
 *
 * Every scenario drives a real session, and the machine runs a limited number of
 * them at once: create the next one while the previous is still finishing and it
 * is QUEUED instead of started, so the actor's assumptions ("Pi is streaming now")
 * are wrong and the scenario hangs in a way that looks like a product bug. The
 * suite is about the reducer, not about the queue, so it waits.
 */
async function quiet(api, tries = 600) {
  for (let i = 0; i < tries; i++) {
    const info = await api('/api/info');
    const scheduler = info.scheduler || {};
    if (!scheduler.activeTasks && !scheduler.queuedTasks) return;
    await sleep(100);
  }
  throw new Error('the machine never became idle between scenarios');
}

const failures = [];

/**
 * One scenario. A scenario that hangs must not cost the others their fixtures: the
 * corpus is generated in one pass, and the run reports which scenario failed instead
 * of leaving the rest stale (`crash-and-resume` is known-flaky — it fails the same
 * way on HEAD, see KNOWN_BASELINE_FAILURES.md).
 */
async function scenario(fixture, name, prompt, run = async () => {}) {
  const { api, base } = fixture;
  try {
    await quiet(api);
    const task = await api('/api/tasks', { projectId: 'fixture', prompt });
    const events = await capture(base, task.id, async () => {
      await run(task.id);
      await idle(api, task.id);
    });
    const final = await api(`/api/tasks/${task.id}`);
    const expected = reduce(final, events);
    await fs.writeFile(path.join(OUT, `${name}.json`), JSON.stringify({ task: final, events, expected }, null, 2) + '\n');
    console.log(`  ${name}: ${events.length} events, ${expected.length} turns`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  ✖ ${name}: ${error.message}`);
  }
}

const fixture = await startFixture();
try {
  await fs.mkdir(OUT, { recursive: true });
  // `base` is needed by the fork block below (it captures the copy's own stream).
  const { api, base } = fixture;
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

  // Thinking is part of the conversation (TESTING_PLAN.md §4, «02-thinking»): the
  // reasoning block, its length label and the "no answer yet" state all come from
  // these deltas, and both reducers must build the same turn from them.
  await scenario(fixture, 'thinking', 'think — подумай и ответь коротко');

  // In-place edit of the operator's line (TURN_EDITED): the log is rewritten and the
  // answer below it is re-run. The variant case lives in edit-answer.json.
  await scenario(fixture, 'edit-turn', 'вопрос, который перепишут', async (id) => {
    await idle(api, id);
    const events = await api(`/api/tasks/${id}/events?limit=0`);
    const user = events.filter((event) => event.type === 'USER_MESSAGE').at(-1);
    const turnId = user ? `user-${user.seq}` : 'user-initial';
    await api(`/api/tasks/${id}/turns/${turnId}/edit`, { text: 'переписанный вопрос' });
  });

  await scenario(fixture, 'model-error', 'model-error-json');

  // A branch is a session of its own, so the copy is what a client of the new
  // session receives — captured here instead of the source's stream. `from`
  // starts the copy at the chosen message: its text becomes the session's own
  // prompt (no event of its own, exactly like a session created with it) and
  // everything after it is copied with the source cursors.
  {
    const source = await api('/api/tasks', { projectId: 'fixture', prompt: 'первое' });
    await idle(api, source.id);
    await api(`/api/tasks/${source.id}/message`, { text: 'второй вопрос' });
    await idle(api, source.id);
    const events = await api(`/api/tasks/${source.id}/events?limit=0`);
    const user = events.filter((event) => event.type === 'USER_MESSAGE').at(-1);
    const fork = await api(`/api/tasks/${source.id}/fork`, { turnId: `user-${user.seq}`, direction: 'from' });
    const copied = await capture(base, fork.id, async () => {});
    const final = await api(`/api/tasks/${fork.id}`);
    const expected = reduce(final, copied);
    await fs.writeFile(path.join(OUT, 'fork-from.json'), JSON.stringify({ task: final, events: copied, expected }, null, 2) + '\n');
    console.log(`  fork-from: ${copied.length} events, ${expected.length} turns`);
  }
} finally {
  await fixture.close();
}

if (failures.length) {
  console.log('\nСценарии, которые не удалось снять (остальные файлы обновлены):');
  for (const failure of failures) console.log(`  ${failure}`);
  process.exit(1);
}
