import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Пре-флайт перед прогоном бенчмарка кодирования. Приводит стенд в известное
// состояние и ПАДАЕТ, если что-то не так, — потому что прогон длится десятки
// минут, и обнаружить в конце, что роутер был мёртв, а на устройстве лежал чужой
// архив, значит потерять прогон целиком.
//
//   node bench/preflight.mjs --fixture <эталон.db> [--app com.arny.habrrss.oomtest]
//
// Что проверяет:
//   1. ровно одно устройство, и оно отвечает;
//   2. роутер llama.cpp отвечает на /health (мы уже теряли прогон на упавшем);
//   3. экран не спит и не погаснет в середине прогона (дважды ловили чёрные скриншоты);
//   4. приложение очищено (pm clear) и в него залита ЭТАЛОННАЯ фикстура;
//   5. logcat и dropbox очищены — иначе модель находит в устройстве чужое
//      падение (в одном прогоне она нашла краш боевого приложения v1.0.4 и
//      приняла его за улику, ничего не воспроизведя сама).

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  const next = process.argv[i + 1];
  // Флаг без значения — это true, а не undefined: иначе `--accept-…` в конце
  // командной строки молча превращается в false и проверка не смягчается.
  argv.set(key, next === undefined || next.startsWith('--') ? true : next);
}

const APP = String(argv.get('app') || 'com.arny.habrrss.oomtest');
// Проект, для которого строится индекс ast-index и из которого берётся фикстура.
const PROJECT = path.resolve(String(argv.get('project') || process.cwd()));
const FIXTURE = path.resolve(String(argv.get('fixture') || path.join(root, 'data', 'runtime', 'fixture', 'habr_rss.db')));
// Добавленные хабы живут НЕ в базе, а в SharedPreferences (ключ custom_feeds):
// `pm clear` стирает их вместе с базой, и без этого файла сценарий не находит хаб
// («Добавленные хабы» пустой). Именно так хаб терялся при каждом прогоне.
const PREFS = path.resolve(String(argv.get('prefs') || path.join(root, 'bench', 'fixture', 'habr_rss_prefs.xml')));
const PREFS_NAME = String(argv.get('prefs-name') || 'habr_rss_prefs.xml');
const SDK = process.env.ANDROID_SDK_ROOT || 'C:/Users/ArnyPC/AppData/Local/Android/Sdk';
const ADB = path.join(SDK, 'platform-tools', 'adb.exe');
const HEALTH = String(argv.get('health') || 'http://127.0.0.1:8080/health');
// История падений в dropbox не чистится без root. Если это осознанное решение —
// флаг снимает ошибку и оставляет предупреждение.
const acceptDropbox = Boolean(argv.get('accept-dropbox-history'));

