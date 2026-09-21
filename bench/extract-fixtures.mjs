// Извлечение реальных примеров вывода Gradle из сессионных файлов в фикстуры.
// Запуск: node bench/extract-fixtures.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = new URL('./fixtures/', import.meta.url).pathname.replace(/^\//, '');
const sessionsRoot = path.join(os.homedir(), '.pi', 'agent', 'sessions');

const wanted = [
  { name: 'gradle-compile-error.txt', re: /e: file:[^\n]*Unresolved reference/, why: 'ошибки компиляции' },
  { name: 'gradle-resolution.txt', re: /Could not resolve|Could not find/, why: 'не разрешаются зависимости' },
  { name: 'gradle-environment.txt', re: /SDK location not found|ANDROID_SDK_ROOT/, why: 'проблема окружения' },
];

for (const dir of fs.readdirSync(sessionsRoot)) {
  const full = path.join(sessionsRoot, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  for (const file of fs.readdirSync(full)) {
    if (!file.endsWith('.jsonl')) continue;
    const lines = fs.readFileSync(path.join(full, file), 'utf8').split(/\r?\n/).filter(l => l.trim().startsWith('{'));
    for (const w of wanted) {
      if (fs.existsSync(path.join(OUT, w.name))) continue;
      for (const line of lines) {
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        const m = j.message;
        if (m?.role !== 'toolResult') continue;
        const text = (m.content || []).map(p => p.text || '').join('\n');
        if (w.re.test(text) && text.length > 80) {
          fs.writeFileSync(path.join(OUT, w.name), text);
          console.log(`сохранено ${w.name} (${text.length} символов) — ${w.why}`);
          break;
        }
      }
    }
  }
}

for (const w of wanted) {
  const p = path.join(OUT, w.name);
  console.log(fs.existsSync(p) ? `есть: ${w.name}` : `НЕ НАЙДЕНО в сессиях: ${w.name} (${w.why})`);
}
