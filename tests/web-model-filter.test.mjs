// Правила Web-пикера без DOM: поиск, фильтры, порядок и избранное.
// Каталог генерируется в размере реального (552 модели, 10 провайдеров), чтобы
// проверять поведение на боевом объёме, а не на трёх строках.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITIES,
  FAVORITES_KEY,
  availableCapabilities,
  describeCount,
  describeEmpty,
  filterModels,
  hasActiveFilters,
  isFavorite,
  loadFavorites,
  matchesQuery,
  modelKey,
  parseFavorites,
  plural,
  providersOf,
  saveFavorites,
  searchTokens,
  selectModels,
  serializeFavorites,
  sortModels,
  toggleFavorite,
} from '../web/model-filter.mjs';

const PROVIDERS = [
  { provider: 'deepseek', count: 4, local: false },
  { provider: 'routerai', count: 120, local: false },
  { provider: 'wormsoft', count: 300, local: false },
  { provider: 'google', count: 63, local: false },
  { provider: 'openrouter', count: 60, local: false },
  { provider: 'llamacpp', count: 2, local: true },
  { provider: 'strata', count: 2, local: true },
  { provider: 'openai-codex', count: 1, local: false },
];

function catalog() {
  const models = [];
  for (const entry of PROVIDERS) {
    for (let i = 0; i < entry.count; i += 1) {
      models.push({
        provider: entry.provider,
        id: `${entry.provider}-model-${i}`,
        name: `${entry.provider} model ${i}`,
        local: entry.local,
        // Возможности щедро раздаём только части моделей, чтобы фильтр «vision»
        // было на чём проверить.
        images: i % 5 === 0,
        tools: i % 2 === 0,
        reasoning: i % 3 === 0,
        contextWindow: 128000,
      });
    }
  }
  return models;
}

test('каталог в 552 модели фильтруется и считает группы', () => {
  const models = catalog();
  assert.equal(models.length, 552);
  assert.deepEqual(providersOf(models), [
    { provider: 'deepseek', count: 4 },
    { provider: 'google', count: 63 },
    { provider: 'llamacpp', count: 2 },
    { provider: 'openai-codex', count: 1 },
    { provider: 'openrouter', count: 60 },
    { provider: 'routerai', count: 120 },
    { provider: 'strata', count: 2 },
    { provider: 'wormsoft', count: 300 },
  ]);
  assert.equal(filterModels(models, { scope: 'local' }).length, 4, 'локальные — по флагу сервера');
  assert.equal(filterModels(models, { scope: 'cloud' }).length, 548);
  assert.equal(filterModels(models, { provider: 'deepseek' }).length, 4);
  assert.equal(selectModels(models, { provider: 'deepseek' }).length, 4);
  assert.equal(describeCount(552, 552), '552 модели');
  assert.equal(describeCount(4, 552), '4 из 552 модели');
  assert.equal(describeCount(0, 0), '');
});

test('поиск идёт словами по провайдеру, id и имени', () => {
  const models = catalog();
  assert.deepEqual(searchTokens('  DeepSeek  FLASH '), ['deepseek', 'flash']);
  const deepseek = filterModels(models, { query: 'deepseek flash' });
  assert.ok(deepseek.every(model => model.provider === 'deepseek'), 'провайдер учтён');
  assert.equal(deepseek.length, 0, 'fla в этом каталоге нет — пусто, а не «всё подряд»');
  assert.equal(filterModels(models, { query: 'wormsoft model 1' }).length > 0, true);
  assert.equal(matchesQuery({ provider: 'p', id: 'x', name: 'Имя' }, searchTokens('имя')), true, 'регистр не важен');
});

test('фильтры складываются: поиск + провайдер + избранное + возможности', () => {
  const models = catalog();
  const favorites = new Set(['wormsoft/wormsoft-model-12', 'deepseek/deepseek-model-0']);
  const combined = selectModels(models, {
    query: 'model 1',
    provider: 'wormsoft',
    scope: 'cloud',
    capabilities: ['reasoning'],
    favorites,
  });
  assert.ok(combined.length > 0);
  for (const model of combined) {
    assert.equal(model.provider, 'wormsoft');
    assert.equal(model.reasoning, true);
    assert.equal(model.local, false, 'облачная группа');
  }
  // Избранное первым, даже если каталог отдал другую модель раньше.
  assert.equal(combined[0].id, 'wormsoft-model-12');

  const onlyFavorites = selectModels(models, { favoritesOnly: true, favorites });
  assert.deepEqual(onlyFavorites.map(modelKey), ['deepseek/deepseek-model-0', 'wormsoft/wormsoft-model-12']);

  assert.deepEqual(selectModels(models, { query: 'нет-такой-модели', favorites }), []);
  assert.equal(hasActiveFilters({ query: 'нет-такой-модели' }), true);
  assert.equal(hasActiveFilters({}), false);
});

