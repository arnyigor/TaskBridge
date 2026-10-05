// Пресеты llama.cpp роутера (models.ini) для моделей из библиотеки TaskBridge.
//
// Скачанная с Hugging Face модель становится видимой для Pi через роутер:
// llama-server читает --models-preset при старте и отдаёт пресеты через /models,
// а Pi перечисляет их под своим провайдером роутера. В ~/.pi/agent/models.json
// TaskBridge не пишет — это файл Pi (правило внешних серверов, см.
// ExternalLocalServers.forget).
//
// models.ini — чужой файл: он правится текстом, только добавлением/заменой
// секции пресета. Глобальные ключи (version = 1), секция [*] с дефолтами и
// порядок остальных секций остаются байт-в-байт (CRLF сохраняется).

import fs from 'node:fs/promises';

// [section] с точным совпадением имени; имя секции — до перевода строки.
const sectionRe = id => new RegExp(`^\\[${escapeRe(id)}\\][ \\t]*(?:\\r?\\n|$)`, 'm');

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Текст, где секция [id] заменена на body (или добавлена в конец). Чистая —
 * покрыта тестами. Возврат null означал бы «двигай сам»: таких случаев нет,
 * файл всегда можно дописать.
 */
export function upsertPreset(text, id, body) {
  const source = String(text ?? '');
  if (!id || /[\\[\]\r\n]/.test(id)) {
    throw Object.assign(new Error(`Недопустимое имя пресета: ${id}`), { code: 'INPUT_INVALID' });
  }
  const section = sectionRe(id);
  const match = section.exec(source);
  if (!match) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const prefix = source && !source.endsWith(eol) ? eol : '';
    return `${source}${prefix}${eol}[${id}]${eol}${body.trimEnd()}${eol}`;
  }
  // Границы секции: от её заголовка до следующего заголовка или конца файла.
  const rest = source.slice(match.index);
  const next = /^\[[^\]\r\n]+\]/m.exec(rest.slice(rest.indexOf('\n') + 1));
  const end = next ? match.index + rest.indexOf('\n') + 1 + next.index : source.length;
  return `${source.slice(0, match.index)}[${id}]\n${body.trimEnd()}\n${source.slice(end).replace(/^\r?\n/, '')}`;
}

/**
 * Убрать секцию [id] из models.ini (при удалении модели из библиотеки).
 * Возвращает { text, changed } или null, если секции нет.
 */
export function removePreset(text, id) {
  const source = String(text ?? '');
  const match = sectionRe(id).exec(source);
  if (!match) return null;
  const rest = source.slice(match.index);
  const next = /^\[[^\]\r\n]+\]/m.exec(rest.slice(rest.indexOf('\n') + 1));
  const end = next ? match.index + rest.indexOf('\n') + 1 + next.index : source.length;
  return { text: `${source.slice(0, match.index)}${source.slice(end).replace(/^\r?\n/, '')}`, changed: true };
}

// Ключи пресета, значения которых — пути к файлам модели. Тот же набор, что у
// внешних серверов (`engine-context.mjs`: MODEL_PATH_FLAGS), только в виде
// ключей models.ini: проверка наличия файлов нужна, чтобы строка с удалёнными
// весами сказала об этом, а не предлагала «Запустить» то, чего нет.
export const PRESET_PATH_KEYS = ['model', 'mmproj', 'pack', 'native', 'ple-gguf', 'expert-profile', 'mtp'];

/**
 * Секции models.ini как данные: id, пути к файлам и признак vision.
 * `vision` = у пресета есть работающий `mmproj` (строка не закомментирована)
 * и не выключен автоподбор проектора (`no-mmproj`/`mmproj-auto`). Чистая —
 * покрыта тестами.
 * Секции без `model` (`[*]` с дефолтами, глобальные ключи) пропускаются: у
 * пресета без файла весов нет своей модели.
 */
export function parsePresets(text) {
  const presets = [];
  let current = null;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const head = /^\s*\[([^\]\r\n]+)\]\s*$/.exec(rawLine);
    if (head) {
      current = { id: head[1], paths: [], mmproj: null, autoOff: false };
      presets.push(current);
      continue;
    }
    if (!current) continue;   // глобальные ключи до первой секции
    const kv = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/.exec(rawLine);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2];
    // Автоподбор проектора: `no-mmproj = true` и `mmproj-auto = false` — одно и то же.
    if (key === 'no-mmproj' || key === 'mmproj-auto') {
      const truthy = /^(?:true|1|yes|on)$/i.test(value);
      current.autoOff = key === 'no-mmproj' ? truthy : !truthy;
      continue;
    }
    if (!PRESET_PATH_KEYS.includes(key) || !value) continue;
    current.paths.push({ key, value });
    if (key === 'mmproj') current.mmproj = value;
  }
  return presets
    .filter(preset => preset.paths.some(path => path.key === 'model'))
    .map(({ id, paths, mmproj, autoOff }) => ({ id, paths, mmproj, vision: Boolean(mmproj) && !autoOff }));
}

