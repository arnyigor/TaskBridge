/**
 * Запуск прогона: одна сессия, свои пути, проверка после старта.
 *
 *   node bench/launch-run.mjs --cwd <каталог> --prompt-file <файл> [--profile build-project]
 *                            [--model llama.cpp/qwen-27b-q3] [--thinking medium]
 *                            [--max-minutes 60] [--tag kmp2] [--start-timeout 180] [--check]
 *
 * Почему отдельный скрипт, а не одна строка в шелле. Прошлый прогон был запущен длинной
 * командой с heredoc, сломанный фрагмент выполнил строку запуска ВТОРОЙ раз — и в одном
 * каталоге работали две сессии pi с одинаковым промптом. Это испортило замер: stdout-трейс
 * показал одну сессию, счётчики надзирателя смешались, а «второй проект» и «внешняя сборка»
 * оказались действиями второго агента.
 *
 * Что здесь защищает от повтора:
 *   1) мьютекс `<cwd>/.pi/run.lock` с PID: живой процесс — отказ;
 *   2) уникальные пути на прогон (trace, лог надзирателя, манифест);
 *   3) проверка после старта: в каталоге сессий этого cwd должен появиться РОВНО ОДИН новый
 *      файл; иначе прогон гасится вместе с деревом процессов.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  if (n === undefined || n.startsWith('--')) argv.set(t.replace(/^--/, ''), true);
  else { argv.set(t.replace(/^--/, ''), n); i += 1; }
}

const sessionsDirFor = cwdPath => path.join(os.homedir(), '.pi', 'agent', 'sessions', `--${cwdPath.replace(/[\\:]/g, '-')}--`);
const cwd = path.resolve(String(argv.get('cwd') ?? process.cwd()));
const promptFile = argv.get('prompt-file') ? path.resolve(String(argv.get('prompt-file'))) : null;
const promptInline = argv.get('prompt') ? String(argv.get('prompt')) : null;
const model = String(argv.get('model') ?? 'llama.cpp/qwen-27b-q3');
const thinking = String(argv.get('thinking') ?? 'medium');
const maxMinutes = Number(argv.get('max-minutes') ?? 60);
const tag = String(argv.get('tag') ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
const profile = argv.get('profile') ? String(argv.get('profile')) : '';
const checkOnly = Boolean(argv.get('check'));

if (!promptFile && !promptInline) { console.error('нужен --prompt-file или --prompt'); process.exit(2); }
if (!fs.existsSync(cwd)) { console.error(`нет каталога: ${cwd}`); process.exit(2); }

const runId = `${tag}`;
const runDir = path.join(cwd, 'runs', runId);
const lockPath = path.join(cwd, '.pi', 'run.lock');
const sessionsDir = sessionsDirFor(cwd);

// ─── 1. Мьютекс ────────────────────────────────────────────────────────────────

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readLock() {
  try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return null; }
}

const existing = readLock();
// Живость проверяем по процессу pi, а не по bash-обёртке: обёртка умирает сразу, и мьютекс
// пропускал бы второй запуск в каталог, где pi ещё работает.
const existingPid = existing?.piPid || existing?.pid;
if (existing && existingPid && pidAlive(existingPid)) {
  console.error(`В каталоге уже идёт прогон: PID ${existingPid}, старт ${existing.startedAt}, tag ${existing.tag}.`);
  console.error('Второй запуск сломал бы замер (две сессии в одном каталоге). Останови первый или удали .pi/run.lock.');
  process.exit(3);
}
if (existing) console.log(`старый lock (PID ${existingPid} мёртв) — перезаписываю`);

// Сколько сессий уже было — чтобы потом убедиться, что появилась ровно одна новая.
const before = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')) : [];

if (checkOnly) {
  console.log(`проверка пройдена: свободно.\n  cwd: ${cwd}\n  сессий уже: ${before.length}\n  каталог сессий: ${sessionsDir}`);
  process.exit(0);
}

// ─── 2. Запуск ────────────────────────────────────────────────────────────────

fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(path.dirname(lockPath), { recursive: true });
const promptText = promptFile ? fs.readFileSync(promptFile, 'utf8') : promptInline;
fs.writeFileSync(path.join(runDir, 'prompt.txt'), promptText);

const tracePath = path.join(runDir, 'trace.jsonl');
const supervisorLog = path.join(runDir, 'supervisor.log');
const startedAt = new Date().toISOString();

// Профиль надзирателя — из файла задачи, если он там уже прописан; иначе из флага.
const harnessFile = path.join(cwd, '.pi', 'harness.json');
let settingsFromFile = {};
try { if (fs.existsSync(harnessFile)) settingsFromFile = JSON.parse(fs.readFileSync(harnessFile, 'utf8')); } catch { /* битый файл не должен ломать запуск */ }
if (profile && settingsFromFile.profile !== profile) {
  settingsFromFile = { ...settingsFromFile, profile };
  fs.writeFileSync(harnessFile, JSON.stringify(settingsFromFile, null, 2) + '\n');
}

