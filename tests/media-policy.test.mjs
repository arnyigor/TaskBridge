import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import installMediaPolicy, {
  applyMediaPolicy,
  applyToolResultPolicy,
  createFileStore,
  imagePayload,
  parseMarker,
  payloadImages,
  projectContext,
  redactStructured,
  referenceText,
  trimPayloadImages
} from '../pi-extension/taskbridge-media.js';

// The media policy keeps base64 screenshots out of the transcript and out of
// the request (2026-10-19: 39 images = 47.6 MB of a 48.6 MB history, 413 on
// every request). These tests pin the parts that do not need Pi: archiving a
// tool result, projecting the context, and the provider payload guard.

const sha = 'b'.repeat(64);

// Stand-in for the file store: content-addressed by the sha the test chooses.
function memoryStore(bytesOf = new Map()) {
  return {
    saved: [],
    async save(base64, mimeType) {
      const bytes = Buffer.from(base64, 'base64');
      const created = { sha: sha, bytes: bytes.length, mimeType, written: true };
      bytesOf.set(sha, bytes);
      this.saved.push(created);
      return created;
    },
    async load(id) {
      const bytes = bytesOf.get(id);
      return bytes ? { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' } : null;
    },
    async size(id) {
      return bytesOf.get(id)?.length ?? 0;
    }
  };
}

const imagePart = (text, mimeType = 'image/png') => ({ type: 'image', data: Buffer.from(text).toString('base64'), mimeType });

test('a tool result image becomes a reference, not base64', async () => {
  const store = memoryStore();
  const result = await applyToolResultPolicy([{ type: 'text', text: 'Read image' }, imagePart('shot-bytes')],
    { save: (base64, mimeType) => store.save(base64, mimeType) });
  assert.equal(result.changed, true);
  assert.equal(result.archived.length, 1);
  assert.equal(result.content[0].text, 'Read image', 'the tool text survives');
  assert.equal(result.content[1].type, 'text');
  assert.equal(parseMarker(result.content[1].text), sha);
  assert.equal(result.content.some(part => part.type === 'image'), false, 'no base64 left in the transcript');
  assert.equal(store.saved.length, 1);
});

test('a text-only tool result is returned untouched', async () => {
  const store = memoryStore();
  const content = [{ type: 'text', text: 'plain output' }];
  const result = await applyToolResultPolicy(content, { save: (base64, mimeType) => store.save(base64, mimeType) });
  assert.equal(result.changed, false);
  assert.equal(result.content, content, 'same array, nothing rewritten');
});

test('provider payloads in structuredContent are redacted, the rest survives', () => {
  const structured = { summary: 'scene', frames: [{ type: 'image', data: 'A'.repeat(400), mimeType: 'image/png' }], count: 1 };
  const redacted = redactStructured(structured);
  assert.equal(redacted.summary, 'scene');
  assert.equal(redacted.count, 1);
  assert.equal(redacted.frames[0].type, 'text');
  assert.equal(JSON.stringify(redacted).includes('AAAA'), false);
});

test('context keeps the newest image and archives the rest', async () => {
  const store = memoryStore();
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'start' }] },
    { role: 'toolResult', content: [{ type: 'image', data: Buffer.from('old').toString('base64'), mimeType: 'image/png' }] },
    { role: 'toolResult', content: [{ type: 'image', data: Buffer.from('new').toString('base64'), mimeType: 'image/png' }] }
  ];
  const result = await projectContext(messages, { store, keepImages: 1, imageBudgetBytes: 1024 * 1024 });
  assert.equal(result.archived, 2);
  assert.equal(result.hydrated, 1, 'only the newest image is sent');
  const last = result.messages[2].content;
  assert.deepEqual(last.map(part => part.type), ['text', 'image'], 'reference + restored image');
  assert.equal(parseMarker(last[0].text), sha);
  assert.equal(Buffer.from(last[1].data, 'base64').toString(), 'new');
  // The original array is not mutated: Pi keeps its own history.
  assert.equal(messages[2].content.length, 1);
  assert.equal(messages[2].content[0].type, 'image');
});

test('an existing reference is hydrated again on the next turn', async () => {
  const bytesOf = new Map([[sha, Buffer.from('archived-image')]]);
  const store = memoryStore(bytesOf);
  const messages = [{ role: 'toolResult', content: [{ type: 'text', text: referenceText(sha, 14, 'image/png') }] }];
  const result = await projectContext(messages, { store, keepImages: 2, imageBudgetBytes: 1024 * 1024 });
  assert.equal(result.archived, 0, 'nothing to archive: it is already a reference');
  assert.equal(result.hydrated, 1);
  assert.deepEqual(result.messages[0].content.map(part => part.type), ['text', 'image']);
  assert.equal(Buffer.from(result.messages[0].content[1].data, 'base64').toString(), 'archived-image');
});

