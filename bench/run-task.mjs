/**
 * Полный цикл одного прогона: сброс → запуск → сторож по времени → архив → оракул → сводка.
 *
 *   node bench/run-task.mjs --cwd <полигон> --prompt-file <файл> --tag BUG1 [--minutes 20]
 *                           [--arm shadow|stagnation|verify-delta|repro] [--oracle anwap|none]
 *
 * Зачем отдельный скрипт, а не команды руками. Ручная последовательность уже стоила потерь:
 *   · `--max-minutes` у launch-run НИ К ЧЕМУ не приводит (поле в манифесте), прогоны
 *     приходилось гасить по часам — один ушёл на 26 минут вместо 25;
 *   · сырой журнал R1 был удалён вместе с полигоном при подготовке следующего прогона,
 *     потому что архивация делалась в конце серии, а не сразу по остановке.
 * Здесь и то, и другое выполняется механически.
 *
 * Плечо A/B задаётся ОДНИМ ключом `--arm`: остальные гейты при этом остаются в shadow.
 * Это и есть требование парного эксперимента — отличается ровно один переключатель.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  if (n === undefined || n.startsWith('--')) argv.set(t.slice(2), true);
  else { argv.set(t.slice(2), n); i += 1; }
}

const cwd = path.resolve(String(argv.get('cwd') ?? ''));
const promptFile = path.resolve(String(argv.get('prompt-file') ?? ''));
const tag = String(argv.get('tag') ?? `run-${Date.now()}`);
const minutes = Number(argv.get('minutes') ?? 20);
const arm = String(argv.get('arm') ?? 'shadow');
const oracle = String(argv.get('oracle') ?? 'anwap');
const model = String(argv.get('model') ?? 'llama.cpp/qwen-27b-q3');
if (!fs.existsSync(cwd) || !fs.existsSync(promptFile)) {
  console.error('нужны --cwd и --prompt-file, оба существующие');
  process.exit(2);
}

const log = (...m) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...m);
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

// ─── 1. Сброс полигона ───────────────────────────────────────────────────────
// Полигон обязан быть в ТОМ ЖЕ состоянии перед каждым прогоном, иначе плечи A и B
// сравнивать нельзя. Отслеживаемые файлы возвращаются из git, мусор прошлого прогона сносится.
log(`сброс полигона ${cwd}`);
sh('git', ['checkout', '--', '.'], { cwd });
for (const junk of ['runs', 'probes', '.pi/run.lock']) fs.rmSync(path.join(cwd, junk), { recursive: true, force: true });
const sessionsDir = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.pi', 'agent', 'sessions',
  `--${cwd.replace(/[\\:]/g, '-')}--`);
fs.rmSync(sessionsDir, { recursive: true, force: true });
const dirty = sh('git', ['status', '--porcelain'], { cwd }).stdout.split('\n').filter(Boolean);
log(`после сброса незакоммиченного: ${dirty.length} (${dirty.slice(0, 3).join('; ') || 'чисто'})`);

// ─── 2. Плечо эксперимента ───────────────────────────────────────────────────
// shadow — наблюдение по всем гейтам. Любое другое значение ВКЛЮЧАЕТ ровно один гейт,
// остальные остаются в тени: A/B требует одного отличия, иначе непонятно, что подействовало.
const env = {
  ...process.env,
  BENCH_ROUTER_URL: process.env.BENCH_ROUTER_URL ?? 'http://127.0.0.1:8090',
  BENCH_BLOCKING: '1',
  BENCH_MAX_NUDGES: '0',          // никаких steer-инъекций: они меняют траекторию
  BENCH_AUTO_VERIFY: '1',
  BENCH_AUTO_VERIFY_RUNS: '1',    // один baseline-прогон: это показание прибора, не помощь
  BENCH_SHADOW: arm === 'shadow' ? '1' : '0',
  BENCH_ENFORCED_GATE: arm,
};
log(`плечо: ${arm}${arm === 'shadow' ? ' (все гейты только наблюдают)' : ' (этот гейт блокирует, остальные в тени)'}`);

// ─── 3. Запуск ───────────────────────────────────────────────────────────────
const launch = sh('node', [path.join(here, 'launch-run.mjs'),
  '--cwd', cwd, '--prompt-file', promptFile, '--model', model,
  '--max-minutes', String(minutes), '--start-timeout', '300', '--tag', tag], { env });
process.stdout.write(launch.stdout ?? '');
if (launch.status !== 0) { console.error(launch.stderr ?? 'запуск не удался'); process.exit(3); }
const piPid = Number(JSON.parse(fs.readFileSync(path.join(cwd, '.pi', 'run.lock'), 'utf8')).piPid ?? 0);

// ─── 4. Сторож по времени ────────────────────────────────────────────────────
// Именно здесь `--minutes` начинает что-то значить: сам прогон не остановится.
const runDir = path.join(cwd, 'runs', tag);
const deadline = Date.now() + minutes * 60 * 1000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
log(`сторож: остановлю в ${new Date(deadline).toTimeString().slice(0, 8)}`);
while (Date.now() < deadline) {
  sh('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 20']);
  if (piPid && !alive(piPid)) { log('прогон завершился сам'); break; }
}
if (piPid && alive(piPid)) {
  log('потолок времени — останавливаю');
  sh('taskkill', ['/F', '/T', '/PID', String(piPid)]);
}
fs.rmSync(path.join(cwd, '.pi', 'run.lock'), { force: true });

// ─── 5. Архив СРАЗУ ──────────────────────────────────────────────────────────
// До всякого анализа и до любых операций с полигоном: сырой журнал одного прогона уже
// был потерян из-за того, что архивация откладывалась.
const archive = path.join(here, 'reports', tag);
fs.mkdirSync(archive, { recursive: true });
for (const f of ['supervisor.log', 'trace.jsonl', 'manifest.json', 'stderr.log']) {
  const src = path.join(runDir, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(archive, f === 'supervisor.log' ? 'supervisor.ndjson' : f));
}
const diff = sh('git', ['diff', '--stat'], { cwd }).stdout;
fs.writeFileSync(path.join(archive, 'model-diff.txt'), `${sh('git', ['status', '--porcelain'], { cwd }).stdout}\n${diff}`);
log(`архив: ${archive}`);

// ─── 6. Оракул ───────────────────────────────────────────────────────────────
let verdict = 'нет оракула';
if (oracle === 'anwap') {
  const r = sh('node', [path.join(here, 'verify-anwap.mjs'), cwd]);
  fs.writeFileSync(path.join(archive, 'oracle.json'), r.stdout ?? '');
  verdict = (r.stdout ?? '').match(/ВЕРДИКТ: (\w+)/)?.[1] ?? 'неизвестно';
}
log(`ОРАКУЛ: ${verdict}`);

// ─── 7. Сводка ───────────────────────────────────────────────────────────────
const summary = sh('node', [path.join(here, 'analyze-run.mjs'), path.join(archive, 'supervisor.ndjson')]);
process.stdout.write(summary.stdout ?? '');
fs.writeFileSync(path.join(archive, 'summary.txt'), `плечо: ${arm}\nоракул: ${verdict}\n\n${summary.stdout ?? ''}`);
// ─── 8. Возврат полигона ─────────────────────────────────────────────────────
// ПОСЛЕ архива и оракула, иначе стирали бы то, что меряем. Сброс только перед прогоном
// оставлял правку модели лежать в каталоге до следующего запуска — её легко принять
// за собственную работу или за исходное состояние проекта.
sh('git', ['checkout', '--', '.'], { cwd });
for (const junk of ['runs', 'probes', '.pi/run.lock']) fs.rmSync(path.join(cwd, junk), { recursive: true, force: true });
const left = sh('git', ['status', '--porcelain'], { cwd }).stdout.split('\n').filter(Boolean);
log(`полигон возвращён: незакоммиченного ${left.length} (${left.slice(0, 2).join('; ') || 'чисто'})`);

log(`готово: ${tag} | плечо ${arm} | оракул ${verdict}`);
