/**
 * Метрики прогона из сессионных файлов pi.
 *
 *   node bench/analyze-sessions.mjs "<каталог сессий>" [минут назад]
 *
 * Почему из сессий, а не из stdout-трейса: при запуске легко получить ДВЕ сессии в одном
 * каталоге (одна команда — два процесса), и тогда stdout-трейс содержит либо одну из них,
 * либо перемешанные. Сессионный файл pi — один на сессию и потому авторитетен.
 * Ровно этот случай и произошёл: в kmp_app_run работали две сессии с одинаковым промптом.
 */

import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const minutes = Number(process.argv[3] ?? 0);
if (!dir || !fs.existsSync(dir)) { console.log('укажи существующий каталог сессий'); process.exit(2); }

const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.jsonl'))
  .map(f => path.join(dir, f))
  .filter(f => minutes === 0 || fs.statSync(f).mtimeMs > Date.now() - minutes * 60000)
  .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);

console.log(`сессий найдено: ${files.length}${minutes ? ` (за последние ${minutes} мин)` : ''}`);
if (files.length > 1 && minutes > 0) {
  console.log('ВНИМАНИЕ: больше одной сессии в одном каталоге — это признак дублирующего запуска.');
  console.log('         Метрики ниже считаются ПО КАЖДОЙ сессии отдельно, смешивать нельзя.');
}

// Сборка = реальная команда Gradle, а не упоминание пути.
const isBuild = cmd => /(^|[\\/\s])gradlew(\.bat)?(\s|$)/.test(cmd) || /(^|[;&|]\s*)gradle\s+[:a-zA-Z]/.test(cmd);

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim().startsWith('{'));
  const tools = {};
  let buildCmds = [];
  let ok = 0;
  let fail = 0;
  let out = 0;
  let ctx = 0;
  let prompt = '';
  let lastText = '';
  let cwd = '';
  const writes = [];

  for (const line of lines) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!cwd && j.cwd) cwd = j.cwd;
    const m = j.message;
    if (!m) continue;
    if (m.role === 'user' && !prompt) {
      prompt = (Array.isArray(m.content) ? m.content : []).map(p => p.text || '').join(' ').replace(/\s+/g, ' ').slice(0, 120);
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type !== 'toolCall') continue;
        tools[p.name] = (tools[p.name] ?? 0) + 1;
        const cmd = String(p.arguments?.command ?? '');
        if (p.name === 'bash' && isBuild(cmd)) buildCmds.push(cmd.replace(/\s+/g, ' ').slice(0, 120));
        if (p.name === 'write' || p.name === 'edit') writes.push(String(p.arguments?.path ?? ''));
      }
      const text = m.content.filter(p => p.type === 'text').map(p => p.text).join(' ').trim();
      if (text) lastText = text;
    }
    if (m.usage) {
      out += m.usage.output || 0;
      if ((m.usage.totalTokens || 0) > ctx) ctx = m.usage.totalTokens;
    }
    if (m.role === 'toolResult') {
      const t = JSON.stringify(m.content || '');
      if (/BUILD SUCCESSFUL/.test(t)) ok += 1;
      if (/BUILD FAILED/.test(t)) fail += 1;
    }
  }

  const started = files.length ? new Date(fs.statSync(file).birthtimeMs).toTimeString().slice(0, 8) : '?';
  console.log(`\n──── сессия ${path.basename(file).slice(20, 31)} ────`);
  console.log(`  старт: ${started} | cwd: ${cwd || '?'}`);
  console.log(`  промпт: ${prompt || '?'}`);
  console.log(`  инструменты: ${Object.entries(tools).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log(`  команд сборки: ${buildCmds.length} | BUILD SUCCESSFUL: ${ok} | BUILD FAILED: ${fail}`);
  buildCmds.slice(0, 3).forEach(c => console.log(`    → ${c}`));
  console.log(`  правок файлов: ${writes.length} | сгенерировано: ${out} | пик контекста: ${ctx}`);
  console.log(`  последний текст: ${lastText.replace(/\s+/g, ' ').slice(-200)}`);
}

// Общий вердикт по каталогу
console.log('\n──── итог ────');
console.log(files.length > 1
  ? `  В каталоге работали ${files.length} сессии одновременно — прогон недействителен как A/B, числа смешаны.`
  : '  Одна сессия — замер можно использовать.');
