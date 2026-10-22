import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { shrinkSession, shrinkSessionFile, saveArtifact, describeShrink } from '../src/session-shrink.mjs';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'shrink-sixh-'));
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

test('повреждённый архив с правильным именем перезаписывается из исходных байт', async t => {
  const dir = await tmp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 13) % 251));
  const part = { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' };
  const file = path.join(dir, `${sha(bytes)}.png`);
  // Так выглядит файл, оборванный посреди записи: имя верное, байты — половина.
  await fs.writeFile(file, bytes.subarray(0, 100));

  const saved = await saveArtifact(dir, part, bytes.length);
  assert.equal(saved.written, true);
  assert.equal(saved.repaired, true, 'повреждение распознано, а не принято за готовый архив');
  assert.equal(sha(await fs.readFile(file)), saved.sha256, 'содержимое снова совпадает с именем');
  assert.deepEqual(await fs.readdir(dir), [`${saved.sha256}.png`], 'временных файлов не осталось');
});

test('целый архив не перезаписывается', async t => {
  const dir = await tmp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('same picture again');
  const part = { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' };
  const first = await saveArtifact(dir, part, bytes.length);
  assert.equal(first.written, true);
  const second = await saveArtifact(dir, part, bytes.length);
  assert.equal(second.written, false);
  assert.equal(second.repaired, undefined, 'целый файл не считается повреждённым');
});

test('две одновременные записи одной картинки дают один целый файл', async t => {
  const dir = await tmp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from(Array.from({ length: 65536 }, (_, index) => index % 251));
  const part = { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' };
  const results = await Promise.all([saveArtifact(dir, part, bytes.length), saveArtifact(dir, part, bytes.length)]);
  assert.equal(results[0].sha256, results[1].sha256);
  const names = await fs.readdir(dir);
  assert.deepEqual(names, [`${results[0].sha256}.png`], 'ровно один файл, без временных');
  assert.equal(sha(await fs.readFile(path.join(dir, names[0]))), results[0].sha256);
});
