/**
 * Сравнение двух плеч по их timeline.json.
 *
 *   node bench/compare-arms.mjs <A:timeline.json> <B:timeline.json> [...]
 *
 * Печатает пороги рядом — так видно, что именно дала правка обвязки, а что объясняется
 * разбросом самой модели (он у нас большой: в одном прогоне первая правка на 8-й минуте,
 * в другом её нет и на 20-й).
 */

import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2).filter(f => fs.existsSync(f));
if (files.length < 2) { console.log('укажи минимум два timeline.json'); process.exit(2); }

const rows = files.map(f => {
  const t = JSON.parse(fs.readFileSync(f, 'utf8'));
  const kinds = {};
  for (const e of t.events ?? []) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const nudges = Object.entries(kinds).filter(([k]) => /напоминание/.test(k)).reduce((a, [, v]) => a + v, 0);
  return {
    arm: t.tag ?? path.basename(path.dirname(f)),
    dir: path.basename(t.cwd ?? ''),
    thresholds: t.thresholds ?? {},
    nudges,
    events: (t.events ?? []).length,
    compactions: kinds['компакция'] ?? 0,
    autoVerify: Object.entries(kinds).filter(([k]) => /АВТОПРОВЕРКА/.test(k)).reduce((a, [, v]) => a + v, 0),
  };
});

const cell = (r, key) => (r.thresholds[key] ? `${r.thresholds[key].mmss} (шаг ${r.thresholds[key].step})` : '—');

console.log('СРАВНЕНИЕ ПЛЕЧ');
console.log('  метрика'.padEnd(28) + rows.map(r => (r.arm + ' / ' + r.dir).padEnd(24)).join(''));
console.log('  ' + '─'.repeat(28 + rows.length * 24));
const line = (label, fn) => console.log('  ' + label.padEnd(26) + rows.map(r => String(fn(r)).padEnd(24)).join(''));

line('первая правка', r => cell(r, 'firstEdit'));
line('первая сборка моделью', r => cell(r, 'firstModelBuild'));
line('модель увидела сборку', r => cell(r, 'modelSawBuildResult'));
line('автопроверка обвязкой', r => cell(r, 'firstAutoVerify'));
line('напоминаний всего', r => r.nudges);
line('событий автосборки', r => r.autoVerify);
line('компакций', r => r.compactions);
line('событий в таймлайне', r => r.events);

console.log('\nЧТО ЧИТАТЬ:');
console.log('  • «первая сборка моделью» и «модель увидела сборку» — главные: они показывают,');
console.log('    когда модель получила факт о своём коде, а не догадку;');
console.log('  • «автопроверка обвязкой» — сработал ли механизм (в плече без autoVerify её не будет);');
console.log('  • разница в «первой правке» между плечами — это разброс модели, а не эффект обвязки;');
console.log('    при n=1 по плечу сравнивать по ней нельзя.');
