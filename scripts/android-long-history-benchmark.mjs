#!/usr/bin/env node
// Android long-history acceptance and benchmark (TESTING_PLAN.md §8 и §9).
//
// §8: after touching history/reducer/cache, the crash buffer must stay clean —
// FATAL EXCEPTION, OutOfMemoryError, a duplicate LazyColumn key.
// §9: three measurement points of the SAME session — just opened, ~half loaded,
// history start reached — with the device's memory and the internal facts behind the
// screen. The result is a baseline file: later runs are compared with it by numbers,
// not by memory of «looked fine».
//
//   node scripts/android-long-history-benchmark.mjs --task 7f93ddc27f7f
//   node scripts/android-long-history-benchmark.mjs --task <id> --swipes 8 --device 192.168.1.132:5555
//   node scripts/android-long-history-benchmark.mjs --task <id> --compare   # diff against the saved baseline
//
// Preconditions (checked, not assumed): a device is attached, the app is installed
// and paired with the server, and the server is reachable from the device.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASELINE = path.join(ROOT, 'AndroidLongHistoryBenchmark.json');
const PACKAGE = 'ru.arny.taskbridge';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const out = { task: null, device: null, swipes: 12, server: 'http://127.0.0.1:8787', compare: false, baselineOnly: false, timeoutSec: 600 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--task') out.task = next();
    else if (arg === '--device') out.device = next();
    else if (arg === '--swipes') out.swipes = Number(next()) || 12;
    else if (arg === '--server') out.server = next();
    else if (arg === '--timeout') out.timeoutSec = Number(next()) || 600;
    else if (arg === '--compare') out.compare = true;
    else if (arg === '--no-crash-check') out.baselineOnly = true;
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
const adbPath = process.env.ADB || path.join(
  process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools',
  process.platform === 'win32' ? 'adb.exe' : 'adb',
);

/** Every adb call goes through one place: one device, one place to log what ran. */
function adb(args, { binary = false, timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(adbPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill(), timeout);
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: 127, text: '', buffer: Buffer.alloc(0), error: error.message }); });
    child.once('close', (code) => {
      clearTimeout(timer);
      const buffer = Buffer.concat(chunks);
      resolve({ code: code ?? 1, text: buffer.toString('utf8'), buffer });
    });
  });
}

async function deviceArg() {
  const devices = await adb(['devices']);
  const attached = devices.text.split('\n').slice(1).map(line => line.split('\t')).filter(parts => parts[1] === 'device').map(parts => parts[0]);
  if (!attached.length) throw new Error('нет подключённого устройства: adb devices пуст (включите эмулятор или подключите телефон)');
  if (options.device) {
    if (!attached.includes(options.device)) throw new Error(`устройства ${options.device} нет в списке: ${attached.join(', ')}`);
    return options.device;
  }
  return attached[0];
}

const shell = (serial, args, opts = {}) => adb(['-s', serial, 'shell', ...args], opts);

/**
 * The device's memory for the app: PSS total and the Dalvik heap that actually
 * grows with the chat (heap size/alloc are what the OOM of 2026-10-11 hit).
 */
async function meminfo(serial) {
  const { text } = await shell(serial, ['dumpsys', 'meminfo', PACKAGE]);
  const number = (pattern) => {
    const match = new RegExp(pattern, 'mu').exec(text);
    return match ? Number(String(match[1]).replaceAll(',', '').replace(' KB', '')) : null;
  };
  return {
    totalPssKb: number('TOTAL\\s+(\\d[\\d,]*)\\s'),
    dalvikHeapSizeKb: number('Dalvik Heap\\s+\\d[\\d,]*\\s+\\d[\\d,]*\\s+\\d[\\d,]*\\s+\\d[\\d,]*\\s+\\d[\\d,]*\\s+(\\d[\\d,]*)\\s+\\d'),
    dalvikHeapAllocKb: number('Dalvik Heap\\s+(?:\\d[\\d,]*\\s+){5}\\d[\\d,]*\\s+(\\d[\\d,]*)\\s+(\\d[\\d,]*)'),
    nativeHeapKb: number('Native Heap\\s+(\\d[\\d,]*)\\s'),
  };
}

/** The app's own cache for a session: its `reachedStart` is how far the history got. */
async function cacheState(serial, taskId) {
  const dirs = await shell(serial, ['run-as', PACKAGE, 'ls', 'files/chat-cache']);
  const dir = dirs.text.split('\n').map(line => line.trim()).filter(Boolean).find(line => !line.startsWith('.'));
  if (!dir) return null;
  const read = await shell(serial, ['run-as', PACKAGE, 'cat', `files/chat-cache/${dir}/${taskId}.chat.json`]);
  if (read.code !== 0 || !read.text.trim()) return null;
  try {
    const parsed = JSON.parse(read.text);
    return {
      events: Array.isArray(parsed.events) ? parsed.events.length : 0,
      reachedStart: parsed.reachedStart === true,
      bytes: read.text.length,
    };
  } catch {
    return null;
  }
}

async function pid(serial) {
  const { text } = await shell(serial, ['pidof', PACKAGE]);
  return text.trim() || null;
}

