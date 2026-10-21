// Turn instructions (§4/§5 of the 1.3 plan).
//
// До этой правки любой первый запрос получал один и тот же хвост — «At the end,
// summarize what you changed and what checks you ran» — независимо от того, что
// спросили. Информационный запрос («есть ли у меня такой курс?») читался моделью
// как поручение составить отчёт об изменениях, и исследование продолжалось,
// чтобы этому отчёту было что содержать.
//
// Здесь проверяется сам контракт: тип задачи определяется без модели, текст
// пользователя не переписывается, а требования к отчёту об изменениях остаются
// только там, где просили изменения. Цена ложного `implement` — лишний отчёт об
// изменениях в ответе; цена ложного `quick` — обрезанное исследование, поэтому
// неясный запрос уходит в `explore`, а не в `quick`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnPrompt, detectProfile, QUICK, EXPLORE, IMPLEMENT } from '../src/prompt-builder.mjs';

// [запрос, ожидаемый профиль, почему]
const CASES = [
  // --- quick: ответ — факт, который подтверждает одна-две команды ------------
  ['Unreal filmmaking курс. У меня есть такой? В Learning посмотри.', QUICK, 'исходный сценарий 2026-10-21'],
  ['А теперь просто посмотри, есть ли нужный файл.', QUICK, 'уточнение по ходу работы'],
  ['Найди папку с курсом Unreal', QUICK, 'поиск пути'],
  ['Покажи, что лежит в Blender', QUICK, 'листинг'],
  ['Сколько места занимает Houdini?', QUICK, 'факт, одно измерение'],
  ['Где находится проект LastSignal?', QUICK, 'поиск пути'],
  ['Где лежит конфиг Pi?', QUICK, 'поиск пути'],
  ['У меня есть файл config.json?', QUICK, 'проверка существования'],
  ['Проверь, есть ли в проекте тесты на очередь', QUICK, 'проверка существования'],
  ['Посмотри, есть ли такая папка', QUICK, 'проверка существования'],
  ['Посмотри в F:/Install/Learning', QUICK, 'осмотр каталога'],
  ['where is the .env file', QUICK, 'en: поиск пути'],
  ['does the folder Learning exist', QUICK, 'en: существование'],
  ['show me the last commit', QUICK, 'en: листинг'],
  ['list the files in scripts/', QUICK, 'en: листинг'],
  ['how much space does the data folder take?', QUICK, 'en: замер'],
  ['Не исправляй ничего, только найди, есть ли файл очереди', QUICK, 'отрицание изменения'],
  ['do not fix anything, just find the queue test', QUICK, 'en: отрицание изменения'],
  ['Ничего не меняй, покажи список сессий', QUICK, 'запрет изменений + листинг'],

  // --- explore: разбор, причина, архитектура --------------------------------
  ['Разберись, почему этот файл не открывается', EXPLORE, 'диагностика'],
  ['Почему падает сборка?', EXPLORE, 'диагностика'],
  ['В чём причина ошибки 413?', EXPLORE, 'диагностика'],
  ['Найди причину таймаута в очереди', EXPLORE, 'поиск причины, а не пути'],
  ['Найди, почему сборка падает', EXPLORE, 'lookup-глагол, но вопрос — причина'],
  ['Проанализируй всю архитектуру приложения', EXPLORE, 'анализ'],
  ['Оцени архитектуру модуля памяти', EXPLORE, 'анализ'],
  ['Объясни, как работает очередь', EXPLORE, 'объяснение'],
  ['why does the build fail?', EXPLORE, 'en: причина, «build» — не глагол-действие'],
  ['investigate the flaky test', EXPLORE, 'en: диагностика'],
  ['проект TaskBridge', EXPLORE, 'неясно — не обрезаем'],
  ['сравни две реализации', EXPLORE, 'неясно — исследование допустимо'],
  ['', EXPLORE, 'пустой текст'],

  // --- implement: просят изменение ------------------------------------------
  ['Исправь ошибку и протестируй', IMPLEMENT, 'изменение'],
  ['Найди и исправь все ошибки', IMPLEMENT, 'глагол поиска не делает ход quick'],
  ['Добавь тест на очередь', IMPLEMENT, 'изменение'],
  ['Реализуй профили исполнения', IMPLEMENT, 'изменение'],
  ['Обнови README', IMPLEMENT, 'изменение'],
  ['Удали старый модуль', IMPLEMENT, 'изменение'],
  ['Зарефактори этот файл', IMPLEMENT, 'изменение'],
  ['Поправь опечатку в названии', IMPLEMENT, 'изменение'],
  ['Не надо ничего менять, но обнови README', IMPLEMENT, 'отрицание не отменяет второе действие'],
  ['fix the failing test', IMPLEMENT, 'en: изменение'],
  ['add a test for the queue', IMPLEMENT, 'en: изменение'],
  ['refactor the dispatcher', IMPLEMENT, 'en: изменение'],
  ['update the changelog', IMPLEMENT, 'en: изменение'],
  ['remove the dead code', IMPLEMENT, 'en: изменение'],
  ['rename the events route', IMPLEMENT, 'en: изменение'],
  ['fix the тест, который падает', IMPLEMENT, 'смешанный язык'],
];

