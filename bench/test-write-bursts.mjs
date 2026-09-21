/**
 * Smoke шага 6: write burst — мутации ПРОЕКТА между попытками проверки.
 *
 *   node bench/test-write-bursts.mjs
 *
 * Зачем не `editsPerVerify`: среднее прячет хвост. 3,3,3,3 и 1,1,1,13 дают одно и то же
 * среднее и описывают совершенно разное поведение, а гейт нужен ровно против второго.
 *
 * Мутация считается по WorkspaceDelta + класс PROJECT, поэтому burst не зависит от того,
 * чем модель писала — edit, write, bash, python или генератор. Секция E проверяет это на
 * НАСТОЯЩЕЙ файловой системе, секция F — что живой код считает именно так.
 *
 * Кривую P(проверка упала | длина burst) здесь НИКТО не строит: supervisor пишет факты,
 * анализ идёт offline по логу.
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
  grabFunction(src, 'failureKindOf'),
].join('\n'))}; return { snapshotTree, diffSnapshot, classifyArtifact, failureKindOf };`)(fs, path);

// Модель счётчика из supervisor.ts: мутация = путь класса PROJECT из дельты,
// граница burst = ЛЮБАЯ попытка проверки.
// Трекер собирается из НАСТОЯЩЕГО кода supervisor.ts, а не пишется заново: копия модели
// пропускала мутации ядра насквозь (проверено — четыре из шести проходили незамеченными).
// Подставляются только заглушки окружения: record собирает события, S — настройки.
function makeTracker(S = { blocking: false, shadow: true, editsBeforeVerifyBlock: 4 }) {
  const closed = [];
  // Строки, которыми syncWorkspace раскладывает дельту по классам, берутся из живого кода.
  const syncSrc = src.slice(src.indexOf('const syncWorkspace'), src.indexOf('// Метрика первого артефакта'));
  const deltaLoop = syncSrc.slice(syncSrc.indexOf("for (const p of d.created) if"));
  if (!/burstAdd/.test(deltaLoop)) throw new Error('в syncWorkspace не найден разбор дельты по классам');
  const burstBlock = src.slice(src.indexOf('  let burstId = 0;'), src.indexOf('  // Наблюдение дерева'));
  if (!/closeBurst/.test(burstBlock)) throw new Error('блок burst не найден в supervisor.ts');

  const made = new Function('classifyArtifact', 'failureKindOf', 'record', 'S', 'steps', 'seq',
    'projectTouched', 'draftTouched', `${stripTsTypes(burstBlock)}
     function applyDelta(d) { ${deltaLoop} }
     return { applyDelta, closeBurst, verifyResult, peek: () => burst };`)(
    api.classifyArtifact, api.failureKindOf,
    (event, extra) => { if (event === 'write_burst_closed') closed.push(extra); },
    S, 0, 0, new Set(), new Set());

  return {
    closed,
    applyDelta: made.applyDelta,
    verify: (kind, result) => made.closeBurst(kind, result),
    verifyResult: made.verifyResult,
    get open() { return { mutations: made.peek().mutations, uniqueFiles: made.peek().files.size }; },
  };
}
const D = (created = [], modified = [], deleted = []) => ({ created, modified, deleted });

// ─── A. Простой burst ───────────────────────────────────────────────────────
console.log('\nA. Три мутации → падение');
{
  const t = makeTracker();
  t.applyDelta(D(['src/A.kt']));
  t.applyDelta(D([], ['src/A.kt']));
  t.applyDelta(D(['src/B.kt']));
  t.verify('bash', 'fail');
  check('mutations=3', t.closed[0].mutations === 3, String(t.closed[0].mutations));
  check('result=fail', t.closed[0].verification.result === 'fail', '');
}

// ─── B. Один файл правится многократно ──────────────────────────────────────
console.log('\nB. Один файл, три правки');
{
  const t = makeTracker();
  for (let i = 0; i < 3; i += 1) t.applyDelta(D([], ['src/Foo.kt']));
  t.verify('bash', 'pass');
  const c = t.closed[0];
  // Два счётчика намеренно РАЗНЫЕ: «20 правок одного файла» и «20 файлов по правке» —
  // разные режимы риска. Какой из них предскажет падение, решат данные, а не мы сейчас.
  check('mutations=3, но uniqueFiles=1', c.mutations === 3 && c.uniqueFiles === 1, `${c.mutations}/${c.uniqueFiles}`);
}

// ─── C. Generated / research / harness не считаются ─────────────────────────
console.log('\nC. В burst попадает только PROJECT');
{
  const t = makeTracker();
  // `build/tmp/Gen.kt`, а не `build/A.class`: разделяет классификатор только файл с ПРОЕКТНЫМ
  // расширением внутри каталога сборки. `.class` отсеялся бы и без каталогов — такой случай
  // пропустил бы поломку GENERATED_DIRS (проверено мутацией).
  t.applyDelta(D(['src/A.kt', 'build/tmp/Gen.kt', 'build/A.class', '.research/x.md', '.pi/log.json', 'nul', 'src/B.kt']));
  t.verify('bash', 'pass');
  const c = t.closed[0];
  check('mutations=2, uniqueFiles=2', c.mutations === 2 && c.uniqueFiles === 2, `${c.mutations}/${c.uniqueFiles}`);
}

// ─── D. Упавшая проверка ТОЖЕ закрывает burst ───────────────────────────────
console.log('\nD. FAIL закрывает отрезок (критический случай)');
{
  const t = makeTracker();
  t.applyDelta(D(['src/A.kt', 'src/B.kt', 'src/C.kt']));
  t.verify('bash', 'fail');
  t.applyDelta(D(['src/D.kt', 'src/E.kt']));
  t.verify('bash', 'pass');
  check('два наблюдения, а не одно', t.closed.length === 2, String(t.closed.length));
  check('burst1=3 FAIL', t.closed[0].mutations === 3 && t.closed[0].verification.result === 'fail', '');
  check('burst2=2 PASS', t.closed[1].mutations === 2 && t.closed[1].verification.result === 'pass', '');
}

// ─── D2. Падение стенда ≠ падение кода ──────────────────────────────────────
console.log('\nD2. Поломка окружения не вешается на длину burst');
{
  const t = makeTracker();
  const infra = 'FAILURE: Build failed\n> SDK location not found. Define location with sdk.dir';
  const code = 'FAILURE: Build failed\ne: file:///src/A.kt:3:1 unresolved reference';
  check('нет SDK → infra_error', t.verifyResult(true, infra) === 'infra_error', t.verifyResult(true, infra));
  check('ошибка компиляции → fail', t.verifyResult(true, code) === 'fail', t.verifyResult(true, code));
  check('успех → pass', t.verifyResult(false, '') === 'pass', '');
}

// ─── D3. Правый цензор при включённой блокировке ────────────────────────────
console.log('\nD3. Burst, упёршийся в работающий гейт, помечен цензором');
{
  // Прогон С блокировкой: длина burst ограничена сверху самим порогом, и выводить из такого
  // распределения новый K нельзя. Пометка обязана быть в логе, а не в голове аналитика.
  const enforced = makeTracker({ blocking: true, shadow: false, editsBeforeVerifyBlock: 4 });
  enforced.applyDelta(D(['src/A.kt', 'src/B.kt', 'src/C.kt', 'src/D.kt']));
  enforced.verify('bash', 'fail');
  check('4 мутации при включённом гейте → censored', enforced.closed[0].censored === true, JSON.stringify(enforced.closed[0].censored));

  const shadow = makeTracker();
  shadow.applyDelta(D(['src/A.kt', 'src/B.kt', 'src/C.kt', 'src/D.kt']));
  shadow.verify('bash', 'fail');
  check('те же 4 мутации в shadow → не censored', shadow.closed[0].censored === false, '');

  const short = makeTracker({ blocking: true, shadow: false, editsBeforeVerifyBlock: 4 });
  short.applyDelta(D(['src/A.kt']));
  short.verify('bash', 'pass');
  check('короткий burst под гейтом цензором не помечен', short.closed[0].censored === false, '');
}

// ─── E. Запись из bash — на настоящей файловой системе ──────────────────────
console.log('\nE. `echo > file` даёт мутацию без edit/write');
{
  const tmp = 'C:/temp/burst-smoke';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  let snap = api.snapshotTree(tmp);
  const t = makeTracker();
  execFileSync('bash', ['-lc', 'echo "fun main(){}" > src/New.kt && echo x > nul'], { cwd: tmp });
  const after = api.snapshotTree(tmp);
  t.applyDelta(api.diffSnapshot(snap, after));
  snap = after;
  t.verify('bash', 'fail');
  const c = t.closed[0];
  check('shell-запись засчитана', c.mutations === 1 && c.created === 1, JSON.stringify(c));
  check('а `nul` рядом — нет', c.uniqueFiles === 1, String(c.uniqueFiles));
}

// ─── F. Проводка в supervisor.ts ────────────────────────────────────────────
console.log('\nF. Живой код считает burst по артефактам, а не по инструментам');
{
  const sync = src.slice(src.indexOf('const syncWorkspace'), src.indexOf('const recomputeWorkspaceState'));
  check('burstAdd вызывается только для класса PROJECT',
    /classifyArtifact\(p\)\.cls === 'PROJECT'\) \{ projectTouched\.add\(p\); burstAdd/.test(sync), '');
  check('счётчик edits в burst не участвует', !/burstAdd\(.*edits/.test(src), '');

  const close = src.slice(src.indexOf('const closeBurst'), src.indexOf('// Наблюдение дерева'));
  check('пишется и mutations, и uniqueFiles',
    /mutations: burst\.mutations/.test(close) && /uniqueFiles: burst\.files\.size/.test(close), '');
  check('есть пометка правого цензора для прогонов с блокировкой',
    /censored: S\.blocking && !S\.shadow/.test(close), '');
  check('кривая/пороги внутри supervisor НЕ считаются',
    !/failureProbability|probability\[/.test(src), '');

  // Три точки закрытия: verify-инструмент, bash-проверка, автогейт. Пропуск любой слепляет отрезки.
  check('burst закрывается во всех трёх точках проверки',
    (src.match(/closeBurst\(/g) ?? []).length === 3, String((src.match(/closeBurst\(/g) ?? []).length));
  // Обе точки, где исход известен, обязаны закрывать отрезок безусловно: `if (!failed)`
  // здесь слепил бы «3 мутации → FAIL → 2 мутации → PASS» в одно наблюдение из пяти.
  check('verify-инструмент закрывает на любом исходе',
    /closeBurst\(event\.toolName, verifyResult\(failed, text\)\)/.test(src), '');
  const bashAt = src.indexOf('if (S.gatePatterns.some');
  const bashBranch = src.slice(bashAt, src.indexOf('} else if', bashAt));
  check('bash-проверка закрывает на любом исходе',
    /closeBurst\('bash', verifyResult\(failed, text\)\)/.test(bashBranch) && !/if \(!?failed\) closeBurst/.test(bashBranch), '');
}

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nwrite burst меряется отрезками, а не средним');
process.exit(failed ? 1 : 0);
