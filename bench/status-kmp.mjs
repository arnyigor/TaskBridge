/**
 * Статус прогона: что модель успела сделать и в каком она состоянии.
 *
 *   node bench/status-kmp.mjs
 *
 * Читает трейс (файл может быть недописан — это нормально, читаем что есть),
 * сравнивает каталог с git-базой, показывает заполнение контекста и записи надзирателя.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const RUN_DIR = process.argv[2] ?? 'G:/AIModels/LLMBenchmarks/MyTests/kmp_app_run';
const TRACE = process.argv[3] ?? path.join(RUN_DIR, 'trace.jsonl');
const CTX = 102400;
const SUP_LOG = path.join(RUN_DIR, 'supervisor.log');

if (!fs.existsSync(TRACE)) { console.log(`трейса нет: ${TRACE}`); process.exit(0); }

const raw = fs.readFileSync(TRACE, 'utf8');
const lines = raw.split(/\r?\n/).filter(l => l.trim().startsWith('{'));

let calls = {};
let bashWrites = 0;
let turns = 0;
let contextTokens = 0;
let maxInput = 0;
let outTokens = 0;
let lastAssistant = '';
let startedAt = null;
let finished = false;
let errors = 0;
const recent = [];

for (const line of lines) {
  let j;
  try { j = JSON.parse(line); } catch { continue; }
  if (!startedAt && j.timestamp) startedAt = j.timestamp;
  if (j.type === 'turn_end') turns += 1;
  if (j.type === 'agent_end') finished = true;
  if (j.type === 'tool_execution_start') {
    calls[j.toolName] = (calls[j.toolName] ?? 0) + 1;
    // Файлы создаются и через bash (`cat > файл`, heredoc), а не только инструментами
    // write/edit — без этого счётчик правок врёт (показывает 0 при живом проекте).
    if (j.toolName === 'bash') {
      const cmd = String(j.args?.command ?? '');
      if (/>\s*[^\s|&]+/.test(cmd) || /<<\s*'?[A-Za-z]/.test(cmd)) bashWrites += 1;
    }
    recent.push(`${j.toolName} ${JSON.stringify(j.args ?? {}).slice(0, 90)}`);
    if (recent.length > 8) recent.shift();
  }
  if (j.type === 'tool_execution_end' && j.isError) errors += 1;
  const u = j.message?.usage ?? j.usage;
  if (u) {
    if (typeof u.input === 'number' && u.input > maxInput) maxInput = u.input;
    if (typeof u.output === 'number') outTokens += u.output;
  }
  // Заполнение окна считаем по составу диалога, а НЕ по usage.input: роутер отдаёт в usage
  // только некэшированную часть промпта (кэш берёт на себя до 1.6M токенов), поэтому
  // usage.input показывал 15 % там, где на деле занято ~80 %.
  const content = j.message?.content;
  if (Array.isArray(content)) {
    for (const p of content) {
      if (p.type === 'text' && p.text) contextTokens += p.text.length / 2.78;
      if (p.type === 'toolCall' && p.arguments) contextTokens += JSON.stringify(p.arguments).length / 2.78;
    }
  }
  if (j.type === 'agent_end' && Array.isArray(j.messages)) {
    for (const m of j.messages) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      const t = m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
      if (t) lastAssistant = t;
    }
  }
}

// Живой ли процесс pi
let alive = false;
try {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*--mode json*' } | Select-Object -First 1 -ExpandProperty ProcessId"], { encoding: 'utf8' });
  alive = out.trim().length > 0;
  if (alive) var pid = out.trim();
} catch { /* нет процесса — значит не запущен */ }

// Что изменилось в каталоге относительно git-базы
let changes = [];
try {
  const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: RUN_DIR, encoding: 'utf8' });
  changes = porcelain.split(/\r?\n/).filter(Boolean);
} catch { /* не git — пропускаем */ }
let commits = '';
try { commits = execFileSync('git', ['log', '--oneline'], { cwd: RUN_DIR, encoding: 'utf8' }).trim(); } catch {}

const total = Object.values(calls).reduce((a, b) => a + b, 0);
const writes = (calls.write ?? 0) + (calls.edit ?? 0);
const elapsed = startedAt ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000) : 0;
const hhmmss = s => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

