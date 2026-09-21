import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Прогон пользовательского сценария на устройстве и вердикт «падает / не падает».
// Это тело инструмента `verify` (bench/verify-tool.ts): одна кнопка вместо
// многошаговой мороки «собрать → поставить → потыкать → посмотреть лог», которую
// модель избегает.
//
//   node bench/verify-scenario.mjs --app com.arny.habrrss.oomtest [--driver uiautomator|artemis]
//
// Драйверы:
//   uiautomator (по умолчанию) — детерминированные тапы: запустить приложение →
//     тап по вкладке «Хабы» в нижней навигации → ждать. ~40 секунд.
//   artemis — отдать вождение ARTEMIS (`artemis run <goal> --locked-app`). Он водит
//     по описанию и надёжнее на кривых экранах, но это модель в цикле: на практике
//     один сценарий занимает десятки минут, поэтому он не путь по умолчанию.
//
// Вердикты: CRASH (падение с уликой), OK (сценарий прошёл), NOT_RUN (сценарий не
// состоялся — занятое устройство, приложение не вышло на экран) — NOT_RUN это НЕ успех.
// Код возврата: 1 на CRASH, 2 на NOT_RUN, 0 на OK.

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(here, '..', 'data', 'runtime');

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) argv.set(token.replace(/^--/, ''), true);
  else { argv.set(token.replace(/^--/, ''), next); i += 1; }
}

const APP = String(argv.get('app') || 'com.arny.habrrss.oomtest');
const DRIVER = String(argv.get('driver') || 'uiautomator');
const ARTEMIS_DIR = path.resolve(String(argv.get('artemis') || 'G:/AIModels/MCPs/artemis'));
const ARTEMIS_TIMEOUT = Number(argv.get('artemis-timeout') || 300) * 1000;
const GOAL = String(argv.get('goal')
  || `Открой приложение ${APP}, перейди на вкладку «Хабы», открой хаб программирования (programming) и нажми кнопку «Загрузить все страницы». Если приложение закроется само — это и есть искомое поведение, дождись этого и заверши.`);
const WATCH_MS = Number(argv.get('watch-ms') || 60000);
const SDK = process.env.ANDROID_SDK_ROOT || 'C:/Users/ArnyPC/AppData/Local/Android/Sdk';
const ADB = path.join(SDK, 'platform-tools', 'adb.exe');

// Причины выхода по Android: 10 — «пользователь попросил» (наш же force-stop),
// 0 — нет данных. Падением считаем остальное (4/5 — крах, 6 — ANR, 3 — ресурсы).
const USER_REASONS = new Set([0, 10]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const exec = (file, args, timeout) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(`${path.basename(file)} ${args.join(' ').slice(0, 70)} → ${error.message}`), { stderr: String(stderr || '') }));
    else resolve(String(stdout));
  });
});

const log = [];
const run = (dev, ...args) => exec(ADB, ['-s', dev, ...args], 120000);

// --- устройство -----------------------------------------------------------------

async function device() {
  const lines = (await exec(ADB, ['devices'])).split(/\r?\n/).slice(1).filter(l => /\tdevice$/.test(l));
  if (lines.length !== 1) throw new Error(`нужно ровно одно устройство, видно ${lines.length}`);
  return lines[0].split('\t')[0];
}

async function screenSize(dev) {
  const out = await run(dev, 'shell', 'wm', 'size').catch(() => '');
  const match = out.match(/(\d+)x(\d+)/);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 1080, height: 2340 };
}

async function foreground(dev) {
  const dump = await run(dev, 'shell', 'dumpsys', 'window').catch(() => '');
  return (dump.match(/mCurrentFocus=\S+ \S+ ([^/]+)\/(\S+)/) || [, '', ''])[1];
}

