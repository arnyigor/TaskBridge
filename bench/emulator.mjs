import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Поднимает эмулятор для прогонов бенчмарка: модель крутится на GPU хоста, поэтому
// эмулятор берётся ТОЛЬКО с программным рендерингом, иначе они не влезут в 16 ГБ
// VRAM (модель занимает ~15.6 ГБ).
//
//   node bench/emulator.mjs                 # поднять и дождаться загрузки
//   node bench/emulator.mjs --wipe          # с чистого листа (пустой dropbox!)
//   node bench/emulator.mjs --kill          # погасить
//
// Почему `--wipe` важен: без него на устройстве остаётся история падений в dropbox,
// и модель может найти там ЧУЖОЙ крах (в одном прогоне она нашла краш боевого
// приложения и приняла его за своё воспроизведение). Чистый эмулятор + свежий
// applicationId на прогон закрывают эту дыру.
//
// ANDROID_SDK_ROOT обязателен: без него эмулятор падает с
// "Cannot find AVD system path" (проверено). Для этих AVD SDK лежит в G:/Android/SDK.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) argv.set(token.replace(/^--/, ''), true);
  else { argv.set(token.replace(/^--/, ''), next); i += 1; }
}

const SDK = process.env.ANDROID_SDK_ROOT || 'G:/Android/SDK';
const AVD = String(argv.get('avd') || 'Pixel_5');
const MEMORY = String(argv.get('memory') || '2048');
const WIPE = Boolean(argv.get('wipe'));
const KILL = Boolean(argv.get('kill'));
const EMULATOR = path.join(SDK, 'emulator', 'emulator.exe');
const ADB = path.join(SDK, 'platform-tools', 'adb.exe');
const SERIAL = `emulator-${argv.get('port') || 5554}`;
const BOOT_LOG = path.join(root, 'data', 'runtime', 'emulator-boot.log');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const adb = (...args) => new Promise((resolve, reject) => {
  execFile(ADB, args, { windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(`adb ${args.join(' ')} → ${error.message}`), { stderr }));
    else resolve(String(stdout));
  });
});

if (KILL) {
  try { await adb('-s', SERIAL, 'emu', 'kill'); } catch { /* уже погашен */ }
  console.log(`эмулятор ${SERIAL} погашен`);
  process.exitCode = 0;
} else {
  const devices = await adb('devices').catch(() => '');
  if (new RegExp(`^${SERIAL}\\s+device`, 'm').test(devices)) {
    console.log(`эмулятор уже поднят: ${SERIAL}`);
    process.exitCode = 0;
  } else {
    const args = [
      '-avd', AVD,
      '-gpu', 'swiftshader_indirect',   // без VRAM: она нужна модели
      '-no-snapshot', '-no-boot-anim', '-no-audio',
      '-memory', MEMORY
    ];
    if (WIPE) args.push('-wipe-data');
    const out = await import('node:fs').then(fs => {
      fs.mkdirSync(path.dirname(BOOT_LOG), { recursive: true });
      return fs.openSync(BOOT_LOG, 'a');
    });
    const child = spawn(EMULATOR, args, {
      cwd: path.join(SDK, 'emulator'),
      env: { ...process.env, ANDROID_SDK_ROOT: SDK, ANDROID_HOME: SDK, ANDROID_AVD_HOME: process.env.ANDROID_AVD_HOME || path.join(process.env.USERPROFILE || '', '.android', 'avd') },
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true
    });
    child.unref();
    console.log(`запускаю ${AVD}${WIPE ? ' (--wipe-data)' : ''}, лог: ${BOOT_LOG}`);

    const deadline = Date.now() + Number(argv.get('timeout') || 180) * 1000;
    let booted = false;
    while (Date.now() < deadline) {
      await sleep(5000);
      const boot = await adb('-s', SERIAL, 'shell', 'getprop', 'sys.boot_completed').catch(() => '');
      if (boot.trim() === '1') { booted = true; break; }
    }
    if (!booted) {
      console.log('эмулятор не загрузился за отведённое время — смотри лог');
      process.exitCode = 1;
    } else {
      const heap = (await adb('-s', SERIAL, 'shell', 'getprop', 'dalvik.vm.heapgrowthlimit').catch(() => '?')).trim();
      const sdk = (await adb('-s', SERIAL, 'shell', 'getprop', 'ro.build.version.sdk').catch(() => '?')).trim();
      console.log(`готово: ${SERIAL} (API ${sdk}, heap ${heap})`);
      console.log('дальше: node bench/preflight.mjs --app <пакет> и запуск pi с -e bench/supervisor.ts -e bench/verify-tool.ts');
    }
  }
}