/**
 * Включить/выключить vision у пресета [id] правкой его секции в models.ini.
 *
 * Шаг 1 (измерено на живом llama-server b-серии, 2026-10-04): `no-mmproj`
 * (= `--no-mmproj-auto`) выключает только АВТОподбор проектора для `-hf` —
 * явный `mmproj = <файл>` он не отменяет и проектор всё равно грузится.
 * Поэтому выключение комментирует строку проектора (`; mmproj = <файл>`, как
 * комментарии самого models.ini; inih-парсер llama.cpp их не читает — проверено
 * тем же опытом), а путь остаётся в файле, виден человеку и нужен включению
 * обратно. Включение раскомментирует эту строку; если её нет, нужен путь
 * проектора — его передаёт вызывающий ([mmproj] из другой секции с теми же
 * весами или найденный рядом с ними файл): сам модуль по диску не ходит.
 *
 * Чистая — покрыта тестами. null — секции с таким id в файле нет (строка
 * пришла не из models.ini: править нечего).
 */
export function patchPresetVision(text, id, { vision, mmproj = null } = {}) {
  const source = String(text ?? '');
  const lines = source.split(/\r?\n/);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*\[([^\]\r\n]+)\]\s*$/.exec(lines[i]);
    if (!head) continue;
    if (start < 0) {
      if (head[1] === id) start = i;
      continue;
    }
    end = i;
    break;
  }
  if (start < 0) return null;

  const autoRe = /^\s*(no-mmproj|mmproj-auto)\s*=\s*(.*?)\s*$/i;
  const mmprojRe = /^\s*mmproj\s*=\s*(.+?)\s*$/i;
  const parkedRe = /^\s*[;#]\s*mmproj\s*=\s*(.+?)\s*$/i;
  const modelRe = /^\s*model\s*=\s*.+$/i;
  const on = value => /^(?:true|1|yes|on)$/i.test(value);
  let modelLine = -1;
  let mmprojLine = -1;
  let parkedLine = -1;
  let parkedPath = null;
  const autoLines = [];
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (modelLine < 0 && modelRe.test(line)) { modelLine = i; continue; }
    if (mmprojLine < 0 && mmprojRe.test(line)) { mmprojLine = i; continue; }
    if (parkedLine < 0 && parkedRe.test(line)) { parkedLine = i; parkedPath = parkedRe.exec(line)[1]; continue; }
    const auto = autoRe.exec(line);
    if (auto) autoLines.push({ index: i, key: auto[1].toLowerCase(), value: auto[2] });
  }
  // Пути и флаги читаем ДО правки строк: вставка сдвигает индексы.
  const projector = mmprojLine >= 0 ? mmprojRe.exec(lines[mmprojLine])[1] : null;
  // `mmproj-auto = true` — это автоматика ВКЛючена; `no-mmproj = true` — выключена.
  const autoOff = autoLines.some(entry => (entry.key === 'no-mmproj' ? on(entry.value) : !on(entry.value)));
  const previous = Boolean(projector) && !autoOff;

  if (vision === false) {
    if (!previous && autoOff) return { text: source, previous, mmproj: null, changed: false };
    const updated = [...lines];
    if (parkedLine < 0 && mmprojLine >= 0) updated[mmprojLine] = `; mmproj = ${projector}`;
    // Автоподбор проектора тоже выключаем: у пресета с -hf иначе найдётся
    // чужая проекция, и «только текст» окажется неправдой.
    const autoLine = autoLines[0];
    if (autoLine) updated[autoLine.index] = autoLine.key === 'no-mmproj' ? 'no-mmproj = true' : 'mmproj-auto = false';
    else updated.splice(modelLine >= 0 ? modelLine + 1 : start + 1, 0, 'no-mmproj = true');
    return { text: updated.join(eol), previous, mmproj: null, changed: true };
  }
  if (vision !== true) {
    throw Object.assign(new Error('Поле vision — это true или false.'), { code: 'INPUT_INVALID' });
  }

  const enabled = projector || parkedPath || (mmproj ? String(mmproj) : null);
  if (!enabled) {
    throw Object.assign(new Error('У пресета нет mmproj-проектора — включать vision нечем.'), { code: 'LOCAL_VISION_UNSUPPORTED' });
  }
  if (previous) return { text: source, previous, mmproj: enabled, changed: false };
  // Флаги автоподбора убираем: включённый vision у этого пресета — явный mmproj,
  // а висящий рядом `no-mmproj = true` читался бы человеком как «выключено».
  // Строки перебираем в один проход: список чистится, поэтому индексы из
  // первоначального разбора применимы только через сравнение с ними.
  const updated = [];
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const inside = i > start && i < end;
    if (inside && autoRe.test(lines[i])) continue;
    if (inside && i === parkedLine) { updated.push(`mmproj = ${enabled}`); continue; }
    // Позиция строки model — в новом массиве, а не в старом: строки выше неё
    // могли быть убраны, а искать «первый model в файле» нельзя — это модель
    // соседней секции (и правка ушла бы в чужой пресет).
    if (i === modelLine) insertAt = updated.length;
    updated.push(lines[i]);
  }
  if (mmprojLine < 0 && parkedLine < 0) {
    updated.splice(insertAt >= 0 ? insertAt + 1 : start + 1, 0, `mmproj = ${enabled}`);
  }
  return { text: updated.join(eol), previous, mmproj: enabled, changed: true };
}

