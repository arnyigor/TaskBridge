import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { placeholdersIn, resolveParameters, renderRecipe, validateRecipe, normalizeParameters } from '../src/recipes/recipe.mjs';
import { startFixture } from './server-fixture.mjs';

// MR-05: Run Recipes. Проверяется то, ради чего они существуют — параметры вместо
// стены текста, подстановка только в разрешённые поля и запуск, который создаёт
// обычную сессию (а не второй источник правды о запуске).

const schema = {
  base_ref: { type: 'string', default: 'master' },
  area: { type: 'enum', values: ['all', 'android', 'server'], default: 'all' },
  run_tests: { type: 'boolean', default: true },
  attempts: { type: 'number', default: 2 },
};

const recipe = {
  id: 'rc-1', projectId: 'p', workItemId: null, name: 'Daily audit',
  promptTemplate: 'Проверь {{area}} относительно {{base_ref}}.',
  parameters: schema,
  runtime: { id: 'pi', model: null, thinking: null },
  verification: { required: true, command: null },
};

test('parameters take their defaults, and a value of the wrong kind is refused', () => {
  assert.deepEqual(resolveParameters(schema, {}), { base_ref: 'master', area: 'all', run_tests: true, attempts: 2 });
  assert.deepEqual(resolveParameters(schema, { area: 'android', run_tests: false }), { base_ref: 'master', area: 'android', run_tests: false, attempts: 2 });
  assert.throws(() => resolveParameters(schema, { area: 'телефон' }), { code: 'INPUT_INVALID' }, 'перечислимое значение проверяется');
  assert.throws(() => resolveParameters(schema, { run_tests: 'да' }), { code: 'INPUT_INVALID' });
  assert.throws(() => resolveParameters(schema, { нет_такого: 'x' }), { code: 'INPUT_INVALID' }, 'опечатка в имени параметра — отказ');
  // A default outside the declared enum would offer the phone a value the recipe refuses.
  assert.throws(() => normalizeParameters({ area: { type: 'enum', values: ['a', 'b'], default: 'c' } }), { code: 'INPUT_INVALID' });
  assert.deepEqual(normalizeParameters({ flag: { type: 'boolean' } }), { flag: { type: 'boolean', default: false } });
});

test('substitution happens in the allowed fields and nowhere else', () => {
  const rendered = renderRecipe(recipe, { area: 'android', base_ref: 'release' });
  assert.equal(rendered.prompt, 'Проверь android относительно release.');
  // Предпросмотр показывает только то, что запуск применяет (AUTO-01A): полей
  // workspace/context/limits в нём нет, потому что их никто не исполняет.
  assert.deepEqual(Object.keys(rendered).sort(), ['name', 'parameters', 'projectId', 'prompt', 'recipeId', 'runtime', 'verification', 'workItemId']);
  assert.deepEqual(rendered.parameters, { base_ref: 'release', area: 'android', run_tests: true, attempts: 2 });
  // An unknown placeholder stays as it was written: it can never become a value.
  assert.equal(renderRecipe({ ...recipe, promptTemplate: 'x {{nothing}}' }, {}).prompt, 'x {{nothing}}');
  assert.deepEqual(placeholdersIn('{{a}} {{ b }} a'), ['a', 'b'], 'placeholder-ы читаются с пробелами и без');
});

