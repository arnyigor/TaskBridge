/**
 * Проверка детектора проекта на РЕАЛЬНЫХ каталогах.
 *
 *   node bench/test-project-detect.mjs
 *
 * Отдельный тест, потому что здесь легко ошибиться незаметно: в плече kmp_auto модель создала
 * проект в подкаталоге `TodoApp/`, а детектор смотрел только в корень — фаза осталась `recon`,
 * автосборка не сработала ни разу, и плечо дало недействительный результат.
 */

import fs from 'node:fs';
import path from 'node:path';
import { stripTsTypes, grabFunction, grabConst } from './lib-ts-extract.mjs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'supervisor.ts'), 'utf8');

const grab = name => grabFunction(src, name);
const strip = stripTsTypes;
const markersLine = grabConst(src, 'MARKERS');
const settingsLine = grabConst(src, 'SETTINGS_MARKERS');
const helper = strip([markersLine, settingsLine, grab('findProjectDirs'), grab('countSources'), grab('projectDir'), grab('buildSystemPresent'), grab('skeletonReady')].join('\n'));

const IGNORED = new Set(['runs', 'build', '.gradle', '.git', 'node_modules', 'out', 'bin', 'dist', 'tmp', '.tmp']);
const f = new Function('fs', 'path', 'IGNORED_DIRS', `${helper}; return { projectDir, skeletonReady, buildSystemPresent };`)(fs, path, IGNORED);
const BASE = 'G:/AIModels/LLMBenchmarks/MyTests';
// Пустой каталог создаём сами: ссылаться на живые полигоны нельзя — их состояние меняется
// от прогона к прогону, и тест начинает ругаться на смену состояния, а не на детектор.
fs.mkdirSync('C:/temp/skel-empty', { recursive: true });
// [каталог, ожидаемый projectDir, ожидаемая «сборка есть», ожидаемый «скелет», пояснение, записи модели]
const cases = [
  [`${BASE}/kmp_auto`, 'TodoApp', true, false, 'проект в подкаталоге, записей модели нет → собирать нельзя (похоже на шаблон)'],
  [`${BASE}/kmp_auto`, 'TodoApp', true, true, 'то же, но модель писала в подкаталог → скелет готов', [`${BASE}/kmp_auto/TodoApp/shared/src/main/kotlin/X.kt`]],
  [`${BASE}/anwap_bug`, '', true, true, 'существующий проект в корне (полигон бага)'],
  [`${BASE}/kmp_app`, null, false, false, 'только zip и доки — проекта нет'],
  ['C:/temp/skel-empty', null, false, false, 'пустой каталог (создаётся тестом — детерминированный случай)'],
  ['G:/nope/nope', null, false, false, 'несуществующий путь'],
];

let bad = 0;
for (const [dir, expectRel, expectBuild, expectSkeleton, why, writes = []] of cases) {
  if (!fs.existsSync(dir)) { console.log(`пропуск (нет каталога): ${dir}`); continue; }
  const d = f.projectDir(dir, writes);
  const rel = d ? (path.relative(dir, d) || '') : null;
  const okDir = expectRel === null ? rel === null : rel === expectRel;
  const okBuild = f.buildSystemPresent(dir, writes) === expectBuild;
  const okSkel = f.skeletonReady(dir, writes) === expectSkeleton;
  const ok = okDir && okBuild && okSkel;
  if (!ok) bad += 1;
  console.log(`${ok ? 'ок    ' : 'ОШИБКА'}  ${path.basename(dir).padEnd(14)} projectDir=${String(rel).padEnd(14)} сборка=${f.buildSystemPresent(dir, writes)} скелет=${f.skeletonReady(dir, writes)}  — ${why}`);
}
console.log(bad ? `\nПРОВАЛЕНО: ${bad}` : '\nдетектор проекта работает на всех реальных каталогах');
process.exit(bad ? 1 : 0);
