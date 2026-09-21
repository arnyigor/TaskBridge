/**
 * Надзиратель за агентом: состояние репозитория → фаза → блокировка с причиной.
 *
 * ─── Почему переписано ─────────────────────────────────────────────────────────
 * Первая версия была набором порогов «шагов без правки» и текстовых напоминаний (`steer`).
 * Замеры показали три вещи:
 *   1. локальная 27B игнорирует текстовые напоминания (8–12 инъекций подряд — ноль реакций);
 *   2. ручной выбор профиля под задачу промахивается: различие «новый проект / существующий»
 *      определяется СОСТОЯНИЕМ репозитория, а не намерением, и меняется по ходу сессии;
 *   3. скрытие инструмента (`setActiveTools`) немо: модель не знает причины и зацикливается,
 *      а мутация списка бьёт по кэшу промпта.
 *
 * Поэтому здесь: детектор состояния (событийный), фаза ВЫВОДИТСЯ из цвета гейта, а не из слов
 * задачи, и вмешательство делается БЛОКОМ С ПРИЧИНОЙ в момент намерения (`tool_call`).
 * `setActiveTools` остаётся только для read-only режима, где список стабилен всю сессию.
 *
 * ─── Состояние среды (наблюдаемый факт, не стадия агента) ───────────────────
 *   unknown       — baseline ещё не наблюдался (гейт не гонялся);
 *   greenfield    — сборочных файлов нет;
 *   baseline_green/baseline_red — результат дешёвого прогона базового состояния.
 * Красный baseline НЕ означает «целевой дефект воспроизведён»: он означает ровно то, что
 * видно — базовое состояние не зелёное. Вид сбоя хранится ОТДЕЛЬНО (failureKind).
 * Слова «reproduce»/«implement» — больше НЕ состояние системы, а legacy-режим формулировок
 * (legacyMode), который потом отдельно решит shadow/A-B.
 * Цвет состояния даёт один дешёвый прогон (фоновая сборка/тесты), он же — baseline для дельты.
 *
 * ─── Две точки блокировки ──────────────────────────────────────────────────
 *   1. запись при КРАСНОМ baseline: правки запрещены, пока модель не увидела падение в СВОЁМ
 *      контексте (вердикт гейта озвучен либо она сама прогнала и получила фейл);
 *   2. непроверенная дельта: после K правок без проверки следующие правки запрещены —
 *      K выводится из замеров (в прогоне OOM было 97 правок на 31 проверку ≈ 3.1, по умолчанию 4).
 * Плюс бюджет разведки: в greenfield без единого файла ПРОЕКТА после N шагов блокируется любое
 * исследование — по ЭФФЕКТУ (файлов нет), а не по имени инструмента.
 *
 * ─── Настройка ────────────────────────────────────────────────────────────────
 * env > `<проект>/.pi/harness.json` > умолчания. Профиль в файле — подсказка намерения
 * и потолок автономии, а не обязательный ручной выбор: он лишь сдвигает уточняемые числа.
 * Живая правка: команда `/nudge`.
 *
 * Проверяемость: чистые функции (детектор проекта, парсер ошибок, решения о блокировке)
 * вырезаются тестами — `node bench/test-measure.mjs`, `node bench/test-project-detect.mjs`,
 * `node bench/test-state.mjs`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Команды, которыми проект реально проверяется (проверено по --help у каждой подкоманды ast-index
// и на реальных прогонах). Без этого списка сборка не считалась проверкой.
const DEFAULT_VERIFY_PATTERNS = [
  'gradlew', 'gradle ', 'mvn', 'npm test', 'npm run', 'pnpm ', 'yarn ',
  'pytest', 'cargo build', 'cargo test', 'go build', 'go test', 'dotnet build',
  // `node `/`python ` широки намеренно: на задачах без сборочной системы проверка выглядит
  // как прогон скрипта (модель обычно пишет .py или .mjs и гоняет его). Если данные покажут,
  // что ловится лишнее, сузим.
  'node ', 'python ', 'python3 ', 'py ',
  'make', 'tsc ', 'cmake', 'ctest', 'ruff ', 'eslint', 'ktlint',
];

// Состояние среды — наблюдаемый факт, а не стадия работы агента. Слова 'reproduce'/'implement'
// здесь не встречаются: красный baseline не значит «целевой дефект воспроизведён».
type WorkspaceState = 'unknown' | 'greenfield' | 'baseline_green' | 'baseline_red';
// Вид сбоя — максимально механический. Сомневаешься — 'unknown': точное «не знаю»
// для измерителя лучше уверенной неправильной классификации.
type FailureKind = 'none' | 'test' | 'compile' | 'configuration' | 'dependency' | 'environment' | 'unknown';
const EVENT_SCHEMA_VERSION = 1;

// Legacy-адаптер: наблюдаемое состояние → старые формулировки политики/промпта.
// Это СЛОЙ ПРЕДСТАВЛЕНИЯ, а не состояние системы: нужен, чтобы не переписывать промпты v1–v4
// одновременно с миграцией данных. Позже shadow/A-B отдельно решит, нужна ли режиму
// baseline_red вообще своя политика (возможно, он исчезнет целиком).
type LegacyMode = 'greenfield' | 'reproduce' | 'implement';
function legacyMode(state: WorkspaceState): LegacyMode {
  if (state === 'baseline_red') return 'reproduce';
  if (state === 'baseline_green') return 'implement';
  return 'greenfield';
}

// Классификация сбоя: сначала СТРОГИЕ признаки окружения (включая сеть — это среда, а не граф
// зависимостей проекта), потом вид вердикта, потом текст. Сомнительное — 'unknown'.
// Порядок важен: сбой разрешения зависимостей случается на конфигурации, и без отдельной
// ветки он был бы записан в configuration.
function failureKindOf(verdictKind: string, output: string): FailureKind {
  if (verdictKind === 'success') return 'none';
  const o = output.slice(-40000);
  if (/SDK location not found|JAVA_HOME is not set|Unsupported class file major version|Could not find or load main class|Unsupported Java|Invalid toolchain|command not found|Could not resolve host|Could not connect|Connection timed out|Operation timed out|Network is unreachable|Could not GET/i.test(o)) return 'environment';
  if (verdictKind === 'compile_errors') return 'compile';
  if (verdictKind === 'test_failure') return 'test';
  if (verdictKind === 'environment') return 'environment';
  if (/Could not resolve all (files|dependencies)|Could not resolve [a-zA-Z0-9_.-]+:|Could not find (org|com|io|net|androidx|junit|dev)|Error resolving plugin|Plugin \[id: [^\]]+\] was not found|was not found in any of the following sources/i.test(o)) return 'dependency';
  if (verdictKind === 'config_failure' || verdictKind === 'task_missing'
      || /A problem occurred (evaluating|configuring)|Could not determine the dependencies/i.test(o)) return 'configuration';
  return 'unknown';
}

type Settings = {
  maxNudges: number;
  staleNudges: boolean;
  nudgeAfter: number;
  workNudgeAfter: number;
  nudgeHardAfter: number;
  repeatLimit: number;
  verifyPatterns: string[];
  reproPatterns: string[];
  gatePatterns: string[];
  autoVerify: boolean;
  autoVerifyCommand: string;
  autoVerifyTimeoutSec: number;
  autoVerifyRuns: number;
  reconTools: string[];
  stagnationAfter: number;
  editsBeforeVerifyBlock: number;
  // Shadow: гейт считает решение и ПИШЕТ его в лог, но не применяет. Абlation становится
  // бесплатным и идёт на каждом прогоне, по-гейтово. Плюс появляется главная статистика:
  // исправилась ли модель сама в пределах окна после того, как гейт сработал бы.
  shadow: boolean;
  shadowWindow: number;
  // Плечо A/B: имя ЕДИНСТВЕННОГО гейта, которому разрешено блокировать. Остальные при этом
  // продолжают считать и писать в журнал, но не вмешиваются. Без этого включение блокировок
  // включало бы все гейты разом, и по результату нельзя было бы понять, который подействовал.
  enforcedGate: string;
  blocking: boolean;
  readOnly: boolean;
  log: string;
  profile: string;
};

const BASE: Settings = {
  maxNudges: 3,
  staleNudges: false,
  nudgeAfter: 24,
  workNudgeAfter: 8,
  nudgeHardAfter: 40,
  repeatLimit: 4,
  verifyPatterns: DEFAULT_VERIFY_PATTERNS,
  reproPatterns: ['test', 'run', 'repro', 'install', 'adb ', 'am instrument', 'connectedandroidtest'],
  gatePatterns: ['gradlew', 'gradle ', 'mvn', 'npm test', 'npm run test', 'pytest', 'cargo test', 'go test', 'dotnet test', 'node ', 'python ', 'python3 ', 'py '],
  // УМОЛЧАНИЕ — НАБЛЮДЕНИЕ, А НЕ ВМЕШАТЕЛЬСТВО. Ни один гейт пока не доказал, что помогает:
  // это решает парный A/B (один и тот же прогон с гейтом и без), а он ещё не сделан.
  // Поэтому в обычной сессии `pi` надзиратель считает и пишет, но ничего не блокирует,
  // не напоминает и не запускает сборку за модель. Включить блокировки: BENCH_SHADOW=0
  // или `/nudge block=on` прямо в сессии.
  autoVerify: false,
  autoVerifyCommand: '',
  autoVerifyTimeoutSec: 900,
  autoVerifyRuns: 2,
  reconTools: ['web-search_get-web-search-summaries', 'web-search_full-web-search', 'web-search_get-single-web-page-content'],
  stagnationAfter: 24,
  editsBeforeVerifyBlock: 4,
  shadow: true,
  shadowWindow: 8,
  enforcedGate: '',
  blocking: true,
  readOnly: false,
  // Общий журнал: без него надзиратель молчит совсем и статистика на реальных задачах
  // не копится. Переопределяется BENCH_SUPERVISOR_LOG; пустое значение переменной отключает.
  log: path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.pi', 'agent', 'bench-harness.ndjson'),
  profile: '',
};

// Профиль — подсказка намерения и потолок автономии; числа уточняются фазой.
const PROFILES: Record<string, Partial<Settings>> = {
  'build-project': { stagnationAfter: 24, nudgeAfter: 24, workNudgeAfter: 8, editsBeforeVerifyBlock: 4, maxNudges: 2 },
  'existing-bug': { stagnationAfter: 8, nudgeAfter: 6, workNudgeAfter: 6, editsBeforeVerifyBlock: 3, maxNudges: 3 },
  'existing-feature': { stagnationAfter: 8, nudgeAfter: 6, workNudgeAfter: 6, editsBeforeVerifyBlock: 4, maxNudges: 3 },
  'search-only': { readOnly: true, staleNudges: false, blocking: false },
  'fix-first': { stagnationAfter: 8, nudgeAfter: 8, workNudgeAfter: 6, editsBeforeVerifyBlock: 4, maxNudges: 3 },
  'generate-artifact': { staleNudges: false, editsBeforeVerifyBlock: 3, maxNudges: 2 },
};

function loadSettings(trusted = true): Settings {
  let file: Partial<Settings> & { profile?: string } = {};
  try {
    // Конфиг проекта читаем только у доверенного проекта: иначе чужой каталог может
    // навязать надзирателю свои пороги и блокировки. Доверие — официальный признак pi.
    const p = path.join(process.cwd(), '.pi', 'harness.json');
    if (trusted && fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* битый файл настроек не должен ломать прогон */ }

  const envProfile = process.env.BENCH_PROFILE;
  const profileName = (envProfile && PROFILES[envProfile]) ? envProfile : (file.profile ?? '');
  const profile = profileName && PROFILES[profileName] ? PROFILES[profileName] : {};
  const { profile: _ignored, ...fromFile } = file;
  const merged: Settings = { ...BASE, ...profile, ...fromFile, profile: profileName };

  const num = (name: string, fallback: number) => (process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : fallback);
  const flag = (name: string, fallback: boolean) => (process.env[name] !== undefined ? process.env[name] === '1' : fallback);
  return {
    ...merged,
    nudgeAfter: num('BENCH_NUDGE_AFTER', merged.nudgeAfter),
    workNudgeAfter: num('BENCH_WORK_NUDGE_AFTER', merged.workNudgeAfter),
    nudgeHardAfter: num('BENCH_NUDGE_HARD_AFTER', merged.nudgeHardAfter),
    repeatLimit: num('BENCH_REPEAT_LIMIT', merged.repeatLimit),
    maxNudges: num('BENCH_MAX_NUDGES', merged.maxNudges),
    autoVerify: flag('BENCH_AUTO_VERIFY', merged.autoVerify),
    autoVerifyCommand: process.env.BENCH_AUTO_VERIFY_CMD ?? merged.autoVerifyCommand,
    autoVerifyTimeoutSec: num('BENCH_AUTO_VERIFY_TIMEOUT', merged.autoVerifyTimeoutSec),
    autoVerifyRuns: num('BENCH_AUTO_VERIFY_RUNS', merged.autoVerifyRuns),
    stagnationAfter: num('BENCH_STAGNATION_AFTER', num('BENCH_RECON_AFTER', merged.stagnationAfter)),
    editsBeforeVerifyBlock: num('BENCH_EDITS_BEFORE_VERIFY', merged.editsBeforeVerifyBlock),
    shadow: flag('BENCH_SHADOW', merged.shadow),
    enforcedGate: process.env.BENCH_ENFORCED_GATE ?? merged.enforcedGate,
    shadowWindow: num('BENCH_SHADOW_WINDOW', merged.shadowWindow),
    blocking: flag('BENCH_BLOCKING', merged.blocking),
    readOnly: flag('BENCH_READ_ONLY', merged.readOnly),
    log: process.env.BENCH_SUPERVISOR_LOG ?? merged.log ?? '',
  };
}

