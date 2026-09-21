/**
 * Статус прогона по его каталогу (формат launch-run.mjs).
 *
 *   node bench/status-run.mjs <каталог прогона>
 *
 * Читает манифест, trace, лог надзирателя и lock; отдельно проверяет, что сессия в каталоге
 * ровно одна (иначе числам верить нельзя — именно так был испорчен прошлый замер).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Запись файла в bash: heredoc или редирект в НЕ /dev/null и НЕ в файловый дескриптор.
// Без этой проверки «2>/dev/null» и «2>&1» считались правками и порог первой правки врал.
// Запись файла в bash: редирект в файл. Heredoc САМ ПО СЕБЕ записью не является — `python - <<EOF`
// кормит stdin интерпретатору (на этом детектор врал: 13 «правок» на этапе разведки).
function isBashWrite(cmd) {
  // Считаем записью, только если цель редиректа похожа на имя файла (буквы, цифры, . @ + - /).
  // Тогда sed-выражения вида s/.*<\/version>.*/ и «2>/dev/null» больше не дают ложных правок.
  const re = /(?<![0-9])>>?\s*(?:'([^']+)'|"([^"]+)"|(\/?(?:[\w.@+-]+\/)*[\w.@+-]+))/g;
  for (const m of cmd.matchAll(re)) {
    const target = m[1] ?? m[2] ?? m[3] ?? '';
    if (!target || target.startsWith('/dev/') || /^&[12]$/.test(target)) continue;
    if (!/^[\w.@+\/-]{2,}$/.test(target) || !/[.\/]/.test(target)) continue;
    return true;
  }
  return false;
}

