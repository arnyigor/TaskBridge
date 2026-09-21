/**
 * Кривая скорости Qwen3.8-27B Q3_K_XL по заполнению контекста.
 *
 *   node bench/measure-context-speed.mjs 0.10,0.25,0.50,0.75,0.90
 *
 * Размер промпта не оценивается по символам: сначала /tokenize даёт точное число токенов,
 * затем текст масштабируется до цели. Метрики берём из ответа (prompt_per_second /
 * predicted_per_second) — это то, что реально напечатал llama.cpp.
 */

const BASE = 'http://127.0.0.1:8080';
const MODEL = 'qwen-27b-q3';
const CTX = 102400;
const RATIOS = (process.argv[2] || '0.90').split(',').map(Number);
const MAX_TOKENS = 256;

function filler(chars) {
  const line = n => `Section ${n}: telemetry nominal, attitude stable, thruster duty cycle ${(n % 97) / 97}, ground station Madrid tracking pass ${n % 53}, residual error ${((n * 7919) % 1000) / 1000}. `;
  let out = '';
  let i = 0;
  while (out.length < chars) out += line(i++);
  return out;
}

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, text: text.slice(0, 300) }; }
}

const vram = () => {
  try {
    return require('node:child_process').execSync('nvidia-smi --query-gpu=memory.used --format=csv,noheader', { encoding: 'utf8' }).trim();
  } catch { return '?'; }
};

const probe = filler(400_000);
const probeTokens = (await post('/tokenize', { model: MODEL, content: probe })).json?.tokens?.length;
console.log(`калибровка: ${probe.length} символов = ${probeTokens} токенов (${(probe.length / probeTokens).toFixed(2)} симв/токен)`);

const results = [];
for (const ratio of RATIOS) {
  const target = Math.round(CTX * ratio);
  const text = filler(Math.round(probe.length * (target / probeTokens)));
  const exact = (await post('/tokenize', { model: MODEL, content: text })).json?.tokens?.length ?? target;
  const usedBefore = vram();

  const started = Date.now();
  const res = await post('/v1/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: text + '\n\nСколько было разделов «Section»? Ответь одной строкой.' }],
    max_tokens: MAX_TOKENS,
    stream: false,
    temperature: 0.2,
  });
  const wall = (Date.now() - started) / 1000;
  const t = res.json?.timings ?? {};
  const usage = res.json?.usage ?? {};
  const row = {
    fillPercent: Math.round((exact / CTX) * 100),
    promptTokens: usage.prompt_tokens ?? exact,
    pp: t.prompt_per_second ?? null,
    tg: t.predicted_per_second ?? null,
    promptSec: (t.prompt_ms ?? 0) / 1000,
    genSec: (t.predicted_ms ?? 0) / 1000,
    wall,
    vramBefore: usedBefore,
    vramAfter: vram(),
    answer: String(res.json?.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 60),
  };
  results.push(row);
  console.log(`  ${String(row.fillPercent).padStart(3)}% → PP ${(row.pp ?? 0).toFixed(0)} ток/с, TG ${(row.tg ?? 0).toFixed(1)} ток/с, промпт ${row.promptSec.toFixed(0)} с, VRAM ${row.vramAfter}`);
}

console.log('\n=== КРИВАЯ ПО ЗАПОЛНЕНИЮ (Qwen3.8-27B Q3_K_XL, ctx 102400) ===');
console.log('заполн.  токенов   PP ток/с   TG ток/с   промпт,с   генерация,с');
for (const r of results) {
  console.log(`${String(r.fillPercent + '%').padStart(7)}${String(r.promptTokens).padStart(9)}${String((r.pp ?? 0).toFixed(0)).padStart(11)}${String((r.tg ?? 0).toFixed(1)).padStart(11)}${r.promptSec.toFixed(0).padStart(11)}${r.genSec.toFixed(1).padStart(14)}`);
}
const fs = await import('node:fs');
fs.mkdirSync('G:/Android/AndroidStudioProjects/Taskbridge/data/runtime/batch', { recursive: true });
fs.writeFileSync('G:/Android/AndroidStudioProjects/Taskbridge/data/runtime/batch/q3-context-speed.json', JSON.stringify(results, null, 2) + '\n');
console.log('\nсохранено: data/runtime/batch/q3-context-speed.json');