const run = (file, args, timeout = 120000, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${path.basename(file)} ${args.join(' ')} → ${error.message}${stderr ? `\n${stderr}` : ''}`));
    else resolve(String(stdout));
  });
});
const adb = (...args) => run(ADB, args);

const problems = [];
const ok = (what, detail = '') => console.log(`  ✓ ${what}${detail ? ` — ${detail}` : ''}`);
const bad = (what, detail = '') => { problems.push(`${what}: ${detail}`); console.log(`  ✗ ${what}${detail ? ` — ${detail}` : ''}`); };
// Предупреждение — для необязательных для этой задачи инструментов: их отсутствие не
// ломает эталонное состояние, но должно быть видно, а не выясняться посреди прогона.
const warn = (what, detail = '') => console.log(`  ⚠ ${what}${detail ? ` — ${detail}` : ''}`);

// Сама фикстура должна содержать регистрацию хаба и его статьи: иначе `pm clear`
// стирает добавленный хаб, и сценарий просто не находит кнопку (уже случалось —
// вердикт получился «падения нет», хотя база была не та).
const MIN_ROWS = Number(argv.get('min-rows') || 10000);
const FEED = String(argv.get('feed') || 'habr-hub:programming:alltime');

console.log(`пре-флайт: приложение ${APP}`);
console.log(`  фикстура   ${FIXTURE}`);

// 0. содержимое фикстуры ---------------------------------------------------------
if (!fs.existsSync(FIXTURE)) {
  bad('фикстура', `не найдена: ${FIXTURE}`);
} else {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(FIXTURE, { readOnly: true });
    const rows = db.prepare('select count(*) c from feed_items where feedId = ?').get(FEED).c;
    const sync = db.prepare('select count(*) c from sync_state where sourceKey = ?').get(FEED).c;
    const bodied = db.prepare("select count(*) c from feed_items where feedId = ? and cachedArticleJson is not null and cachedArticleJson <> ''").get(FEED).c;
    if (rows >= MIN_ROWS && sync === 1 && bodied >= MIN_ROWS) ok('фикстура', `${rows} строк в ${FEED}, из них ${bodied} с телом`);
    else bad('фикстура', `в ${FEED}: строк ${rows} (нужно ≥${MIN_ROWS}), с телом ${bodied}, запись в sync_state ${sync} — база не та или тела не попали`);
    db.close();
  } catch (error) { bad('фикстура', `не читается: ${error.message}`); }
}

// 0б. индекс ast-index -----------------------------------------------------------
// Структурные запросы (`class`, `symbol`, `refs`) без индекса отвечают
// "Index not found. Run 'ast-index rebuild' first." — и агент, уткнувшись в это,
// возвращается к grep. Сам rebuild дешёвый (0.31 c на 127 файлов), поэтому
// строим его до прогона, а не надеемся на догадку модели.
const AST = process.env.BENCH_AST_INDEX || 'G:/Android/plugins/ast-index.exe';
if (fs.existsSync(AST)) {
  try {
    await run(AST, ['rebuild'], 180000, { cwd: PROJECT });
    const stats = await run(AST, ['stats'], 60000, { cwd: PROJECT });
    const symbols = (stats.match(/Symbols:\s*(\d+)/) || [, '?'])[1];
    ok('индекс ast-index', `символов ${symbols}`);
  } catch (error) { bad('ast-index', `${error.message.split('\n')[0]} — модель вернётся к grep`); }
} else {
  bad('ast-index', `не найден ${AST}`);
}

// 0в. структурный поиск ast-grep ------------------------------------------------
// Второй инструмент (`sg`) закрывает языки, которых нет в ast-index: JS/TS/TSX, Python,
// Go, Rust, C/C++ и др. Для Kotlin-задачи он не нужен, поэтому отсутствие бинаря —
// предупреждение, а не отказ: инструмент в этом случае честно сообщает об ошибке запуска.
// npm-обёртка `ast-grep` — shell-скрипт, который execFile на Windows не запускает,
// поэтому ищем нативный .exe (та же логика, что в bench/ast-tool.ts).
const AST_GREP_HINT = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@ast-grep', 'cli', 'ast-grep.exe')
  : '';
const AST_GREP = [process.env.BENCH_AST_GREP, AST_GREP_HINT].filter(Boolean).find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (AST_GREP) {
  try {
    const version = String(await run(AST_GREP, ['--version'], 30000)).trim().split(/\r?\n/)[0];
    ok('ast-grep (sg)', version);
  } catch (error) { warn('ast-grep', `${error.message.split('\n')[0]} — инструмент sg будет отвечать ошибкой запуска`); }
} else {
  warn('ast-grep', `не найден — sg будет доступен только для языков в PATH (npm i -g @ast-grep/cli)`);
}


// 1. устройства -----------------------------------------------------------------
let serial = null;
try {
  const lines = (await adb('devices')).split(/\r?\n/).slice(1).filter(l => l.trim());
  const ready = lines.filter(l => /\tdevice$/.test(l));
  if (ready.length === 1) { serial = ready[0].split('\t')[0]; ok('устройство', serial); }
  else if (ready.length === 0) bad('устройство', `не найдено ни одного (строк: ${lines.length})`);
  else bad('устройство', `больше одного (${ready.map(l => l.split('\t')[0]).join(', ')}) — прогон будет спотыкаться на -s`);
} catch (error) { bad('adb', error.message.split('\n')[0]); }

const onDevice = (...args) => adb('-s', serial, ...args);

if (serial) {
  // 3. экран и питание ----------------------------------------------------------
  try {
    await onDevice('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
    await onDevice('shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000');
    const timeout = (await onDevice('shell', 'settings', 'get', 'system', 'screen_off_timeout')).trim();
    if (timeout === '1800000') ok('экран не уснёт', 'screen_off_timeout 30 мин');
    else bad('экран', `screen_off_timeout = ${timeout}`);
  } catch (error) { bad('экран', error.message.split('\n')[0]); }

  try {
    const battery = Number((await onDevice('shell', 'dumpsys', 'battery')).match(/level:\s*(\d+)/)?.[1]);
    if (Number.isFinite(battery) && battery >= 20) ok('заряд', `${battery}%`);
    else bad('заряд', `${battery}% — до конца прогона может не дожить`);
  } catch (error) { bad('заряд', error.message.split('\n')[0]); }

  // Звонок перекрывает всё: экран вызова — системное окно, его нельзя перекрыть
  // ни monkey, ни am start, поэтому сценарий молча не запускается (уже случилось).
  try {
    const registry = await onDevice('shell', 'dumpsys', 'telephony.registry');
    const states = [...registry.matchAll(/mCallState=(\d)/g)].map(m => Number(m[1]));
    if (states.every(state => state === 0)) ok('телефон не занят звонком');
    else bad('телефон', `идёт звонок (mCallState=${states.filter(s => s).join(',')}) — автоматизация UI не сработает`);
  } catch (error) { bad('телефон', error.message.split('\n')[0]); }

  // 4. чистое приложение + эталонная фикстура ------------------------------------
  try {
    await onDevice('shell', 'am', 'force-stop', APP);
    const cleared = (await onDevice('shell', 'pm', 'clear', APP)).trim();
    if (cleared.includes('Success')) ok('данные приложения очищены');
    else bad('pm clear', cleared);

    await run(ADB, ['-s', serial, 'push', FIXTURE, '/data/local/tmp/bench-fixture.db'], 300000);
    await onDevice('shell', `run-as ${APP} mkdir -p databases`);
    await onDevice('shell', `cat /data/local/tmp/bench-fixture.db | run-as ${APP} sh -c 'cat > databases/habr_rss.db'`, 300000);
    await onDevice('shell', `run-as ${APP} rm -f databases/habr_rss.db-wal databases/habr_rss.db-shm`);
    await onDevice('shell', 'rm', '-f', '/data/local/tmp/bench-fixture.db');

    const expected = fs.statSync(FIXTURE).size;
    // `ls -l` в Android: права, ссылки, владелец, группа, РАЗМЕР, дата, время, имя
   // (плюс CR в конце строки, который ломает Number).
    const listing = await onDevice('shell', `run-as ${APP} ls -l databases/habr_rss.db`);
    const actual = Number(String(listing).replace(/\r/g, '').trim().split(/\s+/)[4]);
    if (actual === expected) ok('фикстура залита', `${actual} байт`);
    else bad('фикстура', `на устройстве ${actual}, эталон ${expected} — состояние не то`);

    // 4б. настройки приложения (список добавленных хабов) ------------------
    if (fs.existsSync(PREFS)) {
      await run(ADB, ['-s', serial, 'push', PREFS, '/data/local/tmp/bench-prefs.xml'], 60000);
      await onDevice('shell', `run-as ${APP} mkdir -p shared_prefs`);
      await onDevice('shell', `cat /data/local/tmp/bench-prefs.xml | run-as ${APP} sh -c 'cat > shared_prefs/${PREFS_NAME}'`);
      await onDevice('shell', 'rm', '-f', '/data/local/tmp/bench-prefs.xml');
      const prefsListing = await onDevice('shell', `run-as ${APP} cat shared_prefs/${PREFS_NAME}`);
      if (prefsListing.includes('custom_feeds')) ok('настройки залиты', `shared_prefs/${PREFS_NAME} (хаб в списке)`);
      else bad('настройки', `в shared_prefs/${PREFS_NAME} нет ключа custom_feeds — хаб не появится`);
    } else {
      bad('настройки', `нет файла ${PREFS} — «Добавленные хабы» будут пустыми`);
    }
  } catch (error) { bad('фикстура', error.message.split('\n')[0]); }

  // 5. чистая история падений ----------------------------------------------------
  try {
    await onDevice('shell', 'logcat', '-c');
    await onDevice('shell', 'logcat', '-b', 'crash', '-c');
    ok('logcat очищен');
  } catch (error) { bad('logcat', error.message.split('\n')[0]); }

  try {
    const box = await onDevice('shell', 'dumpsys', 'dropbox', '--print');
    const leaks = ['OutOfMemoryError', 'FATAL EXCEPTION'].filter(marker => box.includes(marker));
    const ours = box.includes(APP);
    if (!leaks.length) ok('dropbox без следов падений');
    else if (ours && !acceptDropbox) bad('dropbox', `в нём есть падение ПАКЕТА ${APP}: модель может принять чужой краш за своё воспроизведение. Лечится свежим applicationId на прогон (applicationIdSuffix = ".b<N>") или явным --accept-dropbox-history`);
    else if (ours) console.log(`  ! dropbox: есть падение нашего пакета ${APP} (${leaks.join(', ')}) — принято по --accept-dropbox-history`);
    else if (acceptDropbox) console.log(`  ! dropbox: старые крахи (${leaks.join(', ')}) — приняты по --accept-dropbox-history`);
    else bad('dropbox', `в нём старые крахи (${leaks.join(', ')}) — без root он не чистится; это улика, добытая не моделью`);
  } catch { /* dropbox может быть недоступен — это не блокер */ }
}

// 2. роутер ----------------------------------------------------------------------
// Мало свободной VRAM — это не всегда проблема: если модель уже загружена, прогон
// стартует тепло. А вот холодный старт требует почти всей карты, и порог
// в 100 МиБ (как было раньше) пропускал именно это состояние.
const REQUIRE_FREE_MIB = Number(argv.get('require-free-mib') || 15000);
const API = String(argv.get('api') || 'http://127.0.0.1:8787/api/local');
try {
  const response = await fetch(HEALTH, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const free = await new Promise(resolve => execFile('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], (e, out) => resolve(e ? null : Number(String(out).trim().split(/\r?\n/)[0]))));
  let loaded = [];
  try {
    const state = await (await fetch(API, { signal: AbortSignal.timeout(4000) })).json();
    loaded = Array.isArray(state.loaded) ? state.loaded : [];
  } catch { /* API может быть недоступно — тогда судим только по VRAM */ }
  if (loaded.length) ok('роутер отвечает', `${HEALTH}, уже загружено: ${loaded.join(', ')} (тёплый старт)`);
  else if (free === null) ok('роутер отвечает', HEALTH);
  else if (free >= REQUIRE_FREE_MIB) ok('роутер отвечает', `${HEALTH}, VRAM свободно ${free} МиБ`);
  else bad('VRAM', `свободно ${free} МиБ, модели не загружены — холодный старт не поднимется (нужно ≥${REQUIRE_FREE_MIB})`);
} catch (error) { bad('роутер', `${HEALTH} не отвечает (${error.message}) — подними: node bin/taskbridge.mjs models start`); }

console.log(problems.length ? `\nпре-флайт ПРОВАЛЕН (${problems.length}):\n- ${problems.join('\n- ')}` : '\nпре-флайт пройден: стенд в эталонном состоянии');
// process.exit() с висящими fetch-хендлами роняет libuv на Windows (assertion),
// поэтому только код возврата.
process.exitCode = problems.some(p => p.startsWith("устройство")) ? 2 : problems.length ? 1 : 0;