test('порядок: избранные, затем локальные, затем каталог без перестановок', () => {
  const models = [
    { provider: 'a', id: '1' },
    { provider: 'b', id: '2', local: true },
    { provider: 'c', id: '3' },
    { provider: 'd', id: '4', local: true },
  ];
  const sorted = sortModels(models, new Set(['c/3']));
  assert.deepEqual(sorted.map(modelKey), ['c/3', 'b/2', 'd/4', 'a/1']);
  assert.deepEqual(sortModels(models, null).map(modelKey), ['b/2', 'd/4', 'a/1', 'c/3']);
  // Вход не меняется: фильтрация — не выбор модели.
  assert.deepEqual(models.map(modelKey), ['a/1', 'b/2', 'c/3', 'd/4']);
});

test('неизвестные метаданные не превращаются в возможности', () => {
  const models = [
    { provider: 'x', id: 'no-meta' },
    { provider: 'x', id: 'null-meta', images: null, tools: undefined, reasoning: 'yes' },
  ];
  assert.deepEqual(availableCapabilities(models), [], 'нет ни одного достоверного true');
  // Фильтр по возможности без метаданных не пропускает «на всякий случай».
  assert.deepEqual(filterModels(models, { capabilities: ['images'] }), []);
  assert.deepEqual(availableCapabilities([{ provider: 'x', id: 'v', images: true }]), ['images']);
  // Модель без поля не считается «без возможности»: она просто не попадает под фильтр.
  assert.equal(filterModels(models, { capabilities: [] }).length, 2);
  assert.ok(CAPABILITIES.every(capability => typeof capability.label === 'string'));
});

test('одноимённые модели разных провайдеров не конфликтуют', () => {
  const models = [
    { provider: 'wormsoft', id: 'deepseek-v4-flash' },
    { provider: 'deepseek', id: 'deepseek-v4-flash' },
  ];
  assert.equal(modelKey(models[0]), 'wormsoft/deepseek-v4-flash');
  assert.equal(modelKey(models[1]), 'deepseek/deepseek-v4-flash');
  const favorites = toggleFavorite(new Set(), modelKey(models[0]));
  assert.deepEqual([...favorites], ['wormsoft/deepseek-v4-flash']);
  assert.equal(isFavorite(models[0], favorites), true);
  assert.equal(isFavorite(models[1], favorites), false);
  assert.deepEqual(filterModels(models, { favoritesOnly: true, favorites }).map(model => model.provider), ['wormsoft']);
  // Снятие возвращает ровно одну модель и не трогает соседнюю с тем же id.
  assert.equal(toggleFavorite(favorites, modelKey(models[0])).size, 0);
  assert.equal(modelKey({ id: '' }), '', 'без id ключа нет');
});

test('повреждённое хранилище не ломает пикер', () => {
  assert.equal(parseFavorites('{не json').size, 0);
  assert.equal(parseFavorites('null').size, 0);
  assert.equal(parseFavorites('"строка"').size, 0);
  assert.equal(parseFavorites('{"a":"b"}').size, 0);
  assert.deepEqual([...parseFavorites('[1, "a/b", null, "", "  c/d  ", "без-слэша"]')], ['a/b', 'c/d']);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(loadFavorites(broken).size, 0, 'отказ хранилища — пустое избранное');
  assert.equal(saveFavorites(broken, new Set(['a/b'])), false, 'и честный отказ записи');
  assert.equal(loadFavorites(null).size, 0);
});

test('избранное переживает перезагрузку страницы', () => {
  const storage = { store: {}, getItem(key) { return this.store[key] ?? null; }, setItem(key, value) { this.store[key] = String(value); } };
  const favorites = toggleFavorite(new Set(['deepseek/x']), 'wormsoft/y');
  assert.equal(saveFavorites(storage, favorites), true);
  // Новая страница читает то же хранилище и получает тот же набор.
  assert.deepEqual([...loadFavorites(storage)], ['deepseek/x', 'wormsoft/y']);
  assert.equal(storage.store[FAVORITES_KEY], serializeFavorites(favorites));
  assert.equal(serializeFavorites(new Set()), '[]');
});

test('пустой результат объясняется словами', () => {
  assert.equal(plural(1), 'модель');
  assert.equal(plural(3), 'модели');
  assert.equal(plural(11), 'моделей');
  assert.equal(plural(21), 'модель');
  assert.equal(describeEmpty({ total: 0 }), 'Pi не вернул ни одной доступной модели.');
  assert.equal(describeEmpty({ total: 552, hasFilters: true }), 'Ничего не найдено. Сбросьте фильтры.');
  assert.equal(describeEmpty({ total: 552, hasFilters: false }), 'Ничего не найдено.');
});