// Запуск сборки — именно ВЫЗОВ, а не упоминание. «chmod +x gradlew», «ls gradle» и URL
// с «gradle» в имени — не сборка (на этом детектор уже один раз соврал).
function isBuildCmd(cmd) {
  // Вызов в позиции команды. После имени обязана идти задача или флаг (либо ничего — тогда
  // Gradle берёт задачу по умолчанию). Без этого «gradlew /tmp/файл .» считался сборкой.
  if (/(^|[;&|]\s*)(\.\/|[\w.@-]*[\\/])?gradlew(\.bat)?(\s+[-:a-zA-Z]|\s*$)/m.test(cmd)) return true;
  // ИЛИ оборот «gradlew <задача>» в любом месте строки — так выглядит запуск через оболочку:
  // cmd //c "gradlew.bat :shared:compileKotlinJvm …". Без этого правила сборка не виделась
  // (реальный случай в прогоне kmp_nudge: сборка была на 28:45, а детектор её не нашёл).
  if (/(^|[;&|"'\s])gradlew(\.bat)?\s+[:a-zA-Z]/.test(cmd)) return true;
  return /(^|[;&|]\s*)gradle\s+[:a-zA-Z]/.test(cmd);
}

const runDir = process.argv[2];
if (!runDir || !fs.existsSync(runDir)) { console.log('укажи каталог прогона'); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
const cwd = manifest.cwd;
const CTX = Number(process.env.PI_RUN_CTX ?? 102400);

const lock = (() => { try { return JSON.parse(fs.readFileSync(path.join(cwd, '.pi', 'run.lock'), 'utf8')); } catch { return null; } })();
// Живость по PID ненадёжна: у nohup $! указывает на оболочку, а не на pi. Поэтому
// считаем прогон живым, если свежий трейс или свежий файл сессии.
const fresh = (p, sec = 120) => { try { return Date.now() - fs.statSync(p).mtimeMs < sec * 1000; } catch { return false; } };
const pidAlive = (() => { if (!lock?.pid) return false; try { process.kill(lock.pid, 0); return true; } catch { return false; } })();
// Итоговый признак живости: свежий трейс или свежий файл сессии (PID из lock ненадёжен).
// Каталог сессий нужен и для проверки живости, и для счёта сессий — объявляем до обоих,
// иначе завершённый прогон валил статус: «Cannot access 'sessionsDir' before initialization».
const sessionsDir = path.join(os.homedir(), '.pi', 'agent', 'sessions', `--${cwd.replace(/[\\:]/g, '-')}--`);

const alive = (() => {
  if (fresh(manifest.tracePath)) return true;
  const sessPath = (manifest.sessionFiles ?? []).map(f => path.join(sessionsDir, f)).find(p => fs.existsSync(p));
  return sessPath ? fresh(sessPath) : pidAlive;
})();

// ─── сессии ───────────────────────────────────────────────────────────────────
const sessions = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')) : [];

// ─── trace ────────────────────────────────────────────────────────────────────
const raw = fs.existsSync(manifest.tracePath) ? fs.readFileSync(manifest.tracePath, 'utf8') : '';
const lines = raw.split(/\r?\n/).filter(l => l.trim().startsWith('{'));
const calls = {};
let turns = 0;
let ctxPeak = 0;
let out = 0;
let errors = 0;
let writes = 0;
let bashWrites = 0;
let finished = false;
let lastText = '';
const recent = [];
const builds = [];

for (const line of lines) {
  let j;
  try { j = JSON.parse(line); } catch { continue; }
  if (j.type === 'agent_end') finished = true;
  if (j.type === 'turn_end') turns += 1;
  if (j.type === 'tool_execution_start') {
    calls[j.toolName] = (calls[j.toolName] ?? 0) + 1;
    if (j.toolName === 'write' || j.toolName === 'edit') writes += 1;
    const cmd = String(j.args?.command ?? '');
    if (j.toolName === 'bash') {
      if (isBashWrite(cmd)) bashWrites += 1;
      if (isBuildCmd(cmd)) builds.push(cmd.replace(/\s+/g, ' ').slice(0, 110));
    }
    recent.push(`${j.toolName} ${JSON.stringify(j.args ?? {}).slice(0, 80)}`);
    if (recent.length > 6) recent.shift();
  }
  if (j.type === 'tool_execution_end' && j.isError) errors += 1;
  const u = j.message?.usage;
  if (u) {
    if ((u.totalTokens ?? 0) > ctxPeak) ctxPeak = u.totalTokens;
    out += u.output ?? 0;
  }
  if (j.message?.role === 'assistant' && Array.isArray(j.message.content)) {
    const t = j.message.content.filter(p => p.type === 'text').map(p => p.text).join(' ').trim();
    if (t) lastText = t;
  }
}

// ─── надзиратель ──────────────────────────────────────────────────────────────
const supPath = path.join(runDir, 'supervisor.log');
const supKinds = {};
let autoVerify = [];
if (fs.existsSync(supPath)) {
  for (const m of fs.readFileSync(supPath, 'utf8').matchAll(/\{\"at\":\"[^\"]+\",\"kind\":\"([a-z_]+)\"(.*)\}/g)) {
    supKinds[m[1]] = (supKinds[m[1]] ?? 0) + 1;
    if (m[1] === 'auto_verify_end') autoVerify.push(m[2].slice(1, 160));
  }
}

// ─── скорость ─────────────────────────────────────────────────────────────────
let interval = null;
try {
  const m = execFileSync('curl', ['-s', '-m', '5', `http://127.0.0.1:8080/metrics?model=${manifest.model.split('/').pop()}`], { encoding: 'utf8' });
  const num = n => { const r = new RegExp(`^llamacpp:${n} ([0-9.e+]+)$`, 'm').exec(m); return r ? Number(r[1]) : null; };
  const snapPath = path.join(runDir, 'metrics-snapshot.json');
  const now = { at: Date.now(), prompt: num('prompt_tokens_total'), predicted: num('tokens_predicted_total') };
  if (fs.existsSync(snapPath)) {
    const prev = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    const dt = (now.at - prev.at) / 1000;
    if (dt > 5 && now.predicted !== null && prev.predicted !== null) interval = { seconds: Math.round(dt), pp: (now.prompt - prev.prompt) / dt, tg: (now.predicted - prev.predicted) / dt };
  }
  fs.writeFileSync(snapPath, JSON.stringify(now));
} catch { /* сервер не ответил */ }

// ─── файлы проекта ────────────────────────────────────────────────────────────
let changed = [];
try {
  changed = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
} catch { /* не git */ }

const hhmm = s => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
const started = new Date(lock?.startedAt ?? manifest.startedAt).getTime();
const elapsed = Math.round((Date.now() - started) / 1000);

console.log('=== ПРОГОН ===');
// Валидность прогона: без ответов модели он не состоялся, даже если код выхода 0.
// (`pi -p` молча возвращает 0, когда эндпоинт мёртв — найденный дефект измерения.)
const toolCalls = Object.values(calls).reduce((a, b) => a + b, 0);
const envFile = path.join(runDir, 'environment.json');
const envInfo = fs.existsSync(envFile) ? JSON.parse(fs.readFileSync(envFile, 'utf8')) : null;
if (turns === 0 || (toolCalls === 0 && out === 0)) {
  console.log('ВАЛИДНОСТЬ: НЕ СОСТОЯЛСЯ — модель не отвечала (ноль вызовов и ноль генерации)');
  if (!envInfo) console.log('  (нет environment.json — прогон старше защиты от мёртвой модели)');
} else {
  console.log(`ВАЛИДНОСТЬ: ок${envInfo ? ` | модель: ${envInfo.model} по ${envInfo.routerUrl}` : ' | модель: не зафиксирована'}`);
}
console.log(`состояние: ${finished ? 'завершён' : alive ? 'работает' : 'процесса нет'}${alive && lock?.pid ? ` (lock pid ${lock.pid}${pidAlive ? '' : ', но он уже мёртв — живость по трейсу'})` : ''}`);
console.log(`время: ${hhmm(elapsed)} из ${manifest.maxMinutes} мин | ходов: ${turns} | вызовов: ${Object.values(calls).reduce((a, b) => a + b, 0)}`);
console.log(`правок: ${writes} write/edit + ${bashWrites} через bash | ошибок инструментов: ${errors}`);
console.log(`контекст (по usage.totalTokens): ${ctxPeak} из ${CTX} (${((ctxPeak / CTX) * 100).toFixed(1)} %) | сгенерировано: ${out}`);
if (interval) console.log(`за последние ${interval.seconds} с: PP ${interval.pp.toFixed(0)}, TG ${interval.tg.toFixed(1)} ток/с`);
console.log(`инструменты: ${Object.entries(calls).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ') || '—'}`);
console.log(`\nСБОРКИ моделью: ${builds.length ? `${builds.length}` : 'нет'}`);
builds.slice(-3).forEach(b => console.log(`  → ${b}`));
if (autoVerify.length) { console.log(`\nАВТОПРОВЕРКА ОБВЯЗКОЙ: ${autoVerify.length}`); autoVerify.slice(-2).forEach(a => console.log(`  ${a}`)); }

console.log(`\n=== СЕССИИ В КАТАЛОГЕ: ${sessions.length} ${sessions.length === 1 ? '(ок)' : '← ВНИМАНИЕ: дубль, числам верить нельзя'} ===`);

console.log(`\n=== ФАЙЛЫ (git status) ===`);
if (!changed.length) console.log('  изменений нет');
else { console.log(`  записей: ${changed.length}`); changed.slice(0, 10).forEach(c => console.log('   ' + c)); if (changed.length > 10) console.log(`   … ещё ${changed.length - 10}`); }

console.log(`\n=== НАДЗИРАТЕЛЬ ===`);
console.log('  ' + (Object.entries(supKinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ') || 'записей нет'));

console.log(`\n=== ПОСЛЕДНИЕ ДЕЙСТВИЯ ===`);
recent.forEach(r => console.log('  ' + r));
if (lastText) console.log(`\n=== ЧТО ГОВОРИТ МОДЕЛЬ ===\n  ${lastText.replace(/\s+/g, ' ').slice(-300)}`);
