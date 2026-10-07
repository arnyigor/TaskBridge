import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStrataMetrics } from '../src/local-models.mjs';

// Форма ответа снята с живого движка Strata 0.1.15 (GET /metrics).
const idle = {
  engine: { model: 'qwen3.8-flash-next-iq3_s', max_context: 262144, context: 262144, expert_slots: 3163, vram_free_mib: 899 },
  live: { state: 'idle', queued: 0, phase: null, prompt_tokens: null, prompt_read: null, prompt_total: null, generated: null, max_tokens: null, elapsed_s: null, tok_s: null },
  requests: [
    { prompt_tokens: 70026, reused: 69981, output_tokens: 322, prompt_ms: 1237.0, decode_ms: 11718.1, decode_tok_s: 27.5 },
    { prompt_tokens: 69238, reused: 69213, output_tokens: 742, prompt_ms: 571.8, decode_ms: 21899.3, decode_tok_s: 33.9 }
  ]
};

test('parseStrataMetrics ignores anything that is not a Strata payload', () => {
  assert.equal(parseStrataMetrics(null), null);
  assert.equal(parseStrataMetrics('text'), null);
  assert.equal(parseStrataMetrics({}), null);
});

test('parseStrataMetrics reports the idle state and the last request', () => {
  const m = parseStrataMetrics(idle);
  assert.equal(m.available, true);
  assert.equal(m.source, 'strata');
  assert.equal(m.busy, false);
  assert.equal(m.phase, null);
  assert.equal(m.model, 'qwen3.8-flash-next-iq3_s');
  assert.equal(m.contextWindow, 262144);
  // 45 новых токенов из 70 026 — промпт пришёл из кеша беседы: скорости чтения
  // у такого запроса нет (было бы «36 tok/s» из 1.24 с накладных расходов).
  assert.equal(m.pp, null);
  assert.equal(m.ppUnavailable, 'conversation-cache');
  assert.equal(m.freshTokens, 45);
  assert.equal(m.promptTokens, 70026);
  assert.equal(m.tg, 27.5);
});

// Записи сняты с живого сервера (iq3_s, 8083, 2026-09-30): на длинной беседе
// доля `reused` доходит до 99.9%, и «новые / prompt_ms» падает до десятков
// токенов в секунду — это те самые «105», которые видел оператор.
test('parseStrataMetrics не публикует PP на промпте, который пришёл из кеша', () => {
  const m = parseStrataMetrics({
    engine: { model: 'qwen3.8-flash-next-iq3_s' },
    live: { state: 'idle', tok_s: null },
    requests: [
      { prompt_tokens: 55496, reused: 55333, output_tokens: 392, prompt_ms: 1501.9, decode_ms: 8820.3, decode_tok_s: 44.4 },
      { prompt_tokens: 60938, reused: 60915, output_tokens: 295, prompt_ms: 677.4, decode_ms: 8519.7, decode_tok_s: 34.6 }
    ]
  });
  // 163 новых токена за 1501.9 мс — «108 tok/s» старой формулы;
  // движок при этом читает новые токены на ~650 ток/с (см. регрессию в
  // STRATA_CACHED_PROMPT_MAX). Скорости чтения нет — есть факт: сколько прочитано.
  assert.equal(m.pp, null);
  assert.equal(m.ppUnavailable, 'conversation-cache');
  assert.equal(m.freshTokens, 163);
  assert.equal(m.promptTokens, 55496);
});

test('parseStrataMetrics считает PP по новым токенам, когда промпт читали целиком', () => {
  // Первый запрос сессии снял с живого сервера: 16 198 токенов, reused 0,
  // prompt_ms 14 085 => 1 150 ток/с — сходится с измеренной таблицей самого
  // движка (IQ3_S: 1 070 ток/с на 32K, 931 на 128K).
  const m = parseStrataMetrics({
    engine: { model: 'qwen3.8-flash-next-iq3_s' },
    live: { state: 'idle', tok_s: null },
    requests: [{ prompt_tokens: 16198, reused: 0, output_tokens: 256, prompt_ms: 14085.4, decode_ms: 5000, decode_tok_s: 51.2 }]
  });
  assert.equal(Math.round(m.pp), 1150);
  assert.equal(m.ppUnavailable, null);
  assert.equal(m.freshTokens, 16198);
  assert.equal(m.promptTokens, 16198);
});

test('parseStrataMetrics без поля reused считает весь промпт прочитанным', () => {
  // Движки до 0.1.3 поля `reused` не отдают — тогда prompt_ms и есть чтение промпта.
  const m = parseStrataMetrics({
    engine: { model: 'old-engine' },
    live: { state: 'idle' },
    requests: [{ prompt_tokens: 8768, output_tokens: 100, prompt_ms: 8187, decode_tok_s: 50 }]
  });
  assert.equal(m.freshTokens, 8768);
  assert.equal(m.promptTokens, 8768);
  assert.equal(Math.round(m.pp), 1071);
});

