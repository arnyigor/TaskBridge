// Пункт 1.1 плана: у каждого выполнения свой runId, и он виден снаружи.
// Проверяется сквозь HTTP на фикстуре: пока ход идёт — runId есть и совпадает с
// записью журнала прогонов, после завершения — прогон закрыт, а история осталась.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFixture } from './server-fixture.mjs';

const waitFor = async (check, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('не дождались состояния');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

test('runId виден во время хода и остаётся в журнале прогонов после', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'slow' });
  // Пока ход идёт, снимок задачи называет активный прогон.
  const running = await waitFor(async () => {
    const current = await fixture.api(`/api/tasks/${task.id}`);
    return current.runId ? current : null;
  });
  assert.match(String(running.runId), /^[0-9a-f-]{36}$/, 'runId — идентификатор прогона');

  const finished = await waitFor(async () => {
    const current = await fixture.api(`/api/tasks/${task.id}`);
    return ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(current.status) ? current : null;
  });
  assert.equal(finished.status, 'SUCCEEDED');

  const { runs } = await fixture.api(`/api/tasks/${task.id}/runs`);
  const match = runs.find(run => run.id === running.runId);
  assert.ok(match, 'прогон из снимка есть в журнале');
  assert.equal(match.taskId, task.id);
  assert.equal(match.status, 'SUCCEEDED', 'прогон закрыт тем же статусом, что и ход');
  assert.ok(match.finishedAt, 'у закрытого прогона есть время окончания');
});