/**
 * Путь к models.ini из args роутера (`--models-preset <файл>`). null — роутер
 * не настроен или путь не задан: прописывать некуда.
 */
export function modelsPresetPath(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const i = list.findIndex(a => a.toLowerCase() === '--models-preset');
  return i >= 0 && list[i + 1] ? list[i + 1] : null;
}

/**
 * `ctx-size` секции пресета, у которой `model =` совпадает с modelPath
 * (полным путём, без учёта регистра; фолбэк — совпадение имени файла).
 * Строки с `ctx-size = N` заменяется, при отсутствии — вставляется после
 * строки `model`. Возврат null: секции с таким файлом в models.ini нет.
 * Чистая — покрыта тестами; чужой файл правится только этой строкой.
 */
export function patchPresetContext(text, modelPath, ctxSize) {
  if (!ctxSize || !Number.isInteger(Number(ctxSize)) || Number(ctxSize) <= 0) {
    throw Object.assign(new Error(`Контекст — целое положительное число, получено: ${ctxSize}`), { code: 'INPUT_INVALID' });
  }
  if (!modelPath) return null;
  const lines = String(text ?? '').split(/\r?\n/);
  const eol = String(text ?? '').includes('\r\n') ? '\r\n' : '\n';
  const wanted = String(modelPath).toLowerCase();
  const wantedName = wanted.split(/[\\/]/).pop();

  let sectionStart = -1;   // индекс строки с model = внутри подходящей секции
  let current = null;      // { modelLine, matches }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = /^\s*\[([^\]\r\n]+)\]/.exec(line);
    if (header) {
      if (current?.matches) { sectionStart = current.modelLine; break; }
      current = { modelLine: -1, matches: false };
      continue;
    }
    if (current) {
      const model = /^\s*model\s*=\s*(.+?)\s*$/.exec(line);
      if (model && current.modelLine < 0) {
        const value = model[1].toLowerCase();
        current.matches = value === wanted || value.split(/[\\/]/).pop() === wantedName;
        current.modelLine = i;
      }
      // `[*]`-дефолты и глобальные ключи до первой секции не считаем пресетом:
      // у секции без model нет своего файла.
    }
  }
  if (sectionStart < 0 && current?.matches) sectionStart = current.modelLine;
  if (sectionStart < 0) return null;

  const ctxRe = /^\s*ctx-size\s*=\s*.*$/i;
  const previous = ctxRe.exec(lines[sectionStart]);
  for (let i = sectionStart; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break; // следующая секция — ctx-size не найден
    if (ctxRe.test(lines[i])) {
      const old = lines[i];
      const previous = /\d+/.exec(old);
      lines[i] = `ctx-size = ${ctxSize}`;
      return { text: lines.join(eol), previous: previous ? Number(previous[0]) : null, changed: old !== lines[i] };
    }
  }
  lines.splice(sectionStart + 1, 0, `ctx-size = ${ctxSize}`);
  return { text: lines.join(eol), previous: null, changed: true };
}

/**
 * Зарегистрировать модель библиотеки в models.ini: секция с model (+ mmproj
 * для vision) и ctx-size. Дефолты загрузки наследуются от секции [*] — свой
 * блок здесь только то, что у пресета своё.
 *
 * Возвращает { preset, file, changed, restartRequired }. restartRequired —
 * роутер сейчас жив: llama.cpp читает models.ini при старте, поэтому новый
 * пресет он увидит после перезапуска (решает пользователь, модель не трогаем).
 */
export async function registerLibraryPreset({ entry, file, ctxSize = 32768, routerAlive = false } = {}) {
  if (!entry || !Array.isArray(entry.files) || !entry.files.length) {
    throw Object.assign(new Error('У записи библиотеки нет файлов.'), { code: 'INPUT_INVALID' });
  }
  if (!file) {
    throw Object.assign(new Error('Роутер не настроен (localRuntime.router без --models-preset) — прописать модель некуда.'), { code: 'NOT_CONFIGURED' });
  }
  const weights = entry.files.filter(f => !/mmproj/i.test(f.path));
  const projector = entry.files.find(f => /mmproj/i.test(f.path));
  if (!weights.length) {
    throw Object.assign(new Error('В записи нет файла весов (.gguf).'), { code: 'INPUT_INVALID' });
  }
  // Имя секции — slug записи: точки/прочее в INI-заголовке не нужны.
  const preset = String(entry.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const lines = [`model = ${weights[0].path}`, `ctx-size = ${ctxSize}`];
  if (projector) lines.splice(1, 0, `mmproj = ${projector.path}`);
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const updated = upsertPreset(text, preset, lines.join('\n'));
  const changed = updated !== text;
  if (changed) {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, updated, 'utf8');
    await fs.rename(tmp, file);
  }
  return {
    preset,
    file,
    changed,
    restartRequired: Boolean(routerAlive),
    model: weights[0].path,
    mmproj: projector ? projector.path : null
  };
}
