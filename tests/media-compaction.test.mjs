import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { createFileStore } from '../pi-extension/taskbridge-media.js';

// MEDIA-05: компактизация не должна делать архив скриншотов бесполезным.
// Проверяется то, что видно на границе TaskBridge: запрос сжатия проходит, файл
// истории и архивные файлы остаются байт в байт, скриншот по-прежнему открывается
// по своему sha, а следующий ход не упирается в 413.
//
// Чего этот тест НЕ проверяет: что делает с маркерами сам Pi. Фейковый Pi сжатие
// не переписывает (см. tests/fake-pi.mjs), поэтому сохранность ссылок в рабочем
// контексте реального Pi остаётся интеграционной проверкой (NOT_TESTED).

const ACTIVE = ['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'VERIFYING', 'CANCELLING'];

async function settle(api, id, { tries = 200, delay = 50 } = {}) {
  let task;
  for (let i = 0; i < tries; i++) {
    task = await api(`/api/tasks/${id}`);
    if (!ACTIVE.includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(`task stayed ${task.status}`);
}

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const sessionHeader = JSON.stringify({ type: 'session', version: 1, id: 'fixture-session' });
const userLine = text => JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
const imageLine = (toolCallId, data) => JSON.stringify({
  type: 'message',
  message: { role: 'toolResult', toolCallId, toolName: 'read', content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data }] }
});
// Форма расширения: в истории только маркер, байты — в data/media.
const markerLine = (toolCallId, sha, kb) => JSON.stringify({
  type: 'message',
  message: {
    role: 'toolResult',
    toolCallId,
    toolName: 'read',
    content: [{ type: 'text', text: `[скриншот сохранён вне истории: [[taskbridge-media:${sha}]] — ${kb} КБ image/png, оригинал открывается инструментом taskbridge_media_open]` }]
  }
});

test('компактизация не ломает архив: файлы, sha, открытие и следующий ход', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'first turn' });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');

  // Убираем живой Pi: он держит историю в памяти и переписал бы наш файл.
  await api(`/api/tasks/${id}/session/restart`, {});
  const dir = path.join(fixture.root, 'data', 'pi-sessions', id);
  await fs.mkdir(dir, { recursive: true });
  const existing = (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl'));
  const file = path.join(dir, existing[0] || '2026-01-01T00-00-00-000Z_fixture.jsonl');

  // Три архивных скриншота: байты разные, имена — sha256 содержимого.
  const mediaDir = path.join(fixture.root, 'data', 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  const shots = [];
  for (const fill of ['A', 'B', 'C']) {
    const bytes = Buffer.from(fill.repeat(400_000));
    const sha = sha256(bytes);
    await fs.writeFile(path.join(mediaDir, `${sha}.png`), bytes);
    shots.push({ sha, bytes });
  }
  const transcript = [
    sessionHeader,
    userLine('начало разговора'),
    // Одна картинка ещё «в работе» — расширение её бы уже заархивировало, но
    // сессия из прошлой версии может нести base64, и это не должно мешать.
    imageLine('call-live', Buffer.from('D'.repeat(200_000)).toString('base64')),
    ...shots.map((shot, index) => markerLine(`call-${index}`, shot.sha, 400))
  ].join('\n');
  await fs.writeFile(file, `${transcript}\n`);
  const before = await fs.readFile(file, 'utf8');
  const digestBefore = await Promise.all(shots.map(async shot => sha256(await fs.readFile(path.join(mediaDir, `${shot.sha}.png`)))));

  // 05A: сжатие проходит на реальном маршруте TaskBridge.
  const compacted = await api(`/api/tasks/${id}/compact`, {});
  assert.ok(compacted.result, 'Pi ответил результатом сжатия');
  assert.equal(compacted.result.estimatedTokensAfter, 500);

  // 05F: тики smart-compaction не оставляют сессию «сжимающейся». Кадры
  // compaction_* приходят отдельно от ответа на команду, поэтому ждём счётчик.
  let task = await api(`/api/tasks/${id}`);
  for (let attempt = 0; attempt < 100 && task.compaction?.count !== 1; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
    task = await api(`/api/tasks/${id}`);
  }
  assert.equal(task.compaction?.count, 1, 'сжатие учтено в сессии');
  assert.equal(task.current || '', '', 'строка активности не залипла на «Smart compaction»');
  const runtime = await api(`/api/tasks/${id}/runtime`).catch(() => null);
  if (runtime) assert.notEqual(runtime.compacting, true, 'сессия не считается сжимающейся');

  // 05B: история и архив не изменились ни на байт.
  assert.equal(await fs.readFile(file, 'utf8'), before, 'файл истории тот же');
  for (const [index, shot] of shots.entries()) {
    const onDisk = await fs.readFile(path.join(mediaDir, `${shot.sha}.png`));
    assert.equal(sha256(onDisk), digestBefore[index], `архив ${shot.sha} не подменён`);
    assert.deepEqual(onDisk, shot.bytes, 'байты скриншота те же');
  }

  // 05C: скриншот по известному sha открывается тем же хранилищем, что у Pi.
  const store = createFileStore(mediaDir);
  for (const shot of shots) {
    const opened = await store.load(shot.sha);
    assert.ok(opened, `scриншот ${shot.sha} открывается после сжатия`);
    assert.deepEqual(Buffer.from(opened.data, 'base64'), shot.bytes);
  }

  // 05D (уровень файла): маркеры остались в истории — их видно и после сжатия.
  const after = await fs.readFile(file, 'utf8');
  for (const shot of shots) assert.ok(after.includes(`[[taskbridge-media:${shot.sha}]]`), 'ссылка в истории на месте');

  // 05E: следующий ход после сжатия проходит, без 413 и без повторного восстановления.
  await api(`/api/tasks/${id}/message`, { text: 'после сжатия' });
  const finished = await settle(api, id);
  assert.equal(finished.status, 'SUCCEEDED', finished.error || '');
  assert.notEqual(finished.errorCode, 'REQUEST_TOO_LARGE', '413 не было');
  const events = await api(`/api/tasks/${id}/events?limit=200`);
  const types = (Array.isArray(events) ? events : events.events || []).map(event => event.type);
  assert.ok(!types.includes('SESSION_TOO_LARGE'), 'сессия не объявлена слишком большой');
  assert.ok(!types.includes('SESSION_SHRUNK'), 'повторного восстановления не потребовалось');
});
