// AUTO-03B: сводка запуска читает существующие факты и не выдумывает числа.
// Здесь проверяются правила, которые легко сделать «удобными» и соврать:
// незавершённый запуск не имеет длительности, отсутствие usage — не ноль,
// ожидание в очереди не смешивается с работой модели.
import test from 'node:test';
import assert from 'node:assert/strict';
import { betweenIso, invocationSummary } from '../src/automation/invocation-summary.mjs';

test('длительность считается только между известными моментами в правильном порядке', () => {
  assert.equal(betweenIso('2026-10-21T09:00:00.000Z', '2026-10-21T09:02:41.000Z'), 161_000);
  assert.equal(betweenIso('2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z'), 0);
  assert.equal(betweenIso('2026-10-21T09:02:41.000Z', '2026-10-21T09:00:00.000Z'), null, 'обратный порядок — не «-161 с»');
  assert.equal(betweenIso(null, '2026-10-21T09:00:00.000Z'), null);
  assert.equal(betweenIso('не дата', '2026-10-21T09:00:00.000Z'), null);
});

test('завершённый запуск: время, модель, токены с указанием масштаба', () => {
  const summary = invocationSummary(
    {
      id: 'inv-1', status: 'SUCCEEDED', trigger: 'schedule',
      scheduledAt: '2026-10-21T09:00:00.000Z', startedAt: '2026-10-21T09:00:20.000Z',
      finishedAt: '2026-10-21T09:03:01.000Z', verification: 'PASSED',
      sessionId: 'sess-1', resultArtifact: 'result.md',
    },
    { model: { provider: 'deepseek', id: 'deepseek-flash' }, lastUsage: { input: 17000, output: 1420, totalTokens: 18420 } },
  );
  assert.equal(summary.durationMs, 161_000);
  assert.equal(summary.waitingMs, 20_000, 'ожидание в очереди отдельно от работы');
  assert.deepEqual(summary.model, { provider: 'deepseek', id: 'deepseek-flash' });
  assert.equal(summary.tokens.total, 18420);
  assert.equal(summary.tokens.scope, 'last-turn', 'масштаб токенов назван явно');
  assert.equal(summary.verification, 'PASSED');
  assert.equal(summary.sessionExists, true);
  assert.equal(summary.cost, null, 'стоимость без тарифа не выдумывается');
});

test('незавершённый запуск не имеет длительности, а отсутствие usage — не ноль', () => {
  const running = invocationSummary({ id: 'inv-2', status: 'RUNNING', startedAt: '2026-10-21T09:00:00.000Z', finishedAt: null });
  assert.equal(running.durationMs, null, 'длительность «0 мс» была бы враньём');
  assert.equal(running.tokens, null);
  assert.equal(running.model, null);

  const noUsage = invocationSummary(
    { id: 'inv-3', status: 'SUCCEEDED', trigger: 'manual', startedAt: '2026-10-21T09:00:00.000Z', finishedAt: '2026-10-21T09:00:10.000Z' },
    { model: { provider: 'strata', id: 'qwen3.8-flash-next-iq3_s' }, lastUsage: null },
  );
  assert.equal(noUsage.tokens, null, 'нет usage — «нет данных», а не 0');
  assert.equal(noUsage.waitingMs, null, 'ручной запуск не ждал расписания');
  assert.deepEqual(noUsage.model, { provider: 'strata', id: 'qwen3.8-flash-next-iq3_s' });
});

test('удалённая сессия: время и статус запуска остаются, модель неизвестна', () => {
  const summary = invocationSummary(
    { id: 'inv-4', status: 'FAILED', startedAt: '2026-10-21T09:00:00.000Z', finishedAt: '2026-10-21T09:00:30.000Z', reason: 'сессия запуска больше не существует', sessionId: 'gone' },
    null,
  );
  assert.equal(summary.durationMs, 30_000);
  assert.equal(summary.sessionExists, false);
  assert.equal(summary.model, null);
  assert.equal(summary.tokens, null);
  assert.match(summary.reason, /больше не существует/);
});

test('сводка отдаётся и через API запуска', { timeout: 120000 }, async t => {
  const { startFixture } = await import('./server-fixture.mjs');
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const api = fixture.api;
  const [project] = await api('/api/projects');
  const headers = { 'content-type': 'application/json' };
  const post = (route, body) => fetch(fixture.base + route, { method: 'POST', headers, body: JSON.stringify(body) }).then(response => response.json());

  const recipe = await post('/api/recipes', { projectId: project.id, name: 'Сводка', promptTemplate: 'Проверь сборку.' });
  const schedule = await post('/api/schedules', { recipeId: recipe.id, spec: { kind: 'daily', at: '09:00' } });
  const invocation = await post(`/api/schedules/${schedule.id}/run`, {});

  const response = await fetch(`${fixture.base}/api/invocations/${invocation.id}/summary`);
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.id, invocation.id);
  assert.equal(summary.trigger, 'manual', 'ручной запуск по кнопке');
  assert.equal(summary.sessionId, invocation.sessionId);
  assert.ok(summary.sessionExists, 'сессия ещё существует');

  // Неизвестный запуск — 404-подобный отказ, а не выдуманная сводка.
  const missing = await fetch(`${fixture.base}/api/invocations/inv-нет/summary`);
  assert.ok(missing.status >= 400, `неизвестный запуск: ${missing.status}`);
});
