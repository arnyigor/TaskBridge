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

  const dir = discovery.dir ? String(discovery.dir) : null;
  const configs = dir ? readServerConfigs(dir, discovery.configGlob) : [];
  const routerPort = portOfBaseUrl(discovery.healthUrl);
  const python = discovery.python || path.join('.venv', 'Scripts', 'python.exe');
  const server = discovery.server || path.join('serve', 'server.py');
  const engine = discovery.engine || 'strata';

  const found = [];
  for (const [provider, block] of Object.entries(providers)) {
    if (!block || typeof block !== 'object') continue;
    if (skip.has(provider)) continue;
    const baseUrl = block.baseUrl;
    if (!isLocalBaseUrl(baseUrl)) continue;

    const port = portOfBaseUrl(baseUrl);
    // Свой сервер на порту роутера — это и есть роутер.
    if (routerPort != null && port === routerPort) continue;

    // Главный признак «наш сервер»: в каталоге установки есть его конфиг с этим
    // портом. Иначе мы не знаем ни команды запуска, ни контекста — и не выдаём
    // чужой локальный эндпоинт (прокси, релей) за модель Strata.
    const cfg = configs.find(item => item.port === port);
    if (!dir || !cfg) continue;

    const first = (Array.isArray(block.models) ? block.models : [])[0] || {};
    const entry = {
      provider,
      model: first.id || provider,
      name: first.name || first.id || provider,
      baseUrl: baseUrl.replace(/\/v1\/?$/u, ''),
      loadTimeoutMs: 600000,
      discovered: true,
      start: [
        path.join(dir, python),
        path.join(dir, server),
        '--engine', engine,
        '--config', cfg.file,
        '--port', String(port)
      ],
      cwd: dir
    };
    // Контекст берём из конфига движка (что реально поднято), если он там есть.
    if (cfg.contextWindow) entry.contextWindow = cfg.contextWindow;
    else if (Number.isFinite(first.contextWindow)) entry.contextWindow = first.contextWindow;
    found.push(entry);
  }
  return found;
}
