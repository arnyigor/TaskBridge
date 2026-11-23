// Быстрая проверка статики, которую не видит ESLint:
//   • JS-комментарии `//` внутри CSS (по спецификации CSS они ломают СЛЕДУЮЩЕЕ
//     правило — именно так сломался `.imageSpoiler`, 2026-11-18);
//   • дисбаланс <div> в HTML (два лишних закрывающих ломали flex-раскладку чата).
//
// Это дешёвый гейт: секунда вместо разбора «почему чат поехал». Запускается из
// `npm run lint`, а тот — из `npm run check` (то же, что гоняет CI).
import fs from 'node:fs/promises';
import path from 'node:path';

const webDir = path.resolve('web');
const errors = [];

const entries = await fs.readdir(webDir, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isFile()) continue;
  const name = entry.name;
  const file = path.join(webDir, name);

  if (name.endsWith('.css')) {
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, idx) => {
      // `//` в CSS не комментарий: браузер выбрасывает строку, а вместе с ней —
      // правило, к которому она приклеена. Допускаем только URL-схему в строке.
      if (/^\s*\/\//.test(line)) {
        errors.push(`web/${name}:${idx + 1}: недопустимый JS-комментарий "//" в CSS`);
      }
    });
  }

  if (name.endsWith('.html')) {
    const raw = await fs.readFile(file, 'utf8');
    // HTML-комментарии не считаются: в них бывают примеры разметки.
    const clean = raw.replace(/<!--[\s\S]*?-->/g, '');
    let depth = 0;
    clean.split(/\r?\n/).forEach((line, idx) => {
      depth += (line.match(/<div\b/gi) || []).length;
      depth -= (line.match(/<\/div\s*>/gi) || []).length;
      if (depth < 0) {
        errors.push(`web/${name}:${idx + 1}: лишний закрывающий </div> (depth=${depth})`);
        depth = 0;
      }
    });
    if (depth !== 0) errors.push(`web/${name}: незакрытые <div> (остаток depth=${depth})`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('check-static: ok');