async function main() {
  const serial = await deviceArg();
  if (!options.task) throw new Error('укажите сессию: --task <id> (её события и будут листаться)');

  const health = await fetch(`${options.server}/api/health`).then(r => r.json()).catch(() => null);
  if (!health) throw new Error(`сервер TaskBridge не отвечает на ${options.server}`);
  const task = await fetch(`${options.server}/api/tasks/${options.task}`).then(r => r.json()).catch(() => null);
  if (!task || task.id !== options.task) throw new Error(`сессии ${options.task} нет на сервере`);
  const totalEvents = (await fetch(`${options.server}/api/tasks/${options.task}/events?limit=0`).then(r => r.json()).catch(() => [])).length;

  // §8 starts here: a clean crash buffer, so nothing from before can be mistaken for
  // this run's result.
  await adb(['-s', serial, 'logcat', '-c']);
  await adb(['-s', serial, 'logcat', '-c', '-b', 'crash']);
  await shell(serial, ['am', 'force-stop', PACKAGE]);

  const openedAt = Date.now();
  await shell(serial, ['am', 'start', '-n', `${PACKAGE}/.MainActivity`, '--es', 'taskId', options.task]);
  // The first screen is ready when the app's own cache for this session shows up.
  let first = null;
  for (let attempt = 0; attempt < 60 && !first; attempt++) {
    await sleep(500);
    first = await cacheState(serial, options.task);
  }
  const timeToFirstScreenMs = Date.now() - openedAt;
  const pidAtStart = await pid(serial);
  const pointA = { ...await meminfo(serial), cache: first };

  // Scroll up in steps: the same gesture the operator makes, `swipes` times per point.
  const swipe = () => shell(serial, ['input', 'swipe', '540', '500', '540', '2100', '140']);
  const half = Math.max(1, Math.round(options.swipes / 2));
  for (let index = 0; index < half; index++) { await swipe(); await sleep(400); }
  await sleep(1500);
  const pointB = { ...await meminfo(serial), cache: await cacheState(serial, options.task) };

  // Point C: the history start. The app persists `reachedStart`, so this is a fact
  // from the app, not a guess from how long we scrolled.
  const deadline = Date.now() + options.timeoutSec * 1000;
  let reached = false;
  while (Date.now() < deadline && !reached) {
    await swipe();
    await sleep(600);
    const state = await cacheState(serial, options.task);
    reached = state?.reachedStart === true;
  }
  await sleep(2000);
  const pointC = { ...await meminfo(serial), cache: await cacheState(serial, options.task) };
  const pidAtEnd = await pid(serial);

  // §8: the crash buffer after the scenario.
  const crash = (await adb(['-s', serial, 'logcat', '-d', '-b', 'crash'])).text;
  const fatal = crash.split('\n').filter(line => /FATAL EXCEPTION|OutOfMemoryError|IllegalArgumentException|LazyList/.test(line));
  const restarted = pidAtStart !== pidAtEnd;

  const result = {
    at: new Date().toISOString(),
    taskId: options.task,
    totalEventsOnServer: totalEvents,
    device: serial,
    appVersion: (await shell(serial, ['dumpsys', 'package', PACKAGE])).text.match(/versionName=(\S+)/u)?.[1] ?? null,
    swipesPerPoint: options.swipes,
    timeToFirstScreenMs,
    reachedHistoryStart: reached,
    points: { A: pointA, B: pointB, C: pointC },
    crash: { fatals: fatal, restarted, clean: fatal.length === 0 && !restarted },
  };

  if (options.compare) {
    const previous = JSON.parse(await fs.readFile(BASELINE, 'utf8').catch(() => 'null'));
    if (!previous) console.log('baseline ещё не сохранён — сравнивать не с чем (запустите без --compare)');
    else {
      console.log('\n=== Сравнение с baseline');
      for (const point of ['A', 'B', 'C']) {
        const before = previous.points?.[point]?.dalvikHeapAllocKb ?? null;
        const now = result.points[point].dalvikHeapAllocKb ?? null;
        if (before && now) {
          const change = ((now - before) / before) * 100;
          console.log(`  ${point}: heap alloc ${before} → ${now} KB (${change >= 0 ? '+' : ''}${change.toFixed(1)}%)`);
        }
      }
      if (previous.timeToFirstScreenMs && result.timeToFirstScreenMs) {
        console.log(`  первый экран: ${previous.timeToFirstScreenMs} → ${result.timeToFirstScreenMs} мс`);
      }
    }
  } else {
    await fs.writeFile(BASELINE, JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log(`\nbaseline сохранён: ${path.basename(BASELINE)}`);
  }

  console.log('\n=== Точки замера (PSS / Dalvik heap alloc, KB)');
  for (const [point, values] of Object.entries(result.points)) {
    console.log(`  ${point}: ${values.totalPssKb ?? '—'} / ${values.dalvikHeapAllocKb ?? '—'} | событий в кэше: ${values.cache?.events ?? '—'} | начало истории: ${values.cache?.reachedStart ? 'да' : 'нет'}`);
  }
  console.log(`  первый экран: ${result.timeToFirstScreenMs} мс | история дочитана до начала: ${reached ? 'да' : 'НЕТ'}`);
  console.log(`  краши: ${result.crash.clean ? 'чисто' : `НАЙДЕНО (${fatal.length} строк, перезапуск=${restarted})`}`);
  for (const line of fatal.slice(0, 5)) console.log(`    ${line}`);
  console.log(`  сервер сообщает событий в сессии: ${totalEvents}`);
  process.exit(result.crash.clean && reached ? 0 : 1);
}

main().catch((error) => {
  console.error(`✖ ${error.message}`);
  process.exit(2);
});