async function lastExit(dev) {
  const dump = await run(dev, 'shell', 'dumpsys', 'activity', 'exit-info', APP).catch(() => '');
  const block = String(dump).split('ApplicationExitInfo #')[1];
  if (!block) return null;
  const field = name => (block.match(new RegExp(`${name}=([^\\r\\n]+)`)) || [, null])[1];
  const timestamp = field('timestamp');
  if (!timestamp) return null;
  const reasonRaw = field('reason') || '';
  return {
    timestamp: timestamp.trim(),
    reason: Number(reasonRaw.split(/\s/)[0]) || 0,
    reasonText: (reasonRaw.match(/\(([^)]*(?:\([^)]*\))?[^)]*)\)/) || [, 'неизвестно'])[1],
    pss: Number(String(field('pss') || '').replace(/[^\d]/g, '')) || null,
    rss: Number(String(field('rss') || '').replace(/[^\d]/g, '')) || null
  };
}

// --- вождение UI (детерминированный драйвер) -------------------------------------

function parseNodes(xml) {
  const nodes = [];
  for (const match of xml.matchAll(/<node[^>]*>/g)) {
    const tag = match[0];
    const bounds = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) continue;
    const text = (tag.match(/text="([^"]*)"/) || [, ''])[1];
    const desc = (tag.match(/content-desc="([^"]*)"/) || [, ''])[1];
    nodes.push({
      label: `${text} ${desc}`.trim(),
      clickable: /clickable="true"/.test(tag),
      x: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
      y: Math.round((Number(bounds[2]) + Number(bounds[4])) / 2)
    });
  }
  return nodes;
}

async function dumpUi(dev) {
  // Дамп в файл и чтение: `uiautomator dump /dev/tty` на части сборок молчит.
  await run(dev, 'shell', 'uiautomator', 'dump', '/sdcard/bench-ui.xml').catch(() => {});
  const xml = await run(dev, 'shell', 'cat', '/sdcard/bench-ui.xml').catch(() => '');
  return parseNodes(xml);
}

// Узлы нижней навигации выбираем только в нижней полосе экрана: раньше поиск по
// подписи «Хабы» находил ЗАГОЛОВОК экрана и тап уходил в текст, а не в кнопку —
// из-за этого сценарий оставался на «Ленте» и вердикт врал.
async function alive(dev) {
  return Boolean((await run(dev, 'shell', 'pidof', APP).catch(() => '')).trim());
}

async function tapBottomNav(dev, pattern, { bottomShare = 0.85, timeoutMs = 8000 } = {}) {
  const size = await screenSize(dev);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Приложение уже умерло — искать кнопки бессмысленно, это и есть результат.
    if (!(await alive(dev))) { log.push('приложение уже упало — прекращаю поиск элементов'); return false; }
    const nodes = (await dumpUi(dev)).filter(n => n.y >= size.height * bottomShare);
    const hit = nodes.find(n => pattern.test(n.label) && n.clickable) || nodes.find(n => pattern.test(n.label));
    if (hit) {
      await run(dev, 'shell', 'input', 'tap', String(hit.x), String(hit.y));
      log.push(`тап по нижней навигации ${pattern} → «${hit.label}» (${hit.x},${hit.y})`);
      return true;
    }
    await sleep(1000);
  }
  log.push(`не найдена вкладка ${pattern} в нижней полосе`);
  return false;
}

// Полный путь сценария — не только вкладка: падение происходит когда открыт САМ
// хаб (его архив грузится в список), а не от одного перехода на «Хабы».
// Поэтому: скроллим до нужного текста, тапаем, и только потом судим.
async function tapTextAnywhere(dev, pattern, { scrolls = 3, timeoutMs = 6000 } = {}) {
  const size = await screenSize(dev);
  for (let attempt = 0; attempt <= scrolls; attempt++) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await alive(dev))) { log.push('приложение уже упало — прекращаю поиск элементов'); return false; }
      const nodes = await dumpUi(dev);
      const hit = nodes.find(n => pattern.test(n.label) && n.clickable) || nodes.find(n => pattern.test(n.label));
      if (hit) {
        await run(dev, 'shell', 'input', 'tap', String(hit.x), String(hit.y));
        log.push(`тап ${pattern} → «${hit.label.slice(0, 40)}» (${hit.x},${hit.y})`);
        return true;
      }
      await sleep(800);
    }
    if (attempt < scrolls) {
      await run(dev, 'shell', 'input', 'swipe', String(Math.round(size.width / 2)), String(Math.round(size.height * 0.68)), String(Math.round(size.width / 2)), String(Math.round(size.height * 0.38)), '250');
      log.push(`скролл ${attempt + 1} — ${pattern} пока нет`);
      await sleep(1200);
    }
  }
  log.push(`не найден текст ${pattern} (скроллов: ${scrolls})`);
  return false;
}

