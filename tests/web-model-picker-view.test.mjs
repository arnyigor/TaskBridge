// DOM-сборка выбора модели в linkedom: разметка строки, избранное, чипы
// возможностей и пустой результат. Проверяются свойства, за которые отвечает
// именно вид (текст вместо HTML, раздельные кнопки, скрытие пустых фильтров).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { catalogStateText, modelGroupLabel, modelMetaText, renderCapabilityChips, renderEmptyState, renderGroupHeader, renderModelRow, renderProviderOptions } from '../web/model-picker-view.mjs';

const dom = () => parseHTML('<!doctype html><html><body><div id="list"></div><div id="facets"></div><select id="providers"></select></body></html>').document;

test('имя модели не может внедрить HTML в строку', () => {
  const document = dom();
  const attack = '<img src=x onerror="alert(1)">';
  const row = renderModelRow({
    document,
    model: { provider: 'evil', id: attack, name: '<b>bold</b>' },
    onPick() {},
  });
  assert.equal(row.querySelector('img'), null, 'тег из имени не создан');
  assert.equal(row.querySelector('.modelId').textContent, attack, 'показан текстом');
  assert.equal(row.querySelector('.modelMeta').textContent, '<b>bold</b>', 'мета — тоже текст');
  assert.equal(row.querySelector('b'), null, 'тег из имени модели не создан');
  // Разметка строки, разобранная заново, не содержит элементов из имени модели.
  const roundTrip = parseHTML(`<body>${row.innerHTML}</body>`).document;
  assert.equal(roundTrip.querySelector('img'), null, 'и в сериализованной разметке тега нет');
  assert.equal(roundTrip.querySelector('b'), null);
});

test('выбор, избранное и проверка — три раздельные кнопки', () => {
  const document = dom();
  const picked = [];
  const probed = [];
  const starred = [];
  const model = { provider: 'deepseek', id: 'deepseek-flash' };
  const row = renderModelRow({
    document,
    model,
    active: true,
    favorite: true,
    onPick: m => picked.push(m),
    onProbe: m => probed.push(m),
    onToggleFavorite: m => starred.push(m),
  });
  const item = row.querySelector('.modelItem');
  const star = row.querySelector('.modelFav');
  const probe = row.querySelector('.modelProbe');
  assert.ok(item && star && probe, 'все три контрола на месте');
  assert.equal(item.classList.contains('active'), true, 'текущая модель подсвечена');
  assert.equal(item.getAttribute('aria-current'), 'true');
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.match(star.getAttribute('aria-label'), /Убрать из избранного/);
  assert.equal(star.textContent, '★');

  let stopped = 0;
  const stop = () => { stopped += 1; };
  item.onclick({ stopPropagation: stop });
  star.onclick({ stopPropagation: stop });
  probe.onclick({ stopPropagation: stop });
  assert.deepEqual(picked, [model]);
  assert.deepEqual(starred, [model]);
  assert.deepEqual(probed, [model]);
  assert.equal(stopped, 2, 'избранное и проверка не дают клику дойти до выбора');
});

test('заголовки групп: одна локальная группа и провайдеры Pi', () => {
  const document = dom();
  assert.equal(modelGroupLabel({ provider: 'deepseek', id: 'x' }), 'deepseek');
  assert.equal(modelGroupLabel({ provider: 'llamacpp', id: 'x', local: true }), 'Локальные модели');
  assert.equal(modelGroupLabel({ id: 'x' }), '—');
  assert.equal(renderGroupHeader({ document, label: 'Локальные модели' }).className, 'modelGroup');
  assert.equal(renderGroupHeader({ document, label: 'deepseek' }).textContent, 'deepseek');
  assert.equal(
    modelMetaText({ provider: 'strata', id: 'qwen', local: true, contextWindow: 131072, reasoning: true, images: true }),
    'strata · ctx 131072 · thinking · vision',
  );
  // Без метаданных вторая строка остаётся пустой, а не выдумывает возможности.
  assert.equal(modelMetaText({ provider: 'deepseek', id: 'x' }), '');
});

test('чипы возможностей появляются только для достоверных данных', () => {
  const document = dom();
  const container = document.getElementById('facets');
  const toggled = [];
  renderCapabilityChips({ document, container, available: ['images'], selected: ['images'], onToggle: (key, checked) => toggled.push([key, checked]) });
  const inputs = [...container.querySelectorAll('input')];
  assert.deepEqual(inputs.map(input => input.value), ['images'], 'Tools/Thinking без данных не показаны');
  assert.equal(inputs[0].checked, true);
  assert.equal(container.hidden, false);

  // Нет данных — нет блока: пикер не обещает фильтров, которых не из чего собрать.
  renderCapabilityChips({ document, container, available: [] });
  assert.equal(container.hidden, true);
  assert.equal(container.querySelectorAll('input').length, 0);
});

test('пустой результат объясняет причину, а не молчит', () => {
  const document = dom();
  const list = document.getElementById('list');
  renderEmptyState({ document, list, text: 'Ничего не найдено. Сбросьте фильтры.' });
  assert.equal(list.querySelectorAll('.modelRow').length, 0);
  assert.equal(list.querySelector('.modelEmpty').textContent, 'Ничего не найдено. Сбросьте фильтры.');
});

test('фильтр провайдеров помечает выбранную опцию и не теряет «все»', () => {
  const document = dom();
  const select = document.getElementById('providers');
  const providers = [{ provider: 'deepseek', count: 4 }, { provider: 'google', count: 63 }];
  renderProviderOptions({ document, select, providers, selected: 'google' });
  const options = [...select.querySelectorAll('option')];
  assert.equal(options.length, 3);
  assert.equal(options[0].textContent, 'Все провайдеры');
  assert.equal(options[1].textContent, 'deepseek (4)');
  assert.equal(select.value, 'google', 'выбранный провайдер отмечен');
  // Провайдер исчез из каталога — падаем на «все», а не показываем пустой фильтр.
  renderProviderOptions({ document, select, providers, selected: 'удалённый' });
  assert.equal(select.value, '');
});

// Пункт 2.5 плана: клиент говорит, откуда список, и не выдаёт кэш за свежий.
test('строка состояния каталога различает кэш, частичное обновление и ошибку', async () => {
  assert.equal(catalogStateText({ freshness: 'refreshed' }), '', 'свежий каталог молчит');
  assert.equal(catalogStateText({ failed: 'boom' }), 'Не удалось обновить список — показан прежний.');
  assert.equal(catalogStateText({ freshness: 'cache' }), 'Список из кэша: Pi сейчас не ответил.');
  const partial = catalogStateText({
    freshness: 'partial',
    sync: { providers: [{ provider: 'wormsoft' }, { provider: 'routerai', error: 'HTTP 500' }, { provider: 'zai', skipped: 'deadline' }] },
  });
  assert.match(partial, /частично/);
  assert.match(partial, /routerai/);
  assert.match(partial, /zai/);
  assert.equal(partial.includes('wormsoft'), false, 'ответивший провайдер не упоминается');
  // Конфликт ревизии: список обновился, но чужую правку models.json не затёрли.
  assert.match(catalogStateText({ freshness: 'refreshed', sync: { conflict: true } }), /models\.json менялся/);
});