// Средняя скорость генерации за весь прогон — из счётчиков сервера.
let avgTg = null;
let avgPp = null;
try {
  const m = execFileSync('curl', ['-s', '-m', '5', 'http://127.0.0.1:8080/metrics?model=qwen-27b-q3'], { encoding: 'utf8' });
  const num = name => { const r = new RegExp(`^llamacpp:${name} ([0-9.e+]+)$`, 'm').exec(m); return r ? Number(r[1]) : null; };
  const pred = num('tokens_predicted_total');
  const predSec = num('tokens_predicted_seconds_total');
  const prompt = num('prompt_tokens_total');
  const promptSec = num('prompt_seconds_total');
  const cached = num('prompt_tokens_cached_total');
  if (pred && predSec) avgTg = pred / predSec;
  if (prompt && promptSec) avgPp = prompt / promptSec;
  if (cached) console.log(`кэш промпта: ${Math.round(cached / 1e6 * 10) / 10}M токенов переиспользовано`);
} catch { /* сервер может не ответить — не критично */ }

// Скорость за интервал между проверками: счётчики llama.cpp обновляются по завершении
// запроса, поэтому «мгновенно» в середине генерации прочитать нельзя — зато можно
// сравнить с тем, что было на прошлой проверке, и получить темп последнего периода.
const SNAP = 'G:/Android/AndroidStudioProjects/Taskbridge/data/runtime/batch/q3-snapshot.json';
let interval = null;
try {
  const m = execFileSync('curl', ['-s', '-m', '5', 'http://127.0.0.1:8080/metrics?model=qwen-27b-q3'], { encoding: 'utf8' });
  const num = name => { const r = new RegExp(`^llamacpp:${name} ([0-9.e+]+)$`, 'm').exec(m); return r ? Number(r[1]) : null; };
  const now = { at: Date.now(), prompt: num('prompt_tokens_total'), predicted: num('tokens_predicted_total') };
  if (fs.existsSync(SNAP)) {
    const prev = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
    const dt = (now.at - prev.at) / 1000;
    if (dt > 5 && now.predicted !== null && prev.predicted !== null) {
      interval = { seconds: Math.round(dt), pp: (now.prompt - prev.prompt) / dt, tg: (now.predicted - prev.predicted) / dt };
    }
  }
  fs.writeFileSync(SNAP, JSON.stringify(now));
} catch { /* сервер не ответил — не критично */ }

console.log('=== СТАТУС ПРОГОНА ===');
console.log(`состояние: ${finished ? 'ЗАВЕРШЁН' : alive ? 'работает' : 'НЕ РАБОТАЕТ (процесса нет)'}${alive && pid ? ` (PID ${pid})` : ''}`);
console.log(`время: ${hhmmss(elapsed)} | ходов: ${turns} | вызовов инструментов: ${total} | правок файлов: ${writes} через write/edit + ${bashWrites} через bash`);
console.log(`контекст (оценка по диалогу): ${Math.round(contextTokens)} из ${CTX} токенов (${((contextTokens / CTX) * 100).toFixed(1)} %)`);
console.log(`токенов сгенерировано: ${outTokens} | ошибок инструментов: ${errors}${avgTg ? ` | средняя TG ${avgTg.toFixed(1)} ток/с${avgPp ? `, PP ${avgPp.toFixed(0)} ток/с` : ''}` : ''}`);
if (interval) console.log(`за последние ${interval.seconds} с: PP ${interval.pp.toFixed(0)} ток/с, TG ${interval.tg.toFixed(1)} ток/с`);
console.log(`\nвызовы: ${Object.entries(calls).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ') || '—'}`);

console.log(`\n=== ЧТО СДЕЛАНО (git status) ===`);
if (!changes.length) console.log('  пока ничего не изменено');
else {
  const created = changes.filter(c => c.startsWith('??'));
  const modified = changes.filter(c => !c.startsWith('??'));
  console.log(`  новых файлов/каталогов: ${created.length}, изменённых: ${modified.length}`);
  changes.slice(0, 15).forEach(c => console.log('   ' + c));
  if (changes.length > 15) console.log(`   … ещё ${changes.length - 15}`);
}

if (fs.existsSync(SUP_LOG)) {
  const sup = fs.readFileSync(SUP_LOG, 'utf8');
  const kinds = {};
  for (const m of sup.matchAll(/"event":"([a-z_]+)"/g)) kinds[m[1]] = (kinds[m[1]] ?? 0) + 1;
  console.log(`\n=== НАДЗИРАТЕЛЬ ===`);
  console.log('  ' + (Object.entries(kinds).map(([k, v]) => `${k}:${v}`).join('  ') || 'записей нет'));
}

console.log(`\n=== ПОСЛЕДНИЕ ДЕЙСТВИЯ ===`);
recent.forEach(r => console.log('  ' + r));
if (lastAssistant) {
  console.log(`\n=== ЧТО ГОВОРИТ МОДЕЛЬ (хвост ответа) ===`);
  console.log('  ' + lastAssistant.replace(/\s+/g, ' ').slice(-400));
}
