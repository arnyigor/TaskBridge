// Мастер подключения (пункт 2.3 плана), шаги 4–6. Проверяется то, по чему человек
// принимает решение записать файл: отбор моделей, предпросмотр записи и итог.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WIZARD_MODEL_LIMIT,
  WIZARD_STEPS,
  draftPreviewText,
  draftReady,
  filterDiscoveredModels,
  toggleDiscoveredModel,
  wizardResultText,
} from '../web/provider-wizard-view.mjs';

test('мастер называет свои шаги по порядку', () => {
  assert.equal(WIZARD_STEPS.length, 6);
  assert.equal(WIZARD_STEPS[0], 'Тип подключения');
  assert.equal(WIZARD_STEPS.at(-1), 'Готово');
  assert.equal(WIZARD_MODEL_LIMIT, 100, 'лимит совпадает с серверным');
});

test('поиск по каталогу: ID и название, регистр не важен, показ ограничен', () => {
  const models = [
    { id: 'qwen/qwen3:27b', name: 'Qwen3 27B' },
    { id: 'openai/gpt-5', name: 'GPT-5' },
    { id: 'zai/glm-5.3', name: 'GLM 5.3' },
  ];
  assert.equal(filterDiscoveredModels({ models }).total, 3, 'пустой запрос показывает всё');
  assert.deepEqual(filterDiscoveredModels({ models, query: 'GPT' }).matched.map(m => m.id), ['openai/gpt-5']);
  assert.deepEqual(filterDiscoveredModels({ models, query: 'qwen3' }).matched.map(m => m.id), ['qwen/qwen3:27b'], 'ищем и по названию');
  assert.equal(filterDiscoveredModels({ models, query: 'нет такого' }).shown.length, 0);
  // Провайдеры отвечают сотнями моделей: показываем страницу, но считаем всё.
  const many = Array.from({ length: 300 }, (_, index) => ({ id: `model-${index}` }));
  const page = filterDiscoveredModels({ models: many, limit: 50 });
  assert.equal(page.shown.length, 50);
  assert.equal(page.total, 300);
});

test('отметка модели: лимит не превышается молча и повтор снимает отметку', () => {
  let selected = [];
  selected = toggleDiscoveredModel(selected, 'a').selected;
  selected = toggleDiscoveredModel(selected, 'b').selected;
  assert.deepEqual(selected, ['a', 'b']);
  assert.deepEqual(toggleDiscoveredModel(selected, 'a').selected, ['b'], 'повторное нажатие снимает');
  const full = Array.from({ length: WIZARD_MODEL_LIMIT }, (_, index) => `m-${index}`);
  const overflow = toggleDiscoveredModel(full, 'лишняя');
  assert.equal(overflow.added, false);
  assert.equal(overflow.reason, 'limit');
  assert.equal(overflow.selected.length, WIZARD_MODEL_LIMIT, 'чужой выбор не обрезается');
});

test('предпросмотр показывает, что именно уйдёт в models.json, без секретов', () => {
  const text = draftPreviewText({ id: 'tb-demo', baseUrl: 'https://api.example/v1', keyEnv: 'DEMO_KEY', models: ['a', 'b'] });
  assert.match(text, /tb-demo/);
  assert.match(text, /https:\/\/api\.example\/v1/);
  assert.match(text, /переменной DEMO_KEY/);
  assert.match(text, /Моделей: 2/);
  // Ключ — только имя переменной; значения ключа мастер не знает и не печатает.
  assert.doesNotMatch(text, /sk-|Bearer/);
  const long = draftPreviewText({ id: 'tb-long', baseUrl: 'https://api.example/v1', keyEnv: 'K', models: Array.from({ length: 8 }, (_, i) => `m${i}`) });
  assert.match(long, /и ещё 3/, 'длинный список не печатается целиком');
  const local = draftPreviewText({ id: 'tb-local', baseUrl: 'http://127.0.0.1:8080/v1', models: ['m'] });
  assert.match(local, /без ключа/);
});

test('готовность черновика повторяет серверные правила', () => {
  const base = { id: 'tb-demo', baseUrl: 'https://api.example/v1', keyEnv: 'DEMO_KEY', models: ['a'] };
  assert.equal(draftReady(base), true);
  assert.equal(draftReady({ ...base, id: 'demo' }), false, 'ID только tb-*');
  assert.equal(draftReady({ ...base, id: 'tb-' }), false);
  assert.equal(draftReady({ ...base, baseUrl: 'ftp://api.example/v1' }), false);
  assert.equal(draftReady({ ...base, keyEnv: 'sk-live-123' }), false, 'значение ключа вместо имени не принимается');
  assert.equal(draftReady({ ...base, models: [] }), false);
  // Локальному серверу ключ не нужен.
  assert.equal(draftReady({ id: 'tb-local', baseUrl: 'http://127.0.0.1:8080/v1', keyEnv: '', models: ['m'] }), true);
  assert.equal(draftReady({ ...base, models: Array.from({ length: WIZARD_MODEL_LIMIT + 1 }, (_, i) => `m${i}`) }), false);
});

test('итог говорит, нужен ли перезапуск сервера', () => {
  const withKey = wizardResultText({ id: 'tb-demo', keyEnv: 'DEMO_KEY', changed: true, modelCount: 2 });
  assert.match(withKey, /сохранено/);
  assert.match(withKey, /моделей: 2/);
  assert.match(withKey, /перезапустите сервер/, 'без перезапуска новый ключ не подхватится');
  const local = wizardResultText({ id: 'tb-local', changed: true, modelCount: 1 });
  assert.doesNotMatch(local, /перезапустите сервер/, 'локальному подключению перезапуск не нужен');
  assert.match(local, /обновите каталог моделей/);
  assert.match(wizardResultText({ id: 'tb-x', changed: false }), /не изменено/);
});
