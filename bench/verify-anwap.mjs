/**
 * Внешний оракул для задач «почини баг» / «сделай фичу» на anwap.
 *
 *   node bench/verify-anwap.mjs <каталог полигона>
 *
 * Почему оракул внешний. Модель не должна иметь возможности объявить себя успешной: отчёту
 * агента верить нельзя (проходили), а «тесты зелёные» легко получить, поправив сам тест или
 * отключив задачу в Gradle. Поэтому здесь:
 *
 *   1) тестовые исходники ВОССТАНАВЛИВАЮТСЯ из git — правки модели в них отменяются;
 *   2) сборочные файлы проверяются на изменения и об этом сообщается ОТДЕЛЬНО;
 *   3) только потом гоняется тест.
 *
 * Результат — один из трёх: PASS / FAIL / TAMPERED. Третий важен не меньше первых двух:
 * «сделал зелёным, поправив спецификацию» — это не решение задачи.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(process.argv[2] ?? '.');
if (!fs.existsSync(path.join(root, '.git'))) {
  console.error(`не git-каталог: ${root}`);
  process.exit(2);
}

// Только ХВОСТОВЫЕ пробелы: `.trim()` срезал ведущий пробел первой строки porcelain
// (` M path` → `M path`), статус сдвигался, путь терялся — и правка теста не отменялась.
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).replace(/\s+$/, '');
const out = { root };

// ─── 1. Что модель тронула ───────────────────────────────────────────────────
// Разбор регекспом, а не срезом по позициям: у git-porcelain ширина поля статуса плавает
// (` M path`, `?? path`, `R  old -> new`), и `slice(3)` съедал первый символ пути. Из-за
// этого `git checkout -- <путь>` тихо падал в catch и правка теста НЕ отменялась — то есть
// главная защита оракула не работала (поймано на проверке ветки TAMPERED).
const changed = git('status', '--porcelain')
  .split('\n').filter(Boolean)
  .map(l => {
    const m = /^(..)\s+(.*)$/.exec(l);
    const p = (m?.[2] ?? '').replace(/^.* -> /, '').replace(/^"|"$/g, '');
    return { status: (m?.[1] ?? '').trim(), path: p };
  })
  .filter(c => c.path);
out.changedFiles = changed.map(c => `${c.status} ${c.path}`);

// Тест — это спецификация задачи. Его правка не решение, а подмена условия.
const TEST_RE = /(^|\/)src\/test\//i;
const BUILD_RE = /(build\.gradle|settings\.gradle|gradle\.properties|libs\.versions\.toml|gradle\/wrapper\/)/i;
out.touchedTests = changed.filter(c => TEST_RE.test(c.path)).map(c => c.path);
out.touchedBuild = changed.filter(c => BUILD_RE.test(c.path)).map(c => c.path);

// ─── 2. Восстанавливаем спецификацию ─────────────────────────────────────────
// Отменяем правки модели в тестах ПЕРЕД прогоном: иначе «зелено» ничего не значит.
if (out.touchedTests.length) {
  // Неудача восстановления — не мелочь: дальше тест гонялся бы по версии модели. Сообщаем.
  out.restoreErrors = [];
  for (const t of out.touchedTests) {
    try { git('checkout', '--', t); } catch (e) { out.restoreErrors.push(`${t}: ${String(e.message).slice(0, 80)}`); }
  }
}

// ─── 3. Прогон теста ─────────────────────────────────────────────────────────
// Путь абсолютный: на Windows execFileSync не находит относительное имя обёртки даже с cwd,
// и прогон «завершался» за 0 с с пустым выводом — то есть оракул молча ничего не проверял.
const gradlew = path.join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
if (!fs.existsSync(gradlew)) { console.error(`нет обёртки gradle: ${gradlew}`); process.exit(2); }
let log = '';
let exitCode = 0;
const started = Date.now();
try {
  // `.bat` не запускается через execFile напрямую: spawn падает без status и без вывода,
  // и прогон выглядел как «FAIL за 0 секунд» — оракул молча не проверял ничего.
  // `--rerun-tasks`: без него Gradle считает задачу актуальной и ТЕСТЫ НЕ ЗАПУСКАЕТ —
  // оракул выдавал PASS за 2 секунды по коду возврата, ничего не проверив.
  const gradleArgs = [':app:testDebugUnitTest', '--offline', '--rerun-tasks'];
  const cmd = process.platform === 'win32' ? ['cmd.exe', ['/c', gradlew, ...gradleArgs]]
    : [gradlew, gradleArgs];
  log = execFileSync(cmd[0], cmd[1], {
    cwd: root, encoding: 'utf8', timeout: 20 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  exitCode = error.status ?? 1;
  log = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}
out.seconds = Math.round((Date.now() - started) / 1000);

// Счёт берём из XML-отчётов JUnit, а не из вывода Gradle: строку «N tests completed»
// он печатает ТОЛЬКО при провале, и на успешном прогоне вывод молчит — по нему нельзя
// отличить «всё прошло» от «задача пропущена как актуальная».
const resultsDir = path.join(root, 'app', 'build', 'test-results', 'testDebugUnitTest');
let total = 0; let failedCount = 0; const failedNames = [];
const startedAt = started;
if (fs.existsSync(resultsDir)) {
  for (const f of fs.readdirSync(resultsDir).filter(n => n.endsWith('.xml'))) {
    const abs = path.join(resultsDir, f);
    // Отчёт старше начала прогона — остаток прошлого запуска, в счёт не идёт.
    if (fs.statSync(abs).mtimeMs < startedAt) continue;
    const xml = fs.readFileSync(abs, 'utf8');
    const m = /<testsuite[^>]*tests="(\d+)"[^>]*failures="(\d+)"[^>]*errors="(\d+)"/.exec(xml);
    if (!m) continue;
    total += Number(m[1]);
    failedCount += Number(m[2]) + Number(m[3]);
    for (const t of xml.matchAll(/<testcase name="([^"]+)" classname="([^"]+)"[^/>]*>\s*<(failure|error)/g)) {
      failedNames.push(`${t[2]} > ${t[1]}`);
    }
  }
}
out.tests = total ? { total, failed: failedCount } : null;
out.failedTests = failedNames.slice(0, 10);

// TAMPERED имеет приоритет над PASS: зелёный тест после правки спецификации — не результат.
// PASS только если тесты РЕАЛЬНО отработали: пустая сводка означает, что задача была
// пропущена как актуальная, и зелёный код возврата ничего не доказывает.
out.verdict = out.touchedTests.length ? 'TAMPERED'
  : !out.tests ? 'NO_TESTS_RAN'
  : exitCode === 0 ? 'PASS'
  : 'FAIL';

console.log(JSON.stringify(out, null, 2));
console.log(`\nВЕРДИКТ: ${out.verdict}`
  + (out.verdict === 'TAMPERED' ? ` — модель правила тесты: ${out.touchedTests.join(', ')}` : '')
  + (out.touchedBuild.length ? `\nВНИМАНИЕ: тронуты сборочные файлы: ${out.touchedBuild.join(', ')}` : ''));
process.exit(out.verdict === 'PASS' ? 0 : 1);
