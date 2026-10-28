// Какую команду Pi запускает TaskBridge (DIST-05).
//
// Порядок важен и повторяет выбор Node в Desktop-лаунчере:
//   1. `pi.command` из конфигурации — то, что оператор написал сам;
//   2. TASKBRIDGE_PI — явный путь без правки конфигурации (разработка, тесты,
//      «попробовать другую сборку Pi»);
//   3. комплектный Pi поставки — <dist>/runtime/pi/pi(.cmd) при распознанной
//      сборке (<dist>/server + TaskBridge.exe + app) или <serverRoot>/runtime/pi;
//   4. `pi` из PATH — прежнее поведение, поэтому запуск из репозитория и уже
//      установленные копии продолжают работать без изменений.
//
// Возвращается не только команда, но и источник: без него «Pi не найден» в
// диагностике не отличить от «нашли не тот Pi».
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const exists = file => {
  try { return fs.statSync(file).isFile(); } catch { return false; }
};

/** Сборка TaskBridge: рядом с корнем сервера лежат `server/` и приложение. */
function isDistribution(serverRoot) {
  if (path.basename(serverRoot) !== 'server') return false;
  const dist = path.dirname(serverRoot);
  return exists(path.join(dist, 'TaskBridge.exe')) && fs.existsSync(path.join(dist, 'app'));
}

/**
 * @returns {{command: string, source: 'config'|'environment'|'bundled'|'path'|'default'}}
 */
export function resolvePiCommand({
  config = {},
  env = process.env,
  serverRoot = SERVER_ROOT,
  platform = process.platform,
  fileExists = exists,
  directoryExists = dir => fs.existsSync(dir),
} = {}) {
  const configured = typeof config.pi?.command === 'string' ? config.pi.command.trim() : '';
  if (configured) return { command: configured, source: 'config' };
  const fromEnv = typeof env.TASKBRIDGE_PI === 'string' ? env.TASKBRIDGE_PI.trim() : '';
  if (fromEnv) return { command: fromEnv, source: 'environment' };
  const name = platform === 'win32' ? 'pi.cmd' : 'pi';
  const candidates = [path.join(serverRoot, 'runtime', 'pi', name)];
  // Только настоящая поставка: у обычного репозитория рядом нет runtime/pi.
  if (isDistribution(serverRoot)) candidates.push(path.join(path.dirname(serverRoot), 'runtime', 'pi', name));
  for (const candidate of candidates) if (fileExists(candidate)) return { command: candidate, source: 'bundled' };
  return { command: 'pi', source: 'path' };
}

// Состояния, которые показывает диагностика (DIST-05 §8). Отсутствие модели —
// не то же самое, что отсутствие Pi: их нельзя смешивать в одну строку.
export const PI_STATES = Object.freeze({
  MISSING: 'missing',
  INCOMPATIBLE: 'incompatible',
  READY: 'ready',
});

export function piRuntimeState(probe) {
  if (!probe?.version) return { state: PI_STATES.MISSING, reason: probe?.error || 'Pi не найден' };
  if (probe.supported === false) return { state: PI_STATES.INCOMPATIBLE, reason: `Pi ${probe.version} вне поддерживаемого диапазона ${probe.supportedRange || ''}`.trim() };
  return { state: PI_STATES.READY, reason: null };
}
