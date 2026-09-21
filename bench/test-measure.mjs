/**
 * Проверка измерительных систем: детекторы, классификатор сборки, метрики.
 *
 *   node bench/test-measure.mjs
 *
 * Тестируется НАСТОЯЩИЙ код из bench/*.mjs и bench/supervisor.ts (вырезается и исполняется),
 * а не переписанная копия — иначе проверяли бы не то, что работает в прогоне.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stripTsTypes, grabFunction, grabConst } from './lib-ts-extract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(here, f), 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ок    ' : 'ОШИБКА'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ─── A. Детектор записи файла в bash ─────────────────────────────────────────
console.log('A. Детектор правок через bash (isBashWrite)');
{
  const src = read('timeline-run.mjs');
  const start = src.indexOf('function isBashWrite(');
  const end = src.indexOf('\n}', start) + 2;
  const isBashWrite = new Function(`${src.slice(start, end)}; return isBashWrite;`)();

  const cases = [
    ['ls x 2>/dev/null; echo ---', false, '2>/dev/null не правка'],
    ['cmd 2>&1 | tail -5', false, '2>&1 не правка'],
    ['curl -s u | sed -n "s/.*<version>\\([^<]*\\)<\\/version>.*/\\1/p"', false, '> внутри sed'],
    ['grep -o "a>b" file.txt', false, '> внутри кавычек'],
    ['curl -o out.html https://x', false, '-o у curl'],
    ['cat > build.gradle.kts << EOF', true, 'heredoc'],
    ['echo hi > file.txt', true, 'редирект'],
    ['printf x > .gitignore', true, 'файл без расширения'],
    ['cat > "local.properties" << EOF', true, 'кавычки'],
    ["python - <<'EOF'\nimport urllib.request\nprint(1)\nEOF", false, 'heredoc кормит stdin, а не файл'],
    ['echo x >> settings.gradle.kts', true, 'дозапись'],
  ];
  for (const [cmd, want, why] of cases) check(`  ${why}`, isBashWrite(cmd) === want, cmd.slice(0, 46));
}

// ─── B. Детектор сборки ──────────────────────────────────────────────────────
console.log('\nB. Детектор запуска сборки');
{
  const src = read('timeline-run.mjs');
  const start = src.indexOf('function isBuildCmd(');
  const end = src.indexOf('\n}', start) + 2;
  const looksLikeBuild = new Function(`${src.slice(start, end)}; return isBuildCmd;`)();
  check('  функция isBuildCmd найдена в коде', start > 0);
  const cases = [
    ['cd proj && ./gradlew :shared:compileKotlinJvm --console=plain', true, 'реальная команда из прогона'],
    ['gradlew.bat build', true, 'windows-обёртка'],
    ['cd x && rm -rf todo-app && ./gradlew build', true, 'с префиксом'],
    ['cd /g/proj && cmd //c "gradlew.bat :shared:compileKotlinJvm --console=plain" 2>&1 | tail -60', true, 'запуск через cmd //c (нашёлся только на 28-й минуте)'],
    ['curl -s https://repo1.maven.org/maven2/com/google/devtools/ksp/symbol-processing-gradle-plugin/maven-metadata.xml', false, 'URL с gradle в имени'],
    ['cat gradle/libs.versions.toml', false, 'чтение файла'],
    ['cp -r _tpl/KotlinProject/gradle/wrapper todo-app/', false, 'копирование'],
    ['ls gradle; mv wrapper gradle/wrapper; chmod +x gradlew', false, 'упоминание gradlew без запуска'],
    ['gradlew /tmp/tpl/KotlinProject/gradlew.bat . && cp -r /tmp/tpl/x res', false, 'копирование gradlew.bat'],
  ];
  for (const [cmd, want, why] of cases) check(`  ${why}`, looksLikeBuild(cmd) === want, cmd.slice(0, 50));
}

// ─── C. Классификатор результата сборки (на РЕАЛЬНЫХ выводах Gradle) ──────────
console.log('\nC. Классификатор вердикта сборки (classifyBuild из supervisor.ts)');
{
  const src = read('supervisor.ts');
  const hashLineSrc = src.match(/const hashLine = [^\n]+;/)?.[0] ?? '';
  const fnText = stripTsTypes([hashLineSrc, grabFunction(src, 'parseBuildResult'), grabFunction(src, 'classifyBuild')].join('\n'));
  const classify = new Function('fs', 'path', 'createHash', `${fnText}; return classifyBuild;`)(fs, path, createHash);

  // Фикстуры — настоящие выводы Gradle: падающий и зелёный тест сняты с полигона
  // anwap_bug, ошибка компиляции — из сессии прогона kmp_nudge.
  const fixtures = [
    ['gradle-success.txt', 'success', true, 'успешная сборка — сказать'],
    ['gradle-test-failed.txt', 'test_failure', true, 'тест падает — это воспроизведение, сказать'],
    ['gradle-compile-error.txt', 'compile_errors', true, 'ошибки компиляции — говорим ДЕЛЬТОЙ новых'],
    ['gradle-resolution.txt', 'config_failure', true, 'не разрешаются зависимости — сказать'],
    ['gradle-plugin-resolution.txt', 'config_failure', true, 'Error resolving plugin (реальный случай kmp_iq4xs) — сказать'],
    ['gradle-environment.txt', 'environment', true, 'проблема окружения — сказать'],
  ];
  for (const [file, kind, speak, why] of fixtures) {
    const p = path.join(here, 'fixtures', file);
    if (!fs.existsSync(p)) { check(`  ${why}`, false, `нет фикстуры ${file} (запусти node bench/extract-fixtures.mjs)`); continue; }
    const v = classify(fs.readFileSync(p, 'utf8'), 10);
    check(`  ${why}`, v.kind === kind && v.speak === speak, `${file}: ${v.kind}/${v.speak ? 'говорит' : 'молчит'}`);
  }
}

