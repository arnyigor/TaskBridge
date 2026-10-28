import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPortableZip, portableTarCommand } from '../scripts/build-portable-zip.mjs';

async function sandbox(t, name) {
  await fs.mkdir('.local', { recursive: true });
  const root = await fs.mkdtemp(path.resolve(`.local/taskbridge-${name}-`));
  t.after(async () => {
    for (let attempt = 0; ; attempt++) {
      try { await fs.rm(root, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt >= 9 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) return;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  });
  return root;
}

async function write(root, rel, text = 'marker') {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  return file;
}

/** Minimal portable layout: the exe, the app image, a runtime and a server bundle. */
async function staged(t, { withServer = true } = {}) {
  const root = await sandbox(t, 'zip');
  const dist = path.join(root, 'TaskBridge');
  await write(dist, 'TaskBridge.exe');
  await write(dist, 'app/taskbridge.jar');
  await write(dist, 'runtime/bin/server/jvm.dll');
  if (withServer) {
    await write(dist, 'server/src/server.mjs');
    await write(dist, 'server/package.json', '{"name":"server"}');
    await write(dist, 'server/release-manifest.json', JSON.stringify({ product: 'TaskBridge', version: '1.3.0', files: {} }));
  }
  return { root, dist };
}

const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
// Windows tar reads `G:\path` as host:path, so every invocation runs from the
// directory it works in and receives a relative name.
const tar = (args, cwd) => spawnSync(portableTarCommand, args, { cwd, encoding: 'utf8' });

test('the archive carries the program, the server bundle and a hash list', { timeout: 60000 }, async t => {
  const { root, dist } = await staged(t);
  const out = path.join(root, 'out', 'TaskBridge-Portable-test.zip');
  // Build twice: SHA256SUMS must not include a stale hash of itself.
  await buildPortableZip({ dist, out });
  const built = await buildPortableZip({ dist, out });
  assert.deepEqual((await fs.readFile(out)).subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  assert.equal(built.target, out);
  assert.equal(built.serverVersion, '1.3.0');
  assert(built.bytes > 0);
  assert.match(await fs.readFile(`${out}.sha256`, 'utf8'), new RegExp(`^${built.sha256}  TaskBridge-Portable-test\\.zip$`, 'm'));

  const list = tar(['-tf', path.basename(out)], path.dirname(out));
  assert.equal(list.status, 0, list.stderr);
  const entries = list.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  for (const required of ['TaskBridge/TaskBridge.exe', 'TaskBridge/app/taskbridge.jar', 'TaskBridge/runtime/bin/server/jvm.dll', 'TaskBridge/server/src/server.mjs', 'TaskBridge/server/release-manifest.json', 'TaskBridge/SHA256SUMS.txt']) {
    assert(entries.includes(required), `missing ${required} in ${entries.join(', ')}`);
  }

  // Extracted bytes and the embedded hash list must agree with the source tree.
  const extracted = path.join(root, 'unpacked');
  await fs.mkdir(extracted);
  const untar = tar(['-xf', path.relative(extracted, out), '-C', '.'], extracted);
  assert.equal(untar.status, 0, untar.stderr);
  const sums = (await fs.readFile(path.join(extracted, 'TaskBridge', 'SHA256SUMS.txt'), 'utf8')).trim().split('\n');
  const entriesInSums = sums.map(line => line.slice(66));
  assert(!entriesInSums.includes('SHA256SUMS.txt'));
  assert(entriesInSums.includes('TaskBridge.exe'));
  assert(entriesInSums.includes('server/release-manifest.json'));
  for (const line of sums) {
    const file = path.join(extracted, 'TaskBridge', line.slice(66));
    assert.equal(await hash(file), line.slice(0, 64), line.slice(66));
  }
  assert.equal(await hash(path.join(extracted, 'TaskBridge', 'app/taskbridge.jar')), await hash(path.join(dist, 'app/taskbridge.jar')));
});

for (const forbidden of ['server/config.json', 'server/data/taskbridge.db', 'configure.log', 'server/logs/a.log']) {
  test(`operator state is refused instead of packed: ${forbidden}`, async t => {
    const { root, dist } = await staged(t);
    if (forbidden.endsWith('/') || !path.extname(forbidden)) await fs.mkdir(path.join(dist, forbidden), { recursive: true });
    else await write(dist, forbidden);
    await assert.rejects(
      () => buildPortableZip({ dist, out: path.join(root, 'x.zip') }),
      /operator state|settings|log/,
    );
    assert.equal(await fs.stat(path.join(root, 'x.zip')).then(() => true, () => false), false);
  });
}

test('a missing server bundle is named, not silently zipped', async t => {
  const { root, dist } = await staged(t, { withServer: false });
  await assert.rejects(
    () => buildPortableZip({ dist, out: path.join(root, 'x.zip') }),
    /standalonePortable/,
  );
});

test('GNU tar output is rejected even when the archiver exits successfully', { skip: process.platform !== 'win32' }, async t => {
  const gitTar = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'tar.exe');
  try { await fs.access(gitTar); } catch { t.skip('Git GNU tar is not installed'); return; }
  const { root, dist } = await staged(t);
  const out = path.join(root, 'not-a-zip.zip');
  await fs.writeFile(`${out}.sha256`, 'stale checksum');
  await assert.rejects(() => buildPortableZip({ dist, out, tarCommand: gitTar }), /did not produce ZIP/);
  assert.equal(await fs.stat(out).then(() => true, () => false), false);
  assert.equal(await fs.stat(`${out}.sha256`).then(() => true, () => false), false);
});

test('a missing executable is named too', async t => {
  const root = await sandbox(t, 'zip-exe');
  await fs.mkdir(path.join(root, 'TaskBridge'), { recursive: true });
  await assert.rejects(
    () => buildPortableZip({ dist: path.join(root, 'TaskBridge'), out: path.join(root, 'x.zip') }),
    /:desktopApp:portable/,
  );
});
