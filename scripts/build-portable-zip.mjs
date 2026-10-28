#!/usr/bin/env node
// Собирает portable ZIP (PKG-01) из уже подготовленного каталога сборки:
//
//   node scripts/build-portable-zip.mjs [--dist clients/kmp/dist/.staging/TaskBridge] [--out <file.zip>]
//
// Внутри архива: TaskBridge.exe, app/, runtime/, server/ (поставка из DIST-03) и
// SHA256SUMS.txt с хешами всех файлов. Рядом с архивом кладётся <архив>.sha256.
//
// Что НЕ попадает в архив никогда: config.json, каталоги data/logs/backups/config
// и любые *.log — это состояние оператора, а не программа. Проверка идёт по всему
// дереву, а не только по корню: поставка сервера лежит на уровень глубже.
//
// ZIP собирается системным tar (Windows 10+ умеет `-a -c -f .zip`), без npm-зависимостей:
// сборка не должна тянуть сеть и не должна падать на машине без архиватора.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

const FORBIDDEN_DIRS = new Set(['data', 'logs', 'backups', 'config', 'node_modules', '.git', '.gradle']);
const FORBIDDEN_FILES = new Set(['config.json']);

async function walk(dir, base = dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (FORBIDDEN_DIRS.has(entry.name)) throw new Error(`portable build contains operator state: ${path.relative(base, full)}`);
      await walk(full, base, out);
    } else if (entry.isFile()) {
      if (FORBIDDEN_FILES.has(entry.name)) throw new Error(`portable build contains settings: ${path.relative(base, full)}`);
      if (entry.name.toLowerCase().endsWith('.log')) throw new Error(`portable build contains a log: ${path.relative(base, full)}`);
      out.push(full);
    }
  }
  return out;
}

const sha256 = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

// Git's GNU tar accepts -a but writes TAR for .zip. Use Windows' libarchive tar,
// not the first tar.exe on PATH. Non-Windows builds require bsdtar explicitly.
export const portableTarCommand = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'bsdtar';

export async function buildPortableZip({ dist, out, tarCommand = portableTarCommand } = {}) {
  const packageJson = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
  const root = path.resolve(dist);
  const exe = path.join(root, 'TaskBridge.exe');
  if (!(await fs.stat(exe).then(() => true, () => false))) {
    throw new Error(`portable build is missing TaskBridge.exe: ${root} — run ./gradlew :desktopApp:portable first`);
  }
  const manifestFile = path.join(root, 'server', 'release-manifest.json');
  const manifest = await fs.readFile(manifestFile, 'utf8').then(JSON.parse, () => null);
  if (!manifest) {
    throw new Error(`portable build has no server bundle: ${manifestFile} — run ./gradlew :desktopApp:standalonePortable first`);
  }
  // A repeated build must not hash the previous manifest into its replacement.
  const files = (await walk(root)).filter(file => file !== path.join(root, 'SHA256SUMS.txt')).sort();
  const sums = [];
  for (const file of files) sums.push(`${await sha256(file)}  ${path.relative(root, file).replaceAll('\\', '/')}`);
  await fs.writeFile(path.join(root, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);

  const target = path.resolve(out || path.join(path.dirname(root), `TaskBridge-Portable-${packageJson.version}-win-x64.zip`));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(target, { force: true });
  await fs.rm(`${target}.sha256`, { force: true });
  // -a выбирает формат по расширению (.zip), -C даёт относительные пути внутри архива.
  // Пути передаются ОТНОСИТЕЛЬНО рабочего каталога: Windows-tar читает `G:\...` как
  // `хост:путь` и падает с «Cannot connect to G:» (проверено на этой машине).
  const targetDir = path.dirname(target);
  const result = spawnSync(
    tarCommand,
    ['-a', '-c', '-f', path.basename(target), '-C', path.relative(targetDir, path.dirname(root)) || '.', path.basename(root)],
    { cwd: targetDir, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`archiving failed (${tarCommand} ${result.status}): ${result.stderr || result.error?.message || ''}`.trim());
  // A successful tar exit and round-trip do not prove the output is ZIP.
  const handle = await fs.open(target, 'r');
  const signature = Buffer.alloc(4);
  try { await handle.read(signature, 0, 4, 0); } finally { await handle.close(); }
  if (!signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    await fs.rm(target, { force: true });
    throw new Error('archiver did not produce ZIP (missing PK header); use libarchive/bsdtar, not GNU tar');
  }
  const zipHash = await sha256(target);
  await fs.writeFile(`${target}.sha256`, `${zipHash}  ${path.basename(target)}\n`);
  const stat = await fs.stat(target);
  return { target, bytes: stat.size, files: files.length + 1, sha256: zipHash, version: packageJson.version, serverVersion: manifest.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = argValue('--dist', path.join(repo, 'clients/kmp/dist/.staging/TaskBridge'));
  const out = argValue('--out', null);
  try {
    const built = await buildPortableZip({ dist, out });
    console.log(`portable zip: ${path.relative(repo, built.target) || built.target}`);
    console.log(`  version ${built.version} (server ${built.serverVersion}), ${built.files} files, ${(built.bytes / 1048576).toFixed(1)} MiB`);
    console.log(`  sha256 ${built.sha256}`);
  } catch (error) {
    console.error(`portable zip: ${error.message}`);
    process.exitCode = 1;
  }
}
