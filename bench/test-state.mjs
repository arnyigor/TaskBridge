/**
 * Тесты ядра надзирателя: решения о блокировке и парсер дельты ошибок.
 *
 *   node bench/test-state.mjs
 *
 * Функции вырезаются из bench/supervisor.ts и исполняются как есть (см. lib-ts-extract.mjs):
 * проверяем настоящий код, а не переписанную копию.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripTsTypes, grabFunction, grabConst } from './lib-ts-extract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'supervisor.ts'), 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ок    ' : 'ОШИБКА'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// Собираем helper-блок: константы + нужные функции.
const markers = grabConst(src, 'MARKERS');
const settingsMarkers = grabConst(src, 'SETTINGS_MARKERS');
const hashLineSrc = src.match(/const hashLine = [^\n]+;/)?.[0] ?? '';
// GATE_REASON — многострочный объект, grabConst (однострочный) его не возьмёт: режем по
// закрывающей строке `};`. Если он не найден — падаем громко, а не молча берём пустую строку:
// пустой блок дал бы «ни один гейт не срабатывает» и зелёный тест ни на чём.
const gateReasonSrc = src.match(/const GATE_REASON[\s\S]*?\n\};/)?.[0];
if (!gateReasonSrc) throw new Error('GATE_REASON не найден в supervisor.ts');
const chain = stripTsTypes([
  markers, settingsMarkers, hashLineSrc,
  grabFunction(src, 'isBashWrite'),
  grabFunction(src, 'isBuildCmd'),
  grabFunction(src, 'parseBuildResult'),
  // decideGate теперь опирается на условие и тексты причин — без них он немой.
  grabFunction(src, 'gateConditions'),
  gateReasonSrc,
  grabFunction(src, 'decideGate'),
  grabFunction(src, 'decideBlock'),
].join('\n'));

const api = new Function('fs', 'path', 'createHash', 'IGNORED_DIRS', `${chain}; return { isBashWrite, isBuildCmd, parseBuildResult, decideGate, decideBlock };`)(
  fs, path, createHash, new Set(['runs', 'build', '.gradle', '.git', 'node_modules', 'out', 'bin', 'dist', 'tmp', '.tmp']),
);

const baseSettings = {
  blocking: true, readOnly: false,
  reconTools: ['web-search_full-web-search'],
  stagnationAfter: 24,
  editsBeforeVerifyBlock: 4,
};

// ─── 0. Имя гейта (для по-гейтового ablation) ────────────────────────────────
console.log('\n0. Гейты различаются по имени');
{
  const mk = over => ({ state: 'baseline_green', toolName: 'edit', command: '', writtenPaths: [], projectFiles: 0, edits: 0, verifications: 1, lastVerifiedTouched: 0, reproSeenInContext: true, steps: 5, S: { ...baseSettings }, ...over });
  check('  непроверенная дельта → гейт verify-delta', api.decideGate(mk({ projectFiles: 4 }))?.gate === 'verify-delta', String(api.decideGate(mk({ projectFiles: 4 }))?.gate));
  check('  verify-delta измеряется файлами, не вызовами', api.decideGate(mk({ edits: 99, projectFiles: 1 })) === null);
  check('  запись до воспроизведения → гейт repro', api.decideGate(mk({ edits: 0, state: 'baseline_red', reproSeenInContext: false }))?.gate === 'repro');
  // Застой — это ДИНАМИКА: гейт смотрит на шаги без сдвига, а не на число файлов.
  check('  долгий застой → гейт stagnation', api.decideGate(mk({ stepsSinceProgress: 30, toolName: 'web-search_full-web-search' }))?.gate === 'stagnation');
  check('  stagnation ловит ЛЮБОЙ инструмент, не только web-search', api.decideGate(mk({ stepsSinceProgress: 30, toolName: 'read' }))?.gate === 'stagnation');
  check('  файлов много, но сдвиг был только что — не срабатывает', api.decideGate(mk({ projectFiles: 43, stepsSinceProgress: 0, toolName: 'read' })) === null);
}

// ─── 1. Блокировка записи до воспроизведения ────────────────────────────────
console.log('\n1. Блокировка записи, пока модель не видела падение (state = baseline_red)');
{
  const mk = over => ({ state: 'baseline_red', toolName: 'edit', command: '', writtenPaths: [], projectFiles: 0, edits: 0, verifications: 0, lastVerifiedTouched: 0, reproSeenInContext: false, steps: 5, S: { ...baseSettings }, ...over });
  const blocked = api.decideBlock(mk({}));
  check('  правка при красном baseline без наблюдения падения — блок', /КРАСНОЕ|падени/i.test(blocked ?? ''), String(blocked).slice(0, 60));
  check('  правка после наблюдения падения — нет блока', api.decideBlock(mk({ reproSeenInContext: true })) === null);
  check('  запись через bash тоже блокируется', /КРАСНОЕ|падени/i.test(api.decideBlock(mk({ toolName: 'bash', command: 'echo x > file.txt' })) ?? ''));
  check('  bash без записи (2>/dev/null) — нет блока', api.decideBlock(mk({ toolName: 'bash', command: 'ls x 2>/dev/null' })) === null);
  check('  чтение файла — нет блока', api.decideBlock(mk({ toolName: 'read' })) === null);
}

// ─── 2. Блокировка непроверенной дельты ─────────────────────────────────────
console.log('\n2. Блокировка при накопленной непроверенной дельте');
{
  const mk = over => ({ state: 'baseline_green', toolName: 'edit', command: '', writtenPaths: [], projectFiles: 0, edits: 0, verifications: 1, lastVerifiedTouched: 0, reproSeenInContext: true, steps: 20, S: { ...baseSettings }, ...over });
  check('  3 файла из 4 — нет блока', api.decideBlock(mk({ projectFiles: 3 })) === null);
  const blocked = api.decideBlock(mk({ projectFiles: 4 }));
  check('  4 файла без проверки — блок', /без проверки/i.test(blocked ?? ''), String(blocked).slice(0, 50));
  check('  после проверки счётчик сброшен — нет блока', api.decideBlock(mk({ projectFiles: 6, lastVerifiedTouched: 5 })) === null);
  check('  правок много, но файлы не менялись — нет блока', api.decideBlock(mk({ edits: 40, projectFiles: 1 })) === null);
}

// ─── 3. Блокировка застоя ───────────────────────────────────────────────────
console.log('\n3. Блокировка при застое');
{
  const mk = over => ({ state: 'greenfield', toolName: 'web-search_full-web-search', command: '', writtenPaths: [], projectFiles: 0, edits: 0, verifications: 0, lastVerifiedTouched: 0, reproSeenInContext: false, steps: 10, stepsSinceProgress: 0, S: { ...baseSettings }, ...over });
  check('  сдвиг только что — нет блока', api.decideBlock(mk({})) === null);
  const blocked = api.decideBlock(mk({ stepsSinceProgress: 30 }));
  check('  30 шагов без сдвига — блок', /без единого изменения/i.test(blocked ?? ''), String(blocked).slice(0, 50));
  check('  сдвиг произошёл — блок снят', api.decideBlock(mk({ stepsSinceProgress: 0, projectFiles: 1 })) === null);
  // Застой не зависит от состояния среды: читать и не двигаться можно и в существующем проекте.
  check('  в существующем проекте тоже действует', (api.decideBlock(mk({ stepsSinceProgress: 30, state: 'baseline_green' })) ?? '').length > 0);
}

// ─── 3а. Что считается проверкой ────────────────────────────────────────────
// На задаче без сборочной системы (единственный .html) проверка — это прогон скрипта,
// а не gradle. Без `node ` в списке любой такой прогон не засчитывался бы, burst не
// закрывался, и final-verify всегда показывал бы «грязно».
console.log('\n3а. Команды, считающиеся проверкой');
{
  const gate = src.match(/gatePatterns: \[[^\]]*\]/)?.[0] ?? '';
  check('  node есть в списке проверок', /'node '/.test(gate), gate.slice(0, 80));
  check('  gradle тоже на месте', /'gradlew'/.test(gate), '');
  check('  python тоже (модель часто пишет .py для проверки физики)', /'python '/.test(gate), '');

  // Тело heredoc — содержимое файла, а не команда. Живой случай: `cat > sim.mjs <<EOF … node …`
  // засчитался проверкой и закрыл write burst, хотя это была ЗАПИСЬ.
  const te = src.slice(src.indexOf("pi.on('tool_execution_end'"), src.indexOf("pi.on('turn_end'"));
  check('  совпадения ищутся ДО начала heredoc', /fullCmd\.split\(\/<</.test(te), '');
  const cut = c => c.toLowerCase().split(/<<[-~]?['"]?\w+/)[0];
  const heredoc = ["cat > sim.mjs <<'EOF'", 'node stuff', 'EOF'].join('\n');
  check('  запись файла с node в теле — не проверка', !cut(heredoc).includes('node '), cut(heredoc).trim());
  check('  настоящий прогон node — проверка', cut('cd x && node -e "1"').includes('node '), '');
}

// ─── 4. Режимы и отключение ────────────────────────────────────────────────
console.log('\n4. Режимы');
{
  const mk = over => ({ state: 'baseline_green', toolName: 'write', command: '', writtenPaths: [], projectFiles: 0, edits: 0, verifications: 1, lastVerifiedTouched: 0, reproSeenInContext: true, steps: 5, S: { ...baseSettings }, ...over });
  check('  read-only блокирует запись', /только чтения/i.test(api.decideBlock(mk({ S: { ...baseSettings, readOnly: true } })) ?? ''));
  check('  blocking=off снимает все блоки', api.decideBlock(mk({ edits: 9, S: { ...baseSettings, blocking: false } })) === null);
}

// ─── 5. Парсер: вердикт и дельта ошибок ────────────────────────────────────
console.log('\n5. Парсер результата сборки (на реальных фикстурах)');
{
  const fixture = name => {
    const p = path.join(here, 'fixtures', name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };
  const cases = [
    ['gradle-success.txt', 'success', true, 'успех — сказать'],
    ['gradle-test-failed.txt', 'test_failure', true, 'тесты падают — воспроизведение, сказать'],
    ['gradle-plugin-resolution.txt', 'config_failure', true, 'резолв плагина — сказать'],
    ['gradle-resolution.txt', 'config_failure', true, 'резолв зависимости — сказать'],
    ['gradle-environment.txt', 'environment', true, 'окружение — сказать'],
  ];
  for (const [file, kind, speak, why] of cases) {
    const text = fixture(file);
    if (!text) { check(`  ${why}`, false, `нет фикстуры ${file}`); continue; }
    const v = api.parseBuildResult(text, 10, new Set());
    check(`  ${why}`, v.kind === kind && v.speak === speak, `${file}: ${v.kind}/${v.speak ? 'говорит' : 'молчит'}`);
  }

  // Дельта: первый прогон говорит про новые ошибки, второй с теми же хэшами — молчит.
  const compile = fixture('gradle-compile-error.txt');
  if (compile) {
    const seen = new Set();
    const first = api.parseBuildResult(compile, 10, seen);
    check('  ошибки компиляции: первый раз говорим', first.kind === 'compile_errors' && first.speak === true, `новых ${first.newErrors.length}`);
    const second = api.parseBuildResult(compile, 10, seen);
    check('  ошибки компиляции: те же ошибки — молчим (дельта пуста)', second.kind === 'compile_errors' && second.speak === false, `виденных ${second.seenErrors}`);
  }
}

// ─── 6. Классификатор артефактов (шаг 4) ─────────────────────────────────
console.log('\n6. Классификатор артефактов: класс + причина');
{
  // Наблюдение отделено от классификации: observer (test-observer.mjs) сообщает ЛЮБОЙ новый
  // путь, включая `nul`. Здесь проверяется только решение о классе.
  // Каждый кусок извлекается ЯВНО: пустая строка вместо не найденной константы дала бы
  // молчаливый ноль (все пути → OTHER), и тест бы «прошёл» ни на чём.
  const need = re => {
    const m = src.match(re);
    if (!m) throw new Error(`не найдено в supervisor.ts: ${re}`);
    return m[0];
  };
  const cls = new Function(stripTsTypes([
    need(/const PROJECT_FILE_RE = [^\n]+;/),
    need(/const PROJECT_FILE_NAMES = [^\n]+;/),
    need(/const HARNESS_DIRS = [^\n]+;/),
    need(/const GENERATED_DIRS = [^\n]+;/),
    need(/const RESEARCH_DIRS = [^\n]+;/),
    grabFunction(src, 'isProjectFile'),
    grabFunction(src, 'classifyArtifact'),
  ].join('\n')) + '; return { isProjectFile, classifyArtifact };')();

  // [путь, класс, кусок причины]
  const cases = [
    ['src/main/kotlin/App.kt', 'PROJECT', 'source_extension'],
    ['settings.gradle.kts', 'PROJECT', 'project_marker_name'],
    ['libs.versions.toml', 'PROJECT', 'project_marker_name'],
    ['androidApp/src/main/AndroidManifest.xml', 'PROJECT', 'project_marker_name'],
    ['.research/design.md', 'RESEARCH', 'research_dir'],
    ['runs/smoke-shadow/supervisor.log', 'HARNESS', 'harness_dir'],
    ['.pi/harness.json', 'HARNESS', 'harness_dir'],
    // Каталог важнее расширения: иначе вывод сборки считался бы работой модели.
    ['build/tmp/kotlin/Foo.kt', 'GENERATED', 'build_output_dir'],
    ['node_modules/x/package.json', 'GENERATED', 'build_output_dir'],
    // Пятый класс: `nul` не относится ни к одному из четырёх — впихивать его нельзя.
    ['mission.html', 'PROJECT', 'source_extension'],
    ['verify.mjs', 'PROJECT', 'source_extension'],
    ['nul', 'OTHER', 'no_project_evidence'],
    ['template.zip', 'OTHER', 'no_project_evidence'],
  ];
  for (const [p, wantCls, wantReason] of cases) {
    const got = cls.classifyArtifact(p);
    check(`  ${p} → ${wantCls}`, got.cls === wantCls && got.reason.startsWith(wantReason), `${got.cls}/${got.reason}`);
  }
  // Метрика first_project_artifact идёт через классификатор, а не через isProjectFile:
  // проектное расширение внутри build/ не должно открывать метрику.
  check('  build/foo.kt: whitelist говорит да, классификатор — нет',
    cls.isProjectFile('build/foo.kt') === true && cls.classifyArtifact('build/foo.kt').cls === 'GENERATED', 'слои различимы');
}

// ─── 7. Граница «ядро ≠ legacy-поведение» ────────────────────────
console.log('\n7. Наблюдаемое состояние и legacy-адаптер');
{
  // Комментарии не считаем: важно, что вне адаптера нет ни ОДНОЙ строки 'reproduce' в коде
  // (ни в состоянии, ни в названиях событий). `://` не трогаем, чтобы не резать URL по ошибке.
  const srcCode = src.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const withoutAdapter = srcCode.replace(/type LegacyMode = [^;]+;/, '').replace(grabFunction(srcCode, 'legacyMode'), '');
  check("  'reproduce' не встречается вне legacy-адаптера", !/'reproduce'/.test(withoutAdapter),
    (withoutAdapter.match(/^.*'reproduce'.*$/m) ?? [''])[0].trim().slice(0, 60));

  const stateDecl = src.match(/type WorkspaceState = [^;]+;/)?.[0] ?? '';
  check('  состояния — наблюдаемые факты',
    /baseline_red/.test(stateDecl) && /baseline_green/.test(stateDecl) && /greenfield/.test(stateDecl)
      && !/reproduce|implement/.test(stateDecl), stateDecl);

  const legacyApi = new Function(stripTsTypes(grabFunction(src, 'legacyMode')) + '; return { legacyMode };')();
  check('  legacy: baseline_red → reproduce', legacyApi.legacyMode('baseline_red') === 'reproduce');
  check('  legacy: baseline_green → implement', legacyApi.legacyMode('baseline_green') === 'implement');
  check('  legacy: greenfield → greenfield', legacyApi.legacyMode('greenfield') === 'greenfield');
}

// ─── 8. Вид сбоя — механическая классификация ───────────────────────────
console.log('\n8. failureKindOf (на реальных фикстурах Gradle)');
{
  const fk = new Function(stripTsTypes(grabFunction(src, 'failureKindOf')) + '; return { failureKindOf };')();
  const fx = n => {
    const f = path.join(here, 'fixtures', n);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  };
  const cases = [
    ['gradle-success.txt', 'success', 'none'],
    ['gradle-test-failed.txt', 'test_failure', 'test'],
    ['gradle-compile-error.txt', 'compile_errors', 'compile'],
    ['gradle-plugin-resolution.txt', 'config_failure', 'dependency'],
    ['gradle-resolution.txt', 'config_failure', 'environment'],
    ['gradle-environment.txt', 'environment', 'environment'],
  ];
  for (const [file, verdictKind, want] of cases) {
    const text = fx(file);
    if (!text) { check(`  ${file}`, false, 'нет фикстуры'); continue; }
    const got = fk.failureKindOf(verdictKind, text);
    check(`  ${file} → ${want}`, got === want, got);
  }
  const cfg = fk.failureKindOf('unknown', 'FAILURE: Build failed with an exception.\n* What went wrong:\nA problem occurred configuring project \':app\'.');
  check('  конфигурация фазы → configuration', cfg === 'configuration', cfg);
  const unk = fk.failureKindOf('unknown', 'FAILURE: Build failed with an exception. Что-то неизвестное');
  check('  непонятное → unknown (не гадаем)', unk === 'unknown', unk);
}


// ─── 9. Плечо A/B: блокирует ровно один гейт ────────────────────────────────
// Требование парного эксперимента: отличается ОДИН переключатель. Если включение блокировок
// включает все гейты разом, по результату нельзя понять, который подействовал.
console.log('\n6. Плечо A/B (enforcedGate)');
{
  const tc = src.slice(src.indexOf("pi.on('tool_call'"), src.indexOf("pi.on('tool_execution_end'"));
  check('  решение о применении учитывает имя гейта',
    /S\.enforcedGate === decision\.gate/.test(tc), '');
  check('  в shadow не блокирует ничего', /!S\.shadow &&/.test(tc), '');
  check("  'all' включает все гейты", /S\.enforcedGate === 'all'/.test(tc), '');
  check('  пустое значение = прежнее поведение (все гейты)', /!S\.enforcedGate \|\|/.test(tc), '');
  check('  плечо читается из переменной окружения', /BENCH_ENFORCED_GATE/.test(src), '');

  // Модель решения из живого кода: подставляем настройки и смотрим, что применится.
  const enforced = (shadow, enforcedGate, gate) => !shadow && (!enforcedGate || enforcedGate === 'all' || enforcedGate === gate);
  check('  плечо stagnation: свой гейт блокирует', enforced(false, 'stagnation', 'stagnation') === true, '');
  check('  плечо stagnation: чужой гейт НЕ блокирует', enforced(false, 'stagnation', 'verify-delta') === false, '');
  check('  shadow сильнее плеча', enforced(true, 'stagnation', 'stagnation') === false, '');
}

// ─── 10. Справка и выключатели ──────────────────────────────────────────────
// Описание команды и её поведение уже расходились: в `description` висела опция, которой
// не существовало, а `off` обещал выключить напоминания, хотя включал их чаще. Здесь
// проверяется, что справка перечисляет реальные ветки, а выключатели глушат всё.
console.log('\n10. Справка /nudge help и выключатели');
{
  const cmd = src.slice(src.indexOf("registerCommand('nudge'"));
  check('  есть ветка help', /arg === 'help'/.test(cmd), '');
  check('  неизвестный аргумент показывает справку', /не понял[\s\S]{0,60}help\(\)/.test(cmd), '');

  for (const opt of ['off', 'silent', 'on']) {
    check(`  «${opt}» из справки обрабатывается`, cmd.includes(`arg === '${opt}'`), '');
  }
  for (const key of ['edits', 'stagnation', 'after', 'work']) {
    check(`  «${key}=» из справки обрабатывается`, cmd.includes(`key === '${key}'`), '');
  }

  // Выключатели обязаны глушить ВСЕ напоминания, а не одну ветку.
  check('  off ставит maxNudges = 0', /arg === 'off'[\s\S]{0,500}S\.maxNudges = 0/.test(cmd), '');
  check('  silent дополнительно гасит журнал', /arg === 'silent'[\s\S]{0,500}S\.log = ''/.test(cmd), '');
  check('  есть глобальный выключатель расширения', /BENCH_SUPERVISOR_OFF === '1'\) return;/.test(src), '');

  // Переменные, названные в справке, должны существовать в коде.
  for (const env of ['BENCH_SUPERVISOR_OFF', 'BENCH_SHADOW', 'BENCH_ENFORCED_GATE', 'BENCH_MAX_NUDGES', 'BENCH_SUPERVISOR_LOG']) {
    const inHelp = cmd.includes(env);
    const inCode = src.includes(`'${env}'`) || src.includes(`env.${env}`);
    check(`  ${env} — и в справке, и в коде`, inHelp && inCode, `справка ${inHelp}, код ${inCode}`);
  }
}

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nядро проверено: блокировки и дельта ошибок работают как задумано');

// Код возврата обязателен: без него тест печатал «ПРОВАЛЕНО», но выходил с нулём — и
// числился зелёным в каждой сводке и в каждом прогоне мутаций. Устаревшие проверки
// (старая семантика `recon`) жили так незамеченными.
process.exit(failed ? 1 : 0);