test('parseStrataMetrics carries the phase and the prompt progress', () => {
  const m = parseStrataMetrics({
    engine: { model: 'qwen3.8-flash-next-iq3_s', context: 262144 },
    live: { state: 'busy', phase: 'reading the prompt', prompt_read: 65536, prompt_total: 131072, generated: 0, elapsed_s: 42.5, tok_s: null, queued: 0 },
    requests: []
  });
  assert.equal(m.busy, true);
  assert.equal(m.phase, 'reading the prompt');
  assert.equal(m.promptRead, 65536);
  assert.equal(m.promptTotal, 131072);
  assert.equal(m.progress, 0.5);
  assert.equal(m.elapsedS, 42.5);
  assert.equal(m.pp, null);   // запросов ещё не было
  assert.equal(m.tg, null);
});

test('parseStrataMetrics prefers the live generation rate over the last request', () => {
  const m = parseStrataMetrics({
    engine: { model: 'x' },
    live: { state: 'busy', phase: 'thinking', tok_s: 47.3 },
    requests: [{ prompt_tokens: 100, reused: 0, prompt_ms: 50, decode_tok_s: 20 }]
  });
  assert.equal(m.tg, 47.3);
  assert.equal(m.pp, 2000);
});

test('parseStrataMetrics keeps a payload that only has the engine block', () => {
  const m = parseStrataMetrics({ engine: { model: 'x', max_context: 4096 } });
  assert.equal(m.available, true);
  assert.equal(m.contextWindow, 4096);
  assert.equal(m.busy, false);
  assert.equal(m.pp, null);
});

// Записи сняты с живого движка 0.1.40 (iq3_s, порт 8083, 2026-10-06) во время
// чтения промпта: live-блок отдаёт `prefill_tok_s_mean` по ИДУЩЕМУ запросу, а
// `requests` ещё содержит только прошлый. Итоговая запись того же запроса в
// /metrics дала 2381-2383 ток/с — живое число и запись сходятся.
test('parseStrataMetrics берёт PP идущего запроса из живой скорости чтения', () => {
  const m = parseStrataMetrics({
    engine: { model: 'qwen3.8-flash-next-iq3_s', context: 204800 },
    live: { state: 'reading', phase: 'reading the prompt', prompt_read: 16384, prompt_total: 39087, generated: 0, elapsed_s: null, tok_s: null, prefill_tok_s_mean: 2416.3 },
    requests: [{ prompt_tokens: 55496, reused: 55333, output_tokens: 392, prompt_ms: 1501.9, decode_ms: 8820.3, decode_tok_s: 44.4 }]
  });
  // Прошлый запрос пришёл из кеша беседы (PP у него нет), но читается новый —
  // строка показывает 2 416 ток/с, а не «—» и не числа прошлого запроса.
  assert.equal(m.pp, 2416.3);
  assert.equal(m.ppUnavailable, null);
  assert.equal(m.phase, 'reading the prompt');
  // Живой TG во время чтения движок не отдаёт — остаётся скорость прошлого запроса.
  assert.equal(m.tg, 44.4);
});

test('parseStrataMetrics без живой скорости чтения падает на прошлый запрос', () => {
  const m = parseStrataMetrics({
    engine: { model: 'qwen3.8-flash-next-iq3_s' },
    live: { state: 'reading', phase: 'reading the prompt', prompt_read: 8192, prompt_total: 16198, generated: 0, tok_s: null },
    requests: [{ prompt_tokens: 16198, reused: 0, output_tokens: 256, prompt_ms: 14085.4, decode_tok_s: 51.2 }]
  });
  assert.equal(Math.round(m.pp), 1150);
  assert.equal(m.ppUnavailable, null);
});

test('parseStrataMetrics не подменяет PP на кеш-артефакт живым числом', () => {
  // Запрос из кеша беседы: движок сразу в `generating`, поля чтения в live пусты.
  const m = parseStrataMetrics({
    engine: { model: 'qwen3.8-flash-next-iq3_s' },
    live: { state: 'generating', phase: 'thinking', prompt_read: null, prompt_total: null, generated: 9, tok_s: 36.0, prefill_tok_s_mean: 19.6 },
    requests: [{ prompt_tokens: 8477, reused: 8472, output_tokens: 16, prompt_ms: 203.8, decode_ms: 433.6, decode_tok_s: 36.9 }]
  });
  // 19.6 — это `prefill_tok_s_mean` от запроса, который почти ничего не читал
  // (5 новых токенов): во время генерации оно не берётся, и строка честно молчит.
  assert.equal(m.pp, null);
  assert.equal(m.ppUnavailable, 'conversation-cache');
  assert.equal(m.tg, 36.0);
});
