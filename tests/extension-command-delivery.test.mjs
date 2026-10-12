// Команда расширения Pi (например `/nudge`), отправленная пока агент работает,
// уходила как steer — а Pi ОТКАЗЫВАЕТСЯ ставить такие команды в очередь
// («Extension command "/nudge" cannot be queued. Use prompt() or execute the command
// when not streaming.», agent-session `_throwIfExtensionCommand`). Команда терялась:
// именно это выглядело как «/nudge в TaskBridge не работает».
//
// Проверяется по журналу доставок поддельного Pi (tests/fake-pi.mjs пишет, каким RPC
// пришёл текст): команда при работающем агенте идёт prompt'ом, а не-команда — прежним
// steer'ом, чтобы очередь для обычных сообщений осталась очередью.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

const DELIVERIES = 'pi-deliveries.ndjson';

function deliveries(root) {
  const file = path.join(root, DELIVERIES);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function waitFor(api, id, predicate, label) {
  for (let i = 0; i < 200; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (predicate(task)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Не дождались: ${label}`);
}

// Фикстур стримит «slow»-ответ 10 с: ждать терминального состояния нужно дольше.
async function terminal(api, id) {
  for (let i = 0; i < 800; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Ход не завершился за 20 с');
}

// Сессия, которая «работает»: текст со словом slow заставляет фикстур стримить 10 с.
async function busyFixture(t) {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первое' });
  const id = created.id;
  assert.equal((await terminal(api, id)).status, 'SUCCEEDED', fixture.logs());
  await api(`/api/tasks/${id}/message`, { text: 'работай slow' });
  await waitFor(api, id, task => task.status === 'RUNNING', 'начала работы агента');
  return { fixture, api, id };
}

test('команда расширения при работающем агенте идёт prompt, а не steer', { timeout: 40000 }, async t => {
  const { fixture, api, id } = await busyFixture(t);

  await api(`/api/tasks/${id}/message`, { text: '/nudge' });
  const sent = deliveries(fixture.root).filter(entry => entry.message === '/nudge');
  assert.equal(sent.length, 1, `доставок /nudge: ${JSON.stringify(deliveries(fixture.root))}`);
  assert.equal(sent[0].type, 'prompt', 'Pi ставит в очередь только prompt; steer с командой отклоняется');

  await terminal(api, id);
});

test('обычный текст при работающем агенте остаётся steer, а не превращается в prompt', { timeout: 40000 }, async t => {
  const { fixture, api, id } = await busyFixture(t);

  await api(`/api/tasks/${id}/message`, { text: 'короткая ремарка по ходу' });
  const sent = deliveries(fixture.root).filter(entry => entry.message === 'короткая ремарка по ходу');
  assert.equal(sent.length, 1, JSON.stringify(deliveries(fixture.root)));
  assert.equal(sent[0].type, 'steer', 'обычный текст по-прежнему вклинивается, а не ждёт');

  await terminal(api, id);
});

test('не-команда со слэшем не считается командой расширения', { timeout: 40000 }, async t => {
  const { fixture, api, id } = await busyFixture(t);

  // Такого имени у Pi нет: разворачивать нечего, и очередь для него законна.
  await api(`/api/tasks/${id}/message`, { text: '/skill:deploy' });
  await api(`/api/tasks/${id}/message`, { text: '/что-то-своё' });
  const log = deliveries(fixture.root);
  assert.equal(log.find(entry => entry.message === '/skill:deploy')?.type, 'steer', JSON.stringify(log));
  assert.equal(log.find(entry => entry.message === '/что-то-своё')?.type, 'steer', JSON.stringify(log));

  await terminal(api, id);
});

test('«вклиниться» командой тоже идёт prompt: очередь для команды запрещена всегда', { timeout: 40000 }, async t => {
  const { fixture, api, id } = await busyFixture(t);

  // mode steer = «вклиниться сразу» (Ctrl+Enter). Pi отказывает такому тексту даже
  // на свободной сессии, поэтому команда выполняется, а не теряется.
  await api(`/api/tasks/${id}/message`, { text: '/nudge', mode: 'steer' });
  const sent = deliveries(fixture.root).filter(entry => entry.message === '/nudge');
  assert.equal(sent.length, 1, JSON.stringify(deliveries(fixture.root)));
  assert.equal(sent[0].type, 'prompt', 'команду нельзя вклинивать — только выполнять');

  await terminal(api, id);
});

test('то же имя на свободной сессии идёт prompt и без правки', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первое' });
  const id = created.id;
  assert.equal((await terminal(api, id)).status, 'SUCCEEDED', fixture.logs());

  await api(`/api/tasks/${id}/message`, { text: '/nudge' });
  assert.equal((await terminal(api, id)).status, 'SUCCEEDED', fixture.logs());
  const sent = deliveries(fixture.root).filter(entry => entry.message === '/nudge');
  assert.equal(sent.length, 1, JSON.stringify(deliveries(fixture.root)));
  assert.equal(sent[0].type, 'prompt', 'на свободной сессии поведение не изменилось');
});
