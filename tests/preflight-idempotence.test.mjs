import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preflightSession } from '../src/application/session-recovery.mjs';

// MEDIA-06G: preflight runs before every Pi start, and after a TaskBridge restart
// it runs again on a session it has already repaired. That second pass must be a
// no-op: no rewrite, no new artifact copies, no extra .bak, and a status that does
// not look like a fresh repair.

const line = record => JSON.stringify(record);
const sessionHeader = line({ type: 'session', version: 1, id: 'fixture' });
const userText = text => line({ type: 'message', id: `u-${text}`, parentId: 'root', message: { role: 'user', content: [{ type: 'text', text }] } });
const imageLine = (id, bytes, fill) => line({
  type: 'message',
  id,
  parentId: `parent-${id}`,
  message: {
    role: 'toolResult',
    toolCallId: `call_${id}`,
    toolName: 'read',
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      // base64 alphabet only: other characters are silently dropped by the decoder
      // and two different images would become the same archive file.
      { type: 'image', data: fill.repeat(bytes), mimeType: 'image/png' }
    ]
  }
});

test('preflight после перезапуска не перерабатывает уже исправленную историю', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const artifactDir = path.join(dir, 'media');
  // Бюджет 200 КБ: четыре картинки по 100 КБ base64 его превышают, а исправленная
  // история (плейсхолдеры вместо base64) в него укладывается.
  const limitBytes = 200_000;
  const fills = ['A', 'B', 'C', 'D'];
  const session = [sessionHeader, userText('начало'), ...fills.map((fill, index) => imageLine(`img${index}`, 100_000, fill))].join('\n');
  await fs.writeFile(file, session);
  assert.ok(Buffer.byteLength(session) > limitBytes);

  const first = await preflightSession(file, { limitBytes, keepImages: 0, artifactDir });
  assert.equal(first.status, 'repaired', first.message);
  assert.equal(first.dropped, 4);
  const repaired = await fs.readFile(file, 'utf8');
  const artifacts = (await fs.readdir(artifactDir)).sort();
  const backups = (await fs.readdir(dir)).filter(name => name.includes('.bak-'));
  assert.equal(artifacts.length, 4);
  assert.equal(backups.length, 1);

  // «Перезапуск»: тот же preflight по тому же файлу и тому же каталогу архива.
  const second = await preflightSession(file, { limitBytes, keepImages: 0, artifactDir });
  assert.notEqual(second.status, 'repaired', 'повторной переработки нет');
  assert.equal(second.changed, false, `второй прогон: ${second.reason}`);
  assert.equal(second.message, '', 'нечего сообщать оператору: правки не было');
  assert.equal(await fs.readFile(file, 'utf8'), repaired, 'байты истории те же');
  assert.deepEqual((await fs.readdir(artifactDir)).sort(), artifacts, 'копий в архиве не прибавилось');
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.includes('.bak-')), backups, 'новых бэкапов нет');
  // Архив по-прежнему адресуется содержимым и открывается по id.
  for (const name of artifacts) {
    const bytes = await fs.readFile(path.join(artifactDir, name));
    assert.equal(name, `${crypto.createHash('sha256').update(bytes).digest('hex')}.png`);
    assert.equal(bytes.length, (100_000 / 4) * 3);
  }
});
