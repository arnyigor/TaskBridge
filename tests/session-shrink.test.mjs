import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { shrinkSession, shrinkSessionFile, describeShrink } from '../src/session-shrink.mjs';

// A provider refuses a request body over ~50 MB (api.deepseek.com, measured
// 2026-10-19: 50.3 MB accepted, 50.4 MB refused) — a transcript made of base64
// screenshots reaches that and the session can never start again. Repair must
// drop the OLD images from the request, keep the originals on disk, and leave
// everything else in the transcript untouched.

const line = record => JSON.stringify(record);

const toolResultWithImage = (id, bytes, shaHint = id) => line({
  type: 'message',
  id,
  parentId: `parent-${id}`,
  message: {
    role: 'toolResult',
    toolCallId: `call_${id}`,
    toolName: 'read',
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: Buffer.from(`${shaHint}`.padEnd(bytes, 'A')).toString('base64'), mimeType: 'image/png' }
    ]
  }
});

const userText = text => line({ type: 'message', id: `u-${text}`, parentId: 'root', message: { role: 'user', content: [{ type: 'text', text }] } });
const sessionHeader = line({ type: 'session', version: 1, id: 'fixture' });

test('keeps the newest N images and replaces older ones with a placeholder', () => {
  const session = [sessionHeader, userText('start'), toolResultWithImage('a', 4096), toolResultWithImage('b', 4096), toolResultWithImage('c', 8192)].join('\n');
  const result = shrinkSession(session, { keepImages: 1 });
  assert.equal(result.images, 3);
  assert.equal(result.dropped, 2);
  assert.equal(result.kept, 1);
  assert.equal(result.unparsed, 0);

  const out = result.text.split('\n').map(l => JSON.parse(l));
  assert.deepEqual(out[1].message.content, [{ type: 'text', text: 'start' }]);
  assert.equal(out[2].message.content[1].type, 'text');
  assert.match(out[2].message.content[1].text, /скриншот исключён/);
  assert.equal(out[2].message.content[0].text, 'Read image file [image/png]');
  assert.equal(out[3].message.content[1].type, 'text');
  assert.equal(out[4].message.content[1].type, 'image');
});

test('history survives: ids, parent links and record types are unchanged', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const session = [
    sessionHeader,
    line({ type: 'model_change', provider: 'deepseek', modelId: 'deepseek-flash' }),
    userText('a'),
    toolResultWithImage('a', 200_000, 'first'),
    line({ type: 'message', id: 'as1', parentId: 'parent-a', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
    toolResultWithImage('b', 200_000, 'second')
  ].join('\n');
  await fs.writeFile(file, session);
  const result = await shrinkSessionFile(file, { keepImages: 1, limitBytes: 100_000 });
  assert.equal(result.changed, true);
  const before = session.split('\n').map(l => JSON.parse(l));
  const after = (await fs.readFile(file, 'utf8')).split('\n').map(l => JSON.parse(l));
  assert.deepEqual(after.map(r => r.id), before.map(r => r.id));
  assert.deepEqual(after.map(r => r.parentId), before.map(r => r.parentId));
  assert.deepEqual(after.map(r => r.type), before.map(r => r.type));
  assert.equal(after[1].modelId, 'deepseek-flash', 'model settings are not touched');
  assert.equal(after[4].message.content[0].text, 'done');
});

test('the originals are saved once, by content, and the placeholder names them', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const artifactDir = path.join(dir, 'media');
  // The same screenshot read twice: one artifact file, two placeholders.
  const session = [sessionHeader, userText('a'), toolResultWithImage('a', 5000, 'same'), toolResultWithImage('b', 5000, 'same'), toolResultWithImage('c', 5000, 'newest')].join('\n');
  await fs.writeFile(file, session);
  const result = await shrinkSessionFile(file, { keepImages: 1, limitBytes: 1000, artifactDir, artifactLabel: 'data/media' });
  assert.equal(result.changed, true);
  assert.equal(result.dropped, 2);
  assert.equal(result.artifacts, 2);
  assert.equal(result.written, 1, 'content-addressed: the duplicate image is stored once');
  const saved = await fs.readdir(artifactDir);
  assert.equal(saved.length, 1);
  assert.match(saved[0], /^[0-9a-f]{64}\.png$/);
  const artifactPath = path.join(artifactDir, saved[0]);
  const records = (await fs.readFile(file, 'utf8')).split('\n').map(l => JSON.parse(l));
  const notices = records.flatMap(r => (Array.isArray(r?.message?.content) ? r.message.content : []))
    .filter(part => part.type === 'text' && part.text.includes('оригинал:'));
  assert.equal(notices.length, 2);
  for (const notice of notices) {
    // An absolute path (Pi's read resolves it without the session's cwd).
    assert.ok(path.isAbsolute(artifactPath));
    assert.ok(notice.text.includes(artifactPath), `placeholder names the artifact: ${notice.text}`);
  }
  // The artifact really holds the removed image.
  const stored = await fs.readFile(path.join(artifactDir, saved[0]));
  assert.equal(stored.toString('utf8'), 'same'.padEnd(5000, 'A'));
});

