import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Раннер эталонного бенчмарка: одна команда — весь прогон (модель × обвязка).
//
//   node bench/run-benchmark.mjs --model llama.cpp/qwen-27b-q3 --harness gate
//   node bench/run-benchmark.mjs --model llama.cpp/qwen-27b-text --harness bare --label iq4xs-bare
//
// Что делает по шагам (и почему именно в этом порядке):
//   1. поднимает эмулятор с -wipe-data   — чистая история падений, телефон свободен;
//   2. собирает и ставит дерево          — свежий applicationId на прогон берётся из дерева;
//   3. пре-флайт                         — очистка, база с архивом, настройки с хабом;
//   4. запускает pi с профилем обвязки   — расширения, сужение MCP, промпт версии;
//   5. считает метрики и, если просят, независимо проверяет фикс контрольным сценарием.
//
// Профили обвязки:
//   bare        — ничего (базовая модель, как в первых прогонах);
//   verify      — только инструмент verify;
//   supervisor  — только надзиратель (инъекции);
//   full        — verify + надзиратель (то, что дало работающий фикс);
//   gate        — full + надзиратель ОТНИМАЕТ verify, пока нет ни одной правки.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) argv.set(token.replace(/^--/, ''), true);
  else { argv.set(token.replace(/^--/, ''), next); i += 1; }
}

const MODEL = String(argv.get('model') || 'llama.cpp/qwen-27b-q3');
const HARNESS = String(argv.get('harness') || 'full');
const THINKING = String(argv.get('thinking') || 'medium');
const TREE = path.resolve(String(argv.get('tree') || 'G:/AIModels/LLMBenchmarks/MyTests/habrrss-oom-27bq3-p3'));
const PROMPT = path.resolve(String(argv.get('prompt') || path.join(root, 'bench', 'prompts', 'v4.txt')));
const LABEL = String(argv.get('label') || `${HARNESS}-${String(MODEL).split('/').pop()}`);
const VERIFY_FIX = Boolean(argv.get('verify-fix'));
const WITH_AST = Boolean(argv.get('with-ast'));
const APPEAR = path.join(TREE, 'composeApp', 'build', 'outputs', 'apk', 'debug', 'composeApp-debug.apk');
const LOG = path.join(root, 'data', 'runtime', `run-${LABEL}.jsonl`);
const SUP_LOG = path.join(root, 'data', 'runtime', `supervisor-${LABEL}.log`);
const RUNTIME = path.join(root, 'data', 'runtime');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (file, args, timeout = 900000, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(`${path.basename(file)} ${args.slice(0, 3).join(' ')} → ${error.message}`), { stdout: String(stdout), stderr: String(stderr) }));
    else resolve(String(stdout));
  });
});
const node = (script, args, timeout) => run(process.execPath, [path.join(root, script), ...args], timeout);

function applicationId() {
  const gradle = fs.readFileSync(path.join(TREE, 'composeApp', 'build.gradle.kts'), 'utf8');
  const suffix = gradle.match(/applicationIdSuffix\s*=\s*"([^"]+)"/)?.[1] ?? '';
  const base = gradle.match(/applicationId\s*=\s*"([^"]+)"/)?.[1] ?? 'com.arny.habrrss';
  return `${base}${suffix}`;
}

function harnessArgs() {
  const ext = [];
  const env = {};
  if (HARNESS === 'bare' && !WITH_AST) return { args: [], env };
  if (HARNESS === 'verify' || HARNESS === 'full' || HARNESS === 'gate') ext.push(path.join(here, 'verify-tool.ts'));
  // `--with-ast` добавляет структурный поиск (ast-index) к любому профилю, чтобы
  // эффект инструмента мерился отдельно, а не растворялся в обвязке.
  if (WITH_AST) ext.push(path.join(here, 'ast-tool.ts'));
  if (HARNESS === 'supervisor' || HARNESS === 'full' || HARNESS === 'gate') ext.push(path.join(here, 'supervisor.ts'));
  if (HARNESS !== 'bare') env.BENCH_GATED_TOOLS = 'verify';
  if (HARNESS === 'gate') env.BENCH_GATE = '1';
  const args = [];
  for (const file of ext) args.push('-e', file);
  if (HARNESS !== 'bare') args.push('--mcp-config', path.join(here, 'mcp-bench.json'));
  return { args, env };
}

const APP = applicationId();
console.log(`бенчмарк: модель ${MODEL}, обвязка ${HARNESS}, приложение ${APP}`);
console.log(`  дерево   ${TREE}`);
console.log(`  промпт   ${PROMPT} (${fs.statSync(PROMPT).size} байт)`);