test('a recipe is validated where the operator can still see the typo', () => {
  assert.throws(() => validateRecipe({ name: 'x', promptTemplate: 'привет {{are}}', parameters: { area: { type: 'string' } } }), /которых нет в схеме/, 'опечатка в placeholder ловится при сохранении');
  assert.throws(() => validateRecipe({ name: '', promptTemplate: 'x' }), { code: 'INPUT_INVALID' });
  assert.throws(() => validateRecipe({ name: 'x', promptTemplate: '   ' }), { code: 'INPUT_INVALID' });
  // AUTO-01A (A1 из docs/auto-00-audit.md): настройки, которые запуск не исполняет,
  // отклоняются при сохранении, а не хранятся как обещание.
  for (const field of ['context', 'workspace', 'limits']) {
    assert.throws(
      () => validateRecipe({ name: 'x', promptTemplate: 'y', [field]: { any: 'value' } }),
      /рецепт не применяет/,
      `${field} обязан быть отклонён`,
    );
  }
  // Пустой объект — это «не указано», а не обещание: он проходит.
  assert.equal(validateRecipe({ name: 'x', promptTemplate: 'y', context: {}, workspace: {}, limits: {} }).name, 'x');
  // Второго ядра нет: `runtime.id` не может обещать OMP.
  assert.throws(() => validateRecipe({ name: 'x', promptTemplate: 'y', runtime: { id: 'omp' } }), /Ядро запуска/);
  const ok = validateRecipe({
    name: '  Daily audit  ', promptTemplate: 'Проверь {{area}}',
    parameters: { area: { type: 'enum', values: ['all', 'android'], default: 'all' } },
    verification: { required: true, command: 'passing' },
  });
  assert.equal(ok.name, 'Daily audit');
  assert.equal(ok.runtime.id, 'pi');
  assert.equal(ok.verification.command, 'passing');
  // Сохранённые поля — только те, что применяются.
  assert.deepEqual(Object.keys(ok).sort(), ['name', 'parameters', 'projectId', 'promptTemplate', 'runtime', 'verification', 'workItemId']);
});

test('a recipe runs as an ordinary session, and the run remembers its parameters', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const api = fixture.api;
  const headers = { 'content-type': 'application/json' };
  const [project] = await api('/api/projects');
  const post = async (route, body, expect = 201) => {
    const response = await fetch(fixture.base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, expect, `POST ${route} → ${response.status}: ${text}`);
    return JSON.parse(text);
  };

  const item = await post('/api/work-items', { projectId: project.id, title: 'Регулярный аудит', goal: 'держать проект в порядке' });
  const created = await post('/api/recipes', {
    projectId: project.id,
    workItemId: item.id,
    name: 'Daily TaskBridge audit',
    promptTemplate: 'Проверь {{area}} относительно {{base_ref}}.',
    parameters: {
      base_ref: { type: 'string', default: 'master' },
      area: { type: 'enum', values: ['all', 'android', 'server'], default: 'all' },
    },
    runtime: { id: 'pi', thinking: 'low' },
    verification: { required: true },
  });
  assert.match(created.id, /^rc-/, `рецепт отличается от сессии и задачи: ${created.id}`);
  assert.deepEqual(created.parameters.area.values, ['all', 'android', 'server']);
  assert.equal(created.runtime.thinking, 'low', 'уровень thinking применяется: он уходит в задачу');
  // Обещанного, но не исполняемого в рецепте не остаётся.
  assert.equal('context' in created, false);
  assert.equal('workspace' in created, false);
  assert.equal('limits' in created, false);

  // The list is per project, and a fresh store keeps it.
  assert.deepEqual((await api(`/api/recipes?projectId=${project.id}`)).items.map(r => r.id), [created.id]);
  assert.deepEqual((await api('/api/recipes?projectId=nope')).items, []);

  // A recipe with a typo in the placeholder never reaches the store.
  await post('/api/recipes', { projectId: project.id, name: 'Опечатка', promptTemplate: 'смотри {{are}}', parameters: {} }, 400);
  // And a recipe for a project nobody registered is refused by code, not by luck.
  await post('/api/recipes', { projectId: 'nope', name: 'x', promptTemplate: 'y' }, 404);

  // Run it with parameters: the prompt is rendered, the session is ordinary.
  const started = await post(`/api/recipes/${created.id}/run`, { parameters: { area: 'android', base_ref: 'release' } });
  const session = started.task;
  assert.equal(session.prompt, 'Проверь android относительно release.', 'параметры попали в промпт');
  assert.equal(session.title, 'Daily TaskBridge audit', 'сессия называет рецепт');
  assert.equal(session.projectId, project.id);
  assert.equal(started.invocation.recipeId, created.id);
  assert.deepEqual(started.invocation.parameters, { base_ref: 'release', area: 'android' });
  assert.equal(started.invocation.trigger, 'manual');
  assert.ok(started.invocation.at, 'факт запуска датирован');

  // The run is part of the work item it names.
  const detail = await api(`/api/work-items/${item.id}`);
  assert.deepEqual(detail.sessions.map(s => s.sessionId), [session.id]);
  assert.equal(detail.sessions[0].relation, 'implementation');

  // The same recipe with other parameters is another run of the same recipe.
  const second = await post(`/api/recipes/${created.id}/run`, { parameters: {} });
  assert.equal(second.task.prompt, 'Проверь all относительно master.', 'по умолчанию — значения схемы');
  assert.notEqual(second.task.id, session.id);
  assert.equal(second.invocation.recipeId, created.id);
  assert.deepEqual(second.invocation.parameters, { base_ref: 'master', area: 'all' });

  // Bad parameters are refused before a session is created.
  const badRun = await fetch(`${fixture.base}/api/recipes/${created.id}/run`, {
    method: 'POST', headers, body: JSON.stringify({ parameters: { area: 'телефон' } }),
  });
  assert.equal(badRun.status, 400);
  assert.equal((await api('/api/tasks')).length, 2, 'отказ не создал сессию');

  // Editing keeps the parameters that were not touched.
  const patched = await api(`/api/recipes/${created.id}`, { name: 'Daily audit (v2)' }, 'PATCH');
  assert.equal(patched.name, 'Daily audit (v2)');
  assert.deepEqual(patched.parameters.area.values, ['all', 'android', 'server']);

  // A restart keeps the recipe, and deleting it leaves its sessions alone.
  await fixture.restart();
  assert.deepEqual((await api('/api/recipes')).items.map(r => r.id), [created.id]);
  const removed = await api(`/api/recipes/${created.id}`, {}, 'DELETE');
  assert.equal(removed.ok, true);
  assert.deepEqual((await api('/api/recipes')).items, []);
  assert.equal((await api('/api/tasks')).length, 2, 'сессии, которые рецепт уже запустил, остались');
  assert.equal((await fetch(`${fixture.base}/api/recipes/${created.id}`)).status, 404);
});

