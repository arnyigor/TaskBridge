import fs from 'node:fs';

// Метрики прогона Pi для бенчмарков: читает лог `pi -p --mode json` и печатает
// по каждому ответу модели время, токены, объём размышлений и вызовы инструментов.
//
// Запуск: node scripts/bench-pi-metrics.mjs <лог.jsonl>
//
// Почему именно так, а не «посмотреть глазами»:
// - Pi пишет NDJSON; один и тот же ответ встречается в событиях message_end,
//   turn_end и agent_end, поэтому строки дедуплицируются по responseId — иначе
//   расход токенов завышается втрое;
// - размышления в usage не приходят (llama.cpp не отдаёт reasoning_tokens),
//   поэтому их объём считается по сумме thinking_delta и переводится в токены
//   делением на 4 — это оценка, и в отчёте она помечена как оценка;
// - wall-clock берётся по timestamp'ам событий, то есть без времени запуска Pi.

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/bench-pi-metrics.mjs <лог.jsonl>');
  process.exit(2);
}

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const rows = [];
const seen = new Set();
let thinking = 0;

for (const line of lines) {
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  const delta = event.assistantMessageEvent;
  if (delta?.type === 'thinking_delta') thinking += String(delta.delta ?? '').length;

  const message = event.message;
  if (message?.role !== 'assistant' || !message.usage) continue;
  // Pi заводит сообщение ассистента со "stopReason: pending" и нулевым usage
  // в начале каждого хода. Это заглушка, а не ответ: без фильтра она даёт
  // лишние строки и портит подсчёт ответов.
  if (!(message.usage.input || message.usage.output)) continue;
  const key = message.responseId ?? `${event.type}-${rows.length}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const parts = Array.isArray(message.content) ? message.content : [];
  rows.push({
    at: message.timestamp,
    input: message.usage.input ?? 0,
    output: message.usage.output ?? 0,
    thinkingChars: thinking,
    textChars: parts.filter(p => p.type === 'text').reduce((n, p) => n + String(p.text ?? '').length, 0),
    tools: parts.filter(p => p.type === 'toolCall' || p.type === 'tool_use').map(p => p.name ?? p.toolName ?? '?'),
    stop: message.stopReason ?? '?'
  });
  thinking = 0;
}

if (!rows.length) {
  console.log(`ответов модели ещё нет (событий в логе: ${lines.length})`);
  process.exit(0);
}

const clock = value => (value ? new Date(value).toISOString().slice(11, 19) : '—');
const sum = key => rows.reduce((n, r) => n + (r[key] ?? 0), 0);

console.log('N | время    | input  | output | thinking~ | текст, симв | инструменты');
for (const [index, row] of rows.entries()) {
  console.log(
    `${String(index + 1).padStart(2)} | ${clock(row.at)} | ${String(row.input).padStart(6)} | ` +
    `${String(row.output).padStart(6)} | ${String(Math.round(row.thinkingChars / 4)).padStart(9)} | ` +
    `${String(row.textChars).padStart(11)} | ${row.tools.join(', ') || '—'}`
  );
}
const tools = rows.flatMap(r => r.tools);
console.log(
  `-- ответов ${rows.length} | input ${sum('input')} | output ${sum('output')} | ` +
  `thinking ~${Math.round(sum('thinkingChars') / 4)} | вызовов инструментов ${tools.length}` +
  `${tools.length ? ` (${[...new Set(tools)].join(', ')})` : ''}`
);
// Окно считается по timestamp'ам самих ответов: timestamp события бывает и
// числом, и ISO-строкой, и вычитать их напрямую нельзя (получается NaN).
const stamps = rows.map(r => r.at).filter(v => typeof v === 'number');
if (stamps.length > 1) {
  console.log(`-- окно лога: ${((stamps[stamps.length - 1] - stamps[0]) / 60000).toFixed(1)} мин`);
}