// --- вердикт ---------------------------------------------------------------------

async function judge(dev, before, startedAt) {
  let crash = null;
  let died = false;
  while (Date.now() - startedAt < WATCH_MS) {
    const current = await lastExit(dev);
    if (current && current.timestamp !== (before?.timestamp ?? null) && !USER_REASONS.has(current.reason)) { crash = current; break; }
    const alive = (await run(dev, 'shell', 'pidof', APP).catch(() => '')).trim();
    if (!alive) {
      died = true;
      await sleep(2500);
      const after = await lastExit(dev);
      if (after && after.timestamp !== (before?.timestamp ?? null) && !USER_REASONS.has(after.reason)) crash = after;
      break;
    }
    await sleep(3000);
  }
  const logs = await run(dev, 'shell', 'logcat', '-d').catch(() => '');
  return {
    crash, died,
    oom: (logs.match(/[^\n]*OutOfMemoryError[^\n]*/) || [null])[0],
    heap: (logs.match(/growth limit \d+/) || [null])[0],
    size: (logs.match(/updateState items=\d+[^\n]*/) || [null])[0]
  };
}

// --- сценарий --------------------------------------------------------------------

const dev = await device();
log.push(`устройство ${dev}, приложение ${APP}, драйвер ${DRIVER}`);

// Стенд мог быть испорчен самим агентом: в одном прогоне модель очистила данные
// приложения и «проверила», что больше не падает, — вердикт OK был ложным. Поэтому
// сначала проверяем, что фикстура на месте, и только потом катаем сценарий.
const FIXTURE = path.resolve(String(argv.get('fixture') || path.join(here, '..', 'data', 'runtime', 'fixture', 'habr_rss.db')));
let standBroken = null;
if (fs.existsSync(FIXTURE)) {
  const expected = fs.statSync(FIXTURE).size;
  const listing = await run(dev, 'shell', `run-as ${APP} ls -l databases/habr_rss.db`).catch(() => '');
  const actual = Number(String(listing).replace(/\r/g, '').trim().split(/\s+/)[4]) || 0;
  // Точного равенства требовать нельзя: приложение дописывает базу во время работы.
  // Но 1 МБ вместо 157 МБ — это стёртое состояние, а не рабочее.
  if (actual < expected * 0.5) standBroken = { actual, expected };
  else log.push(`фикстура на месте: ${actual} байт`);
}

await run(dev, 'shell', 'am', 'force-stop', APP).catch(() => {});
await sleep(1500);
const before = await lastExit(dev);
await run(dev, 'shell', 'logcat', '-c').catch(() => {});