test('recipes survive reopening the database', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-recipes-'));
  // One teardown for both stores, in the right order: a second `t.after` closed the
  // reopened database AFTER the directory was removed (EBUSY on Windows).
  const stores = [];
  t.after(async () => {
    for (const opened of stores) opened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const store = new TaskStore(dir);
  stores.push(store);
  const at = '2026-10-11T12:00:00.000Z';
  store.createRecipe({
    id: 'rc-1', projectId: 'p', workItemId: 'wi-1', name: 'Audit', promptTemplate: 'Проверь {{area}}',
    parameters: { area: { type: 'string', default: 'all' } },
    runtime: { id: 'pi', model: 'local/qwen', thinking: 'low' },
    verification: { required: true, command: null },
    createdAt: at, updatedAt: at,
  });
  store.close();

  const reopened = new TaskStore(dir);
  stores.push(reopened);
  const stored = reopened.getRecipe('rc-1');
  assert.equal(stored.promptTemplate, 'Проверь {{area}}');
  assert.equal(stored.runtime.model, 'local/qwen');
  assert.equal(stored.workItemId, 'wi-1');
  assert.deepEqual(stored.parameters, { area: { type: 'string', default: 'all' } });
  assert.deepEqual(reopened.listRecipes('p').map(r => r.id), ['rc-1']);
  assert.deepEqual(reopened.listRecipes('other'), []);
  assert.equal(reopened.deleteRecipe('rc-1').id, 'rc-1');
  assert.equal(reopened.getRecipe('rc-1'), null);
});
