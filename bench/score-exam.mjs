/**
 * Счётчик для A/B: разбирает ответ модели по формату экзамена, сверяет с эталоном
 * и достаёт метрики из трейса прогона.
 *
 *   node bench/score-exam.mjs <трейс.jsonl> [<трейс2.jsonl> …]
 *
 * Считает не «похоже/не похоже», а точное совпадение множеств: лишние пути — ложные,
 * пропущенные — промахи. Вопрос зачтён только при полном совпадении.
 *
 * Правило строки для Q1/Q2: заголовки классов многострочные, поэтому принимается любая
 * строка в пределах объявления — от строки с `class <Имя>` до строки с `) : <Интерфейс>`.
 * Требовать одну конкретную строку значило бы браковать правильный ответ за то, что
 * модель назвала строку имени класса, а не строку с интерфейсом.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// --exam=<файл> или --exam <файл> — обе формы.
const examArgIdx = process.argv.findIndex(a => a === '--exam' || a.startsWith('--exam='));
const examPath = examArgIdx >= 0
  ? (process.argv[examArgIdx].startsWith('--exam=') ? process.argv[examArgIdx].split('=')[1] : process.argv[examArgIdx + 1])
  : path.join(here, 'tasks', 'anwap-search-exam.json');
const exam = JSON.parse(fs.readFileSync(examPath, 'utf8'));
const examOutName = path.basename(examPath, '.json');
// Путь может прийти в любом из двух естественных видов — относительно корня исходников
// (`com/arny/mobilecinema/…)` или относительно корня пакета (`presentation/…`).
// Считаем это одним и тем же файлом, а не разными ответами.
const norm = p => p
  .replace(/\\/g, '/')
  .replace(/^\.\//, '')
  .replace(/^app\/src\/main\/java\//, '')
  .replace(/^com\/arny\/mobilecinema\//, '')
  .trim();
const relBase = exam.rel_base ?? '';
const absPath = rel => path.join(exam.root, relBase, norm(rel));

// Один и тот же файл может прийти как с полным путём от корня проекта, так и укороченным
// (`comp/arny/mobilecinema/presentation/X.kt` или `presentation/X.kt`). Считаем это одним
// файлом, а не разными ответами: сравниваем по хвосту на границе сегмента.
const sameFile = (a, b) => {
  const x = norm(a);
  const y = norm(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
};

// Трейсы — все позиционные аргументы, кроме --exam и его значения.
const examArgIndexes = new Set();
if (examArgIdx >= 0) {
  examArgIndexes.add(examArgIdx);
  if (!process.argv[examArgIdx].startsWith('--exam=')) examArgIndexes.add(examArgIdx + 1);
}
const files = process.argv
  .map((arg, i) => ({ arg, i }))
  .filter(({ arg, i }) => i >= 2 && !examArgIndexes.has(i) && !arg.startsWith('--exam'))
  .map(({ arg }) => arg);
if (!files.length) {
  console.error('укажи хотя бы один трейс: node bench/score-exam.mjs <трейс.jsonl>');
  process.exit(2);
}

// --- разбор трейса ------------------------------------------------------------

function readTrace(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const calls = {};
  let turns = 0;
  let maxInput = 0;
  let outTokens = 0;
  let finalText = '';
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let j;
    try { j = JSON.parse(trimmed); } catch { continue; }
    if (j.type === 'tool_execution_start' && j.toolName) calls[j.toolName] = (calls[j.toolName] ?? 0) + 1;
    if (j.type === 'turn_end') turns += 1;
    const usage = j.message?.usage ?? j.usage;
    if (usage) {
      if (typeof usage.input === 'number') maxInput = Math.max(maxInput, usage.input);
      if (typeof usage.output === 'number') outTokens += usage.output;
    }
    if (j.type === 'agent_end' && Array.isArray(j.messages)) {
      // Итоговый ответ — последнее текстовое сообщение ассистента.
      for (const m of j.messages) {
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
        const text = m.content.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
        if (text) finalText = text;
      }
    }
  }
  return { calls, turns, maxInput, outTokens, finalText };
}

// --- сверка с эталоном --------------------------------------------------------

// Путь под корнем проекта, относительно которого заданы пути в экзамене (необязательно).
// Для anwap это app/src/main/java/com/arny/mobilecinema, для Python-экзамена — пусто.
// Окно объявления класса: от `class <Имя>` до строки с `) : <Интерфейс>`. Для Python
// строка класса однозначна, поэтому там берём числовое окно из экзамена (line_tolerance).
function lineWindow(relFile, expectedLine) {
  const tol = exam.scoring?.line_tolerance;
  if (typeof tol === 'number') return [expectedLine - tol, expectedLine + tol];
  const abs = absPath(relFile);
  let lines;
  try { lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/); } catch { return [expectedLine, expectedLine]; }
  for (let i = Math.min(expectedLine, lines.length) - 1; i >= 0 && i >= expectedLine - 40; i -= 1) {
    if (/^\s*(?:internal\s+|public\s+|private\s+|open\s+|abstract\s+|data\s+|sealed\s+)*class\b/.test(lines[i])) {
      return [i + 1, expectedLine];
    }
  }
  return [expectedLine, expectedLine];
}

function parseAnswer(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*Q([1-4])\s*\|(.*)$/);
    if (!m) continue;
    const rest = m[2].split('|').map(s => s.trim());
    // Два формата: Q1|<число>|<пути> и Q3|<пути>. Первое поле — число только там, где оно есть.
    const numbered = /^\d+$/.test(rest[0]);
    const items = (numbered ? rest.slice(1).join('|') : rest.join('|')).split(',').map(s => s.trim()).filter(Boolean);
    out[`Q${m[1]}`] = { num: numbered ? Number(rest[0]) : null, items };
  }
  return out;
}

function scoreQuestion(question, answer) {
  const expected = question.expect.map(norm);
  if (!answer) return { verdict: 'нет ответа', ok: false, falsePositives: [], missed: expected };
  // Вопрос «сколько объявлений» оценивается только по числу: перечислять 42 пути не требуется.
  if (question.kind === 'count_only') {
    const ok = answer.num === question.count;
    return { verdict: ok ? 'верно' : `неверно (сказано ${answer.num ?? '—'}, верно ${question.count})`, ok, countOk: ok, falsePositives: [], missed: [] };
  }
  const got = answer.items.map(norm).filter(Boolean);
  const missed = [];
  const falsePositives = [];
  const matchedExpect = new Set();

  for (const item of got) {
    const [file, lineText] = item.split(/:(?=\d+$)/);
    const line = Number(lineText);
    const hit = expected.findIndex(exp => {
      const [expFile, expLine] = exp.split(/:(?=\d+$)/);
      if (!sameFile(expFile, file ?? '')) return false;
      if (!Number.isFinite(line) || !expLine) return true;
      const [from, to] = lineWindow(expFile, Number(expLine));
      return line >= from && line <= to;
    });
    if (hit >= 0) matchedExpect.add(hit);
    else falsePositives.push(item);
  }
  for (let i = 0; i < expected.length; i += 1) if (!matchedExpect.has(i)) missed.push(expected[i]);

  const countOk = question.kind === 'file_set' || question.kind === 'name_set' ? true : answer.num === question.count;
  return {
    verdict: missed.length === 0 && falsePositives.length === 0 && countOk ? 'верно' : 'неверно',
    ok: missed.length === 0 && falsePositives.length === 0 && countOk,
    countOk,
    falsePositives,
    missed
  };
}

// --- отчёт --------------------------------------------------------------------

const report = [];
for (const file of files) {
  const trace = readTrace(file);
  const answer = parseAnswer(trace.finalText);
  const questions = exam.questions.map(q => ({ id: q.id, ...scoreQuestion(q, answer[q.id]) }));
  const correct = questions.filter(q => q.ok).length;
  const toolCalls = Object.entries(trace.calls).sort((a, b) => b[1] - a[1]);
  const total = toolCalls.reduce((sum, [, n]) => sum + n, 0);
  const textSearch = (trace.calls.grep ?? 0) + (trace.calls.bash ?? 0);
  report.push({ file: path.basename(file), correct, of: questions.length, toolCalls, total, textSearch, turns: trace.turns, maxInput: trace.maxInput, outTokens: trace.outTokens, questions });
}

console.log(`\n${'плечо'.padEnd(30)} ${'верно'.padEnd(7)} ${'вызовов'.padEnd(9)} ${'поиск'.padEnd(7)} ${'ходов'.padEnd(7)} ${'вход'.padEnd(9)} выход`);
for (const r of report) {
  console.log(`${r.file.replace('.jsonl', '').padEnd(30)} ${(`${r.correct}/${r.of}`).padEnd(7)} ${String(r.total).padEnd(9)} ${String(r.textSearch).padEnd(7)} ${String(r.turns).padEnd(7)} ${String(r.maxInput).padEnd(9)} ${r.outTokens}`);
}
for (const r of report) {
  console.log(`\n--- ${r.file} ---`);
  console.log(`  вызовы: ${r.toolCalls.map(([n, c]) => `${n}:${c}`).join('  ') || '—'}`);
  for (const q of r.questions) {
    const extra = [q.missed?.length ? `пропущено: ${q.missed.join(', ')}` : '', q.falsePositives?.length ? `лишнее: ${q.falsePositives.join(', ')}` : ''].filter(Boolean).join('; ');
    console.log(`  ${q.id}: ${q.verdict}${extra ? ` — ${extra}` : ''}`);
  }
}

const outDir = path.join(here, '..', 'data', 'runtime', examOutName);
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `score-${examOutName}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`\nотчёт: ${outFile}`);
