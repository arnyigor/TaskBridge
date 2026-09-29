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
  // pp считается по НОВЫМ токенам: 70026 - 69981 = 45 за 1237 мс ≈ 36 t/s,
  // а не по всему промпту (иначе вышло бы 56 600 t/s).
  assert.equal(Math.round(m.pp), 36);
  assert.equal(m.tg, 27.5);
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