test('a second repair of the same session changes nothing (idempotent)', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  await fs.writeFile(file, [sessionHeader, userText('a'), toolResultWithImage('a', 100_000), toolResultWithImage('b', 100_000)].join('\n'));
  const first = await shrinkSessionFile(file, { keepImages: 0, limitBytes: 1000, artifactDir: path.join(dir, 'media') });
  assert.equal(first.changed, true);
  const repaired = await fs.readFile(file, 'utf8');
  const second = await shrinkSessionFile(file, { keepImages: 0, limitBytes: 1000, artifactDir: path.join(dir, 'media') });
  assert.equal(second.changed, false, `second run: ${second.reason}`);
  assert.equal(await fs.readFile(file, 'utf8'), repaired, 'a second run never touches a repaired file');
});

test('a corrupt line is refused: nothing is rewritten', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const broken = '{"type":"message","message":{';
  const session = [sessionHeader, broken, toolResultWithImage('a', 100_000), toolResultWithImage('b', 100_000)].join('\n');
  await fs.writeFile(file, session);
  const result = await shrinkSessionFile(file, { keepImages: 0, limitBytes: 1000 });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'invalid');
  assert.equal(result.line, 2);
  assert.equal(await fs.readFile(file, 'utf8'), session);
});

test('a text-only session over the limit is reported, not edited', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const session = [sessionHeader, userText('x'.repeat(200_000))].join('\n');
  await fs.writeFile(file, session);
  const result = await shrinkSessionFile(file, { limitBytes: 1000 });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'no-images');
  assert.equal(await fs.readFile(file, 'utf8'), session);
});

test('a session under the limit is left alone', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const session = [sessionHeader, userText('a'), toolResultWithImage('a', 4096)].join('\n');
  await fs.writeFile(file, session);
  const result = await shrinkSessionFile(file, { keepImages: 0, limitBytes: 1024 * 1024 });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'under-limit');
  assert.equal(await fs.readFile(file, 'utf8'), session);
});

test('describeShrink reads as «X → Y МБ»', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  await fs.writeFile(file, [sessionHeader, userText('a'), toolResultWithImage('a', 200_000), toolResultWithImage('b', 200_000)].join('\n'));
  const result = await shrinkSessionFile(file, { keepImages: 1, limitBytes: 1000 });
  assert.match(describeShrink(result), /^\d+\.\d → \d+\.\d МБ/);
});

// --- MEDIA-06: восстановление можно повторять -------------------------------
// Один и тот же файл проходит preflight при каждом запуске Pi (в том числе после
// перезапуска TaskBridge). Повторный проход не должен ни переписывать историю,
// ни плодить копии в архиве, ни оставлять лишние .bak.

test('повторное восстановление не плодит ни копий, ни резервных файлов', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const artifactDir = path.join(dir, 'media');
  await fs.writeFile(file, [sessionHeader, userText('a'), toolResultWithImage('a', 100_000, 'one'), toolResultWithImage('b', 100_000, 'two')].join('\n'));

  const first = await shrinkSessionFile(file, { keepImages: 0, limitBytes: 1000, artifactDir });
  assert.equal(first.changed, true, `первый прогон: ${first.reason}`);
  const repaired = await fs.readFile(file, 'utf8');
  const artifactsAfterFirst = (await fs.readdir(artifactDir)).sort();
  const backupsAfterFirst = (await fs.readdir(dir)).filter(name => name.includes('.bak-'));
  assert.equal(artifactsAfterFirst.length, 2);
  assert.equal(backupsAfterFirst.length, 1, 'один бэкап на одну правку');

  const second = await shrinkSessionFile(file, { keepImages: 0, limitBytes: 1000, artifactDir });
  assert.equal(second.changed, false, `второй прогон ничего не меняет: ${second.reason}`);
  assert.equal(await fs.readFile(file, 'utf8'), repaired, 'байты те же');
  assert.deepEqual((await fs.readdir(artifactDir)).sort(), artifactsAfterFirst, 'копий в архиве не прибавилось');
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.includes('.bak-')), backupsAfterFirst, 'лишних бэкапов нет');
});

