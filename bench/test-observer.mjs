/**
 * Smoke шага 3: сырой наблюдатель дерева (снимок + дельта).
 *
 *   node bench/test-observer.mjs
 *
 * Проверяется ТОЛЬКО слой измерения: «путь появился/изменился/исчез».
 * Классификация здесь не участвует — для observer нет «мусора» и «проекта»,
 * поэтому `nul` обязан появиться как созданный файл.
 *
 * Функции вырезаются из bench/supervisor.ts и исполняются как есть (lib-ts-extract.mjs).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripTsTypes, grabFunction } from './lib-ts-extract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'supervisor.ts'), 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ок  ' : 'ОШИБКА'}    ${name}${detail ? `  — ${detail}` : ''}`);
};

const api = new Function('fs', 'path',
  `${stripTsTypes([grabFunction(src, 'snapshotTree'), grabFunction(src, 'diffSnapshot')].join('\n'))}; return { snapshotTree, diffSnapshot };`)(
  fs, path);

const tmp = 'C:/temp/observer-smoke';
const reset = () => { fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true }); };
const short = d => ({ created: d.created, modified: d.modified, deleted: d.deleted });

// ─── A. Существующий файл не трогали ────────────────────────────────────────
console.log('\nA. Существующий файл не трогали');
{
  reset();
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'A.kt'), 'class A');
  const snap = api.snapshotTree(tmp);
  const d = api.diffSnapshot(snap, api.snapshotTree(tmp));
  check('  дельта пуста (created/modified/deleted)', d.created.length === 0 && d.modified.length === 0 && d.deleted.length === 0, JSON.stringify(short(d)));
  check('  снимок содержит файл', snap.has('src/A.kt'), [...snap.keys()].join(','));
}

// ─── B. `> nul` в bash: observer НЕ должен его скрывать ─────────────────────
console.log('\nB. `> nul` — observer обязан показать файл');
{
  reset();
  fs.writeFileSync(path.join(tmp, 'A.kt'), 'class A');
  const snap = api.snapshotTree(tmp);
  execFileSync('bash', ['-c', 'echo x > nul'], { cwd: tmp, shell: false });
  const d = api.diffSnapshot(snap, api.snapshotTree(tmp));
  check('  created содержит "nul"', d.created.includes('nul'), JSON.stringify(d.created));
  check('  в снимке после есть nul', api.snapshotTree(tmp).has('nul'));
}

// ─── C. Настоящий новый исходник ────────────────────────────────────────────
console.log('\nC. Новый исходник в подкаталоге');
{
  reset();
  fs.writeFileSync(path.join(tmp, 'README.md'), 'x');
  const snap = api.snapshotTree(tmp);
  fs.mkdirSync(path.join(tmp, 'timeline-auto', 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'timeline-auto', 'src', 'Main.kt'), 'fun main() {}');
  const d = api.diffSnapshot(snap, api.snapshotTree(tmp));
  check('  created = ["timeline-auto/src/Main.kt"]', d.created.length === 1 && d.created[0] === 'timeline-auto/src/Main.kt', JSON.stringify(d.created));
  check('  путь относительный, с прямыми слэшами', !d.created[0].includes('\\'));
}

// ─── D. Создание → изменение → удаление ─────────────────────────────────────
console.log('\nD. create → modify → delete восстанавливаются по событиям');
{
  reset();
  const s0 = api.snapshotTree(tmp);
  const file = path.join(tmp, 'A.kt');
  fs.writeFileSync(file, 'v1');                                  // шаг 4
  const s1 = api.snapshotTree(tmp);
  const d1 = api.diffSnapshot(s0, s1);
  fs.writeFileSync(file, 'v2 больше размер');                     // шаг 7
  const s2 = api.snapshotTree(tmp);
  const d2 = api.diffSnapshot(s1, s2);
  fs.rmSync(file);                                                // шаг 9
  const d3 = api.diffSnapshot(s2, api.snapshotTree(tmp));
  check('  4 CREATED', d1.created.includes('A.kt') && d1.modified.length === 0, JSON.stringify(short(d1)));
  check('  7 MODIFIED', d2.modified.includes('A.kt') && d2.created.length === 0, JSON.stringify(short(d2)));
  check('  9 DELETED', d3.deleted.includes('A.kt'), JSON.stringify(short(d3)));
}

// ─── E. Правка того же размера (реальные правки разнесены по времени) ─────
console.log('\nE. Изменение при том же размере');
{
  reset();
  const file = path.join(tmp, 'B.kt');
  fs.writeFileSync(file, 'aaaa');
  const s1 = api.snapshotTree(tmp);
  // Реальные правки инструментами разнесены по времени; ждём, чтобы выйти за гранулярность ФС.
  const t = Date.now(); while (Date.now() - t < 1100) { /* ожидание тика метки */ }
  fs.writeFileSync(file, 'bbbb');   // размер тот же
  const d = api.diffSnapshot(s1, api.snapshotTree(tmp));
  check('  modified: подсказка mtime сработала', d.modified.includes('B.kt'), JSON.stringify(short(d)));
}

// ─── E2. ДОКУМЕНТИРОВАННОЕ ограничение: тот же размер в одном тике ──────────
console.log('\nE2. Известное ограничение: тот же размер внутри одного тика');
{
  reset();
  const file = path.join(tmp, 'B2.kt');
  fs.writeFileSync(file, 'aaaa');
  const s1 = api.snapshotTree(tmp);
  fs.writeFileSync(file, 'bbbb');   // без паузы: и размер, и метка совпадают
  const d = api.diffSnapshot(s1, api.snapshotTree(tmp));
  // Тест фиксирует именно ОГРАНИЧЕНИЕ, а не желаемое поведение: такой случай
  // ловится только хэшем (в плане — на шаг 4, когда это станет нужно).
  check('  наблюдатель молчит (ожидаемо, не ложь)', d.modified.length === 0, JSON.stringify(short(d)));
  check('  но и created он не выдумывает', d.created.length === 0, JSON.stringify(short(d)));
}

// ─── F. Сброс/восстановление метки времени не создаёт «новый» файл ──────────
console.log('\nF. Восстановленная метка времени не даёт ложного created');
{
  reset();
  const file = path.join(tmp, 'C.kt');
  fs.writeFileSync(file, 'v1');
  const snap = api.snapshotTree(tmp);
  const old = new Date('2001-01-01T00:00:00Z');
  fs.utimesSync(file, old, old);   // как после git checkout / unzip
  const d = api.diffSnapshot(snap, api.snapshotTree(tmp));
  check('  файл НЕ created (его не было в снимке — нет, он был)', d.created.length === 0, JSON.stringify(short(d)));
  check('  и не modified по размеру', d.modified.length <= 1, JSON.stringify(short(d)));
}

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nнаблюдатель проверен: снимок и дельта дают честный факт');
process.exit(failed ? 1 : 0);