// ─── D. Детектор скелета проекта ─────────────────────────────────────────────
console.log('\nD. Детектор скелета проекта (skeletonReady + projectDir из supervisor.ts)');
{
  const src = read('supervisor.ts');
  const grab = name => { const s = src.indexOf(`function ${name}(`); const e = src.indexOf('\n}', s) + 2; return src.slice(s, e); };
  const strip = stripTsTypes;
  const markersLine = src.match(/const MARKERS = [^\n]+;/)?.[0] ?? '';
  const chain = strip([markersLine, grab('findProjectDirs'), grab('countSources'), grab('projectDir'), grab('buildSystemPresent'), grab('skeletonReady')].join('\n'));
  const IGNORED = new Set(['runs', 'build', '.gradle', '.git', 'node_modules', 'out', 'bin', 'dist', 'tmp', '.tmp']);
  const ready = new Function('fs', 'path', 'IGNORED_DIRS', `${chain}; return skeletonReady;`)(fs, path, IGNORED);

  const project = 'C:/temp/skel-test/KotlinProject';
  check('  реальный шаблон = скелет готов', fs.existsSync(project) ? ready(project) === true : true, fs.existsSync(project) ? project : 'шаблон не распакован — пропущено');
  check('  каталог с одним zip = не скелет', ready('G:/AIModels/LLMBenchmarks/MyTests/kmp_app') === false);
  check('  несуществующий путь = не скелет', ready('G:/nope/nope') === false);
  check('  проект в подкаталоге без записей модели не считается', ready('G:/AIModels/LLMBenchmarks/MyTests/kmp_iq4xs') === false);
}

// ─── E. Метрики в статусе: контекст и живость ────────────────────────────────
console.log('\nE. Метрики статуса');
{
  const st = read('status-run.mjs');
  check('  контекст считается по usage.totalTokens', /usage\.totalTokens|u\.totalTokens/.test(st));
  check('  живость не только по PID', /fresh\(manifest\.tracePath\)/.test(st));
  check('  число сессий проверяется и предупреждает о дубле', /сессий|СЕССИИ/i.test(st) && /дубль/i.test(st));
  const tl = read('timeline-run.mjs');
  check('  таймлайн считает порог "увидела сборку"', /модель УВИДЕЛА результат сборки/.test(tl));
  check('  таймлайн пишет timeline.json', /timeline\.json/.test(tl));
}

// ─── F. Сверка трейса с сессионным файлом (живой прогон) ─────────────────────
console.log('\nF. Сверка измерений с сессионным файлом (если прогон идёт)');
{
  const runDir = process.argv[2];
  if (!runDir || !fs.existsSync(path.join(runDir, 'manifest.json'))) {
    check('  живой прогон не указан — пропущено', true, 'укажи каталог прогона вторым аргументом');
  } else {
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
    const traceCount = {};
    for (const l of fs.readFileSync(manifest.tracePath, 'utf8').split(/\r?\n/)) {
      if (!l.trim().startsWith('{')) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.type === 'tool_execution_start') traceCount[j.toolName] = (traceCount[j.toolName] ?? 0) + 1;
    }
    const sessionsDir = path.join(os.homedir(), '.pi', 'agent', 'sessions', `--${manifest.cwd.replace(/[\\:]/g, '-')}--`);
    const sessFile = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')) : [];
    const sessionCount = {};
    if (sessFile.length === 1) {
      for (const l of fs.readFileSync(path.join(sessionsDir, sessFile[0]), 'utf8').split(/\r?\n/)) {
        if (!l.trim().startsWith('{')) continue;
        let j; try { j = JSON.parse(l); } catch { continue; }
        const m = j.message;
        if (m?.role === 'assistant' && Array.isArray(m.content)) for (const p of m.content) if (p.type === 'toolCall') sessionCount[p.name] = (sessionCount[p.name] ?? 0) + 1;
      }
    }
    const names = [...new Set([...Object.keys(traceCount), ...Object.keys(sessionCount)])];
    let mismatches = 0;
    for (const n of names) if ((traceCount[n] ?? 0) !== (sessionCount[n] ?? 0)) mismatches += 1;
    check(`  сессий в каталоге ровно одна`, sessFile.length === 1, `найдено ${sessFile.length}`);
    check('  счётчики инструментов трейса и сессии совпадают', mismatches === 0,
      names.map(n => `${n}:${traceCount[n] ?? 0}/${sessionCount[n] ?? 0}`).join(' '));
  }
}

console.log(failed ? `\nПРОВАЛЕНО проверок: ${failed}` : '\nвсе проверки измерителей пройдены');
process.exit(failed ? 1 : 0);