test('после восстановления архивируются только новые изображения', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const artifactDir = path.join(dir, 'media');
  await fs.writeFile(file, [sessionHeader, userText('a'), toolResultWithImage('a', 100_000, 'one'), toolResultWithImage('b', 100_000, 'two')].join('\n'));
  const first = await shrinkSessionFile(file, { keepImages: 0, limitBytes: 1000, artifactDir });
  assert.equal(first.changed, true);
  const repaired = await fs.readFile(file, 'utf8');
  const artifactsAfterFirst = (await fs.readdir(artifactDir)).sort();

  // Разговор продолжился: в историю добавились два новых скриншота.
  const fresh = [toolResultWithImage('c', 100_000, 'three'), toolResultWithImage('d', 100_000, 'four')];
  await fs.writeFile(file, `${repaired}\n${fresh.join('\n')}`);

  const second = await shrinkSessionFile(file, { keepImages: 0, limitBytes: 1000, artifactDir });
  assert.equal(second.changed, true, `второй прогон: ${second.reason}`);
  assert.equal(second.dropped, 2, 'сняты ровно новые картинки, старые уже были ссылками');
  const text = await fs.readFile(file, 'utf8');
  assert.ok(text.startsWith(repaired), 'прежняя часть истории не переписана');
  const artifactsAfterSecond = (await fs.readdir(artifactDir)).sort();
  assert.equal(artifactsAfterSecond.length, artifactsAfterFirst.length + 2, 'в архиве только новые файлы');
  assert.deepEqual(artifactsAfterSecond.filter(name => artifactsAfterFirst.includes(name)), artifactsAfterFirst, 'старые файлы на месте');
  // Новые файлы — это именно новые байты (адресация по содержимому).
  for (const name of artifactsAfterSecond.filter(entry => !artifactsAfterFirst.includes(entry))) {
    const bytes = await fs.readFile(path.join(artifactDir, name));
    assert.equal(name, `${crypto.createHash('sha256').update(bytes).digest('hex')}.png`);
  }
});

// MEDIA-06F (детерминированно): публикация архива — это rename, и только он делает
// файл видимым под финальным именем. Дочерний процесс перехватывает именно этот
// rename, сообщает READY_TO_COMMIT и висит на барьере; родитель убивает его
// ровно в этот момент. Никаких гонок с SSD: состояние воспроизводится точно.
test('убитый перед публикацией архива процесс не портит ни архив, ни историю', { timeout: 120000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shrink-barrier-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const artifactDir = path.join(dir, 'media');
  const IMAGES = 4;
  const lines = [sessionHeader, userText('начало')];
  for (let index = 0; index < IMAGES; index += 1) lines.push(toolResultWithImage(`img${index}`, 200_000, `pic${index}`));
  const session = lines.join('\n');
  await fs.writeFile(file, session);

  // Перехват живёт в тестовом процессе: fs/promises импортируется по умолчанию,
  // значит это один и тот же объект, и подмена rename видна модулю репозитория.
  const runner = path.join(dir, 'repair.mjs');
  const moduleHref = new URL('../src/session-shrink.mjs', import.meta.url).href;
  await fs.writeFile(runner, [
    "import { createRequire } from 'node:module';",
    'const require = createRequire(import.meta.url);',
    "const fsp = require('node:fs/promises');",
    'const realRename = fsp.rename;',
    'let parked = false;',
    'fsp.rename = async (from, to) => {',
    "  if (!parked && String(to).endsWith('.png')) {",
    '    parked = true;',
    "    process.stdout.write('READY_TO_COMMIT\\n');",
    '    await new Promise(() => setInterval(() => {}, 1000));',
    '  }',
    '  return realRename(from, to);',
    '};',
    `const { shrinkSessionFile } = await import(${JSON.stringify(moduleHref)});`,
    `await shrinkSessionFile(${JSON.stringify(file)}, { keepImages: 2, limitBytes: 1024, artifactDir: ${JSON.stringify(artifactDir)} });`,
    ''
  ].join('\n'));

  const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* уже мёртв */ } });
  const ready = once(child.stdout, 'data').then(([chunk]) => String(chunk));
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('барьер не достигнут')), 60000));
  assert.match(await Promise.race([ready, timeout]), /READY_TO_COMMIT/);

  // В этот момент: первый архив лежит только как временный файл, истории не тронута.
  const pending = (await fs.readdir(artifactDir)).filter(name => name.includes('.tmp-'));
  assert.equal(pending.length, 1, 'публикация ждёт на барьере');
  const published = (await fs.readdir(artifactDir)).filter(name => name.endsWith('.png'));
  assert.deepEqual(published, [], 'под финальным именем ничего не появилось раньше времени');
  assert.equal(await fs.readFile(file, 'utf8'), session, 'история не тронута');

  child.kill('SIGKILL');
  await once(child, 'exit');
  const after = await fs.readFile(file, 'utf8');
  assert.equal(after, session, 'убитый процесс не переписал историю');
  for (const line of after.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line));

  // Оборванный временный файл остался мусором, но он не выдаётся за архив:
  // повторное восстановление проходит и публикует целые файлы.
  const second = await shrinkSessionFile(file, { keepImages: 2, limitBytes: 1024, artifactDir });
  assert.equal(second.changed, true, `повтор: ${second.reason}`);
  assert.equal(second.dropped, 2);
  const artifacts = (await fs.readdir(artifactDir)).filter(name => name.endsWith('.png'));
  assert.equal(artifacts.length, 2);
  for (const name of artifacts) {
    const bytes = await fs.readFile(path.join(artifactDir, name));
    assert.equal(bytes.length, 200_000, `${name} записан целиком`);
    assert.equal(name, `${crypto.createHash('sha256').update(bytes).digest('hex')}.png`, 'имя совпадает с содержимым');
  }
});
