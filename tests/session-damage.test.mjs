import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preflightSession } from '../src/application/session-recovery.mjs';
import { DEFAULT_SESSION_MAX_MB } from '../src/session-shrink.mjs';

// STAB-01C, MEDIA-07/08: повреждённая история и большая текстовая сессия.
// Правило стадии — ничего не чинить вслепую: переписывать файл, который не
// разбирается целиком, опаснее, чем оставить сессию как есть и сказать об этом.
//
// Что здесь НЕ проверяется: как на такой файл реагирует настоящий Pi. Фейковый
// Pi разбирает JSONL так же, как TaskBridge (JSON.parse по строкам), и его
// реакция проверяется на серверном уровне отдельно.

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
      { type: 'image', data: fill.repeat(bytes), mimeType: 'image/png' }
    ]
  }
});

const workdir = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-damage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

// 07A/07B: файл, который не разбирается целиком, не переписывается ни на байт.
test('оборванная последняя строка: восстановление отказывает и не трогает файл', async t => {
  const dir = await workdir(t);
  const file = path.join(dir, 's.jsonl');
  const artifactDir = path.join(dir, 'media');
  const limitBytes = 1000;
  // Так выглядит сессия после аварийного завершения: последняя запись обрезана.
  const session = `${[sessionHeader, userText('a'), imageLine('img', 100_000, 'A')].join('\n')}\n{"type":"message","id":"cut","message":{"role":"assistant","cont`;
  await fs.writeFile(file, session);

  const first = await preflightSession(file, { limitBytes, keepImages: 0, artifactDir });
  assert.equal(first.status, 'invalid');
  assert.equal(first.line, 4, 'названа именно оборванная строка');
  assert.equal(await fs.readFile(file, 'utf8'), session, 'файл байт в байт прежний');
  assert.equal(await fs.readdir(artifactDir).catch(() => []).then(list => list.length), 0, 'архив не создавался');
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.includes('.bak-')), [], 'резервной копии тоже нет');

  // 07E: повторная попытка после обнаружения повреждения — тот же отказ, без мусора.
  const second = await preflightSession(file, { limitBytes, keepImages: 0, artifactDir });
  assert.equal(second.status, 'invalid');
  assert.equal(await fs.readFile(file, 'utf8'), session, 'повтор ничего не дописал');
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.includes('.bak-')), []);
});

// 07C: JSON разбирается, но структура записей не та, которую ждёт Pi. Что
// проверяется — и что нет.
//
// Заявленный гарант репозитория — fingerprint: id, parentId и типы записей до и
// после правки одинаковы, то есть восстановление не «чинит» подозрительные записи
// и ничего не выбрасывает. Именно это и проверяется ниже.
//
// Чего НЕ проверяется: соответствует ли файл полной схеме Pi и что сделает
// настоящий Pi с таким файлом. Валидатора схемы у TaskBridge нет, и делать вид
// обратного нельзя: файл, который разбирается, получает восстановление изображений
// и честное SESSION_SHRUNK — без обещаний, что структура верна.
test('валидный JSON с подозрительной структурой: правятся только изображения', async t => {
  const dir = await workdir(t);
  const file = path.join(dir, 's.jsonl');
  const artifactDir = path.join(dir, 'media');
  const limitBytes = 1000;
  const session = [
    sessionHeader,
    userText('начало'),
    // Нет .message — запись типа message без сообщения.
    line({ type: 'message', id: 'no-message' }),
    // Неизвестный тип записи.
    line({ type: 'something_else', id: 'weird', payload: { nested: true } }),
    // parentId, указывающий в никуда.
    line({ type: 'message', id: 'orphan', parentId: 'missing-parent', message: { role: 'user', content: [{ type: 'text', text: 'сирота' }] } }),
    // Изображение на месте: чинить есть что, но структура уже не та.
    imageLine('img', 100_000, 'A')
  ].join('\n');
  await fs.writeFile(file, session);
  const structure = text => text.split('\n').filter(Boolean).map(entry => {
    const record = JSON.parse(entry);
    return `${record.type}|${record.id}|${record.parentId ?? ''}`;
  });

  const result = await preflightSession(file, { limitBytes, keepImages: 0, artifactDir });
  assert.equal(result.status, 'repaired', 'файл разбирается: чинится только изображение');
  assert.equal(result.dropped, 1);
  const after = await fs.readFile(file, 'utf8');
  assert.deepEqual(structure(after), structure(session), 'ни одна запись не потеряна и не переписана по смыслу');
  const orphan = JSON.parse(after.split('\n')[4]);
  assert.equal(orphan.parentId, 'missing-parent', 'битая связь осталась как была, её не «починили» вслепую');
  assert.ok(after.includes('"type":"something_else"'), 'неизвестный тип записи сохранён');
  assert.ok(after.includes('"type":"message","id":"no-message"'), 'запись без message сохранена');
  assert.match(result.message, /Контекст сессии восстановлен/);
  assert.doesNotMatch(result.message, /структура проверена|сессия корректна/i, 'никаких обещаний о схеме');
});