// 1. эмулятор
if (!argv.get('no-emulator')) {
  // Гасим и поднимаем заново: `emulator.mjs --wipe` на уже запущенном устройстве
  // ничего не стирает, и в dropbox остаётся чужая история падений (проверено —
  // пре-флайт это поймал).
  await node('bench/emulator.mjs', ['--kill'], 120000).catch(() => {});
  await node('bench/emulator.mjs', ['--wipe'], 300000).catch(error => { throw new Error(`эмулятор: ${error.message}`); });
}

// 2. сборка и установка
const adb = path.join(process.env.ANDROID_SDK_ROOT || 'G:/Android/SDK', 'platform-tools', 'adb.exe');
// `gradlew.bat` — batch-файл: без шелла spawn падает с EINVAL (проверено), поэтому
// сборка идёт через shell, а adb — напрямую, аргументами (там экранировать нечего).
await run(path.join(TREE, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'),
  [':composeApp:assembleDebug', '--console=plain', '-q'], 900000, { shell: process.platform === 'win32', cwd: TREE });
await run(adb, ['-s', 'emulator-5554', 'install', '-r', APPEAR], 300000);

// 3. пре-флайт
const pre = await node('bench/preflight.mjs', ['--app', APP], 300000).catch(error => error.stdout || error.message);
const preOk = String(pre).includes('пре-флайт пройден');
console.log(preOk ? 'пре-флайт: ок' : `пре-флайт: ПРОБЛЕМЫ\n${String(pre).split('\n').slice(-4).join('\n')}`);

// 4. прогон
fs.rmSync(LOG, { force: true });
fs.rmSync(SUP_LOG, { force: true });
const { args: hArgs, env: hEnv } = harnessArgs();
// Промпт передаётся ЧЕРЕЗ STDIN, а не аргументом: `pi -p` читает его из потока
// (проверено), а многострочный текст в аргументах на Windows роняет spawn (EINVAL).
const out = fs.openSync(LOG, 'w');
const child = spawn('pi', ['-p', '--mode', 'json', '--model', MODEL, '--thinking', THINKING, ...hArgs], {
  cwd: TREE,
  env: { ...process.env, BENCH_APP: APP, BENCH_PROJECT: TREE, BENCH_SCENARIO: path.join(here, 'verify-scenario.mjs'), BENCH_SUPERVISOR_LOG: SUP_LOG, ...hEnv },
  stdio: ['pipe', out, out],
  windowsHide: true,
  shell: process.platform === 'win32'
});
child.stdin.end(fs.readFileSync(PROMPT, 'utf8'));
const started = Date.now();
console.log(`прогон пошёл (${new Date().toISOString().slice(11, 19)}), лог ${LOG}`);
const code = await new Promise(resolve => child.on('close', resolve));
const minutes = (Date.now() - started) / 60000;

// 5. итоги
const metrics = await node('scripts/bench-pi-metrics.mjs', [LOG], 120000).catch(() => '');
const raw = fs.readFileSync(LOG, 'utf8');
const count = re => (raw.match(re) || []).length;
const supervisor = fs.existsSync(SUP_LOG) ? fs.readFileSync(SUP_LOG, 'utf8') : '';
const kinds = [...supervisor.matchAll(/"event":"([a-z_]+)"/g)].map(m => m[1]);
const summary = {
  label: LABEL, model: MODEL, harness: HARNESS, thinking: THINKING, app: APP,
  minutes: Number(minutes.toFixed(1)), exitCode: code,
  edits: count(/"toolName":"(?:edit|write)"/g),
  verifyCalls: count(/"toolName":"verify"/g),
  gateHides: (kinds.filter(k => k === 'gate_hide')).length,
  gateRestores: (kinds.filter(k => k === 'gate_restore')).length,
  nudges: kinds.filter(k => k.startsWith('nudge')).length
};
fs.writeFileSync(path.join(RUNTIME, `summary-${LABEL}.json`), `${JSON.stringify(summary, null, 2)}\n`);

console.log('\n--- итог прогона ---');
for (const [key, value] of Object.entries(summary)) console.log(`  ${key.padEnd(14)} ${value}`);
console.log(metrics.split('\n').filter(l => l.startsWith('-- ')).join('\n'));

if (VERIFY_FIX) {
  // Независимая проверка: тот же стенд, тот же сценарий, но уже с правкой модели
  // в дереве. Ставим текущую сборку и смотрим вердикт устройства.
  await run(adb, ['-s', 'emulator-5554', 'install', '-r', APPEAR], 300000);
  await node('bench/preflight.mjs', ['--app', APP], 300000).catch(() => '');
  const verdict = await node('bench/verify-scenario.mjs', ['--app', APP, '--watch-ms', '60000'], 420000)
    .catch(error => error.stdout || error.message);
  const line = String(verdict).split('\n').find(l => l.startsWith('VERDICT=')) ?? 'VERDICT=?';
  const evidence = String(verdict).split('\n').filter(l => l.trim().startsWith('→')).slice(0, 3);
  console.log(`\n--- независимая проверка фикса ---\n  ${line}`);
  for (const item of evidence) console.log(item);
}
