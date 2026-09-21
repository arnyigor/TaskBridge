/**
 * Пакетный прогон всех моделей: moon_mission + три экзамена, со всеми расширениями pi.
 *
 *   node bench/batch-models.mjs [--only <профиль>] [--skip-moon] [--skip-exams]
 *                              [--moon-timeout 3600] [--exam-timeout 1200]
 *
 * Порядок — от маленьких к большим и MoE (как просили). Для каждой модели:
 *   1) роутер грузит пресет из models.ini (--models-max 1: загрузка вытесняет предыдущую);
 *   2) задача moon_mission: pi пишет HTML в каталог прогона;
 *   3) три экзамена (anwap, tivi, python) — те же, что в A/B, плечо C (все расширения);
 *   4) выгрузка.
 *
 * Результаты пишутся на диск ПОСЛЕ КАЖДОГО шага (data/runtime/batch/results.json),
 * поэтому обрыв или перезапуск не теряет уже собранное.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const TASKS = path.join(here, 'tasks');
const MOON_TASK = 'G:/AIModels/LLMBenchmarks/MyTests/moon_mission/task.txt';
const MOON_RUNS = 'G:/AIModels/LLMBenchmarks/MyTests/moon-run';
const BATCH_OUT = path.join(root, 'data', 'runtime', 'batch');

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  if (n === undefined || n.startsWith('--')) argv.set(t.replace(/^--/, ''), true);
  else { argv.set(t.replace(/^--/, ''), n); i += 1; }
}

// Таймаут на один тест — 30 минут (значение задано владельцем стенда):
// если модель не уложилась, прогон помечается timedOut и батарея идёт дальше.
const MOON_TIMEOUT_MS = Number(argv.get('moon-timeout') ?? 1800) * 1000;
const EXAM_TIMEOUT_MS = Number(argv.get('exam-timeout') ?? 1800) * 1000;
const ONLY = argv.get('only') ? String(argv.get('only')) : null;

// Порядок: сначала маленькие, затем большие и MoE.
const MODELS = [
  { profile: 'bonsai-27b-q2', note: 'Ternary-Bonsai 27B Q2_g64, 7.1 ГБ, dense 64 слоя' },
  { profile: 'qwen-27b-q3', note: 'Qwen3.8-27B Q3_K_XL, 12.2 ГБ, dense 65 — базовый ориентир' },
  { profile: 'hauhau-27b-q3', note: 'Qwen3.8-27B Uncensored Q3_K_P, 12.5 ГБ (MTP)' },
  { profile: 'qwen-27b-text', note: 'Qwen3.8-27B IQ4_XS, 13.3 ГБ' },
  { profile: 'qwen-27b-q4', note: 'Qwen3.8-27B Q4_K_XL, 16.4 ГБ (9 слоёв на CPU)' },
  { profile: 'ornith-35b-a3b', note: 'Ornith-1.5-35B-A3B Q6_K, 28.8 ГБ, MoE 256/8, эксперты на CPU' },
  { profile: 'qwen-flash-next-m64', note: 'Flash-Next M64 IQ4_XS, ~48 ГБ, MoE 512/10' },
];

const EXAMS = [
  { file: 'anwap-search-exam.json', label: 'anwap' },
  { file: 'tivi-declarations-exam.json', label: 'tivi' },
  { file: 'ai-reasoning-python-exam.json', label: 'python' },
];

fs.mkdirSync(BATCH_OUT, { recursive: true });
const resultsFile = path.join(BATCH_OUT, 'results.json');
const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : { models: {} };
const save = () => fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));

const log = msg => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);

function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { shell: true, windowsHide: true, ...opts });
    let out = '';
    child.stdout?.on('data', d => { out += d.toString(); });
    child.stderr?.on('data', d => { out += d.toString(); });
    if (opts.stdinText) { child.stdin.write(opts.stdinText); child.stdin.end(); }
    let killed = false;
    // Обычный child.kill() при shell: true убивает только оболочку, а pi продолжает работать
    // и держит GPU — поэтому сносим всё дерево процессов через taskkill /T.
    const timer = opts.timeoutMs ? setTimeout(() => {
      killed = true;
      run('taskkill', ['/F', '/T', '/PID', String(child.pid)], { timeoutMs: 20000 }).then(() => child.kill());
    }, opts.timeoutMs) : null;
    child.on('close', code => { if (timer) clearTimeout(timer); resolve({ code, out, killed }); });
  });
}

const taskbridge = (...args) => run('node', ['bin/taskbridge.mjs', ...args], { cwd: root, timeoutMs: 900000 });

async function routerState() {
  const r = await run('curl', ['-s', '-m', '5', 'http://127.0.0.1:8080/v1/models'], {});
  try {
    const j = JSON.parse(r.out);
    return (j.data ?? j.models ?? []).map(m => m.id ?? m.name).filter(Boolean);
  } catch { return []; }
}

function summarizeTrace(raw) {
  const calls = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let answer = '';
  let errors = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'tool_execution_start' && j.toolName) calls[j.toolName] = (calls[j.toolName] ?? 0) + 1;
    if (j.type === 'turn_end') turns += 1;
    if (j.type === 'tool_execution_end' && j.isError) errors += 1;
    const usage = j.message?.usage ?? j.usage;
    if (usage) {
      if (typeof usage.input === 'number') inputTokens = Math.max(inputTokens, usage.input);
      if (typeof usage.output === 'number') outputTokens += usage.output;
    }
    if (j.type === 'agent_end' && Array.isArray(j.messages)) {
      for (const m of j.messages) {
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
        const text = m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
        if (text) answer = text;
      }
    }
  }
  return { calls, turns, inputTokens, outputTokens, errors, answer };
}

// --- moon_mission ------------------------------------------------------------

function moonPrompt(dir) {
  const task = fs.readFileSync(MOON_TASK, 'utf8');
  return `${task}\n\n---\nСреда: рабочий каталог ${dir}. Сохрани итоговый файл как moon_mission.html в этом каталоге.\nВ ответе не печатай HTML — только короткий отчёт строго такого вида:\nFILE: <путь>\nTLI_DV_MPS: <число>\nMIN_MOON_SURFACE_KM: <число>\nSTATUS: <SUCCESS|FAILED>\n`;
}

async function runMoon(profile, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const startedAt = Date.now();
  const r = await run('pi', ['-p', '--mode', 'json', '--model', `llama.cpp/${profile}`, '--thinking', 'medium'],
    { cwd: dir, timeoutMs: MOON_TIMEOUT_MS, stdinText: moonPrompt(dir), startedAt });
  const trace = path.join(BATCH_OUT, `${profile}-moon.jsonl`);
  fs.writeFileSync(trace, r.out);
  const html = path.join(dir, 'moon_mission.html');
  const summary = summarizeTrace(r.out);
  const secs = Math.round((Date.now() - startedAt) / 1000);
  return {
    seconds: secs,
    exitCode: r.code,
    timedOut: r.killed === true,
    html: fs.existsSync(html) ? { size: fs.statSync(html).size, path: html } : null,
    ...summary,
    answer: summary.answer.slice(0, 600)
  };
}

// --- экзамены ----------------------------------------------------------------

async function runExam(profile, exam) {
  const spec = JSON.parse(fs.readFileSync(path.join(TASKS, exam.file), 'utf8'));
  const startedAt = Date.now();
  const r = await run('pi', ['-p', '--mode', 'json', '--model', `llama.cpp/${profile}`, '--thinking', 'medium'],
    { cwd: spec.root, timeoutMs: EXAM_TIMEOUT_MS, stdinText: spec.prompt, env: { ...process.env, PI_CODE_SEARCH_INTERCEPT: '1' }, startedAt });
  const trace = path.join(BATCH_OUT, `${profile}-${exam.label}.jsonl`);
  fs.writeFileSync(trace, r.out);
  const secs = Math.round((Date.now() - startedAt) / 1000);
  return { seconds: secs, exitCode: r.code, timedOut: r.killed === true, trace, ...summarizeTrace(r.out) };
}

// --- основной цикл -----------------------------------------------------------

for (const model of MODELS) {
  if (ONLY && model.profile !== ONLY) continue;
  log(`=== ${model.profile} — ${model.note} ===`);
  results.models[model.profile] ??= { note: model.note };
  const entry = results.models[model.profile];

  // 1) загрузка
  const t0 = Date.now();
  const load = await taskbridge('models', 'load', model.profile);
  entry.loadSeconds = Math.round((Date.now() - t0) / 1000);
  entry.loadOk = load.code === 0;
  entry.loadOut = load.out.slice(-400);
  const ids = await routerState();
  entry.routerSees = ids.includes(model.profile);
  log(`загрузка ${entry.loadOk ? 'ок' : 'ОШИБКА'} за ${entry.loadSeconds} с; роутер видит модель: ${entry.routerSees}`);
  if (!entry.loadOk) { save(); continue; }

  try {
    // 2) moon_mission
    if (!argv.get('skip-moon')) {
      log('moon_mission: генерация…');
      entry.moon = await runMoon(model.profile, path.join(MOON_RUNS, model.profile));
      entry.moon.tokPerSec = entry.moon.seconds ? Math.round((entry.moon.outputTokens / entry.moon.seconds) * 10) / 10 : 0;
      log(`moon_mission: ${entry.moon.seconds} с, файл ${entry.moon.html ? entry.moon.html.size + ' байт' : 'НЕ СОЗДАН'}, выход ${entry.moon.outputTokens} ток, ~${entry.moon.tokPerSec} ток/с`);
      save();
    }

    // 3) экзамены
    if (!argv.get('skip-exams')) {
      entry.exams = {};
      for (const exam of EXAMS) {
        log(`экзамен ${exam.label}…`);
        entry.exams[exam.label] = await runExam(model.profile, exam);
        const e = entry.exams[exam.label];
        log(`  ${exam.label}: ${e.seconds} с, вызовов ${Object.values(e.calls).reduce((a, b) => a + b, 0)}, ~${e.seconds ? Math.round((e.outputTokens / e.seconds) * 10) / 10 : 0} ток/с`);
        save();
      }
    }
  } finally {
    // 4) выгрузка
    const un = await taskbridge('models', 'unload', model.profile);
    entry.unloadOk = un.code === 0;
    log(`выгрузка ${entry.unloadOk ? 'ок' : 'ОШИБКА'}`);
    save();
  }
}

log(`готово. Результаты: ${resultsFile}`);