// ─── Детектор проекта (событийный) ────────────────────────────────────────────
// Корень переопределяется на КАЖДОМ шаге, а не один раз при старте: проект может появиться
// в подкаталоге через десять минут после начала (реальный промах: автосборка не нашла TodoApp/).

const MARKERS = ['settings.gradle.kts', 'settings.gradle', 'pom.xml', 'package.json', 'Cargo.toml', 'go.mod', 'build.gradle.kts'];
const SETTINGS_MARKERS = ['settings.gradle.kts', 'settings.gradle', 'pom.xml', 'package.json', 'Cargo.toml', 'go.mod'];
const IGNORED_DIRS = new Set(['runs', 'build', '.gradle', '.git', 'node_modules', 'out', 'bin', 'dist', 'tmp', '.tmp']);

function findProjectDirs(root: string): string[] {
  const markers = MARKERS;
  const candidates = [root];
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) candidates.push(path.join(root, e.name));
    }
  } catch { /* каталог недоступен */ }
  return candidates.filter(dir => markers.some(m => fs.existsSync(path.join(dir, m))));
}

function countSources(dir: string, depth = 0): number {
  if (depth > 3) return 0;
  let n = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) n += countSources(path.join(dir, e.name), depth + 1);
    } else if (/\.(kt|kts|java|py|js|mjs|ts|tsx|go|rs|rb|php|c|cpp|cs|swift)$/.test(e.name)) n += 1;
  }
  return n;
}

// Проект — по записям модели (ближайший предок записанного файла с признаком проекта),
// «где больше исходников» — только запасной путь: распакованный шаблон тоже похож на проект.
function projectDir(root: string, writtenPaths: string[] = []): string | undefined {
  for (const p of [...writtenPaths].reverse()) {
    let d = path.dirname(p);
    let nearestMarker: string | undefined;
    for (let i = 0; i < 12; i += 1) {
      if (!d.startsWith(root)) break;
      if (!nearestMarker && MARKERS.some(m => fs.existsSync(path.join(d, m)))) nearestMarker = d;
      if (SETTINGS_MARKERS.some(m => fs.existsSync(path.join(d, m)))) return d;
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    if (nearestMarker) return nearestMarker;
  }
  const found = findProjectDirs(root);
  if (!found.length) return undefined;
  return found.map(d => ({ d, n: countSources(d) })).sort((a, b) => b.n - a.n || a.d.length - b.d.length)[0].d;
}

function buildSystemPresent(dir: string, writtenPaths: string[] = []): boolean {
  return projectDir(dir, writtenPaths) !== undefined || (findProjectDirs(dir).length > 0 && writtenPaths.length === 0);
}

function skeletonReady(root: string, writtenPaths: string[] = []): boolean {
  const dir = projectDir(root, writtenPaths);
  if (!dir) return false;
  if (path.resolve(dir) !== path.resolve(root) && writtenPaths.length === 0) return false;
  const hasSettings = ['settings.gradle.kts', 'settings.gradle'].some(f => fs.existsSync(path.join(dir, f)));
  if (!hasSettings) return false;
  const moduleDirs = ['shared', 'androidApp', 'desktopApp', 'app', 'core', 'composeApp'];
  return moduleDirs.some(d => fs.existsSync(path.join(dir, d, 'src')) || fs.existsSync(path.join(dir, d, 'build.gradle.kts')));
}

// ─── Шаг 3: сырой наблюдатель дерева (ЗАМЕРЕННО ТУПОЙ) ───────────────────────
// Этот слой не знает, что такое «проект», «черновик», «сборка» или «мусор».
// Его единственное утверждение: «путь X появился/изменился/исчез». Классификация — следующий
// слой, и она обязана получить `nul` как СОЗДАННЫЙ файл (живой пример: `> nul` в bash создал
// файл `nul`, и он выдал себя за первый файл проекта — потому что классификация была вшита
// в наблюдение). Здесь этого произойти не может.
//
// mtime — только подсказка для перепроверки и НИКОГДА не источник истины о происхождении:
// «создано во время прогона» = «пути НЕ БЫЛО в снимке», а не «mtime > времени старта»
// (гранулярность ФС, распаковка, git checkout, восстановленные метки времени всё ломают).
// Порядок определяется seq и монотонным временем, а не файловым.

type FileEntry = { size: number; mtimeMs: number };
type Snapshot = Map<string, FileEntry>;
type WorkspaceDelta = { created: string[]; modified: string[]; deleted: string[] };

// Обход дерева. `ignore` — ТОЛЬКО производительность (метаданные VCS), а не классификация:
// исключать содержательные каталоги здесь нельзя, иначе observer начнёт скрывать факты.
function snapshotTree(root: string, ignore: Set<string> = new Set(['.git'])): Snapshot {
  const out: Snapshot = new Map();
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 12 || out.size > 200000) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!ignore.has(e.name)) walk(abs, r, depth + 1);
      } else if (e.isFile()) {
        try { const st = fs.statSync(abs); out.set(r, { size: st.size, mtimeMs: st.mtimeMs }); } catch { /* исчез */ }
      }
    }
  };
  walk(root, '', 0);
  return out;
}