test('a missing artifact leaves the reference inspectable rather than failing', async () => {
  const store = memoryStore();
  const messages = [{ role: 'toolResult', content: [{ type: 'text', text: referenceText('c'.repeat(64), 14, 'image/png') }] }];
  const result = await projectContext(messages, { store, keepImages: 2, imageBudgetBytes: 1024 * 1024 });
  assert.equal(result.hydrated, 0);
  assert.deepEqual(result.messages[0].content.map(part => part.type), ['text']);
});

test('without a store the inline images are trimmed as before', () => {
  const messages = [{ role: 'toolResult', content: [imagePart('a'), imagePart('b'), imagePart('c')] }];
  const result = applyMediaPolicy(messages, { keepImages: 1, imageBudgetBytes: 1024 * 1024 });
  assert.equal(result.dropped, 2);
  assert.equal(result.kept, 1);
  assert.equal(result.messages[0].content.filter(part => part.type === 'image').length, 1);
});

test('the provider payload guard drops images only when the body is over budget', () => {
  const payload = { messages: [{ content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(4000)}` } }] }] };
  const under = trimPayloadImages(structuredClone(payload), 1024 * 1024);
  assert.equal(under.dropped, 0, 'a small body is left alone');
  const over = trimPayloadImages(structuredClone(payload), 1000);
  assert.equal(over.dropped, 1);
  assert.ok(over.sizeAfter < over.size);
  assert.equal(over.payload.messages[0].content[0].type, 'text');
});

test('image payloads are recognised in the shapes providers use', () => {
  assert.equal(imagePayload({ type: 'image', data: 'AAA', mimeType: 'image/png' }).mimeType, 'image/png');
  assert.equal(imagePayload({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } }).base64, 'BBB');
  assert.equal(imagePayload({ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'CCC' } }).mimeType, 'image/webp');
  assert.equal(imagePayload({ type: 'text', text: 'no image here' }), null);
});

test('the file store is content-addressed: the same bytes are written once', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-media-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createFileStore(path.join(dir, 'media'));
  const base64 = Buffer.from('same picture').toString('base64');
  const first = await store.save(base64, 'image/png');
  const second = await store.save(base64, 'image/png');
  assert.equal(first.sha, second.sha);
  assert.equal(first.written, true);
  assert.equal(second.written, false, 'second write is a no-op');
  assert.equal((await fs.readdir(path.join(dir, 'media'))).length, 1);
  assert.equal((await store.load(first.sha)).data, base64);
  assert.equal(await store.size(first.sha), Buffer.byteLength('same picture'));
  assert.equal(await store.load('d'.repeat(64)), null);
});

// Pi пускает расширение в себя двумя дверями: `on` (события) и `registerTool`
// (инструменты). Этого достаточно, чтобы проверить инструмент без Pi-процесса.
function fakePi() {
  const hooks = new Map();
  const tools = new Map();
  return {
    hooks,
    tools,
    on(name, handler) { hooks.set(name, [...(hooks.get(name) || []), handler]); },
    registerTool(definition) { tools.set(definition.name, definition); }
  };
}

// MEDIA-02/03/04: картинка уходит в архив, а модель может попросить её снова —
// и в том же процессе, и после перезапуска (расширение и сервер перезапускаются,
// а хранилище и ссылка в истории остаются те же).
test('taskbridge_media_open возвращает архивный скриншот, в том числе после перезапуска', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-media-tool-'));
  const previous = process.env.TASKBRIDGE_MEDIA_ROOT;
  process.env.TASKBRIDGE_MEDIA_ROOT = path.join(dir, 'media');
  process.env.TASKBRIDGE_MEDIA_NOTIFY = '0';
  t.after(async () => {
    if (previous === undefined) delete process.env.TASKBRIDGE_MEDIA_ROOT;
    else process.env.TASKBRIDGE_MEDIA_ROOT = previous;
    delete process.env.TASKBRIDGE_MEDIA_NOTIFY;
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Разные байты — на случай, если в игру вступит адресация по содержимому.
  const png = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));
  const base64 = png.toString('base64');

  const host = fakePi();
  installMediaPolicy(host);
  const [archive] = host.hooks.get('tool_result');
  const archived = await archive({
    content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data: base64, mimeType: 'image/png' }]
  });
  const text = archived.content.map(part => part.text || '').join(' ');
  const id = parseMarker(text);
  assert.ok(id, 'в истории осталась ссылка с sha256');
  assert.ok(!text.includes(base64.slice(0, 64)), 'сами байты в истории не остаются');
  assert.equal(archived.content.filter(part => part.type === 'image').length, 0);

  // MEDIA-03: модель просит скриншот по id и получает изображение, а не текст.
  const tool = host.tools.get('taskbridge_media_open');
  assert.ok(tool, 'инструмент зарегистрирован');
  const opened = await tool.execute('call-1', { id });
  assert.equal(opened.content.length, 1);
  assert.equal(opened.content[0].type, 'image');
  assert.deepEqual(Buffer.from(opened.content[0].data, 'base64'), png, 'вернулись исходные байты');

  // MEDIA-04: перезапуск (новый экземпляр расширения над тем же каталогом) не
  // ломает ссылку — id, а не путь процесса, держит её живой.
  const restarted = fakePi();
  installMediaPolicy(restarted);
  const again = await restarted.tools.get('taskbridge_media_open').execute('call-2', { id });
  assert.deepEqual(Buffer.from(again.content[0].data, 'base64'), png, 'после перезапуска скриншот открывается');

  // MEDIA-02, обратная сторона: чужой id — честная ошибка, а не пустая картинка.
  const missing = await restarted.tools.get('taskbridge_media_open').execute('call-3', { id: 'a'.repeat(64) });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /не найден/);
});

// Полная цепочка после открытия архива: инструмент вернул картинку → её снова
// заархивировал tool_result → context вернул её модели. Без последнего шага
// модель увидела бы только текстовую ссылку и картинку бы не получила.
test('открытая через media_open картинка доходит до модели в том же запросе', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-media-chain-'));
  const previous = process.env.TASKBRIDGE_MEDIA_ROOT;
  process.env.TASKBRIDGE_MEDIA_ROOT = path.join(dir, 'media');
  process.env.TASKBRIDGE_MEDIA_NOTIFY = '0';
  t.after(async () => {
    if (previous === undefined) delete process.env.TASKBRIDGE_MEDIA_ROOT;
    else process.env.TASKBRIDGE_MEDIA_ROOT = previous;
    delete process.env.TASKBRIDGE_MEDIA_NOTIFY;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const png = Buffer.from(Array.from({ length: 2048 }, (_, index) => (index * 7) % 251));
  const host = fakePi();
  installMediaPolicy(host);
  const store = createFileStore(process.env.TASKBRIDGE_MEDIA_ROOT);
  const { sha } = await store.save(png.toString('base64'), 'image/png');

  // 1. Модель просит архивный скриншот по известному id.
  const opened = await host.tools.get('taskbridge_media_open').execute('call-open', { id: sha });
  assert.equal(opened.content[0].type, 'image');

  // 2. tool_result снова забирает байты в архив (иначе они вернутся в историю).
  const [archive] = host.hooks.get('tool_result');
  const archived = await archive({ content: opened.content });
  assert.equal(archived.content.filter(part => part.type === 'image').length, 0, 'в истории снова только ссылка');
  assert.equal(parseMarker(archived.content[0].text), sha, 'тот же самый скриншот');

  // 3. context собирает запрос к модели: рядом со ссылкой должно быть изображение.
  const [context] = host.hooks.get('context');
  const projected = await context({ messages: [{ role: 'toolResult', content: archived.content }] });
  const parts = projected.messages[0].content;
  assert.deepEqual(parts.map(part => part.type), ['text', 'image'], 'модель видит ссылку и саму картинку');
  assert.equal(parseMarker(parts[0].text), sha, 'ссылка остаётся: следующий ход снова найдёт по id');
  assert.deepEqual(Buffer.from(parts[1].data, 'base64'), png, 'байты те же, что просили');

  // 4. И в сериализованном payload картинка действительно есть.
  const payload = { messages: [
    { role: 'user', content: [{ type: 'text', text: 'посмотри на скриншот' }] },
    ...projected.messages.map(message => ({ role: message.role, content: message.content }))
  ] };
  const trimmed = trimPayloadImages(structuredClone(payload), 40 * 1024 * 1024);
  assert.equal(trimmed.dropped, 0, 'payload в бюджете');
  assert.equal(payloadImages(payload).length, 1, 'картинка уходит провайдеру');
});

// Бюджет 2 МБ — не запрет: pickNewest всегда оставляет хотя бы одну картинку,
// иначе модель не увидела бы ровно тот скриншот, который попросила.
test('открытая картинка больше бюджета 2 МБ всё равно доходит до модели', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-media-big-'));
  const previous = process.env.TASKBRIDGE_MEDIA_ROOT;
  process.env.TASKBRIDGE_MEDIA_ROOT = path.join(dir, 'media');
  process.env.TASKBRIDGE_MEDIA_NOTIFY = '0';
  t.after(async () => {
    if (previous === undefined) delete process.env.TASKBRIDGE_MEDIA_ROOT;
    else process.env.TASKBRIDGE_MEDIA_ROOT = previous;
    delete process.env.TASKBRIDGE_MEDIA_NOTIFY;
    await fs.rm(dir, { recursive: true, force: true });
  });

  // 3 МБ сырых байт — это ~4 МБ base64, вдвое больше стандартного бюджета.
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const host = fakePi();
  installMediaPolicy(host);
  const store = createFileStore(process.env.TASKBRIDGE_MEDIA_ROOT);
  const { sha, bytes } = await store.save(big.toString('base64'), 'image/png');
  assert.equal(bytes, big.length);

  const opened = await host.tools.get('taskbridge_media_open').execute('call-open', { id: sha });
  const [archive] = host.hooks.get('tool_result');
  const archived = await archive({ content: opened.content });
  const [context] = host.hooks.get('context');
  const projected = await context({ messages: [{ role: 'toolResult', content: archived.content }] });
  const image = projected.messages[0].content.find(part => part.type === 'image');
  assert.ok(image, 'единственная картинка не выкидывается из-за бюджета');
  assert.equal(Buffer.from(image.data, 'base64').length, big.length, 'байты не урезаны и не испорчены');
  // Ссылка на месте: если payload всё же не пролезет по общему бюджету, модель
  // знает, как попросить картинку снова.
  assert.equal(parseMarker(projected.messages[0].content[0].text), sha);
});

// MEDIA-06H: имя файла — sha256 его содержимого, поэтому полузаписанный файл с
// правильным именем выглядит как настоящий. Ни читать его модели, ни принимать
// за готовый нельзя; когда байты под рукой (мы их и сохраняем) — перезаписать.
test('оборванный архив не отдаётся модели, а называется повреждённым', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-media-corrupt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createFileStore(dir);
  const png = Buffer.from(Array.from({ length: 8192 }, (_, index) => (index * 3) % 251));
  const id = crypto.createHash('sha256').update(png).digest('hex');
  await fs.writeFile(path.join(dir, `${id}.png`), png.subarray(0, 512));

  assert.equal(await store.load(id), null, 'обрезанные байты не выдаются как картинка');
  assert.equal(await store.verify(id), 'corrupt');
  const host = fakePi();
  process.env.TASKBRIDGE_MEDIA_ROOT = dir;
  process.env.TASKBRIDGE_MEDIA_NOTIFY = '0';
  t.after(() => { delete process.env.TASKBRIDGE_MEDIA_ROOT; delete process.env.TASKBRIDGE_MEDIA_NOTIFY; });
  installMediaPolicy(host);
  const opened = await host.tools.get('taskbridge_media_open').execute('call-corrupt', { id });
  assert.equal(opened.isError, true);
  assert.match(opened.content[0].text, /повреждён/, 'сказано, что файл повреждён, а не «не найден»');
});

test('повреждённый архив перезаписывается теми же байтами и снова открывается', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-media-repair-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createFileStore(dir);
  const png = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 7) % 251));
  const id = crypto.createHash('sha256').update(png).digest('hex');
  await fs.writeFile(path.join(dir, `${id}.png`), Buffer.from('torn'));

  const saved = await store.save(png.toString('base64'), 'image/png');
  assert.equal(saved.sha, id);
  assert.equal(saved.written, true);
  assert.equal(saved.repaired, true);
  assert.deepEqual(await fs.readdir(dir), [`${id}.png`], 'временных файлов не осталось и копий нет');
  const opened = await store.load(id);
  assert.deepEqual(Buffer.from(opened.data, 'base64'), png);
  assert.equal(await store.verify(id), 'ok');
});

test('две сессии сохраняют одну картинку одновременно — файл один и целый', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-media-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createFileStore(dir);
  const png = Buffer.from(Array.from({ length: 32 * 1024 }, (_, index) => index % 251));
  const [first, second] = await Promise.all([
    store.save(png.toString('base64'), 'image/png'),
    store.save(png.toString('base64'), 'image/png'),
  ]);
  assert.equal(first.sha, second.sha);
  assert.deepEqual(await fs.readdir(dir), [`${first.sha}.png`]);
  const opened = await store.load(first.sha);
  assert.deepEqual(Buffer.from(opened.data, 'base64'), png);
});
