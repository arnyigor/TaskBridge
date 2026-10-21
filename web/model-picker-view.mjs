// DOM-сборка выбора модели: строки списка, заголовки групп, пустой результат и
// элементы фильтров. Отдельный модуль по образцу web/provider-status-view.mjs:
// страница передаёт document и обработчики, а здесь нет ни сети, ни состояния —
// поэтому пикер проверяется в linkedom, а не только глазами в браузере.
//
// Текст модели выводится через textContent: имя модели приходит от провайдера и
// не должно попадать в разметку как HTML.
import { CAPABILITIES } from './model-filter.mjs';

/** Заголовок группы: одна группа для всей машины, иначе — провайдер Pi. */
export function modelGroupLabel(model) {
  return model?.local === true ? 'Локальные модели' : (model?.provider || '—');
}

/** Вторая строка модели: провайдер (внутри общей локальной группы), имя, ctx, возможности. */
export function modelMetaText(model) {
  return [
    model?.local === true && model?.provider ? model.provider : null,
    model?.name && model.name !== model.id ? model.name : null,
    model?.contextWindow ? `ctx ${model.contextWindow}` : null,
    model?.reasoning === true ? 'thinking' : null,
    model?.images === true ? 'vision' : null,
  ].filter(Boolean).join(' · ');
}

/** Заголовок группы в списке (провайдер или «Локальные модели»). */
export function renderGroupHeader({ document, label }) {
  const header = document.createElement('div');
  header.className = 'modelGroup';
  header.textContent = label;
  return header;
}

/**
 * Одна строка списка: выбор модели, звёздочка избранного и кнопка проверки.
 * Кнопки раздельные: вложенная кнопка выбирала бы модель вместо проверки или
 * избранного, поэтому клики по ним останавливают всплытие.
 */
export function renderModelRow({ document, model, active = false, favorite = false, onPick, onProbe, onToggleFavorite }) {
  const row = document.createElement('div');
  row.className = 'modelRow';

  const item = document.createElement('button');
  item.type = 'button';
  item.className = active ? 'modelItem active' : 'modelItem';
  if (active) item.setAttribute('aria-current', 'true');
  const id = document.createElement('div');
  id.className = 'modelId';
  id.textContent = String(model?.id ?? '');
  const meta = document.createElement('div');
  meta.className = 'modelMeta';
  meta.textContent = modelMetaText(model);
  item.append(id, meta);
  // onclick, а не addEventListener: остальной app.js и DOM-стенд работают с этим
  // свойством, и вложенных обработчиков у строки нет.
  item.onclick = () => onPick?.(model);

  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'modelFav';
  star.textContent = favorite ? '★' : '☆';
  star.setAttribute('aria-pressed', String(favorite === true));
  star.setAttribute('aria-label', `${favorite ? 'Убрать из избранного' : 'В избранное'}: ${String(model?.id ?? '')}`);
  star.title = favorite ? 'Убрать из избранного' : 'В избранное';
  star.onclick = event => {
    event.stopPropagation();
    onToggleFavorite?.(model);
  };

  const probe = document.createElement('button');
  probe.type = 'button';
  probe.className = 'modelProbe';
  probe.title = 'Проверить модель: один короткий запрос (1 токен) и задержка до первого ответа';
  probe.setAttribute('aria-label', `Проверить модель ${String(model?.id ?? '')}`);
  probe.textContent = '⏱';
  probe.onclick = event => {
    event.stopPropagation();
    return onProbe?.(model, probe, row);
  };

  row.append(item, star, probe);
  return row;
}

/** Пустой результат: список очищается, текст объясняет причину. */
export function renderEmptyState({ document, list, text }) {
  list.replaceChildren();
  const line = document.createElement('p');
  line.className = 'muted small modelEmpty';
  line.textContent = String(text ?? '');
  list.append(line);
  return line;
}

/**
 * Чипы возможностей. Показывается только то, для чего в каталоге есть
 * подтверждённые данные (available); если показывать нечего, блок скрыт.
 */
export function renderCapabilityChips({ document, container, available = [], selected = [], onToggle }) {
  container.replaceChildren();
  const selectedSet = new Set(selected);
  for (const capability of CAPABILITIES) {
    if (!available.includes(capability.key)) continue;
    const label = document.createElement('label');
    label.className = 'modelFacet';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = capability.key;
    input.checked = selectedSet.has(capability.key);
    // onchange, а не addEventListener: DOM-стенд и остальной app.js работают со свойством.
    input.onchange = () => onToggle?.(capability.key, input.checked);
    const text = document.createElement('span');
    text.textContent = capability.label;
    label.append(input, text);
    container.append(label);
  }
  container.hidden = container.childElementCount === 0;
  return container;
}

/**
 * Выпадающий фильтр провайдеров: «Все провайдеры» плюс каждый провайдер с числом моделей.
 * Выбранная опция отмечается атрибутом, а не `select.value`: в DOM-стенде
 * (linkedom) у select есть только геттер value, и присваивание падает.
 */
export function renderProviderOptions({ document, select, providers = [], selected = '' }) {
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Все провайдеры';
  select.append(all);
  for (const entry of providers) {
    const option = document.createElement('option');
    option.value = entry.provider;
    option.textContent = `${entry.provider} (${entry.count})`;
    select.append(option);
  }
  const wanted = providers.some(entry => entry.provider === selected) ? selected : '';
  for (const option of select.querySelectorAll('option')) {
    if (option.getAttribute('value') === wanted) option.setAttribute('selected', 'selected');
    else option.removeAttribute('selected');
  }
  return select;
}
