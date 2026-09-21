/**
 * Smoke шага 4: сквозной путь наблюдение → классификация → метрика, на РЕАЛЬНОМ каталоге.
 *
 *   node bench/test-artifact-flow.mjs
 *
 * Зачем отдельно от test-observer (шаг 3) и от юнита на строках (test-state, секция 6):
 * те проверяют слои по отдельности, а ломается обычно стык. Вопрос здесь ровно один:
 * «когда метрика firstProjectArtifact говорит ДА и на каком файле» — и ответ получается
 * из настоящих файловых событий, а не из заранее подсунутого списка путей.
 *
 * Правило разделения, которое тест обязан удержать:
 *   observer врать не имеет права (любой новый путь — факт, включая `nul` и build/*);
 *   классификатор решает, что это значит;
 *   метрика открывается ТОЛЬКО на created ∧ PROJECT.
 *
 * Функции вырезаются из bench/supervisor.ts и исполняются как есть (lib-ts-extract.mjs).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTsTypes, grabFunction } from './lib-ts-extract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'supervisor.ts'), 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ок  ' : 'ОШИБКА'}    ${name}${detail ? `  — ${detail}` : ''}`);
};

// Пустая строка вместо не найденной константы дала бы молчаливый ноль: всё стало бы OTHER,
// метрика не открылась бы никогда, и тест «прошёл» бы ни на чём. Поэтому — громкий отказ.
const need = re => {
  const m = src.match(re);
  if (!m) throw new Error(`не найдено в supervisor.ts: ${re}`);
  return m[0];
};
const api = new Function('fs', 'path', `${stripTsTypes([
  need(/const PROJECT_FILE_RE = [^\n]+;/),
  need(/const PROJECT_FILE_NAMES = [^\n]+;/),
  need(/const HARNESS_DIRS = [^\n]+;/),
  need(/const GENERATED_DIRS = [^\n]+;/),
  need(/const RESEARCH_DIRS = [^\n]+;/),
  grabFunction(src, 'snapshotTree'),
  grabFunction(src, 'diffSnapshot'),
  grabFunction(src, 'isProjectFile'),
  grabFunction(src, 'classifyArtifact'),
].join('\n'))}; return { snapshotTree, diffSnapshot, classifyArtifact };`)(fs, path);

const tmp = 'C:/temp/artifact-flow-smoke';
const write = (rel, text = 'x') => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

// Мини-модель того, что делает syncWorkspace в надзирателе: шаг за шагом снимок → дельта →
// классы → метрика. Тот же порядок и те же функции, что в живом коде.
function runSteps(steps) {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  if (steps.baseline) steps.baseline();
  let snapshot = api.snapshotTree(tmp);
  const baselineSize = snapshot.size;
  const project = new Set();
  const research = new Set();
  const seenCreated = [];
  let first = null;
  steps.actions.forEach((act, i) => {
    const step = i + 1;
    act();
    const after = api.snapshotTree(tmp);
    const d = api.diffSnapshot(snapshot, after);
    snapshot = after;
    seenCreated.push(...d.created);
    for (const p of [...d.created, ...d.modified]) {
      const { cls } = api.classifyArtifact(p);
      if (cls === 'PROJECT') project.add(p);
      else if (cls === 'RESEARCH') research.add(p);
    }
    for (const p of d.deleted) { project.delete(p); research.delete(p); }
    if (first === null) {
      const hit = d.created.find(p => api.classifyArtifact(p).cls === 'PROJECT');
      if (hit) first = { path: hit, step, reason: api.classifyArtifact(hit).reason };
    }
  });
  return { first, project: [...project], research: [...research], seenCreated, baselineSize };
}

// ─── A. Разведка, потом исходник: метрика открывается на исходнике ──────────
console.log('\nA. Разведка → черновик → исходник');
{
  const r = runSteps({
    actions: [
      () => write('.research/notes.md', '# плен'),          // шаг 1: черновик
      () => write('nul'),                                   // шаг 2: артефакт `> nul` из bash
      () => write('.pi/harness.json', '{}'),                // шаг 3: файл самой упряжки
      () => write('src/main/kotlin/App.kt', 'fun main(){}'),// шаг 4: первый настоящий исходник
    ],
  });
  check('observer увидел все 4 пути (включая nul)', r.seenCreated.length === 4, r.seenCreated.join(', '));
  check('метрика открылась на шаге 4, а не на 1–3', r.first?.step === 4, JSON.stringify(r.first));
  check('и именно на исходнике', r.first?.path === 'src/main/kotlin/App.kt', r.first?.reason);
  check('черновик посчитан отдельно, а не как проект', r.research.length === 1 && r.project.length === 1,
    `research=${r.research.length} project=${r.project.length}`);
  check('nul и .pi не попали ни в один счётчик',
    !r.project.includes('nul') && !r.research.includes('nul') && !r.project.some(p => p.startsWith('.pi/')), '');
}

// ─── B. Вывод сборки не открывает метрику ───────────────────────────────────
console.log('\nB. Каталог сборки с проектными расширениями');
{
  const r = runSteps({
    actions: [
      () => { write('build/tmp/kotlin/Gen.kt'); write('build/libs.versions.toml'); },
      () => write('app/build.gradle.kts', 'plugins {}'),
    ],
  });
  check('build/* виден наблюдателю', r.seenCreated.some(p => p.startsWith('build/')), r.seenCreated.join(', '));
  check('но метрику открыл только app/build.gradle.kts на шаге 2',
    r.first?.step === 2 && r.first?.path === 'app/build.gradle.kts', JSON.stringify(r.first));
}

// ─── C. Распакованный шаблон: всё было в baseline ───────────────────────────
console.log('\nC. Шаблон существовал ДО прогона');
{
  const r = runSteps({
    baseline: () => { write('template/settings.gradle.kts'); write('template/src/Main.kt'); },
    actions: [
      () => fs.readFileSync(path.join(tmp, 'template/src/Main.kt'), 'utf8'), // модель только читает
    ],
  });
  check('baseline снят (2 файла)', r.baselineSize === 2, String(r.baselineSize));
  check('чтение не создаёт артефакт — метрика молчит', r.first === null, JSON.stringify(r.first));
}

// ─── D. Правка существующего файла ≠ первый созданный ───────────────────────
console.log('\nD. Модель правит существующий файл, потом создаёт свой');
{
  const r = runSteps({
    baseline: () => write('src/Old.kt', 'fun old(){}'),
    actions: [
      () => write('src/Old.kt', 'fun old(){ /* правка */ }'),
      () => write('src/New.kt', 'fun neu(){}'),
    ],
  });
  check('правка попала в счётчик проекта', r.project.includes('src/Old.kt'), r.project.join(', '));
  check('но метрика «первый созданный» — на New.kt (шаг 2)',
    r.first?.step === 2 && r.first?.path === 'src/New.kt', JSON.stringify(r.first));
}

