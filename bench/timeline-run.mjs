/**
 * Таймлайн прогона: на какой минуте что произошло — пороги срабатывания.
 *
 *   node bench/timeline-run.mjs <каталог прогона>
 *
 * Данные берём из СЕССИОННОГО файла pi, а не из stdout-трейса: в трейсе у tool-событий нет
 * меток времени (первая версия показывала «первая правка — 00:01 (шаг 29)»), а в сессии
 * timestamp есть у каждого сообщения и каждого вызова инструмента. Плюс сессионный файл —
 * один на сессию, поэтому он не смешивает дублирующие запуски.
 *
 * Пороги, которые фиксируем: первая правка, первая сборка моделью, автопроверка обвязкой и
 * ключевой для A/B — когда модель ВПЕРВЫЕ увидела результат сборки.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Запись файла в bash: heredoc или редирект в существующий по виду файл (не /dev/null, не fd).
// Запись файла в bash: редирект в файл. Heredoc САМ ПО СЕБЕ записью не является — `python - <<EOF`
// кормит stdin интерпретатору (на этом детектор врал: 13 «правок» на этапе разведки).
function isBashWrite(cmd) {
  const re = /(?<![0-9])>>?\s*(?:'([^']+)'|"([^"]+)"|(\/?(?:[\w.@+-]+\/)*[\w.@+-]+))/g;
  for (const m of cmd.matchAll(re)) {
    const target = m[1] ?? m[2] ?? m[3] ?? '';
    if (!target || target.startsWith('/dev/') || /^&[12]$/.test(target)) continue;
    if (!/^[\w.@+\/-]{2,}$/.test(target) || !/[.\/]/.test(target)) continue;
    return true;
  }
  return false;
}

// Запуск сборки — именно ВЫЗОВ, а не упоминание: «chmod +x gradlew», «ls gradle» и URL
// с «gradle» в имени сборкой не считаются (на этом детектор уже один раз соврал).
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

const sessionsDir = path.join(os.homedir(), '.pi', 'agent', 'sessions', `--${manifest.cwd.replace(/[\\:]/g, '-')}--`);
const sessionFile = (manifest.sessionFiles ?? []).map(f => path.join(sessionsDir, f)).find(p => fs.existsSync(p))
  ?? (fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')).map(f => path.join(sessionsDir, f))[0] : null);

if (!sessionFile) { console.log('сессионный файл не найден'); process.exit(2); }

const entries = fs.readFileSync(sessionFile, 'utf8').split(/\r?\n/).filter(l => l.trim().startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
let startMs = entries.find(e => e.timestamp)?.timestamp ?? new Date(manifest.startedAt).getTime();
startMs = typeof startMs === 'string' ? new Date(startMs).getTime() : startMs;

const events = [];
let steps = 0;
let edits = 0;
let modelSawBuild = null;

for (const e of entries) {
  const ts = e.timestamp ? (typeof e.timestamp === 'string' ? new Date(e.timestamp).getTime() : e.timestamp) : startMs;

  if (e.type === 'compaction') {
    events.push({ ts, steps, edits, kind: 'компакция', detail: `${e.tokensBefore ?? '?'} → ${e.estimatedTokensAfter ?? '?'}` });
    continue;
  }
  const m = e.message;
  if (!m) continue;

  if (m.role === 'assistant' && Array.isArray(m.content)) {
    for (const p of m.content) {
      if (p.type !== 'toolCall') continue;
      steps += 1;
      const cmd = String(p.arguments?.command ?? '');
      if (p.name === 'write' || p.name === 'edit') {
        edits += 1;
        events.push({ ts, steps, edits, kind: 'правка файла', detail: `${p.name} ${String(p.arguments?.path ?? '').split(/[\\/]/).pop() ?? ''}`.trim() });
      } else if (p.name === 'bash') {
        if (isBashWrite(cmd)) { edits += 1; events.push({ ts, steps, edits, kind: 'правка через bash', detail: cmd.replace(/\s+/g, ' ').slice(0, 70) }); }
        if (isBuildCmd(cmd)) events.push({ ts, steps, edits, kind: 'СБОРКА моделью', detail: cmd.replace(/\s+/g, ' ').slice(0, 90) });
      }
    }
  }

  if (m.role === 'toolResult') {
    const text = JSON.stringify(m.content ?? '');
    if (!modelSawBuild && /BUILD (SUCCESSFUL|FAILED)/.test(text)) {
      modelSawBuild = { ts, steps, edits, kind: 'модель УВИДЕЛА результат сборки', detail: /BUILD SUCCESSFUL/.test(text) ? 'успех' : 'падение' };
      events.push(modelSawBuild);
    }
  }
}

// События надзирателя: у них своя метка `at` и счётчики.
const supPath = path.join(runDir, 'supervisor.log');
if (fs.existsSync(supPath)) {
  for (const line of fs.readFileSync(supPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const ts = j.at ? new Date(j.at).getTime() : startMs;
    const base = { ts, steps: j.steps ?? 0, edits: j.edits ?? 0 };
    if (j.kind === 'nudge_stale') events.push({ ...base, kind: 'напоминание: нет правок', detail: `stale=${j.stale ?? '?'}` });
    else if (j.kind === 'nudge_hard') events.push({ ...base, kind: 'напоминание: жёсткое (нет правок)', detail: `stale=${j.stale ?? '?'}` });
    else if (j.kind === 'nudge_repeat') events.push({ ...base, kind: 'напоминание: повтор действия', detail: String(j.tool ?? '') });
    else if (j.kind === 'nudge_verify') events.push({ ...base, kind: 'напоминание: нет проверки', detail: `stale=${j.stale ?? '?'}` });
    else if (j.kind === 'nudge_ast') events.push({ ...base, kind: 'напоминание: используй ast', detail: '' });
    else if (j.kind === 'gate_start' || j.kind === 'auto_verify_start') events.push({ ...base, kind: 'ГЕЙТ обвязкой: запуск сборки/тестов', detail: String(j.args ?? '') });
    else if (j.kind === 'gate_end' || j.kind === 'auto_verify_end') events.push({ ...base, kind: `ГЕЙТ: ${j.verdict ?? j.kind_verdict ?? '?'} (${j.status ?? ''}) ${j.speak ? 'вердикт ОЗВУЧЕН' : 'промолчали'} ${j.seconds ?? '?'} с`, detail: '' });
  }
}

events.sort((a, b) => a.ts - b.ts);
const mmss = ms => { const s = Math.max(0, Math.round((ms - startMs) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

console.log(`ТАЙМЛАЙН: ${manifest.tag} (${path.basename(manifest.cwd)})`);
console.log('  время  шаг  правок  событие');
for (const e of events) console.log(`  ${mmss(e.ts)}  ${String(e.steps).padStart(4)}  ${String(e.edits).padStart(6)}  ${e.kind}${e.detail ? `  — ${e.detail}` : ''}`);

const first = re => events.find(e => re.test(e.kind));
const firstEdit = first(/правка/);
const firstBuild = first(/СБОРКА моделью/);
const firstAuto = first(/ГЕЙТ/);
console.log('\nПОРОГИ:');
console.log(`  первая правка:         ${firstEdit ? `${mmss(firstEdit.ts)} (шаг ${firstEdit.steps})` : 'не было'}`);
console.log(`  первая сборка моделью: ${firstBuild ? `${mmss(firstBuild.ts)} (шаг ${firstBuild.steps})` : 'не было'}`);
console.log(`  гейт обвязкой:         ${firstAuto ? `${mmss(firstAuto.ts)} (шаг ${firstAuto.steps})` : 'не было'}`);
console.log(`  модель увидела сборку: ${modelSawBuild ? `${mmss(modelSawBuild.ts)} (шаг ${modelSawBuild.steps})` : 'не видела'}`);

fs.writeFileSync(path.join(runDir, 'timeline.json'), JSON.stringify({
  tag: manifest.tag, cwd: manifest.cwd, sessionFile: path.basename(sessionFile),
  thresholds: {
    firstEdit: firstEdit ? { mmss: mmss(firstEdit.ts), step: firstEdit.steps } : null,
    firstModelBuild: firstBuild ? { mmss: mmss(firstBuild.ts), step: firstBuild.steps } : null,
    firstAutoVerify: firstAuto ? { mmss: mmss(firstAuto.ts), step: firstAuto.steps } : null,
    modelSawBuildResult: modelSawBuild ? { mmss: mmss(modelSawBuild.ts), step: modelSawBuild.steps } : null,
  },
  events: events.map(e => ({ mmss: mmss(e.ts), step: e.steps, edits: e.edits, kind: e.kind, detail: e.detail })),
}, null, 2) + '\n');
console.log(`\nсохранено: ${path.join(runDir, 'timeline.json')}`);
