// Что TaskBridge дописывает к запросу и что остаётся от хода, если модель
// завершилась ошибкой (§4, §7 плана 1.3).
//
// Первый тест: служебные инструкции больше не требуют отчёта об изменениях для
// информационного запроса, а follow-up остаётся дословным — правила приходят с
// первым ходом и живут в транскрипте Pi.
// Второй: успешный вывод инструмента переживает ошибку модели — событие
// TASK_FAILED и result.md называют найденное, а не оставляют пустое
// «Ответ не завершён».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

function deliveries(root) {
  const file = path.join(root, 'pi-deliveries.ndjson');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function terminal(api, id) {
  for (let i = 0; i < 800; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Ход не завершился за 20 с');
}

test('информационный запрос не требует отчёта об изменениях, follow-up — по тем же правилам', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'Есть ли у меня курс Unreal? В Learning посмотри.' });
  const first = await terminal(api, created.id);
  assert.equal(first.status, 'SUCCEEDED', fixture.logs());

  const initial = deliveries(fixture.root).find(entry => entry.type === 'prompt' && entry.message.includes('В Learning посмотри'));
  assert.ok(initial, JSON.stringify(deliveries(fixture.root)));
  assert.ok(initial.message.startsWith('Есть ли у меня курс Unreal? В Learning посмотри.'), 'запрос пользователя идёт первым и дословно');
  assert.match(initial.message, /Task instructions \(quick\)/);
  assert.match(initial.message, /report it and stop/);
  assert.doesNotMatch(initial.message, /summarize what you changed/, 'информационный запрос не поручает отчёт об изменениях');

  // Правила приходят с первым ходом и остаются в транскрипте Pi: follow-up
  // доставляется дословно (на этом инварианте стоят очередь, восстановление
  // после перезапуска и правило команд расширений).
  await api(`/api/tasks/${created.id}/message`, { text: 'Исправь заодно опечатку в названии' });
  const second = await terminal(api, created.id);
  assert.equal(second.status, 'SUCCEEDED', fixture.logs());

  const followUp = deliveries(fixture.root).find(entry => entry.message.includes('Исправь заодно опечатку'));
  assert.ok(followUp, JSON.stringify(deliveries(fixture.root)));
  assert.equal(followUp.message, 'Исправь заодно опечатку в названии', 'follow-up уходит как есть, без повторной инструкции');
});

test('найденное инструментом переживает ошибку модели: событие TASK_FAILED и result.md', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  // Фикстур сначала отдаёт результат read («hello from example.txt»), затем
  // завершает ход stopReason=error — ровно случай «нашли, но ответ не дописан».
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'Найди файл example и model-error' });
  const failed = await terminal(api, created.id);
  assert.equal(failed.status, 'FAILED', fixture.logs());
  assert.equal(failed.error, 'Fixture model error', 'error остаётся строкой провайдера: её значение — часть API');

  // Доказательство инструмента рядом с ошибкой, а не вместо неё.
  const events = await api(`/api/tasks/${created.id}/events?limit=500`);
  const list = Array.isArray(events) ? events : (events.events || []);
  const failure = list.filter(event => event.type === 'TASK_FAILED').pop();
  assert.ok(failure, JSON.stringify(list.slice(-5)));
  const evidence = failure.data?.toolEvidence || [];
  assert.ok(evidence.length >= 1, JSON.stringify(failure.data));
  assert.equal(evidence[0].toolName, 'read');
  assert.equal(evidence[0].target, 'example.txt');
  assert.match(evidence[0].excerpt, /hello from example\.txt/);

  const md = fs.readFileSync(path.join(fixture.root, 'data', 'tasks', created.id, 'artifacts', 'result.md'), 'utf8');
  assert.match(md, /## Tool evidence/);
  assert.match(md, /hello from example\.txt/);

  const json = JSON.parse(fs.readFileSync(path.join(fixture.root, 'data', 'tasks', created.id, 'artifacts', 'result.json'), 'utf8'));
  assert.equal(json.status, 'FAILED', 'терминальное состояние не подменяется успехом');
  assert.ok(Array.isArray(json.toolEvidence) && json.toolEvidence.length >= 1, JSON.stringify(json.toolEvidence));
  assert.equal(json.toolEvidence[0].toolName, 'read');
});

test('служебные инструкции не попадают в steer, которым вклиниваются в ответ', { timeout: 40000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'первое' });
  assert.equal((await terminal(api, created.id)).status, 'SUCCEEDED', fixture.logs());
  await api(`/api/tasks/${created.id}/message`, { text: 'работай slow' });
  for (let i = 0; i < 200; i++) {
    if ((await api(`/api/tasks/${created.id}`)).status === 'RUNNING') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  await api(`/api/tasks/${created.id}/message`, { text: 'короткая ремарка по ходу' });
  await terminal(api, created.id);

  const steer = deliveries(fixture.root).find(entry => entry.type === 'steer');
  assert.ok(steer, JSON.stringify(deliveries(fixture.root)));
  assert.equal(steer.message, 'короткая ремарка по ходу', 'ремарка оператора уходит как есть');
});