// ─── E. Удаление снимает файл со счёта ──────────────────────────────────────
console.log('\nE. Созданный файл удалён');
{
  const r = runSteps({
    actions: [
      () => write('src/Tmp.kt'),
      () => fs.rmSync(path.join(tmp, 'src/Tmp.kt')),
    ],
  });
  check('счётчик проекта вернулся к нулю', r.project.length === 0, r.project.join(', '));
  // Метрика — «когда впервые появился артефакт проекта», это факт прошлого и не отменяется.
  check('но факт первого появления остался (шаг 1)', r.first?.step === 1, JSON.stringify(r.first));
}

// ─── F. Проводка в самом надзирателе ────────────────────────────────────────
// Секции A–E исполняют цикл syncWorkspace ПО ОБРАЗЦУ, а не читают его: подмену
// `classifyArtifact` обратно на `isProjectFile` внутри supervisor.ts они не заметят
// (проверено мутацией). Поэтому — прямая проверка живой строки.
console.log('\nF. Метрика в supervisor.ts идёт через классификатор');
{
  const sync = src.slice(src.indexOf('const syncWorkspace'), src.indexOf('const recomputeWorkspaceState'));
  check('firstProjectArtifact открывается по классу PROJECT',
    /d\.created\.find\(p => classifyArtifact\(p\)\.cls === 'PROJECT'\)/.test(sync), '');
  check('счёт файлов идёт по классам, а не по whitelist напрямую',
    /classifyArtifact\(p\)/.test(sync) && !/isProjectFile\(/.test(sync), '');
}

// ─── G. Веб-задача: единственный .html — это артефакт проекта ───────────────
// Whitelist был чисто JVM-овым. На задаче moon_mission (один .html) мутаций было бы ноль,
// прогресса не было бы никогда, гейт застоя висел бы до конца прогона, а verify-delta
// не открылся бы ни разу — то есть весь замер оказался бы мусором.
console.log('\nG. Веб-задача даёт артефакты проекта');
{
  const r = runSteps({
    actions: [
      () => write('notes.md', 'план'),                 // черновик, не проект
      () => write('mission.html', '<html></html>'),    // собственно результат
      () => write('sim.mjs', 'export const x = 1'),    // скрипт проверки физики
    ],
  });
  check('метрика открылась на .html (шаг 2)', r.first?.step === 2 && r.first?.path === 'mission.html', JSON.stringify(r.first));
  check('.mjs тоже считается проектом', r.project.includes('sim.mjs'), r.project.join(', '));
  // RESEARCH определяется КАТАЛОГОМ (.research/, notes/, scratch/), а не расширением:
  // отдельный notes.md в корне — OTHER. Важно лишь, что он не выдаёт себя за артефакт проекта.
  check('.md не выдаёт себя за артефакт проекта', !r.project.includes('notes.md'), r.project.join(', '));
}

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nстык проверен: наблюдение → класс → метрика');
process.exit(failed ? 1 : 0);
