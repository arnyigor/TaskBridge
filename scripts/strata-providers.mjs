#!/usr/bin/env node
/**
 * strata-providers.mjs — держит провайдеров Strata в ~/.pi/agent/models.json в согласии с конфигами Strata.
 *
 * Зачем: автообнаружение TaskBridge (`localRuntime.externalDiscovery`) берёт провайдеров из models.json,
 * вытаскивает порт и по нему находит конфиг Strata. Если провайдера нет — модель в списке не появится,
 * а раньше его дописывала панель Strata, что связывало её с TaskBridge (нежелательно).
 *
 * Что делает:
 *   1) читает каталог и маску из config.json → localRuntime.externalDiscovery (.dir, .configGlob);
 *   2) собирает конфиги `strata-*.json` (кроме `disabled-*`): порт, model_name, --max-context;
 *   3) добавляет/обновляет провайдера для каждого такого порта (id сохраняется, если он уже указывал на этот порт);
 *   4) удаляет провайдеров `strata*`, чьих конфигов больше нет или они выключены;
 *   5) пишет models.json только при изменениях, с бэкапом.
 *
 * Запуск:  node scripts/strata-providers.mjs [--dry-run] [--quiet]
 *           --dry-run — только показать, что было бы сделано (ничего не пишет).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DRY = process.argv.includes('--dry-run');
const QUIET = process.argv.includes('--quiet');

const log = (...a) => { if (!QUIET) console.log('[strata-providers]', ...a); };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function externalDiscovery() {
  const cfg = readJson(path.join(ROOT, 'config.json')) || {};
  return (cfg.localRuntime && cfg.localRuntime.externalDiscovery) || {};
}

function configsFrom(dir, pattern = 'strata-*.json') {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const mask = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'u');
  for (const name of fs.readdirSync(dir)) {
    if (!mask.test(name) || name.startsWith('disabled-')) continue;
    const cfg = readJson(path.join(dir, name));
    if (!cfg || !cfg.port) continue;
    const args = Array.isArray(cfg.args) ? cfg.args : [];
    const argValue = (flag) => {
      const i = args.indexOf(flag);
      return i >= 0 ? args[i + 1] : undefined;
    };
    out.push({
      file: name,
      port: Number(cfg.port),
      model: cfg.model_name || path.basename(name, '.json'),
      contextWindow: Number(argValue('--max-context')) || undefined
    });
  }
  return out;
}

function main() {
  const agentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  const modelsPath = path.join(agentDir, 'models.json');
  const store = readJson(modelsPath);
  if (!store || !store.providers) { log('нет ' + modelsPath + ' — нечего делать'); return 0; }
  const disc = externalDiscovery();
  const configs = configsFrom(disc.dir, disc.configGlob || 'strata-*.json');
  // Missing/empty discovery is not evidence that user providers should be deleted.
  if (!configs.length) { log('нет активных конфигов Strata — models.json не изменён'); return 0; }
  const ports = configs.map(config => config.port);
  if (new Set(ports).size !== ports.length) { log('повторяющиеся порты Strata — models.json не изменён'); return 1; }

  // образец для thinkingLevelMap/compat: любой существующий strata-провайдер
  const ids = Object.keys(store.providers).filter((k) => k.startsWith('strata') && store.providers[k]?.models?.length);
  if (!ids.length && configs.length) { log('нет образца strata-провайдера в models.json — ничего не меняю'); return 1; }
  const template = store.providers[ids.find((k) => k === 'strata') || ids[0]];
  const templateModel = template.models[0];

  const portOf = (url) => { const m = String(url || '').match(/:(\d+)/u); return m ? Number(m[1]) : null; };
  const before = JSON.stringify(store.providers);
  const wantedIds = new Set();
  const changed = [];

  for (const c of configs) {
    // id: сохраняем уже существующий для этого порта, иначе строим из имени файла
    const existing = Object.entries(store.providers)
      .find(([id, b]) => id.startsWith('strata') && b && Array.isArray(b.models) && b.models.length && portOf(b.baseUrl) === c.port && !wantedIds.has(id));
    const slug = c.file.replace(/^strata-/u, '').replace(/\.json$/u, '').replace(/[^A-Za-z0-9-]/gu, '') || 'model';
    const id = existing ? existing[0] : (slug === 'iq3_s' ? 'strata' : 'strata-' + slug);
    wantedIds.add(id);
    const provider = JSON.parse(JSON.stringify(template));
    provider.baseUrl = 'http://127.0.0.1:' + c.port + '/v1';
    const model = JSON.parse(JSON.stringify(templateModel));
    model.id = c.model;
    // имя существующего провайдера не переписываем: иначе скрипт «обновляет» одно и то же на каждом запуске
    model.name = (existing && existing[1]?.models?.[0]?.name) || (c.model + ' — Strata — :' + c.port);
    if (c.contextWindow) model.contextWindow = c.contextWindow;
    model.maxTokens = model.maxTokens || 32768;
    provider.models = [model];
    if (JSON.stringify(store.providers[id]) !== JSON.stringify(provider)) {
      store.providers[id] = provider;
      changed.push((existing ? 'обновлён ' : 'добавлен ') + id + ' → :' + c.port);
    }
  }

  // удаляем провайдеров strata*, которым больше не соответствует активный конфиг
  for (const id of Object.keys(store.providers)) {
    if (!id.startsWith('strata') || wantedIds.has(id)) continue;
    delete store.providers[id];
    changed.push('удалён ' + id);
  }

  if (!changed.length) { log('изменений нет (моделей: ' + configs.length + ')'); return 0; }
  log(changed.join('\n[strata-providers] '));
  if (DRY) { log('--dry-run: models.json не изменён'); return 0; }
  if (JSON.stringify(store.providers) === before) return 0;
  fs.copyFileSync(modelsPath, modelsPath + '.bak-strata-sync');
  fs.writeFileSync(modelsPath, JSON.stringify(store, null, 2) + '\n', 'utf8');
  log('models.json обновлён (бэкап: models.json.bak-strata-sync)');
  return 0;
}

process.exit(main());
