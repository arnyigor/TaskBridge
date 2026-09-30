import fs from 'node:fs/promises';
import path from 'node:path';

// Размер контекста локальной модели — параметр ЗАГРУЗКИ: движок читает его, пока
// поднимает модель, и на живой модели его не поменять. Поэтому «настройки загрузки
// локальных моделей» в TaskBridge — это правка того файла, из которого движок
// стартует.
//
// Strata: контекст — это `--max-context N` в args конфига модели
// (<установка>/strata-<модель>.json). Проверено на живом сервере (порт 8083,
// 2026-09-30): /health отдаёт {"status":"ok","max_context":262144,...} — ровно это
// число из args. Отдельного флага CLI у serve/server.py для него нет: args целиком
// уходят движку.
//
// Файл правится ТЕКСТОМ, а не JSON.parse/JSON.stringify: он чужой (его пишет
// setup.py, отступы в один пробел, строки CRLF), и переформатирование всего файла
// ради одного числа — лишний риск. Меняются только цифры значения. BOM (server.py
// открывает файл как utf-8-sig, то есть допускает его) от правки не зависит: он
// остаётся, если был.

export const CONTEXT_FLAG = '--max-context';

// Флаги args, за которыми Strata ждёт файл или каталог. По ним и видно, что модель
// ещё есть на диске: веса удаляют, а конфиг остаётся, и без этой проверки строка
// модели вечно висит «не загружена» с кнопкой, которая не может сработать.
// Список — из конфигов этой установки (setup.py пишет именно их): pack — каталог
// движка, native/ple-gguf — веса, expert-profile — профиль экспертов, mtp —
// спекулятивный модуль. Конфиг без этих флагов не проверяется вовсе (null).
const MODEL_PATH_FLAGS = ['--pack', '--native', '--ple-gguf', '--expert-profile', '--mtp', '--mmproj', '--model'];

/** Резидентная часть KV (Strata `--kv-resident`) — читается только для справки. */
export const KV_RESIDENT_FLAG = '--kv-resident';

// Ниже — движок не поднимет даже пустой KV; выше — это опечатка, а не настройка.
export const MIN_CONTEXT = 4096;
export const MAX_CONTEXT = 4194304;

// `"--max-context", "262144"` и `"--max-context": 262144` — и строкой, и числом:
// args в конфиге Strata строки, но правило не должно зависеть от кавычек.
const flagEntry = flag => new RegExp(`"${String(flag).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"\\s*,\\s*"?(-?\\d+)"?`, 'u');

/**
 * Число, которое args отдают движку для `flag`, или null: нет флага — нет числа.
 * Чистая — читается и из теста, и из файла.
 */
export function readEngineArg(text, flag) {
  const match = flagEntry(flag).exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * Тот же текст, где вместо значения `flag` стоит `value`; больше не меняется ни
 * один байт (CRLF, отступы, BOM — если он есть — и порядок args остаются как
 * были). null = флага в тексте нет: вставлять его молча нельзя, порядок args у
 * движка свой, а конфиг не наш.
 */
export function patchEngineArg(text, flag, value) {
  const source = String(text ?? '');
  const match = flagEntry(flag).exec(source);
  if (!match) return null;
  const start = match.index + match[0].lastIndexOf(match[1]);
  return source.slice(0, start) + String(value) + source.slice(start + match[1].length);
}

/** Контекст как число: целое в допустимых границах, иначе INPUT_INVALID. */
export function assertContext(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < MIN_CONTEXT || number > MAX_CONTEXT) {
    throw Object.assign(
      new Error(`Контекст — целое число от ${MIN_CONTEXT} до ${MAX_CONTEXT} токенов.`),
      { code: 'INPUT_INVALID' },
    );
  }
  return number;
}

/**
 * Записать новый контекст в файл конфига движка.
 *
 * Возвращает `{ context, previous, changed, resident }`: `previous` — что стояло
 * (его клиент показывает как «было»), `resident` — резидентная часть KV из того же
 * файла (по ней видно, что новый контекст меньше неё). null — в файле нет
 * `--max-context`, и тогда файл НЕ трогается.
 *
 * Пишется атомарно (tmp + rename): чужой конфиг не должен остаться обрезанным,
 * если запись прервётся.
 */
export async function writeContextFile(file, context, flag = CONTEXT_FLAG) {
  const value = assertContext(context);
  const text = await fs.readFile(file, 'utf8');
  const previous = readEngineArg(text, flag);
  const resident = readEngineArg(text, KV_RESIDENT_FLAG);
  if (previous === null) return null;
  if (previous === value) return { context: value, previous, changed: false, resident };
  const patched = patchEngineArg(text, flag, value);
  const tmp = `${file}.taskbridge-tmp`;
  await fs.writeFile(tmp, patched, 'utf8');
  await fs.rename(tmp, file);
  return { context: value, previous, changed: true, resident };
}

/**
 * Пути, которые конфиг модели требует на диске: `[{ flag, path }]`. null — конфиг
 * не разобрать или он не про файлы (чужая схема): тогда о наличии судить нечем, и
 * вызывающий показывает «неизвестно», а не «файлов нет».
 *
 * Читается JSON.parse, а не текст: здесь важно значение поля, а формат файла эта
 * функция не трогает (правка контекста — отдельно, текстом).
 */
export function modelPaths(text) {
  let cfg = null;
  try {
    cfg = JSON.parse(String(text ?? '').replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
  const list = [];
  if (cfg && typeof cfg.exe === 'string' && cfg.exe) list.push({ flag: 'exe', path: cfg.exe });
  const args = cfg && Array.isArray(cfg.args) ? cfg.args.map(String) : [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (MODEL_PATH_FLAGS.includes(args[i].toLowerCase())) list.push({ flag: args[i], path: args[i + 1] });
  }
  return list.length ? list : null;
}

/**
 * Пути конфига, которых больше нет на диске. null — судить нечем (см. modelPaths),
 * `[]` — всё на месте. Относительные пути считаются от папки самого конфига.
 */
export async function missingModelPaths(text, file) {
  const list = modelPaths(text);
  if (!list) return null;
  const missing = [];
  for (const item of list) {
    const resolved = path.isAbsolute(item.path) ? item.path : path.resolve(path.dirname(file), item.path);
    try {
      await fs.stat(resolved);
    } catch {
      missing.push(item.path);
    }
  }
  return missing;
}
