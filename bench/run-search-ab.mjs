/**
 * Прогоны A/B: одна задача, одно дерево, три плеча обвязки.
 *
 *   node bench/run-search-ab.mjs --repeats 3 [--arms A,B,C] [--model llama.cpp/qwen-27b-q3]
 *
 * Плечи различаются ТОЛЬКО переменной окружения — иначе «до» и «после» отличались бы
 * не одним фактором, а состоянием установки:
 *   A  PI_CODE_SEARCH_OFF=1                инструментов нет вообще
 *   B  —                                   инструменты ast/sg, без перехвата
 *   C  PI_CODE_SEARCH_INTERCEPT=1          инструменты + перехват текстового поиска
 *
 * Промпт берётся из файла экзамена и подаётся через stdin (в командной строке его
 * пришлось бы экранировать, а он многострочный). Трейсы кладутся в data/runtime/anwap-ab.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
// --exam=<файл> или --exam <файл> — обе формы.
const examArgIdx = process.argv.findIndex(a => a === '--exam' || a.startsWith('--exam='));
const examPath = examArgIdx >= 0
  ? (process.argv[examArgIdx].startsWith('--exam=') ? process.argv[examArgIdx].split('=')[1] : process.argv[examArgIdx + 1])
  : path.join(here, 'tasks', 'anwap-search-exam.json');
const exam = JSON.parse(fs.readFileSync(examPath, 'utf8'));
const OUT = path.join(root, 'data', 'runtime', path.basename(examPath, '.json'));

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) argv.set(token.replace(/^--/, ''), true);
  else { argv.set(token.replace(/^--/, ''), next); i += 1; }
}

const REPEATS = Number(argv.get('repeats') ?? 3);
const MODEL = String(argv.get('model') ?? 'llama.cpp/qwen-27b-q3');
const ARMS = String(argv.get('arms') ?? 'A,B,C').split(',').map(s => s.trim()).filter(Boolean);
const PER_RUN_TIMEOUT_MS = Number(argv.get('timeout-ms') ?? 15 * 60 * 1000);
fs.mkdirSync(OUT, { recursive: true });

// Переменные окружения, которые отличают плечи.
const ARM_ENV = {
  A: { PI_CODE_SEARCH_OFF: '1' },
  B: {},
  C: { PI_CODE_SEARCH_INTERCEPT: '1' },
};

function runPi(env) {
  return new Promise(resolve => {
    const child = spawn('pi', ['-p', '--mode', 'json', '--model', MODEL, '--thinking', 'off'],
      { cwd: exam.root, env: { ...process.env, ...env }, shell: true, windowsHide: true });
    let out = '';
    const started = Date.now();
    const timer = setTimeout(() => { child.kill(); }, PER_RUN_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    child.stdin.write(exam.prompt);
    child.stdin.end();
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, out, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

for (const arm of ARMS) {
  for (let i = 1; i <= REPEATS; i += 1) {
    const name = `${arm}-${i}`;
    process.stdout.write(`плечо ${name}: запуск… `);
    const result = await runPi(ARM_ENV[arm] ?? {});
    const file = path.join(OUT, `${name}.jsonl`);
    fs.writeFileSync(file, result.out);
    const toolCalls = (result.out.match(/"type":"tool_execution_start"/g) ?? []).length;
    console.log(`код ${result.code}, ${result.seconds} с, вызовов инструментов ${toolCalls}`);
  }
}

console.log(`\nтрейсы: ${OUT}`);
console.log(`счёт: node bench/score-exam.mjs ${ARMS.flatMap(a => Array.from({ length: REPEATS }, (_, i) => `${OUT}/${a}-${i + 1}.jsonl`)).join(' ')}`);
