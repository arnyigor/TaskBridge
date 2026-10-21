// Доказательства инструментов: границы и привязка к ходу (§7 плана 1.3).
//
// `toolEvidence` существует ради одного случая: ход завершился ошибкой модели
// после того, как инструменты уже вернули результат. Значит он обязан быть
// предсказуемым по размеру — одна bash-команда может вернуть сотни килобайт — и
// не переезжать в следующий ход вместе с сессией.
//
// Проверяется на живом фикстуре Pi (tests/fake-pi.mjs): `many-tools` даёт больше
// успешных вызовов, чем хранится, `huge-output` — результат в 200 КБ, `model-error`
// завершает ход ошибкой.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

async function terminal(api, id) {
  for (let i = 0; i < 800; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Ход не завершился за 20 с');
}

function resultJson(root, id) {
  return JSON.parse(fs.readFileSync(path.join(root, 'data', 'tasks', id, 'artifacts', 'result.json'), 'utf8'));
}

async function failureEvent(api, id) {
  const events = await api(`/api/tasks/${id}/events?limit=500`);
  const list = Array.isArray(events) ? events : (events.events || []);
  return list.filter(event => event.type === 'TASK_FAILED').pop();
}

test('больше успешных вызовов, чем хранится: evidence ограничен 10 записями', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'проверь many-tools и закончи model-error' });
  const failed = await terminal(api, created.id);
  assert.equal(failed.status, 'FAILED', fixture.logs());

  const evidence = resultJson(fixture.root, created.id).toolEvidence;
  assert.equal(evidence.length, 10, `записей: ${evidence.length}`);
  // Хранится последние: первая запись хода (read example.txt) уже вытеснена.
  assert.equal(evidence.at(-1).toolName, 'bash');
  assert.match(evidence.at(-1).target, /echo line-11/);
});

test('результат в 200 КБ не раздувает evidence и не тянет хвост', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'сделай huge-output и model-error' });
  assert.equal((await terminal(api, created.id)).status, 'FAILED', fixture.logs());

  const evidence = resultJson(fixture.root, created.id).toolEvidence;
  const huge = evidence.find(entry => entry.target === 'cat big.log');
  assert.ok(huge, JSON.stringify(evidence.map(entry => entry.target)));
  assert.ok(huge.excerpt.length <= 280, `длина выжимки: ${huge.excerpt.length}`);
  assert.doesNotMatch(huge.excerpt, /TAIL-MARKER/, 'выжимка — начало вывода, а не его хвост');
  // Никаких управляющих символов: вывод нормализован в одну строку.
  assert.doesNotMatch(huge.excerpt, /[\u0000-\u001f]/);

  const failure = await failureEvent(api, created.id);
  const shipped = JSON.stringify(failure.data.toolEvidence);
  assert.ok(shipped.length < 5000, `payload события: ${shipped.length} байт`);
  assert.ok(failure.data.toolEvidence.every(entry => entry.excerpt.length <= 280));
});

test('evidence привязан к своему ходу и не переезжает в следующий', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  // Ход 1: read example.txt + write result.png, затем ошибка модели.
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'make-files и model-error' });
  assert.equal((await terminal(api, created.id)).status, 'FAILED', fixture.logs());
  const first = resultJson(fixture.root, created.id).toolEvidence;
  assert.ok(first.some(entry => entry.toolName === 'write' && entry.target === 'result.png'), JSON.stringify(first));

  // Ход 2 в той же сессии: только read, и он завершается успехом.
  await api(`/api/tasks/${created.id}/message`, { text: 'а теперь просто ответь' });
  assert.equal((await terminal(api, created.id)).status, 'SUCCEEDED', fixture.logs());
  const second = resultJson(fixture.root, created.id).toolEvidence;
  assert.equal(second.length, 1, `записей во втором ходе: ${second.length} — ${JSON.stringify(second)}`);
  assert.equal(second[0].target, 'example.txt');
  assert.equal(second.some(entry => entry.toolName === 'write'), false, 'write остался в первом ходе');
});

test('доказательство не подменяет ни строку ошибки, ни терминальный статус', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'Найди example и model-error' });
  const failed = await terminal(api, created.id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error, 'Fixture model error', 'ошибка провайдера остаётся как есть');
  assert.equal(failed.errorCode, 'MODEL_ERROR');

  // Номер хода обязателен: по нему клиент отличает позднее событие прошлого
  // хода от падения нового (время и seq там уже врут — см. tests/chat.test.mjs).
  const failure = await failureEvent(api, created.id);
  assert.equal(failure.data.turn, 1);

  const json = resultJson(fixture.root, created.id);
  assert.equal(json.status, 'FAILED');
  const md = fs.readFileSync(path.join(fixture.root, 'data', 'tasks', created.id, 'artifacts', 'result.md'), 'utf8');
  assert.match(md, /## Tool evidence/);
  // Доказательство живёт в своём разделе, а не в тексте ответа модели.
  const answer = md.split('## Tool evidence')[0];
  assert.doesNotMatch(answer, /hello from example\.txt/, 'вывод инструмента не подмешивается в ответ модели');
});

test('USER_MESSAGE называет свой ход, чтобы позднюю ошибку можно было опознать', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первое' });
  assert.equal((await terminal(api, created.id)).status, 'SUCCEEDED', fixture.logs());
  await api(`/api/tasks/${created.id}/message`, { text: 'второе' });
  assert.equal((await terminal(api, created.id)).status, 'SUCCEEDED', fixture.logs());

  const events = await api(`/api/tasks/${created.id}/events?limit=200`);
  const list = Array.isArray(events) ? events : (events.events || []);
  const userTurns = list.filter(event => event.type === 'USER_MESSAGE').map(event => event.data?.turn);
  assert.deepEqual(userTurns, [2], 'у follow-up свой номер хода, а не номер первого запроса');
});

test('успешный ход без инструментов не выдумывает доказательства', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  // Фикстур всегда отдаёт один read, поэтому «пусто» проверяется на уровне
  // границы: запись появляется только там, где инструмент действительно отвечал.
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'просто ответь' });
  assert.equal((await terminal(api, created.id)).status, 'SUCCEEDED', fixture.logs());

  const json = resultJson(fixture.root, created.id);
  assert.deepEqual(json.toolEvidence.map(entry => entry.toolName), ['read']);
  assert.match(json.toolEvidence[0].excerpt, /hello from example\.txt/);
});