// Дельта относительно снимка: created = пути НЕ БЫЛО раньше; deleted = пропал; modified = есть,
// но изменился. При совпадении размера и изменения mtime — это лишь повод перепроверить хэшем.
function diffSnapshot(before: Snapshot, after: Snapshot): WorkspaceDelta {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [p, e] of after) {
    const b = before.get(p);
    if (!b) created.push(p);
    else if (b.size !== e.size || b.mtimeMs !== e.mtimeMs) modified.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
  return { created: created.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

// ─── Наблюдаемый эффект вместо парсинга намерений ────────────────────────────
// Правило: гейт через ИМЯ инструмента обходится через bash (curl, wget, git clone).
// Но и ИСКЛЮЧЕНИЯ ПО ИМЕНИ КАТАЛОГА — та же дыра: чёрный список протекает всегда.
// Живой пример: `> nul` в bash создал файл `nul` — его нет ни в одном списке исключений,
// и он выдал себя за первый файл проекта (first_file на шаге 2).
// Поэтому — только белый список: считаем ЛИШЬ то, что выглядит артефактом проекта.
// Whitelist был чисто JVM-овым, и на веб-задаче (единственный .html-файл) это давало
// нулевые мутации: артефакт модели считался OTHER, прогресса не было никогда, гейт застоя
// висел до конца прогона, а verify-delta не открывался ни разу. Измеритель нужно было бы
// чинить прямо во время серии — поэтому расширяем ДО неё.
const PROJECT_FILE_RE = /\.(kt|kts|java|gradle|groovy|toml|properties|xml|pro|html|htm|css|js|mjs|cjs|ts|tsx|jsx|json|py|rs|go|c|h|cpp|hpp)$/i;
const PROJECT_FILE_NAMES = /^(settings\.gradle|build\.gradle|gradle\.properties|libs\.versions\.toml|gradlew|gradlew\.bat|AndroidManifest\.xml)/i;

function isProjectFile(rel: string): boolean {
  const name = rel.split('/').pop() ?? rel;
  return PROJECT_FILE_RE.test(name) || PROJECT_FILE_NAMES.test(name);
}

// Классификация пути — ОТДЕЛЬНЫЙ слой над наблюдением. Observer сообщает любой новый путь
// (включая `nul`); здесь решается, чем он является. Пятый класс OTHER обязателен: `nul` не
// project, не research, не harness и не generated — без него появится ложная классификация.
// Каждый ответ несёт reason: иначе offline-анализ не отличит «PROJECT по расширению» от
// «PROJECT по имени», и спор о метрике превращается в чтение регекспов.
type ArtifactClass = 'PROJECT' | 'RESEARCH' | 'HARNESS' | 'GENERATED' | 'OTHER';
const HARNESS_DIRS = new Set(['.pi', 'runs', '.supervisor', '.benchmark']);
const GENERATED_DIRS = new Set(['build', '.gradle', 'node_modules', 'target', 'dist', 'out', '__pycache__', '.idea']);
const RESEARCH_DIRS = new Set(['.research', 'notes', 'scratch']);

// Именованный тип, а не литерал в сигнатуре: тесты вырезают функцию из .ts текстом,
// и `): { ... }` их чистилка не разбирает.
type ArtifactFact = { cls: ArtifactClass; reason: string };

function classifyArtifact(rel: string): ArtifactFact {
  const parts = rel.split('/');
  const name = parts[parts.length - 1] ?? rel;
  const dirs = parts.slice(0, -1);
  // Каталоги проверяются ПЕРВЫМИ: `build/foo.kt` — вывод сборки, хотя расширение проектное.
  // Порядок среди каталогов не важен (множества не пересекаются), важен приоритет над именем.
  for (const d of dirs) {
    if (HARNESS_DIRS.has(d)) return { cls: 'HARNESS', reason: `harness_dir:${d}` };
    if (GENERATED_DIRS.has(d)) return { cls: 'GENERATED', reason: `build_output_dir:${d}` };
    if (RESEARCH_DIRS.has(d)) return { cls: 'RESEARCH', reason: `research_dir:${d}` };
  }
  if (PROJECT_FILE_NAMES.test(name)) return { cls: 'PROJECT', reason: 'project_marker_name' };
  if (PROJECT_FILE_RE.test(name)) return { cls: 'PROJECT', reason: 'source_extension' };
  return { cls: 'OTHER', reason: 'no_project_evidence' };
}

// ─── Запись файла и запуск сборки в bash (только подсказка для причины) ──────

// Запись файла: редирект в файл. Heredoc сам по себе — не запись (`python - <<EOF` кормит stdin).
function isBashWrite(cmd: string): boolean {
  const re = /(?<![0-9])>>?\s*(?:'([^']+)'|"([^"]+)"|(\/?(?:[\w.@+-]+\/)*[\w.@+-]+))/g;
  for (const m of cmd.matchAll(re)) {
    const target = m[1] ?? m[2] ?? m[3] ?? '';
    if (!target || target.startsWith('/dev/') || /^&[12]$/.test(target)) continue;
    if (!/^[\w.@+\/-]{2,}$/.test(target) || !/[.\/]/.test(target)) continue;
    return true;
  }
  return false;
}

// Запуск сборки — именно ВЫЗОВ, а не упоминание: «chmod +x gradlew» и URL с gradle — не сборка.
function isBuildCmd(cmd: string): boolean {
  if (/(^|[;&|]\s*)(\.\/|[\w.@-]*[\\/])?gradlew(\.bat)?(\s+[-:a-zA-Z]|\s*$)/m.test(cmd)) return true;
  if (/(^|[;&|"'\s])gradlew(\.bat)?\s+[:a-zA-Z]/.test(cmd)) return true;
  return /(^|[;&|]\s*)gradle\s+[:a-zA-Z]/.test(cmd);
}

// ─── Парсер результата сборки: вердикт + ДЕЛЬТА ошибок ───────────────────────
// Полный лог Gradle в контекст отдавать нельзя (на 50+ модулях это портянка на тысячи строк).
// Отдаём: вердикт, новые ошибки, число уже виденных. new/seen — по хэшу строки,
// чтобы модель видела прогресс, а не один и тот же список.

type Verdict = { kind: string; speak: boolean; text: string; newErrors: string[]; seenErrors: number };

const hashLine = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);

function parseBuildResult(output: string, seconds: number, seen: Set<string> = new Set()): Verdict {
  const o = output.slice(-40000);
  const lineOf = re => o.split(/\r?\n/).filter(l => re.test(l)).slice(0, 8);

  if (/BUILD SUCCESSFUL/i.test(o)) {
    return { kind: 'success', speak: true, newErrors: [], seenErrors: 0, text: `Автопроверка: сборка прошла за ${seconds} с — версии и окружение рабочие.` };
  }

  // Файл настроек/резолв — здесь строк `e:` не будет вовсе, и гейт молчал бы «пусто».
  const config = /could not resolve|failed to resolve|no matching variant|plugin \[[^\]]+\] was not found|error resolving plugin|could not be satisfied/i.test(o);
  if (config) {
    const lines = lineOf(/could not resolve|failed to resolve|error resolving plugin|could not be satisfied/i);
    return { kind: 'config_failure', speak: true, newErrors: [], seenErrors: 0, text: `Автопроверка: НЕ РАЗРЕШАЮТСЯ ЗАВИСИМОСТИ/ПЛАГИНЫ (${seconds} с) — это провал подбора версий, чини его до кода:\n${lines.join('\n')}` };
  }
  if (/sdk location not found|android_sdk_root|failed to install|java_home/i.test(o)) {
    return { kind: 'environment', speak: true, newErrors: [], seenErrors: 0, text: `Автопроверка: проблема окружения (${seconds} с), а не кода. Проверяй путь SDK/JDK по переменным.` };
  }
  if (/task '[^']+' not found/i.test(o)) {
    return { kind: 'task_missing', speak: true, newErrors: [], seenErrors: 0, text: `Автопроверка: задача сборки не найдена (${seconds} с) — проверь подключение модулей.` };
  }

  const testFailed = /tests? completed,\s*\d+\s*failed|\d+\s*tests? completed,\s*\d+\s*failed|AssertionFailedError|>\s*Task\s+:\S*[Tt]est\S*\s+FAILED/i.test(o);
  if (testFailed) {
    const lines = lineOf(/FAILED|tests? completed/i);
    return { kind: 'test_failure', speak: true, newErrors: [], seenErrors: 0, text: `Автопроверка: ТЕСТЫ ПАДАЮТ (${seconds} с) — это воспроизведение. Смотри, что проверяет упавший тест:\n${lines.join('\n')}` };
  }

  // Ошибки компиляции: отдаём только новые строки `e: ...`, остальные считаем.
  const errors = lineOf(/^e: \S+\.(kt|java|kts)|\berror:/i);
  const fresh: string[] = [];
  let seenCount = 0;
  for (const line of errors) {
    const h = hashLine(line.trim());
    if (seen.has(h)) seenCount += 1;
    else { seen.add(h); fresh.push(line.trim().slice(0, 200)); }
  }
  if (errors.length) {
    const body = fresh.length
      ? `новых ${fresh.length}:\n${fresh.join('\n')}`
      : `новых нет (все ${seenCount} уже показывались — правки их не сняли)`;
    return { kind: 'compile_errors', speak: fresh.length > 0, newErrors: fresh, seenErrors: seenCount, text: `Автопроверка: ошибки компиляции (${seconds} с), ${body}` };
  }

  return { kind: 'unknown', speak: false, newErrors: [], seenErrors: 0, text: `сборка завершилась неудачно за ${seconds} с, причина не распознана` };
}

// Подпись сбоя: ЧТО именно сломано, без номеров прогона, времени и путей сборки.
// Нужна, чтобы отличить «модель сдвинула ошибку» от «та же ошибка в десятый раз»:
// повторный одинаковый FAIL прогрессом не является, иначе цикл test→read→test→read
// держал бы счётчик застоя у нуля, а модель при этом стоит на месте.
function failureSignature(kind: string, output: string): string {
  const o = output.slice(-40000);
  const lines = o.split(/\r?\n/)
    .filter(l => /^e: \S+\.(kt|java|kts)|\berror:|could not resolve|failed to resolve|error resolving plugin|tests? completed,\s*\d+\s*failed|FAILED/i.test(l))
    .map(l => l.trim().replace(/\d+/g, '#').slice(0, 200))   // номера строк и счётчики — шум
    .sort()
    .slice(0, 12);
  return `${kind}:${lines.length ? hashLine(lines.join('\n')) : 'none'}`;
}

// Совместимость с тестами фикстур: старый контракт «вердикт» без дельты.
function classifyBuild(output: string, seconds: number) {
  const v = parseBuildResult(output, seconds, new Set());
  return { kind: v.kind, speak: v.speak, text: v.text };
}

// ─── Решения о блокировке (чистая функция — тестируется отдельно) ────────────

type BlockInput = {
  state: WorkspaceState;
  toolName: string;
  command: string;
  writtenPaths: string[];
  edits: number;
  projectFiles: number;
  draftFiles: number;
  verifications: number;
  lastVerifiedTouched: number;
  reproSeenInContext: boolean;
  steps: number;
  // Шагов с последнего СДВИГА наблюдаемого состояния (см. noteProgress). Единица порога —
  // шаги, а не время: секунды зависят от кванта, длины контекста и попадания в кэш промпта,
  // и прогоны перестали бы быть сравнимыми. Время пишется рядом в лог как факт.
  stepsSinceProgress: number;
  S: Settings;
};

// 'stagnation' — бывший 'recon'. Переименован по существу: после перехода на счётчик застоя
// он ловит не «разведку», а ЛЮБОЕ отсутствие сдвига — 20 curl подряд, бесконечное
// перечитывание, повтор одного и того же падающего теста. Одна абстракция вместо трёх эвристик.
type GateId = 'repro' | 'verify-delta' | 'stagnation';
type GateDecision = { gate: GateId; reason: string };

// Условие гейта — функция ТОЛЬКО от состояния, без инструмента. Разделение нужно для
// edge-триггера: эпизод открывается, когда состояние стало проблемным, а не когда модель
// случайно попросила подходящий инструмент. Иначе «условие истинно 20 шагов» превращается
// в 20 «срабатываний» или в ноль — в зависимости от того, чем модель занималась.
// Имя инструмента решает только, ПРИМЕНИМ ли блок к этому вызову (см. decideGate).
function gateConditions(i: BlockInput): GateId[] {
  const open: GateId[] = [];
  // Застой — ДИНАМИКА, а не состояние дерева. Прежнее `projectFiles === 0` умирало после
  // любой массовой материализации (unzip шаблона, git clone, gradle init): файлы есть,
  // гейт молчит навсегда — ровно в том прогоне, против которого он и задуман (43 файла
  // из распаковки, 56 шагов, ни одной правки). Сколько файлов уже лежит — не важно.
  if (i.stepsSinceProgress >= i.S.stagnationAfter) open.push('stagnation');
  if (i.state === 'baseline_red' && !i.reproSeenInContext) open.push('repro');
  if (i.projectFiles - i.lastVerifiedTouched >= i.S.editsBeforeVerifyBlock) open.push('verify-delta');
  return open;
}

// Без аннотации типа: TS выводит её сам, а чистилка тестов (lib-ts-extract) разбирает
// только аннотации параметров и возврата — `Record<...>` в const она не осилит.
const GATE_REASON = {
  // По ЭФФЕКТУ, а не по имени инструмента: N шагов без единого сдвига наблюдаемого состояния.
  // Так ловится и web-search, и curl, и бесконечный read/ls, и повтор одного падающего теста —
  // не трогая работу, которая реально что-то меняет.
  stagnation: i => `${i.stepsSinceProgress} шагов без единого изменения: ни правки файла проекта, `
    + 'ни новой ошибки, ни смены результата сборки. Сделай материальный шаг — правку или проверку, '
    + 'которая даст новый результат: перечитывание одного и того же новых данных не приносит.',
  repro: () => 'Базовое состояние сборки КРАСНОЕ, но ты ещё не видел падения сам. Прогони падающий тест/сценарий '
    + 'и покажи результат — после этого правки разрешены.',
  // Дельта измеряется ФАКТОМ изменения файлов, а не числом правок: правка может не изменить
  // файл, а создание файла может прийти из bash/генератора (tee, sed -i, gradle init).
  'verify-delta': i => `Изменилось ${i.projectFiles - i.lastVerifiedTouched} файлов без проверки. Собери проект или прогони тесты — `
    + 'потом продолжай правки: иначе ты правишь вслепую.',
};

// Решение гейта вместе с его именем: нужно, чтобы ablation считался ПО-ГЕЙТОВО, а не одной ручкой.
function decideGate(i: BlockInput): GateDecision | null {
  if (!i.S.blocking) return null;
  if (i.S.readOnly) return { gate: 'repro', reason: 'Режим только чтения: изменения запрещены.' };

  const writes = i.toolName === 'write' || i.toolName === 'edit'
    || (i.toolName === 'bash' && isBashWrite(i.command));
  const open = gateConditions(i);
  // Разведку режем только у НЕ-пишущих вызовов, остальные гейты — только у пишущих.
  const applicable: GateId[] = writes ? ['repro', 'verify-delta'] : ['stagnation'];
  const gate = applicable.find(g => open.includes(g));
  return gate ? { gate, reason: GATE_REASON[gate](i) } : null;
}

// Совместимость: причина блокировки строкой (контракт тестов).
function decideBlock(i: BlockInput): string | null {
  return decideGate(i)?.reason ?? null;
}

// ─── Расширение ──────────────────────────────────────────────────────────────

export default function activate(pi: ExtensionAPI) {
  let S = loadSettings();

  let steps = 0;
  let edits = 0;
  // Главный измеритель прогресса — ФАКТ изменения файлов (git/mtime), а не намерение в вызове.
  let projectFiles = 0;
  let draftFiles = 0;
  let firstFileStep: number | null = null;
  // Снимок дерева на старте: источник истины о том, что СУЩЕСТВОВАЛО до прогона.
  let snapshot: Snapshot = new Map();
  const sessionStartMs = Date.now();
  let verifications = 0;
  let lastVerifiedEdits = 0;
  let lastVerifiedTouched = 0;
  let reproSeenInContext = false;
  let nudges = 0;
  let lastNudgeStep = -1000;
  let gateStatus: 'unknown' | 'red' | 'green' = 'unknown';
  let gateKind = '';
  // Shadow-эпизоды: ОДИН эпизод на непрерывный отрезок, где условие гейта истинно.
  // Раньше здесь был один слот на все гейты, и он переписывался каждым шагом — длинный
  // заскок модели считался как N срабатываний, а параллельный гейт затирал предыдущий.
  // Теперь по эпизоду на гейт: открылся на фронте, закрылся когда условие ушло.
  type Episode = {
    id: string; gate: GateId; openedAtStep: number; openedAtMs: number;
    openState: WorkspaceState; retriggers: number; persistedLogged: boolean;
    filesAtOpen: number; verifiesAtOpen: number;
  };
  const episodes = new Map<GateId, Episode>();
  let episodeCount = 0;
  let inputShapeLogged = false;
  // Команда последнего вызова. На `tool_execution_end` событие приходит БЕЗ input (проверено
  // живым прогоном: keys []), поэтому единственный источник текста команды — `tool_call`.
  // Без этого ветка «это была проверка» не срабатывала ни разу: gradlew/pytest не засчитывались,
  // и любой прогон показывал 0 проверок, а write burst не закрывался никогда.
  let lastToolCommand = '';
  let autoVerifyRuns = 0;
  let autoVerifyBusy = false;
  let workspaceState: WorkspaceState = 'unknown';
  let failureKind: FailureKind = 'unknown';
  let baselineObserved = false;
  const writtenPaths: string[] = [];
  const errorHashes = new Set<string>();
  const repeats = new Map<string, number>();

  let seq = 0;
  // Схема событий v1: единственный источник истины. Метрики считаются offline из этого лога.
  // {"event": "...", "eventSchemaVersion": 1, "seq": N, "workspaceState": ..., "failureKind": ...}
  const record = (event: string, extra: Record<string, unknown> = {}) => {
    if (!S.log) return;
    try {
      seq += 1;
      fs.appendFileSync(S.log, `${JSON.stringify({
        at: new Date().toISOString(), event, eventSchemaVersion: EVENT_SCHEMA_VERSION, seq,
        steps, edits, verifications, nudges, workspaceState, failureKind, gate: gateStatus, ...extra,
      })}\n`);
    } catch { /* телеметрия не должна ломать прогон */ }
  };

  const say = (text: string) => {
    try { pi.sendUserMessage(text, { deliverAs: 'steer' }); } catch { /* сессия закрыта */ }
  };

  // ─── Write burst: сколько мутаций ПРОЕКТА прошло между попытками проверки ────
  // Единица измерения — не `editsPerVerify` (среднее прячет ровно тот хвост, ради которого
  // гейт и существует), а отрезок «проверка → мутации → проверка». Кривая
  // P(следующая проверка упала | длина burst) считается offline; supervisor только пишет факты.
  //
  // Граница burst — ЛЮБАЯ попытка проверки, а не только успешная: последовательность
  // 3 мутации→FAIL→2 мутации→FAIL→1→PASS обязана дать три наблюдения, иначе кривая строится
  // по слипшимся отрезкам. «Мутаций с последней УСПЕШНОЙ проверки» — другая метрика,
  // она нужна final-verify, а не выбору K.
  //
  // Что считается мутацией: только путь класса PROJECT из WorkspaceDelta. Поэтому burst
  // не зависит от инструмента — edit, write, bash, python, генератор дают одинаковый факт.
  let burstId = 0;
  const newBurst = () => ({
    id: (burstId += 1), startStep: steps, startSeq: seq, mutations: 0,
    files: new Set<string>(), created: 0, modified: 0, deleted: 0,
  });
  let burst = newBurst();

  // Провал стенда отделяется от провала кода тем же механическим классификатором, что и
  // baseline (failureKindOf), а не отдельным списком регекспов: один источник правды.
  const verifyResult = (failed: boolean, output: string) => {
    if (!failed) return 'pass';
    return failureKindOf('unknown', output) === 'environment' ? 'infra_error' : 'fail';
  };

  // ─── Прогресс: сдвиг наблюдаемого состояния, а не «что-то произошло» ────────
  // Разделение существенное. АКТИВНОСТЬ — любое заметное действие (проверка, чтение,
  // распаковка). ПРОГРЕСС — только изменение того, что видно снаружи. Иначе цикл
  //   test → FAIL(A) → read → test → FAIL(A) → read → …
  // держал бы счётчик застоя у нуля, хотя модель стоит на месте: каждая попытка проверки
  // «сбрасывала» бы таймер. Поэтому повторный сбой с ТОЙ ЖЕ подписью прогрессом не считается.
  let lastProgressStep = 0;
  let lastProgressMs = Date.now();
  let lastProgressKind = 'session_start';
  let lastFailureSignature = '';
  const noteProgress = (kind: string, detail = '') => {
    lastProgressStep = steps;
    lastProgressMs = Date.now();
    lastProgressKind = kind;
    record('progress', { kind, detail: detail.slice(0, 120) });
  };
  const stepsSinceProgress = () => steps - lastProgressStep;

  // Сдвиг результата проверки: смена подписи сбоя ИЛИ смена исхода (fail→pass, unknown→fail).
  // Одинаковый провал десятый раз подряд — не сдвиг.
  const noteVerification = (result: string, kind: string, output: string) => {
    const sig = `${result}/${failureSignature(kind, output)}`;
    if (sig !== lastFailureSignature) {
      const was = lastFailureSignature || '(первая проверка)';
      lastFailureSignature = sig;
      noteProgress('verification_changed', `${was} → ${sig}`);
    }
  };

  // ─── Final verify: «завершить работу с непроверенным деревом» ───────────────
  // ОТДЕЛЬНАЯ величина от write burst, и разница принципиальна:
  //   write burst  — мутации с ЛЮБОЙ попытки проверки (нужно для выбора K);
  //   final verify — мутации с последней УСПЕШНОЙ проверки (нужно для «можно ли заканчивать»).
  // Последовательность 3 мутации→FAIL→1 мутация→FAIL→finish даёт два burst'а И грязный финиш.
  //
  // Условие — сравнение порядка, а не флаг «проверка когда-то была»: зелёный baseline ДО
  // правки ничего не доказывает про состояние ПОСЛЕ неё.
  let lastProjectMutationSeq = 0;
  let lastVerificationSeq = 0;
  let lastVerificationResult = 'none';
  let lastSuccessfulVerifySeq = 0;
  let dirtyMutations = 0;
  const dirtyFiles = new Set<string>();

  const burstAdd = (p: string, kind: string) => {
    // Мутация файла проекта — прогресс независимо от того, сколько файлов уже лежит
    // и чем они созданы. Распаковка шаблона даёт ОДИН сдвиг на своём шаге, и дальше
    // счётчик застоя снова растёт: атрибуция «кто создал файл» не нужна вовсе.
    if (lastProgressStep !== steps || lastProgressKind !== 'project_mutation') noteProgress('project_mutation', `${kind} ${p}`);
    lastProjectMutationSeq = seq;
    dirtyMutations += 1;
    dirtyFiles.add(p);
    burst.mutations += 1;
    burst.files.add(p);
    if (kind === 'created') burst.created += 1;
    else if (kind === 'modified') burst.modified += 1;
    else burst.deleted += 1;
  };

  // Результат проверки: pass / fail / infra_error / unknown. `infra_error` (упал демон Gradle,
  // нет JDK, нет сети) НЕЛЬЗЯ смешивать с fail — иначе длинный burst получит вину за поломку
  // стенда, и кривая K будет построена на шуме локальной машины.
  const closeBurst = (kind: string, result: string) => {
    record('write_burst_closed', {
      burstId: burst.id, mutations: burst.mutations, uniqueFiles: burst.files.size,
      created: burst.created, modified: burst.modified, deleted: burst.deleted,
      stepsOpen: steps - burst.startStep, startSeq: burst.startSeq,
      verification: { kind, result },
      // Правый цензор: при ВКЛЮЧЁННОЙ блокировке длина burst ограничена сверху самим гейтом,
      // и выводить из такого распределения новый K нельзя (порог доказывал бы сам себя).
      censored: S.blocking && !S.shadow && burst.mutations >= S.editsBeforeVerifyBlock,
    });
    burst = newBurst();
    // Счётчик грязи снимает только УСПЕХ. FAIL закрывает burst, но дерево остаётся
    // непроверенным — иначе «правка → тест упал → finish» выглядел бы чистым завершением.
    lastVerificationSeq = seq;
    lastVerificationResult = result;
    if (result === 'pass') {
      lastSuccessfulVerifySeq = seq;
      dirtyMutations = 0;
      dirtyFiles.clear();
    }
  };

  // Наблюдение дерева после каждого инструмента. Слои разделены жёстко:
  //   measurement (snapshotTree/diffSnapshot) → факт «путь появился/изменился/исчез»;
  //   classification (classifyArtifact → класс + reason, пять классов вместе с OTHER);
  //   metric (projectFiles, firstProjectArtifact) → число.
  const projectTouched = new Set<string>();
  const draftTouched = new Set<string>();
  const syncWorkspace = () => {
    const after = snapshotTree(process.cwd());
    const d = diffSnapshot(snapshot, after);
    if (d.created.length || d.modified.length || d.deleted.length) {
      record('workspace_delta', {
        created: d.created.slice(0, 20), createdCount: d.created.length,
        modified: d.modified.slice(0, 20), modifiedCount: d.modified.length,
        deleted: d.deleted.slice(0, 20), deletedCount: d.deleted.length,
      });
    }
    snapshot = after;

    // RESEARCH считается ОТДЕЛЬНО, а не «всё непроектное = черновик»: если черновики
    // систематически предшествуют первому исходнику, гейт разведки нельзя вешать на
    // «ноль файлов проекта». HARNESS/GENERATED/OTHER не считаются вовсе — это не работа модели.
    for (const p of d.created) if (classifyArtifact(p).cls === 'PROJECT') { projectTouched.add(p); burstAdd(p, 'created'); }
    for (const p of d.modified) if (classifyArtifact(p).cls === 'PROJECT') { projectTouched.add(p); burstAdd(p, 'modified'); }
    for (const p of [...d.created, ...d.modified]) if (classifyArtifact(p).cls === 'RESEARCH') draftTouched.add(p);
    for (const p of d.deleted) {
      if (classifyArtifact(p).cls === 'PROJECT') burstAdd(p, 'deleted');
      projectTouched.delete(p); draftTouched.delete(p);
    }

    // Метрика первого артефакта ПРОЕКТА: строго CREATED и строго проектный класс.
    // Не «любой новый файл», не «mtime > старта», не «первое действие записи».
    if (firstFileStep === null) {
      const firstCreated = d.created.find(p => classifyArtifact(p).cls === 'PROJECT');
      if (firstCreated) {
        firstFileStep = steps;
        record('first_project_artifact', {
          path: firstCreated, reason: classifyArtifact(firstCreated).reason, steps,
          minutes: Number(((Date.now() - sessionStartMs) / 60000).toFixed(1)),
          draftsBefore: draftTouched.size, projectFiles: projectTouched.size,
        });
      }
    }
    projectFiles = projectTouched.size;
    draftFiles = draftTouched.size;
    return projectFiles;
  };

  // Состояние среды выводится из наблюдаемых фактов: нет сборочного файла → greenfield;
  // иначе — по результату baseline-прогона. Красный baseline НЕ трактуется как «дефект найден»:
  // вид сбоя лежит отдельно в failureKind. Никаких ключевых слов из текста задачи.
  const recomputeWorkspaceState = () => {
    const root = process.cwd();
    const next: WorkspaceState = !buildSystemPresent(root, writtenPaths)
      ? 'greenfield'
      : (gateStatus === 'unknown' ? 'unknown' : (gateStatus === 'green' ? 'baseline_green' : 'baseline_red'));
    if (next !== workspaceState) {
      // Переход пишем ЯВНО (from/to). Общие поля события (workspaceState) не должны быть
      // двусмысленными: иначе baseline_observed утверждает ws=unknown при зелёном гейте.
      const from = workspaceState;
      workspaceState = next;
      record('state_change', {
        from, to: next,
        reason: gateStatus === 'unknown' ? 'no build system' : `gate=${gateKind}`,
        source: 'detector',
        // Оба источника рядом: ярлык профиля — только override порогов, состоянием он не управляет.
        profileHint: S.profile || '(нет)',
        legacyMode: legacyMode(next),
        thresholds: { nudgeAfter: S.nudgeAfter, workNudgeAfter: S.workNudgeAfter, stagnationAfter: S.stagnationAfter, editsBeforeVerifyBlock: S.editsBeforeVerifyBlock },
      });
      noteProgress('workspace_state_changed', `${from} → ${next}`);
    }
  };

  // ─── Shadow-эпизоды: фронт открывает, спад закрывает ────────────────────────
  // Вызывается после КАЖДОГО наблюдаемого изменения состояния, а не только на вызове
  // инструмента: условие может уйти само (модель создала файл, прогнала сборку), и этот
  // момент — самое ценное в логе («исправилась ли она без вмешательства»).
  const currentInput = (): BlockInput => ({
    state: workspaceState, toolName: '', command: '', writtenPaths,
    edits, projectFiles, draftFiles, verifications, lastVerifiedTouched,
    reproSeenInContext, steps, stepsSinceProgress: stepsSinceProgress(), S,
  });

  // Эпизод без парного `closed` в логе означает «прогон кончился, пока условие держалось» —
  // отдельного кода для этого не нужно, offline-анализ видит это по самому логу.
  const syncEpisodes = () => {
    const open = new Set(gateConditions(currentInput()));
    for (const gate of open) {
      if (episodes.has(gate)) {
        // Условие всё ещё истинно — это ТОТ ЖЕ эпизод. Нового события нет.
        const e = episodes.get(gate)!;
        if (!e.persistedLogged && steps - e.openedAtStep >= S.shadowWindow) {
          e.persistedLogged = true;
          // Не закрытие: модель застряла, но эпизод продолжается. Отдельный сигнал —
          // P(persist >= H | gate) считается offline именно по нему.
          record('shadow_episode_persisted', { episodeId: e.id, gate, stepsOpen: steps - e.openedAtStep, window: S.shadowWindow });
        }
        continue;
      }
      episodeCount += 1;
      const e: Episode = {
        id: `${gate}-${String(episodeCount).padStart(4, '0')}`, gate, openedAtStep: steps, openedAtMs: Date.now(),
        openState: workspaceState, retriggers: 0, persistedLogged: false,
        filesAtOpen: projectFiles, verifiesAtOpen: verifications,
      };
      episodes.set(gate, e);
      record('shadow_episode_opened', {
        episodeId: e.id, gate, enforced: !S.shadow && S.blocking,
        state: { projectFiles, draftFiles, verifications, filesSinceVerify: projectFiles - lastVerifiedTouched, steps },
        stepsSinceProgress: stepsSinceProgress(), msSinceProgress: Date.now() - lastProgressMs, lastProgressKind,
      });
    }
    for (const [gate, e] of [...episodes]) {
      if (open.has(gate)) continue;
      episodes.delete(gate);
      const verifiesSince = verifications - e.verifiesAtOpen;
      const filesSince = projectFiles - e.filesAtOpen;
      // Что именно сняло условие — важнее самого факта закрытия: гейт, который всегда
      // снимается сам через шаг-два, не нужен.
      const kind = verifiesSince > 0 ? 'verification'
        : filesSince > 0 ? 'productive_write'
        : workspaceState !== e.openState ? 'phase_changed'
        : 'condition_cleared';
      record('shadow_episode_closed', {
        episodeId: e.id, gate, resolution: kind,
        stepsOpen: steps - e.openedAtStep, msOpen: Date.now() - e.openedAtMs,
        retriggers: e.retriggers, verifiesSince, filesSince, persisted: e.persistedLogged,
        lastProgressKind, stepsSinceProgress: stepsSinceProgress(),
      });
    }
  };

  const maybeNudge = (kind: string, text: string, stale: number) => {
    if (nudges >= S.maxNudges) return;
    const base = workspaceState === 'greenfield' ? S.nudgeAfter : S.workNudgeAfter;
    const cooldown = Math.max(4, Math.floor(Math.max(1, base) / 3));
    if (nudges > 0 && steps - lastNudgeStep < cooldown) return;
    nudges += 1;
    lastNudgeStep = steps;
    record(kind, { stale, cooldown });
    say(text);
  };

  // Гейт: один дешёвый прогон даёт цвет (baseline) и дельту ошибок.
  const runGate = async () => {
    if (!S.autoVerify || autoVerifyBusy || autoVerifyRuns >= S.autoVerifyRuns) return;
    const root = process.cwd();
    if (!skeletonReady(root, writtenPaths)) return;
    autoVerifyBusy = true;
    autoVerifyRuns += 1;
    const cwd = projectDir(root, writtenPaths) ?? root;
    const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
    const configured = S.autoVerifyCommand;
    const task = fs.existsSync(path.join(cwd, 'shared', 'build.gradle.kts')) ? ':shared:compileKotlinJvm' : 'build';
    const cmd = configured ? configured.split(/\s+/)[0] : path.join(cwd, gradlew);
    const args = configured ? configured.split(/\s+/).slice(1) : [task, '--console=plain', '--no-daemon'];
    record('gate_start', { cmd: path.basename(cmd), args: args.join(' ') });
    const started = Date.now();
    const isWin = process.platform === 'win32';
    const bin = isWin ? (process.env.ComSpec ?? 'cmd.exe') : cmd;
    const binArgs = isWin ? ['/c', cmd, ...args] : args;
    const output = await new Promise<string>(resolve => {
      execFile(bin, binArgs, { cwd, timeout: S.autoVerifyTimeoutSec * 1000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => resolve(`${stdout || ''}\n${stderr || ''}${error && !stdout && !stderr ? String(error.message) : ''}`));
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    const verdict = parseBuildResult(output, seconds, errorHashes);
    gateKind = verdict.kind;
    gateStatus = verdict.kind === 'success' ? 'green' : 'red';
    // Вид сбоя — отдельно от состояния. Механическая классификация: не уверен — unknown.
    failureKind = failureKindOf(verdict.kind, output);
    // СНАЧАЛА переводим состояние (оно — часть результата наблюдения), потом пишем
    // baseline_observed. Иначе событие утверждает ws=unknown при зелёном гейте,
    // и offline-анализу приходится угадывать, где результат, а где прежнее состояние.
    recomputeWorkspaceState();
    if (!baselineObserved) {
      baselineObserved = true;
      record('baseline_observed', { verdict: verdict.kind, seconds });
    }
    // Вердикт гейта попадает в контекст модели → требование «увидеть падение» выполнено.
    // Прогон гейта — это проверка: без этого модель сразу после первой правки получает
    // напоминание «ты ничего не проверял», хотя тесты только что гоняла обвязка.
    verifications += 1;
    lastVerifiedEdits = edits;
    lastVerifiedTouched = projectFiles;
    // Прогон гейта — такая же попытка проверки, как ручная: burst закрывается и здесь,
    // иначе отрезки слипаются именно там, где обвязка помогла модели.
    noteVerification(verdict.kind === 'success' ? 'pass' : 'fail', verdict.kind, output);
    closeBurst('gate', verdict.kind === 'success' ? 'pass'
      : failureKind === 'environment' ? 'infra_error'
      : failureKind === 'unknown' ? 'unknown' : 'fail');
    if (verdict.speak) { reproSeenInContext = verdict.kind === 'test_failure' || verdict.kind === 'compile_errors' || reproSeenInContext; }
    record('gate_end', { verdict: verdict.kind, failureKind, status: gateStatus, seconds, speak: verdict.speak, chars: output.length, newErrors: verdict.newErrors.length, seenErrors: verdict.seenErrors });
    if (verdict.speak) say(verdict.text);
    autoVerifyBusy = false;
    recomputeWorkspaceState();
  };

  recomputeWorkspaceState();
  record('session_start', { profile: S.profile, blocking: S.blocking, readOnly: S.readOnly });
  // Снимок дерева ДО работы модели — источник истины о том, что существовало ранее.
  // Обход не пропускает содержательные каталоги (то есть не прячет факты).
  snapshot = snapshotTree(process.cwd());
  record('snapshot_taken', { files: snapshot.size, root: process.cwd() });

  // Конфиг проекта — только у доверенного проекта (см. loadSettings). При старте сессии
  // спрашиваем доверие официально и перечитываем настройки, если проект не доверенный.
  pi.on('session_start', (event, ctx) => {
    // Модель сессии в журнал. Без неё общий журнал реальных сессий бесполезен для выводов:
    // в нём смешаны прогоны разных моделей, и «модель отреагировала на напоминание 7 раз
    // из 12» нельзя отнести ни к одной конкретной. Поля ищем в нескольких местах —
    // форма события в доступном API не описана, поэтому рядом пишем и список ключей.
    try {
      const ev = (event ?? {}) as Record<string, unknown>;
      const c = (ctx ?? {}) as Record<string, unknown>;
      const pick = (o: Record<string, unknown>, ...names: string[]) => {
        for (const n of names) {
          const v = o[n];
          if (typeof v === 'string' && v) return v;
          if (v && typeof v === 'object') {
            const inner = (v as Record<string, unknown>).id ?? (v as Record<string, unknown>).name;
            if (typeof inner === 'string' && inner) return inner;
          }
        }
        return '';
      };
      record('session_model', {
        model: pick(ev, 'model', 'modelId') || pick(c, 'model', 'modelId') || '(не определена)',
        provider: pick(ev, 'provider', 'providerId') || pick(c, 'provider', 'providerId') || '',
        eventKeys: Object.keys(ev).slice(0, 12),
        ctxKeys: Object.keys(c).slice(0, 12),
        cwd: process.cwd(),
      });
    } catch { /* телеметрия не должна ломать сессию */ }

    try {
      const trusted = ctx.isProjectTrusted();
      if (!trusted) {
        S = loadSettings(false);
        record('untrusted_project', { configIgnored: true, profile: S.profile });
      }
    } catch { /* контекст может не дать доверие — тогда остаёмся на env/умолчаниях */ }
  });

  // ─── Блокировка с причиной в момент намерения ────────────────────────────────
  pi.on('tool_call', event => {
    steps += 1;
    const callInput = (event.input ?? {}) as Record<string, unknown>;
    const cmd = String(callInput.command ?? callInput.cmd ?? callInput.script ?? '');
    lastToolCommand = cmd;
    if (!inputShapeLogged && event.toolName === 'bash') {
      inputShapeLogged = true;
      record('tool_input_shape', { at: 'tool_call', tool: event.toolName, keys: Object.keys(callInput).slice(0, 12), gotCommand: cmd.length > 0 });
    }
    const decision = decideGate({
      state: workspaceState, toolName: event.toolName, command: cmd, writtenPaths,
      edits, projectFiles, draftFiles, verifications, lastVerifiedTouched, reproSeenInContext,
      steps, stepsSinceProgress: stepsSinceProgress(), S,
    });
    if (decision) {
      // Эпизод открывается по УСЛОВИЮ, а не по этому вызову: здесь только отмечаем, что
      // блок реально коснулся бы конкретного инструмента (повторы внутри эпизода — не события).
      syncEpisodes();
      const live = episodes.get(decision.gate);
      if (live) live.retriggers += 1;
      // Блокирует либо всё (enforcedGate пуст), либо ровно один названный гейт.
      const enforced = !S.shadow && (!S.enforcedGate || S.enforcedGate === 'all' || S.enforcedGate === decision.gate);
      if (!enforced) {
        // Shadow: решение принято и записано, но не применено. Смотрим, исправится ли модель сама.
        record('block_shadow', { gate: decision.gate, episodeId: live?.id ?? null, tool: event.toolName, reason: decision.reason.slice(0, 70) });
      } else {
        record('blocked', { gate: decision.gate, tool: event.toolName, reason: decision.reason.slice(0, 60) });
        return { block: true, reason: decision.reason };
      }
    }

    const signature = `${event.toolName}:${JSON.stringify(event.input ?? {}).slice(0, 200)}`;
    const seen = (repeats.get(signature) ?? 0) + 1;
    repeats.set(signature, seen);

    if (event.toolName === 'write' || event.toolName === 'edit') {
      edits += 1;
      const written = String((event.input as { path?: string } | undefined)?.path ?? '');
      if (written) { writtenPaths.push(written); if (writtenPaths.length > 40) writtenPaths.shift(); }
      record('edit', { tool: event.toolName, path: written });
      recomputeWorkspaceState();
    }

    if (S.repeatLimit > 0 && seen === S.repeatLimit) {
      maybeNudge('nudge_repeat',
        `Ты ${seen}-й раз повторяешь одно и то же действие (${event.toolName}) — новых данных тут нет. `
        + 'Если причина понятна — правь; если нет — смени запрос.', steps - lastVerifiedEdits);
    }
    return undefined;
  });

  // Наблюдение результатов: проверка, воспроизведение, дельта.
  pi.on('tool_execution_end', event => {
    // Команда достаётся из нескольких возможных полей: на `tool_execution_end` форма события
    // отличается от `tool_call`, и молчаливый '' означал бы «проверок не было» при живом
    // `pytest`/`gradlew` — измеритель показывал бы ноль проверок на любом прогоне.
    // Форма пишется в лог один раз, чтобы это не приходилось угадывать снова.
    const rawInput = (event.input ?? {}) as Record<string, unknown>;
    const fullCmd = String(rawInput.command ?? rawInput.cmd ?? lastToolCommand ?? '').toLowerCase();
    // Тело heredoc — это СОДЕРЖИМОЕ ФАЙЛА, а не запускаемая команда. Живой случай:
    // `cat > sim.mjs <<'EOF' … node … EOF` засчитался проверкой, потому что слово `node`
    // встретилось внутри записываемого текста. Запись выдавала себя за проверку и закрывала
    // write burst. Ищем совпадения только до начала heredoc.
    const cmd = fullCmd.split(/<<[-~]?['"]?\w+/)[0];
    const text = JSON.stringify(event.result ?? {});
    // Эффект считаем ПОСЛЕ ЛЮБОГО инструмента — это источник истины о прогрессе.
    syncWorkspace();
    // И сразу пересчитываем эпизоды: условие чаще всего уходит именно здесь (появился файл,
    // прошла сборка), и момент «исправилась сама» должен попасть в лог на своём шаге.
    syncEpisodes();
    if (event.toolName === 'verify' || event.toolName === 'test_runner' || event.toolName === 'repro') {
      verifications += 1;
      lastVerifiedEdits = edits;
      lastVerifiedTouched = projectFiles;
      const failed = /FAILED|OutOfMemoryError|crash/i.test(text);
      if (failed) reproSeenInContext = true;
      noteVerification(verifyResult(failed, text), failed ? 'tool_failure' : 'success', text);
      closeBurst(event.toolName, verifyResult(failed, text));
      return;
    }
    if (event.toolName === 'bash') {
      if (S.gatePatterns.some(p => cmd.includes(p))) {
        verifications += 1;
        lastVerifiedEdits = edits;
        lastVerifiedTouched = projectFiles;
        // Провал скрипта выглядит иначе, чем провал Gradle: исключение вместо `BUILD FAILED`.
        // Слово `failed` само по себе не берём — строка «0 failed» означает успех.
        const failed = /BUILD FAILED|tests? completed,\s*\d+ failed|FAILED|SyntaxError|ReferenceError|TypeError|Error:/i.test(text);
        if (failed) reproSeenInContext = true;
        record('verification', { command: cmd.slice(0, 70) });
        noteVerification(verifyResult(failed, text), failed ? 'bash_failure' : 'success', text);
        closeBurst('bash', verifyResult(failed, text));
      } else if (S.reproPatterns.some(p => cmd.includes(p))) {
        if (/FAILED|OutOfMemoryError|crash|Error/i.test(text)) reproSeenInContext = true;
      }
      // Парсинг команды НЕ решает, была ли правка, — ни здесь, ни где-либо ещё: факт мутации
      // приходит из дельты дерева (burstAdd). Прежняя строка `isBashWrite && projectFiles === 0`
      // была последним остатком угадывания по тексту команды и противоречила этому же комментарию.
      // `isBashWrite` остаётся только для текста причины блокировки.
      recomputeWorkspaceState();
    }
  });

  pi.on('turn_end', async () => {
    try {
      await runGate();
      recomputeWorkspaceState();
      const stale = steps - lastVerifiedEdits;
      const softAfter = workspaceState === 'greenfield' ? S.nudgeAfter : S.workNudgeAfter;
      // Напоминание — по тому же признаку, что и гейт: застой, а не «ноль файлов».
      // Иначе после распаковки шаблона оно замолкает навсегда вместе с гейтом.
      if (S.staleNudges && stepsSinceProgress() >= softAfter) {
        maybeNudge('nudge_stale',
          `${stepsSinceProgress()} шагов без единого сдвига. Сформулируй гипотезу и правь код: чтение не является результатом.`, stale);
      } else if (edits > 0 && verifications === 0 && stale > 2) {
        maybeNudge('nudge_verify',
          `Правок ${edits}, проверки ни одной. Собери проект или прогони тесты — иначе ты не знаешь, работает ли написанное.`, stale);
      }
      // Открытый отрезок пишем на каждом ходе: САМЫЕ ДЛИННЫЕ burst'ы не закрываются никогда
      // (модель перестаёт проверять вовсе), и распределение по одним закрытым отрезкам
      // систематически теряет правый хвост — то есть ровно то, ради чего его и строят.
      record('turn_end', { stale, stepsSinceProgress: stepsSinceProgress(), msSinceProgress: Date.now() - lastProgressMs, lastProgressKind, openBurstMutations: burst.mutations, openBurstFiles: burst.files.size, projectFiles, draftFiles, firstFileStep, editsPerVerify: verifications ? Number((projectFiles / verifications).toFixed(1)) : null });
      syncEpisodes();
      // Final verify — СОБЫТИЕ, а не состояние: иначе «грязно» держалось бы полпрогона и
      // дало бы десятки срабатываний вместо одного. Пишем факт на каждое завершение хода;
      // ОГРАНИЧЕНИЕ: `turn_end` — конец ХОДА, а не гарантированный конец задачи (события
      // завершения задачи в доступном API не видно). Поэтому «финишем» считается ПОСЛЕДНИЙ
      // turn_finish в журнале, и решает это offline-анализатор, а не supervisor.
      record('turn_finish', {
        wouldBlock: lastProjectMutationSeq > lastSuccessfulVerifySeq,
        lastProjectMutationSeq, lastVerificationSeq, lastSuccessfulVerifySeq, lastVerificationResult,
        mutationsSinceSuccessfulVerify: dirtyMutations, uniqueFilesSinceSuccessfulVerify: dirtyFiles.size,
      });
    } catch (error) {
      record('turn_end_error', { message: String((error as Error)?.message ?? error) });
    }
  });

  pi.registerCommand('nudge', {
    description: 'Настройки надзирателя: /nudge | off | on | profile=build-project | after=24 | edits=4 | block=off',
    handler: async (args, ctx) => {
      const arg = String(args ?? '').trim();
      const info = () => `надзиратель:\n  состояние: ${workspaceState} (гейт ${gateStatus}${gateKind ? '/' + gateKind : ''}, сбой ${failureKind})\n  legacy-режим формулировок: ${legacyMode(workspaceState)}\n  профиль: ${S.profile || 'по умолчанию'}\n  блокировки: ${S.blocking ? 'вкл' : 'выкл'}${S.readOnly ? ', только чтение' : ''}\n  правок без проверки до блокировки: ${S.editsBeforeVerifyBlock}\n  шагов без сдвига до блокировки: ${S.stagnationAfter}`;
      if (!arg) { ctx.ui.notify(info(), 'info'); return; }
      if (arg === 'on') { S = loadSettings(); recomputeWorkspaceState(); ctx.ui.notify(info(), 'info'); return; }
      if (arg === 'off') { S.blocking = false; S.staleNudges = false; ctx.ui.notify('надзиратель: блокировки и напоминания выключены', 'info'); return; }
      const m = /^(profile|after|work|edits|stagnation|block)=(.+)$/.exec(arg);
      if (!m) { ctx.ui.notify('формат: off | on | profile=build-project | after=24 | edits=4 | stagnation=24 | block=on|off', 'warning'); return; }
      const [, key, value] = m;
      if (key === 'profile' && PROFILES[value]) { S = { ...BASE, ...PROFILES[value], log: S.log, profile: value }; recomputeWorkspaceState(); }
      if (key === 'after') S.nudgeAfter = Number(value);
      if (key === 'work') S.workNudgeAfter = Number(value);
      if (key === 'edits') S.editsBeforeVerifyBlock = Number(value);
      if (key === 'stagnation') S.stagnationAfter = Number(value);
      if (key === 'block') S.blocking = value !== 'off';
      ctx.ui.notify(info(), 'info');
    },
  });
}