// 08A/08B/08C: большая текстовая сессия — не повод молча уменьшать историю.
test('текстовая сессия больше лимита: ни записи, ни копий, ни повторов', async t => {
  const dir = await workdir(t);
  const file = path.join(dir, 's.jsonl');
  const artifactDir = path.join(dir, 'media');
  const limitBytes = DEFAULT_SESSION_MAX_MB * 1024 * 1024;
  const big = [sessionHeader, userText('x'.repeat(limitBytes + 4096))].join('\n');
  await fs.writeFile(file, big);

  const first = await preflightSession(file, { limitBytes, keepImages: 0, artifactDir });
  assert.equal(first.status, 'too-large');
  assert.match(first.message, /изображений в ней уже нет/i, 'сказано, что уменьшать нечего');
  assert.equal(await fs.readFile(file, 'utf8'), big, 'текст не тронут');
  assert.deepEqual((await fs.readdir(dir)).filter(name => name !== 's.jsonl'), [], 'ни архива, ни .bak');

  // 08C: повторный preflight (перезапуск сервера) не запускает новую обработку.
  for (const attempt of [2, 3]) {
    const again = await preflightSession(file, { limitBytes, keepImages: 0, artifactDir });
    assert.equal(again.status, 'too-large', `попытка ${attempt}`);
    assert.equal(again.changed, false);
    assert.equal(await fs.readFile(file, 'utf8'), big, `попытка ${attempt}: файл прежний`);
    assert.deepEqual((await fs.readdir(dir)).filter(name => name !== 's.jsonl'), [], `попытка ${attempt}: мусора нет`);
  }
});

// Тот же обрыв, но файл меньше лимита: раньше восстановление ничего не делало с
// таким файлом (экономия разбора), и обрыв доходил до Pi. Проверка размера не
// должна быть проверкой целостности.
test('повреждённая сессия меньше лимита: разбор всё равно происходит', async t => {
  const dir = await workdir(t);
  const file = path.join(dir, 's.jsonl');
  const artifactDir = path.join(dir, 'media');
  const session = `${[sessionHeader, userText('короткий разговор'), imageLine('img', 200, 'A')].join('\n')}\n{"type":"message","id":"cut"`;
  await fs.writeFile(file, session);
  const limitBytes = DEFAULT_SESSION_MAX_MB * 1024 * 1024;
  assert.ok(Buffer.byteLength(session) < limitBytes, 'фикстура меньше лимита');

  const result = await preflightSession(file, { limitBytes, keepImages: 0, artifactDir });
  assert.equal(result.status, 'invalid', 'PASS требует разбора, а не только размера');
  assert.equal(result.line, 4);
  assert.equal(await fs.readFile(file, 'utf8'), session, 'файл не тронут');
  assert.deepEqual(await fs.readdir(dir).then(list => list.filter(name => name !== 's.jsonl')), [], 'ни архива, ни .bak');
});