let driverFailed = false;
if (standBroken) {
  // Гнать сценарий на стёртом состоянии бессмысленно: именно так появился ложный OK.
  log.push(`сценарий пропущен: база ${standBroken.actual} байт вместо ~${standBroken.expected} — фикстура стёрта`);
} else if (DRIVER === 'artemis') {
  log.push(`ARTEMIS: ${GOAL.slice(0, 80)}…`);
  try {
    const out = await exec(path.join(ARTEMIS_DIR, '.venv', 'Scripts', 'python.exe'),
      ['-m', 'artemis.interfaces.cli.main', 'run', GOAL, '--profile', String(argv.get('profile') || 'flash'), '--locked-app', APP],
      ARTEMIS_TIMEOUT);
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'artemis-last.log'), out);
    log.push('ARTEMIS завершился');
  } catch (error) {
    driverFailed = true;
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'artemis-last.log'), String(error.stderr || error.message));
    log.push(`ARTEMIS не отработал за ${ARTEMIS_TIMEOUT / 1000} c: ${String(error.message).slice(0, 120)}`);
  }
} else {
  await run(dev, 'shell', 'monkey', '-p', APP, '-c', 'android.intent.category.LAUNCHER', '1').catch(async () => {
    await run(dev, 'shell', 'monkey', '-p', APP, '1');
  });
  let focused = '';
  for (let i = 0; i < 20 && focused !== APP; i++) { await sleep(1000); focused = await foreground(dev); }
  if (focused !== APP) {
    console.log('VERDICT=NOT_RUN');
    for (const step of log) console.log(`  · ${step}`);
    console.log(`  → приложение не вышло на передний план (на экране ${focused || 'неизвестно'}). Сценарий не выполнен.`);
    process.exitCode = 2;
  } else {
    log.push('приложение на переднем плане');
    // 1) вкладка «Хабы»  2) сам хаб programming  3) кнопка «Загрузить все страницы»
    // Каждый шаг сам проверяет, живо ли приложение: с фикстурой оно часто падает
    // уже на первом экране, и дальнейшие поиски только тянут время.
    await tapBottomNav(dev, /^Хабы$/);
    if (await alive(dev)) {
      await sleep(1200);
      await tapTextAnywhere(dev, /programming/i, { scrolls: 3 });
      if (await alive(dev)) {
        await sleep(2000);
        await tapTextAnywhere(dev, /Загрузить все страницы/i, { scrolls: 3 });
      }
    }
  }
}

const started = Date.now();
const verdictData = await judge(dev, before, started);
const reasons = [];
if (verdictData.crash) reasons.push(`exit-info: ${verdictData.crash.reasonText}${verdictData.crash.pss ? `, pss=${verdictData.crash.pss}MB` : ''}${verdictData.crash.rss ? `, rss=${verdictData.crash.rss}MB` : ''} (${verdictData.crash.timestamp})`);
if (verdictData.oom) reasons.push(`logcat: ${verdictData.oom.trim().slice(0, 200)}`);
if (verdictData.heap) reasons.push(`heap: ${verdictData.heap.trim()}`);
if (verdictData.died && !verdictData.crash) reasons.push('процесс исчез (pidof пуст)');

const crashed = Boolean(verdictData.crash || verdictData.oom);
const verdict = standBroken ? 'NOT_RUN' : (crashed ? 'CRASH' : (driverFailed ? 'NOT_RUN' : 'OK'));
if (standBroken) reasons.push(`стенд испорчен: база приложения ${standBroken.actual} байт вместо ~${standBroken.expected} — фикстура стёрта (обычно через pm clear). Судить не о чем: падения нет именно потому, что стёрли данные.`);
if (verdict === 'NOT_RUN') reasons.push('сценарий не состоялся (драйвер не отработал) — это НЕ значит «падения нет»');
if (verdict === 'OK') reasons.push(`за ${Math.round(WATCH_MS / 1000)} c падения не случилось — сценарий прошёл`);
if (verdictData.size) reasons.push(`лог приложения: ${verdictData.size.trim().slice(0, 120)}`);

const report = {
  app: APP, verdict, at: new Date().toISOString(), driver: DRIVER, goal: DRIVER === 'artemis' ? GOAL : null,
  steps: log, crash: verdictData.crash, died: verdictData.died,
  evidence: { oom: verdictData.oom ? verdictData.oom.trim() : null, heap: verdictData.heap ? verdictData.heap.trim() : null, size: verdictData.size ? verdictData.size.trim() : null },
  reasons
};
const jsonPath = argv.get('json') ? path.resolve(String(argv.get('json'))) : path.join(runtime, 'verify-last.json');
fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`VERDICT=${verdict}`);
for (const step of log) console.log(`  · ${step}`);
for (const reason of reasons) console.log(`  → ${reason}`);
process.exitCode = verdict === 'CRASH' ? 1 : verdict === 'NOT_RUN' ? 2 : 0;
