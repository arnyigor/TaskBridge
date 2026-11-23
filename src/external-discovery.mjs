// Автообнаружение внешних локальных серверов (Strata и подобных).
//
// Зачем: список «Локальные модели» собирается из localRuntime.externalServers,
// и каждая новая модель требует ручной записи в config.json. При этом Pi уже
// знает про эти серверы: они лежат в его models.json как провайдеры с baseUrl на
// 127.0.0.1. Здесь мы читаем этот файл и превращаем такие провайдеры в записи
// externalServers, ничего не требуя от пользователя.
//
// Команду запуска (start) для найденного сервера взять неоткуда — Pi её не
// хранит. Поэтому она собирается по конвенции из блока
// `localRuntime.externalDiscovery` (каталог установки + пути внутри него), а
// конкретный конфиг сервера находится сопоставлением ПОРТА: у каждой установки
// Strata есть свои strata-<модель>.json, и в каждом лежит поле `port`.
import fs from 'node:fs';
import path from 'node:path';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Локальный ли адрес. Именно этот признак (а не имя провайдера) отделяет
// «сервер на этой машине» от облачного: у облачных baseUrl внешний.
export function isLocalBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

// «хост:порт» без схемы, пути и хвостового слэша — одна и та же точка на диске
// машины. Нужен там, где имя провайдера в конфиге и в Pi разное, а сервер один.
// null = адрес не разобрать.
export function endpointKey(value) {
  try {
    const url = new URL(String(value));
    const port = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
    if (!port) return null;
    return `${url.hostname.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

// Порт из baseUrl (8083) — по нему сопоставляем запись Pi с конфигом сервера.
export function portOfBaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

// `--max-context` из args движка: контекст, который сервер реально поднимает.
function maxContextFromArgs(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const i = list.indexOf('--max-context');
  const value = i >= 0 ? Number(list[i + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Конфиги серверов внутри каталога установки: [{ file, name, port, contextWindow }].
 * Читается по одному JSON на файл; битый файл просто пропускается — обнаружение
 * не должно ронять статус из-за чужого мусора в каталоге.
 */
export function readServerConfigs(dir, pattern = 'strata-*.json') {
  if (!dir || !fs.existsSync(dir)) return [];
  const mask = String(pattern || 'strata-*.json');
  const prefix = mask.split('*')[0];
  const suffix = mask.split('*')[1] ?? '.json';
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const file = path.join(dir, name);
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const port = Number(cfg.port);
      if (!Number.isFinite(port) || port <= 0) continue;
      out.push({
        file,
        name,
        port,
        contextWindow: maxContextFromArgs(cfg.args)
      });
    } catch {
      // не наш конфиг или недописанный — пропускаем
    }
  }
  return out;
}

/**
 * Записи externalServers, собранные из Pi.
 *
 * agentDir       — каталог Pi (~/.pi/agent), там лежит models.json
 * discovery      — localRuntime.externalDiscovery: { dir, python, server, engine, configGlob, pattern }
 * configured     — уже настроенные записи: их baseUrl/provider имеют приоритет
 */
/** Конфиг Basalt (`basalt_config.json`): порт в server.port, контекст в engine["max-context"]. */
export function readBasaltConfig(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const port = Number(cfg && cfg.server && cfg.server.port);
    if (!Number.isFinite(port) || port <= 0) return null;
    const engine = (cfg && cfg.engine) || {};
    const ctx = Number(engine['max-context']);
    return {
      file,
      name: path.basename(file),
      port,
      contextWindow: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
      model: Array.isArray(cfg.models) && cfg.models[0] ? String(cfg.models[0].model || '') : ''
    };
  } catch {
    return null;
  }
}

/** Источники обнаружения: `sources` из localRuntime.externalDiscovery, иначе старый одиночный dir/glob. */
export function discoverySources(discovery = {}) {
  const list = Array.isArray(discovery.sources) ? discovery.sources.filter(Boolean) : [];
  const sources = list.map(src => ({
    dir: src.dir ? String(src.dir) : null,
    engine: src.engine || 'strata',
    kind: src.kind || (src.configFile ? 'basalt' : 'strata'),
    configGlob: src.configGlob || 'strata-*.json',
    configFile: src.configFile || null,
    python: src.python || null,
    server: src.server || null,
    // Команда запуска: массив с {config} и {port}; без неё — старая Strata-команда.
    command: Array.isArray(src.command) ? src.command.map(String) : null
  }));
  if (discovery.dir && !sources.some(src => src.dir === String(discovery.dir))) {
    sources.unshift({
      dir: String(discovery.dir),
      engine: discovery.engine || 'strata',
      kind: 'strata',
      configGlob: discovery.configGlob || 'strata-*.json',
      configFile: null,
      python: discovery.python || null,
      server: discovery.server || null,
      command: null
    });
  }
  return sources;
}

/** Конфиги одного источника в том же виде, что readServerConfigs: {file, name, port, contextWindow}. */
export function readSourceConfigs(source) {
  if (!source || !source.dir) return [];
  if (source.kind === 'basalt') {
    const file = source.configFile ? path.join(source.dir, source.configFile) : null;
    const one = file ? readBasaltConfig(file) : null;
    return one ? [one] : [];
  }
  return readServerConfigs(source.dir, source.configGlob);
}

export function discoverExternalServers({ agentDir, discovery = {}, configured = [], exclude = [] } = {}) {
  const modelsPath = agentDir ? path.join(agentDir, 'models.json') : null;
  if (!modelsPath || !fs.existsSync(modelsPath)) return [];
  let providers = {};
  try {
    providers = JSON.parse(fs.readFileSync(modelsPath, 'utf8')).providers || {};
  } catch {
    return [];
  }

  // Ручная запись в конфиге сильнее обнаружения, а исключённые — это роутер
  // (llama.cpp/llamacpp) и всё, что указывает на тот же порт, что и он: их
  // строками «внешних серверов» показывать нельзя, они часть рантайма.
  const skip = new Set([
    ...(Array.isArray(configured) ? configured : []).map(entry => entry && entry.provider),
    ...(Array.isArray(exclude) ? exclude : [])
  ].filter(Boolean));

  // Эндпоинты, уже описанные в конфиге TaskBridge: тот же сервер под другим
  // именем провайдера показывать второй раз нельзя (см. проверку ниже).
  const configuredEndpoints = new Set(
    (Array.isArray(configured) ? configured : [])
      .map(entry => endpointKey(entry && entry.baseUrl))
      .filter(Boolean)
  );

  // Несколько источников: папка Strata (configGlob) и папки других движков (Basalt: один конфиг).
  const sources = discoverySources(discovery);
  const byPort = new Map();       // порт -> {cfg, source}
  for (const source of sources) {
    for (const cfg of readSourceConfigs(source)) {
      if (!byPort.has(cfg.port)) byPort.set(cfg.port, { cfg, source });
    }
  }
  const routerPort = portOfBaseUrl(discovery.healthUrl);

  const found = [];
  for (const [provider, block] of Object.entries(providers)) {
    if (!block || typeof block !== 'object') continue;
    if (skip.has(provider)) continue;
    const baseUrl = block.baseUrl;
    if (!isLocalBaseUrl(baseUrl)) continue;

    const port = portOfBaseUrl(baseUrl);
    // Свой сервер на порту роутера — это и есть роутер.
    if (routerPort != null && port === routerPort) continue;
    // Тот же эндпоинт уже описан в externalServers — но под другим именем
    // провайдера (в конфиге «strata-iq3s», в Pi «strata» на том же 8083). Это
    // один сервер, а не два: списку он показывался двумя одинаковыми строками.
    // Остаётся ручная запись — она подробнее (в ней команда запуска) и её можно
    // убрать из списка TaskBridge.
    if (configuredEndpoints.has(endpointKey(baseUrl))) continue;

    // Главный признак «наш сервер»: в каталоге установки есть его конфиг с этим
    // портом. Иначе мы не знаем ни команды запуска, ни контекста — и не выдаём
    // чужой локальный эндпоинт (прокси, релей) за модель Strata.
    const hit = byPort.get(port);
    if (!hit) continue;
    const cfg = hit.cfg;
    const source = hit.source;
    const dir = source.dir;
    const python = source.python || path.join('.venv', 'Scripts', 'python.exe');
    const server = source.server || path.join('serve', 'server.py');
    const engine = source.engine || 'strata';
    // Команда запуска: своя у источника (Basalt: bin/basalt.exe serve --config ...),
    // иначе прежняя Strata-команда через serve/server.py.
    const startCommand = Array.isArray(source.command) && source.command.length
      ? source.command.map(token => {
          const text = String(token)
            .replace('{config}', cfg.file)
            .replace('{port}', String(port))
            .replace('{dir}', dir);
          // Относительный путь из команды источника (bin/basalt.exe, .venv/Scripts/python.exe)
          // разворачиваем от папки источника: spawn получает cwd, но ищет exe не в нём.
          return !text.startsWith('-') && /[\/]/u.test(text) && !path.isAbsolute(text)
            ? path.join(dir, text)
            : text;
        })
      : [path.join(dir, python), path.join(dir, server), '--engine', engine,
         '--config', cfg.file, '--port', String(port)];

    const first = (Array.isArray(block.models) ? block.models : [])[0] || {};
    const entry = {
      provider,
      model: first.id || provider,
      name: first.name || first.id || provider,
      // baseUrl — адрес сервера как такового (health, запуск); apiBaseUrl — исходный
      // адрес из Pi models.json, как его видит провайдер API. Различие реально:
      // OpenAI-совместимый Strata отвечает на /v1/chat/completions, и проба модели,
      // отправленная без /v1, проверила бы чужой маршрут.
      baseUrl: baseUrl.replace(/\/v1\/?$/u, ''),
      apiBaseUrl: baseUrl,
      // Реквизиты из Pi models.json: ключ может быть и '$ENV_VAR', и литералом;
      // разворачивает окружение вызывающая сторона.
      apiKey: block.apiKey ?? null,
      loadTimeoutMs: 600000,
      discovered: true,
      start: startCommand,
      cwd: dir
    };
    // Контекст берём из конфига движка (что реально поднято), если он там есть.
    if (cfg.contextWindow) entry.contextWindow = cfg.contextWindow;
    else if (Number.isFinite(first.contextWindow)) entry.contextWindow = first.contextWindow;
    found.push(entry);
  }
  return found;
}
