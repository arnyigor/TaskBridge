// «Модель читает промпт · X%»: readingPrompt собирает фазу и прогресс чтения
// у внешнего локального сервера (Strata) из info.local.models — тест выполняет
// НАСТОЯЩИЙ исходник из web/app.js в изолированном стенде, а не повторяет его
// логику — иначе тест проверял бы сам себя.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

/** Вырезает исходник функции по имени: от `function name(` до парной `}`. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `в app.js нет функции ${name}`);
  let depth = 0;
  let i = source.indexOf('{', start);
  const open = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`не найдена закрывающая скобка для ${name} (начиная с ${open})`);
}

/** Собирает readingPrompt из реального исходника; состояния подменяет вызывающий. */
function makeReadingPrompt({ turns = [], models = [] } = {}) {
  const factory = new Function(
    'localStatus', 'newestTurn',
    [
      extractFunction(appSource, 'readingPrompt'),
      'return readingPrompt;',
    ].join('\n'),
  );
  // newestTurn в app.js читает глобальный chatState: здесь его роль играет
  // переданный список, последний элемент — «текущий» ход.
  return factory({ models }, () => (turns.length ? turns[turns.length - 1] : null));
}

const row = (over = {}) => ({
  id: 'qwen3.8-flash-next-iq3-s',
  provider: 'strata-iq3s',
  status: 'loaded',
  external: true,
  metrics: {
    available: true,
    source: 'strata',
    state: 'working',
    busy: true,
    phase: 'reading the prompt',
    promptRead: 80000,
    promptTotal: 126088,
    progress: 80000 / 126088,
    pp: 1160.4,
    tg: null,
  },
  ...over,
});

// «Часть от целого» форматирует тот же API, что и UI (toLocaleString ru-RU):
// в строке будут нерaзрывные пробелы разделителей, и ожидание не должно
// зависеть от того, какой именно пробел вписал автор теста.
const partTotal = (read, total) => `${read.toLocaleString('ru-RU')} / ${total.toLocaleString('ru-RU')}`;

test('readingPrompt молчит, когда у сессии нет внешней строки с телеметрией', () => {
  assert.equal(makeReadingPrompt({ models: [] })({ model: { provider: 'strata-iq3s', id: 'x' } }), '');
  assert.equal(makeReadingPrompt({ models: [row({ metrics: null })] })({ model: { provider: 'strata-iq3s', id: 'x' } }), '');
  // Чужой провайдер — не тот сервер, и читать у него нечего.
  assert.equal(makeReadingPrompt({ models: [row()] })({ model: { provider: 'llama.cpp', id: 'q' } }), '');
});

test('readingPrompt показывает фазу и процент чтения промпта', () => {
  const task = { model: { provider: 'strata-iq3s', id: 'qwen3.8-flash-next-iq3-s' } };
  assert.equal(makeReadingPrompt({ models: [row()] })(task), ` — модель читает промпт · 63% · ${partTotal(80000, 126088)}`);
  // Фаза без прогресса и без part/total — факт без цифр.
  assert.equal(makeReadingPrompt({ models: [row({ metrics: { available: true, source: 'strata', state: 'working', busy: true, phase: 'reading the prompt' } })] })(task), ' — модель читает промпт');
  // Прогресс вне 0..1 не даёт процента, но part/total и фаза остаются видны.
  assert.equal(makeReadingPrompt({ models: [row({ metrics: { available: true, source: 'strata', phase: 'reading the prompt', progress: 2, promptRead: 80, promptTotal: 100 } })] })(task), ` — модель читает промпт · ${partTotal(80, 100)}`);
  // Только part/total без процента (сервер отдал счётчики, но не ratio).
  assert.equal(makeReadingPrompt({ models: [row({ metrics: { available: true, source: 'strata', phase: 'reading the prompt', promptRead: 5, promptTotal: 0 } })] })(task), ' — модель читает промпт');
});

test('readingPrompt молчит, когда модель уже отвечает', () => {
  const task = { model: { provider: 'strata-iq3s', id: 'qwen3.8-flash-next-iq3-s' } };
  const answered = [{ id: 'assistant-5', role: 'assistant', text: 'Готово.' }];
  assert.equal(makeReadingPrompt({ turns: answered, models: [row()] })(task), '');
  // Пустой ход (текст ещё не пришёл) — строка чтения уместна.
  const empty = [{ id: 'assistant-5', role: 'assistant', text: '' }];
  assert.equal(makeReadingPrompt({ turns: empty, models: [row()] })(task), ` — модель читает промпт · 63% · ${partTotal(80000, 126088)}`);
});