const env = {
  ...process.env,
  BENCH_SUPERVISOR_LOG: supervisorLog,
  PI_CODE_SEARCH_INTERCEPT: process.env.PI_CODE_SEARCH_INTERCEPT ?? '1',
};

// ─── ЗАЩИТА: прогон без живой модели не должен состояться ─────────────────────
// Найденный дефект: `pi -p` завершается кодом 0 и тогда, когда эндпоинт модели мёртв —
// он просто не делает вызовов инструментов. Такой прогон выглядел как нормальный,
// пока в нём не находили ни одного workspace_delta. Лучше отказать на старте.
const routerUrl = process.env.BENCH_ROUTER_URL ?? 'http://127.0.0.1:8080';
const modelId = (model ?? '').split('/').pop() ?? '';
let serving = '';
try {
  const out = execFileSync('curl', ['-s', '--max-time', '8', `${routerUrl}/v1/models`], { encoding: 'utf8' });
  serving = ([...out.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map(m => m[1])).join(',');
} catch { /* роутер недоступен — это и есть отказ */ }
if (!serving || (modelId && !serving.includes(modelId))) {
  console.error(`ОТКАЗ: модель не обслуживается роутером ${routerUrl}. Показано: ${serving || '(ничего)'}`);
  console.error('Прогон без модели даёт код 0 и ноль вызовов инструментов — это не результат, а тишина.');
  console.error(`Поднять: node bin/taskbridge.mjs models start && node bin/taskbridge.mjs models load ${modelId || '<пресет>'}`);
  process.exit(2);
}
fs.writeFileSync(path.join(runDir, 'environment.json'), JSON.stringify({
  routerUrl, serving: serving.split(','), model: modelId, startedAt: new Date().toISOString(),
}, null, 2) + '\n');

const stdoutPath = tracePath;
const stderrPath = path.join(runDir, 'stderr.log');
const promptPath = path.join(runDir, 'prompt.txt');

// Запуск через bash + nohup. Это проверенный способ: именно так прошёл предыдущий прогон.
// node-овы spawn с detached/unref в этом окружении не выживает: процесс умирает молча,
// не создав ни сессии, ни строки вывода (проверено: stderr пуст, сессия отсутствует).
const quoted = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const startCmd = [
  'nohup pi -p --mode json',
  `--model ${quoted(model)}`,
  `--thinking ${quoted(thinking)}`,
  `< ${quoted(promptPath)}`,
  `> ${quoted(stdoutPath)}`,
  `2> ${quoted(stderrPath)}`,
  '& echo $!',
].join(' ');

let pid = 0;
try {
  const out = execFileSync('bash', ['-lc', startCmd], { cwd, env, encoding: 'utf8', timeout: 60000 });
  pid = Number(String(out).trim().split(/\s+/).pop());
} catch (error) {
  console.error(`ПРОГОН НЕ СТАРТОВАЛ: ${String(error?.message ?? error).slice(0, 300)}`);
  fs.rmSync(lockPath, { force: true });
  process.exit(6);
}

if (!pid || Number.isNaN(pid)) {
  console.error(`ПРОГОН НЕ СТАРТОВАЛ: не получил PID (${pid})`);
  fs.rmSync(lockPath, { force: true });
  process.exit(6);
}

// PID от `echo $!` — это bash-обёртка nohup, а НЕ процесс pi. Найденный дефект: `taskkill /T`
// по нему отвечает «процесс не найден», а pi продолжает работать. Убитый на вид прогон выжил,
// и позже в том же каталоге оказались ДВЕ сессии, пишущие в один лог надзирателя: в нём
// чередовались две последовательности seq, и замер был бы недействителен.
// Поэтому ищем настоящий процесс pi по командной строке, запущенный после нашего старта.
const piPidOf = sinceMs => {
  try {
    const out = execFileSync('wmic', ['process', 'where', "name='node.exe'", 'get', 'ProcessId,CommandLine,CreationDate', '/format:list'], { encoding: 'utf8' });
    const blocks = out.replace(/\r/g, '').split(/\n\n+/);
    const found = [];
    for (const b of blocks) {
      if (!/cli\.js -p/.test(b)) continue;
      const id = Number(b.match(/ProcessId=(\d+)/)?.[1] ?? 0);
      const created = b.match(/CreationDate=(\d{14})/)?.[1];
      if (!id || !created) continue;
      const t = Date.parse(`${created.slice(0, 4)}-${created.slice(4, 6)}-${created.slice(6, 8)}T`
        + `${created.slice(8, 10)}:${created.slice(10, 12)}:${created.slice(12, 14)}`);
      if (t >= sinceMs - 5000) found.push({ id, t });
    }
    return found.sort((a, b) => b.t - a.t)[0]?.id ?? 0;
  } catch { return 0; }
};
const piPid = piPidOf(Date.parse(startedAt));
const killTarget = piPid || pid;

const lock = { pid, piPid, startedAt, tag, model, profile, tracePath, supervisorLog };
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

console.log(`запущено: pid ${pid}${piPid ? ` (pi: ${piPid})` : ' (процесс pi не опознан — гасить придётся вручную)'}`);
console.log(`  cwd: ${cwd}`);
console.log(`  профиль: ${profile || settingsFromFile.profile || 'по умолчанию'}`);
console.log(`  trace: ${tracePath}`);
console.log(`  лог надзирателя: ${supervisorLog}`);

// ─── 3. Проверка после старта ─────────────────────────────────────────────────

// Файл сессии pi появляется не при старте, а после ПЕРВОГО ответа модели (каталог создаётся
// сразу — по нему судить нельзя). У холодной 27B на большой задаче это заметно дольше 30 с,
// и прежний срок гасил здоровый прогон. Срок настраивается: --start-timeout <секунд>.
const startTimeout = Number(argv.get('start-timeout') ?? 180) * 1000;
const deadline = Date.now() + startTimeout;
let newSessions = [];
while (Date.now() < deadline) {
  const now = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')) : [];
  newSessions = now.filter(f => !before.includes(f));
  if (newSessions.length >= 1) break;
  execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 1500']);
}

const manifest = {
  tag, runId, model, thinking, profile, cwd, startedAt, maxMinutes,
  promptFile: promptFile ?? null,
  tracePath, supervisorLog,
  sessionFiles: newSessions,
  sessionsBefore: before.length,
};
fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

if (newSessions.length === 0) {
  console.error(`ПРОВЕРКА НЕ ПРОШЛА: новая сессия не появилась за ${startTimeout / 1000} с. Гашу прогон.`);
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(killTarget)]); } catch { /* уже мёртв */ }
  fs.rmSync(lockPath, { force: true });
  process.exit(4);
}
if (newSessions.length > 1) {
  console.error(`ПРОВЕРКА НЕ ПРОШЛА: появилось ${newSessions.length} сессии вместо одной — это тот самый дубль. Гашу прогон.`);
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(killTarget)]); } catch { /* уже мёртв */ }
  fs.rmSync(lockPath, { force: true });
  process.exit(5);
}

console.log(`проверка пройдена: ровно одна новая сессия (${newSessions[0]})`);
console.log(`\nсмотреть ход: node bench/status-run.mjs ${runDir}`);
console.log(`остановить:   taskkill /F /T /PID ${killTarget}`);
console.log(`манифест: ${path.join(runDir, 'manifest.json')}`);
