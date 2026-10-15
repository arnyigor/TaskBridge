import test from 'node:test';
import assert from 'node:assert/strict';
import { findMergeCandidates, mergeProposalText, significantTerms, similarity } from '../src/memory/memory-consolidator.mjs';

// Этап M3 плана: консолидатор ищет заметки, которые пора слить, и оформляет это
// ПРЕДЛОЖЕНИЕМ (через существующий гейт). Ничего в память он не пишет — решает человек.

test('similarity is symmetric and counts significant words', () => {
  assert.equal(similarity('очередь сообщений важна', 'очередь сообщений важна'), 1);
  assert.equal(similarity('очередь сообщений', 'рендер сцены в blender'), 0);
  assert.equal(similarity('очередь сообщений ждёт', 'очередь сообщений стоит'), similarity('очередь сообщений стоит', 'очередь сообщений ждёт'));
  // Короткие слова не считаются значимыми: «и», «в», «на» есть всюду и дают ложное сходство.
  assert.deepEqual(significantTerms('и в на очередь'), ['очередь']);
  assert.equal(similarity('', 'что угодно'), 0);
});

test('a pair of notes about the same thing is offered for merging', () => {
  const entries = [
    { source: 'core/project/queue-1.md', category: 'decision', description: 'Очередь сообщений', text: 'Сообщение ждёт своей очереди, пока модель занята другим запросом. Курсор двигается после подтверждения.' },
    { source: 'core/project/queue-2.md', category: 'decision', description: 'Очередь сообщений', text: 'Сообщение ждёт очереди, пока модель занята другим запросом. Курсор меняется после подтверждения.' },
    { source: 'core/project/render.md', category: 'architecture', description: 'Рендер', text: 'Blender собирает сцену в отдельном процессе, текстуры пекутся в отдельной папке.' },
  ];
  const pairs = findMergeCandidates(entries);
  assert.equal(pairs.length, 1, JSON.stringify(pairs.map(pair => pair.score)));
  assert.deepEqual(pairs[0].notes.map(note => note.source), ['core/project/queue-1.md', 'core/project/queue-2.md']);
  assert.ok(pairs[0].score > 0.5, `похожие заметки должны быть близко: ${pairs[0].score}`);
  assert.equal(pairs[0].sameCategory, true);
  // Превью — узнаваемое начало, а не весь текст заметки.
  assert.ok(pairs[0].notes[0].preview.startsWith('Сообщение ждёт'));
  assert.ok(pairs[0].notes[0].preview.length <= 200);
});

test('nothing is offered when the notes are about different things', () => {
  const pairs = findMergeCandidates([
    { source: 'a.md', text: 'Очередь сообщений и подтверждение модели.' },
    { source: 'b.md', text: 'Печать текстур в blender занимает двадцать минут.' },
    { source: 'c.md', text: 'Пароль от роутера лежит в сейфе на втором этаже.' },
  ]);
  assert.deepEqual(pairs, [], JSON.stringify(pairs));
});

test('superseded notes are not offered: their fate is already decided', () => {
  const entries = [
    { source: 'core/project/old.md', superseded: true, text: 'Сообщение ждёт очереди, пока модель занята другим запросом.' },
    { source: 'core/project/new.md', text: 'Сообщение ждёт очереди, пока модель занята другим запросом.' },
  ];
  assert.deepEqual(findMergeCandidates(entries), [], 'заменённое не сливаем');
});

test('a merge proposal carries both notes and is not a silent edit', () => {
  const [pair] = findMergeCandidates([
    { source: 'core/project/one.md', category: 'decision', description: 'Очередь', text: 'Сообщение ждёт очереди, пока модель занята. Курсор после подтверждения.' },
    { source: 'core/project/two.md', category: 'decision', description: 'Очередь', text: 'Сообщение ждёт очереди, пока модель занята. Курсор меняется после подтверждения.' },
  ]);
  assert.ok(pair, 'пара найдена');
  const text = mergeProposalText(pair);
  assert.match(text, /core\/project\/one\.md/);
  assert.match(text, /core\/project\/two\.md/);
  assert.match(text, /Сходство по значимым словам/);
  // Предложение — это текст для человека: в нём обе заметки, а не только вывод «похожи».
  assert.match(text, /Сообщение ждёт очереди/);
});

test('the threshold is a parameter, not a hidden constant', () => {
  const entries = [
    { source: 'a.md', text: 'очередь сообщений подтверждение курсора модели' },
    { source: 'b.md', text: 'очередь сообщений подтверждение курсора рендера' },
  ];
  assert.equal(findMergeCandidates(entries, { threshold: 0.9 }).length, 0, 'строгий порог ничего не находит');
  assert.equal(findMergeCandidates(entries, { threshold: 0.1 }).length, 1, 'мягкий находит');
  // Лимит — как в остальном коде проекта: 0 означает «по умолчанию», меньше — обрезает.
  const many = [
    { source: 'a.md', text: 'очередь сообщений подтверждение курсора модели' },
    { source: 'b.md', text: 'очередь сообщений подтверждение курсора рендера' },
    { source: 'c.md', text: 'очередь сообщений подтверждение курсора доставки' },
  ];
  assert.equal(findMergeCandidates(many).length, 3, 'без лимита — все пары');
  assert.equal(findMergeCandidates(many, { limit: 1 }).length, 1, 'лимит обрезает список');
  assert.equal(findMergeCandidates(many, { limit: 0 }).length, 3, 'нулевой лимит — значение по умолчанию');
});
