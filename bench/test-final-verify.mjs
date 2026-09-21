/**
 * Smoke шага 7: попытка закончить работу с непроверенным деревом.
 *
 *   node bench/test-final-verify.mjs
 *
 * Гипотеза ровно одна и самая прямая — исходная патология замера: 36 правок, 0 проверок,
 * завершение. Условие тоже одно:
 *
 *   lastProjectMutationSeq > lastSuccessfulVerifySeq
 *
 * Сравнение ПОРЯДКА, а не флаг «проверка когда-то была»: зелёный baseline до правки ничего
 * не говорит о состоянии после неё. И только УСПЕШНАЯ проверка снимает грязь — упавшая
 * закрывает write burst, но дерево чистым не делает.
 *
 * Как и в шаге 6, исполняется настоящий код supervisor.ts: копия модели пропускала мутации
 * ядра насквозь.
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

const need = re => {
  const m = src.match(re);
  if (!m) throw new Error(`не найдено в supervisor.ts: ${re}`);
  return m[0];
};
const cls = new Function(`${stripTsTypes([
  need(/const PROJECT_FILE_RE = [^\n]+;/),
  need(/const PROJECT_FILE_NAMES = [^\n]+;/),
  need(/const HARNESS_DIRS = [^\n]+;/),
  need(/const GENERATED_DIRS = [^\n]+;/),
  need(/const RESEARCH_DIRS = [^\n]+;/),
  grabFunction(src, 'isProjectFile'),
  grabFunction(src, 'classifyArtifact'),
  grabFunction(src, 'failureKindOf'),
].join('\n'))}; return { classifyArtifact, failureKindOf };`)();

// Живой блок учёта (burst + грязь) + живой разбор дельты из syncWorkspace + живая строка
// turn_finish. Заглушки только у окружения.
function makeRun() {
  const events = [];
  const syncSrc = src.slice(src.indexOf('const syncWorkspace'), src.indexOf('// Метрика первого артефакта'));
  const deltaLoop = syncSrc.slice(syncSrc.indexOf('for (const p of d.created) if'));
  if (!/burstAdd/.test(deltaLoop)) throw new Error('в syncWorkspace не найден разбор дельты');
  const burstBlock = src.slice(src.indexOf('  let burstId = 0;'), src.indexOf('  // Наблюдение дерева'));
  if (!/lastSuccessfulVerifySeq/.test(burstBlock)) throw new Error('учёт грязи не найден в supervisor.ts');
  // Строка turn_finish берётся из живого turn_end, а не переписывается: иначе тест проверял бы
  // собственную формулу вместо production-пути.
  const finishCall = src.match(/record\('turn_finish', \{[\s\S]*?\}\);/)?.[0];
  if (!finishCall) throw new Error('turn_finish не найден в turn_end');

  const made = new Function('classifyArtifact', 'failureKindOf', 'record', 'S', 'steps',
    'projectTouched', 'draftTouched', `
     let seq = 0;
     ${stripTsTypes(burstBlock)}
     function applyDelta(d) { seq += 1; ${deltaLoop} }
     function verify(kind, result) { seq += 1; closeBurst(kind, result); }
     function finish() { seq += 1; ${finishCall} }
     return { applyDelta, verify, finish, verifyResult };`)(
    cls.classifyArtifact, cls.failureKindOf,
    (event, extra) => events.push({ event, ...extra }),
    { blocking: false, shadow: true, editsBeforeVerifyBlock: 4 }, 0, new Set(), new Set());

  return { events, ...made, last: () => events.filter(e => e.event === 'turn_finish').at(-1) };
}
const D = (created = [], modified = [], deleted = []) => ({ created, modified, deleted });

// ─── A. Исходная патология ──────────────────────────────────────────────────
console.log('\nA. Правки без единой проверки → finish');
{
  const r = makeRun();
  r.applyDelta(D(['src/A.kt', 'src/B.kt']));
  r.applyDelta(D([], ['src/A.kt']));
  r.finish();
  check('wouldBlock = true', r.last().wouldBlock === true, JSON.stringify(r.last().wouldBlock));
  check('мутаций с последней успешной проверки = 3', r.last().mutationsSinceSuccessfulVerify === 3, String(r.last().mutationsSinceSuccessfulVerify));
  check('уникальных файлов = 2', r.last().uniqueFilesSinceSuccessfulVerify === 2, String(r.last().uniqueFilesSinceSuccessfulVerify));
}

// ─── B. Проверилась и закончила ─────────────────────────────────────────────
console.log('\nB. Правка → успешная проверка → finish');
{
  const r = makeRun();
  r.applyDelta(D(['src/A.kt']));
  r.verify('bash', 'pass');
  r.finish();
  check('wouldBlock = false', r.last().wouldBlock === false, '');
  check('грязь обнулена', r.last().mutationsSinceSuccessfulVerify === 0, String(r.last().mutationsSinceSuccessfulVerify));
}

// ─── C. Упавшая проверка НЕ делает дерево чистым ────────────────────────────
console.log('\nC. Правка → проверка упала → finish');
{
  const r = makeRun();
  r.applyDelta(D(['src/A.kt']));
  r.verify('bash', 'fail');
  r.finish();
  check('wouldBlock = true', r.last().wouldBlock === true, '');
  check('видно, что последняя проверка была и упала',
    r.last().lastVerificationResult === 'fail' && r.last().lastVerificationSeq > 0, JSON.stringify(r.last().lastVerificationResult));
  check('но успешной не было', r.last().lastSuccessfulVerifySeq === 0, String(r.last().lastSuccessfulVerifySeq));
}

// ─── D. Зелёный baseline ДО правки не засчитывается ─────────────────────────
console.log('\nD. Успешная проверка, потом правка, потом finish');
{
  const r = makeRun();
  r.verify('gate', 'pass');          // зелёный baseline
  r.applyDelta(D([], ['src/Foo.kt']));
  r.finish();
  check('wouldBlock = true (порядок, а не факт наличия проверки)', r.last().wouldBlock === true, '');
  check('мутация позже успешной проверки',
    r.last().lastProjectMutationSeq > r.last().lastSuccessfulVerifySeq,
    `${r.last().lastProjectMutationSeq} > ${r.last().lastSuccessfulVerifySeq}`);
}

// ─── E. Грязь только от PROJECT ─────────────────────────────────────────────
console.log('\nE. Черновики, логи упряжки и вывод сборки дерево не пачкают');
{
  const r = makeRun();
  r.verify('bash', 'pass');
  r.applyDelta(D(['.research/plan.md', '.pi/state.json', 'build/tmp/Gen.kt', 'nul']));
  r.finish();
  check('wouldBlock = false', r.last().wouldBlock === false, JSON.stringify(r.last()));
  const r2 = makeRun();
  r2.verify('bash', 'pass');
  r2.applyDelta(D(['.research/plan.md', 'src/Real.kt']));
  r2.finish();
  check('но один настоящий исходник рядом — пачкает', r2.last().wouldBlock === true, '');
  check('и считается только он', r2.last().mutationsSinceSuccessfulVerify === 1, String(r2.last().mutationsSinceSuccessfulVerify));
}

// ─── F. infra_error не считается успехом ────────────────────────────────────
console.log('\nF. Развалившийся стенд — не доказательство исправности');
{
  const r = makeRun();
  r.applyDelta(D(['src/A.kt']));
  r.verify('bash', r.verifyResult(true, 'FAILURE: Build failed\n> SDK location not found'));
  r.finish();
  check('infra_error оставляет дерево грязным', r.last().wouldBlock === true, r.last().lastVerificationResult);
}

// ─── G. Проводка ────────────────────────────────────────────────────────────
console.log('\nG. Живая проводка');
{
  const turnEnd = src.slice(src.indexOf("pi.on('turn_end'"), src.indexOf("pi.registerCommand('nudge'"));
  // Безусловный вызов, а не просто наличие строки: `if (false) record('turn_finish'...)`
  // проходил проверку на подстроку (поймано мутацией wiring).
  check('turn_finish пишется из живого хука turn_end безусловно',
    /\n\s+record\('turn_finish', \{/.test(turnEnd), '');
  check('условие — сравнение порядка, а не флаг наличия проверки',
    /wouldBlock: lastProjectMutationSeq > lastSuccessfulVerifySeq/.test(turnEnd), '');
  const close = src.slice(src.indexOf('const closeBurst'), src.indexOf('  // Наблюдение дерева'));
  check('грязь снимает только pass', /if \(result === 'pass'\) \{[\s\S]*?dirtyMutations = 0;/.test(close), '');
  check('final verify не превращён в постоянное условие гейта',
    !/gateConditions[\s\S]{0,400}dirtyMutations/.test(src), '');
  check('final verify ничего не блокирует', !/finalVerify[\s\S]{0,80}block: true/.test(src), '');
}

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nfinal verify: грязный финиш виден, ничего не блокируется');
process.exit(failed ? 1 : 0);
