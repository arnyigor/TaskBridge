// Проверка детектора правок: что считается записью файла, а что — чтением.
// Запуск: node bench/test-write-detect.mjs
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./timeline-run.mjs', import.meta.url), 'utf8');
const start = src.indexOf('function isBashWrite(');
const end = src.indexOf('\n}', start) + 2;
const isBashWrite = new Function(`${src.slice(start, end)}; return isBashWrite;`)();

const cases = [
  ['ls x 2>/dev/null; echo ---', false],
  ['cmd 2>&1 | tail -5', false],
  ['curl -s url | sed -n "s/.*<version>\\([^<]*\\)<\\/version>.*/\\1/p"', false],
  ['grep -o "a>b" file.txt', false],
  ['unzip -l x.zip | tail', false],
  ['curl -o out.html https://x', false],
  ['cat > build.gradle.kts << EOF', true],
  ['echo hi > file.txt', true],
  ['printf x > .gitignore', true],
  ['cat > "local.properties" << EOF', true],
  ['echo x >> settings.gradle.kts', true],
];

let bad = 0;
for (const [cmd, expected] of cases) {
  const got = isBashWrite(cmd);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? 'ок  ' : 'ОШИБКА'}  ${got ? 'ПРАВКА' : 'чтение'}  ${cmd.slice(0, 62)}`);
}
console.log(bad ? `\nпровалено: ${bad} из ${cases.length}` : `\nвсе ${cases.length} случаев верны`);
process.exit(bad ? 1 : 0);
