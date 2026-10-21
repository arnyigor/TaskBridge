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
// только там, где просили изменения.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnPrompt, detectProfile, QUICK, EXPLORE, IMPLEMENT } from '../src/prompt-builder.mjs';

test('профиль: вопрос о существовании — quick, а не «разработка»', () => {
  assert.equal(detectProfile('Есть ли у меня курс Unreal Engine For Filmmakers? В Learning посмотри.'), QUICK);
  assert.equal(detectProfile('Найди папку с курсом Unreal'), QUICK);
  assert.equal(detectProfile('Покажи, что лежит в Blender'), QUICK);
});

test('профиль: «найди и исправь» — implement, глагол поиска не делает его quick', () => {
  assert.equal(detectProfile('Найди и исправь все ошибки'), IMPLEMENT);
  assert.equal(detectProfile('Исправь ошибку и протестируй'), IMPLEMENT);
  assert.equal(detectProfile('fix the failing test'), IMPLEMENT);
});

test('профиль: разбор причины — explore', () => {
  assert.equal(detectProfile('Разберись, почему этот файл не открывается'), EXPLORE);
  assert.equal(detectProfile('Проанализируй всю архитектуру приложения'), EXPLORE);
  assert.equal(detectProfile('why does the build fail?'), EXPLORE);
});

test('профиль: неясный запрос не обрезается до поиска', () => {
  assert.equal(detectProfile('проект TaskBridge'), EXPLORE);
  assert.equal(detectProfile(''), EXPLORE);
});

test('текст пользователя не переписывается, вложения перечисляются', () => {
  const text = 'Есть ли у меня курс Unreal?\n\nвторая строка';
  const prompt = buildTurnPrompt({ text, profile: QUICK, files: ['.taskbridge-input/a.txt'] });
  assert.ok(prompt.startsWith(text), 'запрос идёт первым и дословно');
  assert.match(prompt, /Additional files from the phone are in \.taskbridge-input\/:\n- \.taskbridge-input\/a\.txt/);
  assert.match(prompt, /Read attached files as needed\./);
});

test('quick и explore не требуют отчёта об изменениях, implement — требует', () => {
  const lookup = buildTurnPrompt({ text: 'Есть ли курс?', profile: QUICK });
  assert.doesNotMatch(lookup, /summarize what changed/);
  assert.match(lookup, /Do not modify files unless the request asks for changes/);
  assert.match(lookup, /report it and stop/);

  const explore = buildTurnPrompt({ text: 'Разберись, почему падает', profile: EXPLORE });
  assert.doesNotMatch(explore, /summarize what changed/);
  assert.match(explore, /do not modify files unless the request asks/);

  const implement = buildTurnPrompt({ text: 'Исправь падение', profile: IMPLEMENT });
  assert.match(implement, /summarize what changed and which checks ran/);
  assert.match(implement, /Download report\]\(report\.pdf\)/);
});

test('граница рабочей папки и сохранение найденного при сбое инструмента — во всех профилях', () => {
  for (const profile of [QUICK, EXPLORE, IMPLEMENT]) {
    const prompt = buildTurnPrompt({ text: 'запрос', profile });
    assert.match(prompt, /Work only inside the current working directory\./, profile);
    assert.match(prompt, /keep what the earlier tools already confirmed and report the failure/, profile);
  }
});