for (const [text, expected, why] of CASES) {
  test(`профиль «${text || '(пусто)'}» → ${expected} (${why})`, () => {
    assert.equal(detectProfile(text), expected);
  });
}

test('каждый профиль имеет свою строку, и только implement требует отчёта об изменениях', () => {
  const lookup = buildTurnPrompt({ text: 'Есть ли курс?', profile: QUICK });
  assert.match(lookup, /Task instructions \(quick\)/);
  assert.match(lookup, /use the fewest commands and stop at the first confirmed answer/);
  assert.match(lookup, /Do not modify files unless the request asks for changes/);
  assert.doesNotMatch(lookup, /summarize what changed/);

  const explore = buildTurnPrompt({ text: 'Разберись, почему падает', profile: EXPLORE });
  assert.match(explore, /Task instructions \(explore\)/);
  assert.match(explore, /Investigation is allowed while an open question of the request remains/);
  assert.doesNotMatch(explore, /summarize what changed/);

  const implement = buildTurnPrompt({ text: 'Исправь падение', profile: IMPLEMENT });
  assert.match(implement, /Task instructions \(implement\)/);
  assert.match(implement, /summarize what changed and which checks ran/);
  assert.match(implement, /Download report\]\(report\.pdf\)/);
  assert.doesNotMatch(implement, /This is a lookup/);
});

test('общий контракт есть в любом профиле: остановка по подтверждённому ответу и сохранение найденного', () => {
  for (const profile of [QUICK, EXPLORE, IMPLEMENT]) {
    const prompt = buildTurnPrompt({ text: 'запрос', profile });
    assert.match(prompt, /Do only what the request asks/, profile);
    assert.match(prompt, /once the requested answer is confirmed, report it and stop/, profile);
    assert.match(prompt, /say which part is unconfirmed instead of guessing/, profile);
    assert.match(prompt, /keep what the earlier tools already confirmed and report the failure/, profile);
    assert.match(prompt, /Work only inside the current working directory\./, profile);
  }
});

test('текст пользователя не переписывается, вложения перечисляются', () => {
  const text = 'Есть ли у меня курс Unreal?\n\nвторая строка';
  const prompt = buildTurnPrompt({ text, profile: QUICK, files: ['.taskbridge-input/a.txt'] });
  assert.ok(prompt.startsWith(text), 'запрос идёт первым и дословно');
  assert.match(prompt, /Additional files from the phone are in \.taskbridge-input\/:\n- \.taskbridge-input\/a\.txt/);
  assert.match(prompt, /Read attached files as needed\./);
  assert.doesNotMatch(buildTurnPrompt({ text: 'x', profile: QUICK }), /Read attached files/);
});

test('неизвестный профиль не оставляет ход без границ', () => {
  const prompt = buildTurnPrompt({ text: 'запрос', profile: 'nonsense' });
  assert.match(prompt, /Task instructions \(nonsense\)/);
  assert.match(prompt, /Investigation is allowed/, 'неизвестное значение ведёт себя как explore');
  assert.match(prompt, /Work only inside the current working directory\./);
});
