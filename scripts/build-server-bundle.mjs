#!/usr/bin/env node
// Собирает автономную серверную поставку: <out>/server с кодом, Web, расширениями
// Pi, скриптами, шаблоном конфигурации, lockfile и release-manifest.json.
//
//   node scripts/build-server-bundle.mjs [--out clients/kmp/dist/.staging/TaskBridge/server]
//
// Зачем отдельный шаг: `:desktopApp:portable` кладёт только Compose-приложение, а
// распакованный ZIP без репозитория должен уметь поднять локальный сервер. Сборка
// идёт офлайн и только копированием — ничего не скачивает и не ставит.
//
// Что попадает в manifest: версия TaskBridge, версия Node, требуемая строка
// engines, SHA256 каждого файла и явная запись о том, что проверенный LAN-маршрут
// (health, список задач, Web, vendor-модули) не требует node_modules: браузерные
// зависимости лежат в web/vendor, а сервер использует только встроенные модули
// Node. Опциональные облачные зависимости (pg) в локальную поставку не входят —
// им нужен `npm ci --omit=dev` по включённому lockfile.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const out = path.resolve(argValue('--out', path.join(repo, 'clients/kmp/dist/.staging/TaskBridge/server')));

// Same roots as :desktopApp:standalonePortable, so a manual build and a Gradle
// build do not produce two different products.
const roots = ['src', 'scripts', 'web', 'pi-extension'];
const files = ['package.json', 'package-lock.json', 'config.example.json'];
const skipDir = new Set(['node_modules', '.git', 'data', 'dist', '.gradle', 'build']);
const skipFile = name => name.endsWith('.log') || name === 'config.json' || name.endsWith('.tmp');

async function copyFiltered(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDir.has(entry.name)) continue;
      await copyFiltered(path.join(from, entry.name), path.join(to, entry.name));
    } else if (entry.isFile() && !skipFile(entry.name)) {
      await fs.copyFile(path.join(from, entry.name), path.join(to, entry.name));
    }
  }
}

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).replaceAll('\\', '/'));
  }
  return out.sort();
}

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
for (const root of roots) await copyFiltered(path.join(repo, root), path.join(out, root));
for (const file of files) await fs.copyFile(path.join(repo, file), path.join(out, file));

const packageJson = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
const entries = {};
for (const rel of await walk(out)) {
  entries[rel] = crypto.createHash('sha256').update(await fs.readFile(path.join(out, rel))).digest('hex');
}
const manifest = {
  product: 'TaskBridge',
  version: packageJson.version,
  builtAt: new Date().toISOString(),
  node: { required: packageJson.engines?.node || null, builtWith: process.version, note: 'Node is supplied by the distribution, never by PATH' },
  entrypoints: { server: 'src/server.mjs', launcher: 'scripts/start-lan.mjs', proxy: 'src/proxy.mjs', backup: 'scripts/backup.mjs' },
  settings: { configEnv: 'TASKBRIDGE_CONFIG_DIR', dataEnv: 'TASKBRIDGE_DATA_DIR', template: 'config.example.json' },
  runtimeDependencies: {
    nodeModulesBundled: false,
    browserVendored: ['web/vendor/marked.js', 'web/vendor/purify.mjs', 'web/vendor/qrcode.mjs'],
    note: 'The audited local path uses only Node built-ins and the vendored browser modules. Cloud PostgreSQL is optional and requires: npm ci --omit=dev',
  },
  files: entries,
};
await fs.writeFile(path.join(out, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// A bundle that references a file nobody copied fails on the operator's machine
// with a stack trace instead of at build time.
const missing = [];
for (const root of roots) if (!(await fs.stat(path.join(out, root)).then(() => true, () => false))) missing.push(root);
for (const file of [...files, 'release-manifest.json']) if (!(await fs.stat(path.join(out, file)).then(() => true, () => false))) missing.push(file);
if (missing.length) {
  console.error(`bundle incomplete: ${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`server bundle: ${path.relative(repo, out) || '.'} — ${Object.keys(entries).length} files, ${Object.keys(entries).length ? Math.round(Object.values(entries).reduce((sum, hash) => sum + hash.length, 0) / 1024) : 0} KiB of hashes`);
}
