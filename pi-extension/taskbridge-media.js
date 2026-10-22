// TaskBridge media policy for Pi (loaded with `pi --extension <this file>`).
//
// Why this exists (2026-10-19): a Blender session carried 39 full-resolution
// screenshots — 47.6 MB of 48.6 MB of history, 0.2 MB of text — because every
// image Pi ever read stays in the transcript and is re-sent on every request.
// The provider edge refuses a request body over ~50 MB ("413 Failed to buffer
// the request body: length limit exceeded"), so the session could not start at
// all, and Pi retried that permanent error every 5 s.
//
// Three independent guards, because three different things go wrong:
//   * `tool_result`            — a screenshot is archived to the local media
//                                store the moment it is produced, and the
//                                transcript keeps a short reference instead of
//                                the base64. The history stops growing.
//   * `context`                — every model call gets only the newest few
//                                images, restored from the store (old inline
//                                base64 from earlier versions is archived here
//                                too, so both shapes converge).
//   * `before_provider_request`— the serialized payload itself: if it is still
//                                over the provider's request budget, images are
//                                dropped oldest-first until it fits.
// Plus the `taskbridge_media_open` tool, so the model can look at any archived
// screenshot again without it being in every request.
//
// This file is intentionally dependency-free: it runs inside the Pi process.
//
// Environment (set by TaskBridge when it spawns Pi):
//   TASKBRIDGE_MEDIA_ROOT               absolute media store (default: disabled)
//   TASKBRIDGE_MEDIA_KEEP_IMAGES        images kept in a request (default 2)
//   TASKBRIDGE_MEDIA_IMAGE_BUDGET_MB    base64 budget for those images (default 2)
//   TASKBRIDGE_MEDIA_REQUEST_BUDGET_MB  whole payload budget (default 40)
//   TASKBRIDGE_MEDIA_NOTIFY             "0" silences the per-turn notice

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MB = 1024 * 1024;
const MARKER = /\[\[taskbridge-media:([0-9a-f]{64})\]\]/;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export const DEFAULT_POLICY = Object.freeze({
  keepImages: 2,
  imageBudgetBytes: 2 * MB,
  requestBudgetBytes: 40 * MB
});

const positive = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

// --- image payloads ---------------------------------------------------------

// Base64 + mime type of an image block, whatever shape the provider or tool used.
export function imagePayload(part) {
  if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url.url);
    if (match) return { base64: match[2], mimeType: match[1] };
    return null;
  }
  if (typeof part?.data === 'string') return { base64: part.data, mimeType: part?.mimeType || part?.media_type || 'image/png' };
  if (typeof part?.source?.data === 'string') return { base64: part.source.data, mimeType: part.source?.media_type || 'image/png' };
  return null;
}

export const markerText = sha => `[[taskbridge-media:${sha}]]`;

// Budgets are about the bytes on the wire; base64 is 4/3 of the image bytes.
const rawBytes = base64 => Math.floor((base64.length * 3) / 4);

export function referenceText(sha, bytes, mimeType) {
  return `[скриншот сохранён вне истории: ${markerText(sha)} — ${Math.round(bytes / 1024)} КБ ${mimeType}, `
    + 'оригинал открывается инструментом taskbridge_media_open]';
}

export function parseMarker(text) {
  if (typeof text !== 'string') return null;
  const match = MARKER.exec(text);
  return match ? match[1] : null;
}

// --- media store ------------------------------------------------------------

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

// Rename is the only moment an artifact becomes visible under its final name, but
// on Windows a target held open by another process makes it fail with EPERM /
// EBUSY for a moment — retry instead of failing an archive write.
async function renameWithRetry(from, to, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fsp.rename(from, to);
    } catch (error) {
      const transient = ['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(error.code);
      if (!transient || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 10));
    }
  }
}

let tempCounter = 0;

// 'ok' — the file exists and really hashes to the name it carries; 'missing' —
// nothing there; 'corrupt' — something is there, but it is not those bytes.
async function artifactState(target, sha) {
  const existing = await fsp.readFile(target).catch(() => null);
  if (!existing) return 'missing';
  return sha256(existing) === sha ? 'ok' : 'corrupt';
}

// Content-addressed: the same screenshot read twice is written once. The file
// name is the sha256 of the image bytes, so a reference in the transcript stays
// valid even if the same picture arrives through another session.
//
// The name is trusted only after hashing the content: a half-written file with
// the right name would otherwise be handed to the model as if it were the real
// screenshot. New bytes go to a temp file in the same directory and are renamed
// into place, so a killed process leaves either a complete artifact or none.
export function createFileStore(root) {
  if (!root || !path.isAbsolute(root)) throw new Error('TASKBRIDGE_MEDIA_ROOT must be an absolute path');
  const file = (sha, mimeType) => path.join(root, `${sha}.${EXTENSIONS[mimeType] || 'bin'}`);
  return {
    root,
    async save(base64, mimeType) {
      const buffer = Buffer.from(base64, 'base64');
      const sha = sha256(buffer);
      const target = file(sha, mimeType);
      const state = await artifactState(target, sha);
      if (state === 'ok') {
        return { sha, bytes: buffer.length, mimeType, file: target, written: false };
      }
      // Missing, or a corrupt leftover: the source bytes are in hand right here.
      await fsp.mkdir(root, { recursive: true });
      tempCounter += 1;
      const temp = path.join(root, `.${sha}.${EXTENSIONS[mimeType] || 'bin'}.tmp-${process.pid}-${tempCounter}`);
      try {
        await fsp.writeFile(temp, buffer);
        await renameWithRetry(temp, target);
      } catch (error) {
        await fsp.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      return { sha, bytes: buffer.length, mimeType, file: target, written: true, repaired: state === 'corrupt' };
    },
    async load(sha) {
      for (const [mimeType, extension] of Object.entries(EXTENSIONS)) {
        const target = path.join(root, `${sha}.${extension}`);
        const buffer = await fsp.readFile(target).catch(() => null);
        if (!buffer) continue;
        // A file whose content does not hash to its own name is not this picture.
        if (sha256(buffer) !== sha) continue;
        return { type: 'image', data: buffer.toString('base64'), mimeType };
      }
      return null;
    },
    // Why load() returned nothing: 'corrupt' is worth distinguishing in the tool
    // message — the operator can still re-read the image, but silence would look
    // like the archive was never made.
    async verify(sha) {
      for (const extension of Object.values(EXTENSIONS)) {
        const state = await artifactState(path.join(root, `${sha}.${extension}`), sha);
        if (state !== 'missing') return state;
      }
      return 'missing';
    },
    async size(sha) {
      for (const extension of Object.values(EXTENSIONS)) {
        const target = path.join(root, `${sha}.${extension}`);
        const stat = await fsp.stat(target).catch(() => null);
        if (stat) return stat.size;
      }
      return 0;
    }
  };
}

// --- last-N selection (shared by both guards) -------------------------------

// Newest first: the newest screenshot is what the current step is about. The
// budget stops the walk but never empties the request — an image that alone
// exceeds the budget is still sent when it is the newest one.
export function pickNewest(entries, keepImages, budgetBytes) {
  const keep = new Set();
  let bytes = 0;
  for (let i = entries.length - 1; i >= 0 && keep.size < keepImages; i--) {
    if (bytes + entries[i].bytes > budgetBytes && keep.size > 0) break;
    keep.add(i);
    bytes += entries[i].bytes;
  }
  return { keep, bytes };
}

// --- tool_result: keep base64 out of the transcript -------------------------

// Pure planning: which image parts to archive. The caller saves them and calls
// applyToolResultPolicy with the resulting references.
export async function applyToolResultPolicy(content, { save }) {
  if (!Array.isArray(content) || !save) return { content, changed: false, archived: [] };
  const next = [];
  const archived = [];
  for (const part of content) {
    const payload = imagePayload(part);
    if (!payload) {
      next.push(part);
      continue;
    }
    const stored = await save(payload.base64, payload.mimeType);
    archived.push(stored);
    next.push({ type: 'text', text: referenceText(stored.sha, stored.bytes, stored.mimeType) });
  }
  return archived.length
    ? { content: next, changed: true, archived }
    : { content, changed: false, archived };
}

// `structuredContent` may carry the same image (MCP results do). Redact only
// image-shaped nodes: a tool's own text/schema must survive untouched.
export function redactStructured(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return node;
  if (Array.isArray(node)) return node.map(item => redactStructured(item, depth + 1));
  const payload = imagePayload(node);
  if (payload) {
    return { type: 'text', text: `[скриншот сохранён вне истории: ${Math.round(payload.base64.length / 1024)} КБ ${payload.mimeType}]` };
  }
  const copy = {};
  for (const [key, value] of Object.entries(node)) copy[key] = redactStructured(value, depth + 1);
  return copy;
}

// --- context: only the newest images reach the model -----------------------

// Pure fallback with no store: drop old inline images, keep the newest N.
export function applyMediaPolicy(messages, policy = DEFAULT_POLICY) {
  if (!Array.isArray(messages)) return { messages, dropped: 0, kept: 0 };
  const keepImages = Math.max(0, Math.trunc(policy.keepImages ?? DEFAULT_POLICY.keepImages));
  const budget = Math.max(0, policy.imageBudgetBytes ?? DEFAULT_POLICY.imageBudgetBytes);

  const found = [];
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message?.content)) return;
    message.content.forEach((part, partIndex) => {
      if (part?.type !== 'image') return;
      const payload = imagePayload(part);
      if (payload) found.push({ messageIndex, partIndex, bytes: rawBytes(payload.base64), part });
    });
  });
  if (!found.length) return { messages, dropped: 0, kept: 0 };

  const { keep } = pickNewest(found, keepImages, budget);
  const drop = found.filter((_, index) => !keep.has(index));
  if (!drop.length) return { messages, dropped: 0, kept: found.length };

  const next = messages.slice();
  const changed = new Map();
  for (const { messageIndex, partIndex, bytes, part } of drop) {
    let content = changed.get(messageIndex);
    if (!content) {
      content = messages[messageIndex].content.slice();
      changed.set(messageIndex, content);
      next[messageIndex] = { ...messages[messageIndex], content };
    }
    const payload = imagePayload(part);
    content[partIndex] = {
      type: 'text',
      text: `[скриншот не отправлен в этот запрос: ${Math.round(bytes / 1024)} КБ base64, ${payload?.mimeType || 'image'}; оригинал остаётся в истории сессии]`
    };
  }
  return { messages: next, dropped: drop.length, kept: keep.size };
}

// With a store: archive every inline image, replace it with a reference, then
// re-attach the newest N references as real images. Works the same for old
// sessions (inline base64) and new ones (references written by tool_result).
export async function projectContext(messages, { store, keepImages = DEFAULT_POLICY.keepImages, imageBudgetBytes = DEFAULT_POLICY.imageBudgetBytes } = {}) {
  if (!store) return applyMediaPolicy(messages, { keepImages, imageBudgetBytes });
  if (!Array.isArray(messages)) return { messages, archived: 0, hydrated: 0 };

  const next = messages.map(message => (
    Array.isArray(message?.content) ? { ...message, content: message.content.slice() } : message
  ));
  const refs = [];
  let archived = 0;
  for (let mi = 0; mi < next.length; mi++) {
    const content = next[mi]?.content;
    if (!Array.isArray(content)) continue;
    for (let pi = 0; pi < content.length; pi++) {
      const part = content[pi];
      const payload = imagePayload(part);
      if (payload) {
        const stored = await store.save(payload.base64, payload.mimeType);
        content[pi] = { type: 'text', text: referenceText(stored.sha, stored.bytes, stored.mimeType) };
        refs.push({ mi, pi, sha: stored.sha, bytes: stored.bytes });
        archived++;
        continue;
      }
      const sha = part?.type === 'text' ? parseMarker(part.text) : null;
      if (sha) refs.push({ mi, pi, sha, bytes: await store.size(sha) });
    }
  }
  if (!refs.length) return { messages: next, archived, hydrated: 0 };

  // The same picture read twice is one image on the wire: keep the newest
  // occurrence of each sha, then the newest N of those.
  const unique = [];
  const seen = new Set();
  for (let index = refs.length - 1; index >= 0; index--) {
    if (seen.has(refs[index].sha)) continue;
    seen.add(refs[index].sha);
    unique.push(index);
  }
  const ordered = unique.reverse().map(index => refs[index]);
  const { keep: chosen } = pickNewest(ordered, keepImages, imageBudgetBytes);
  const keep = new Set();
  for (let i = 0; i < ordered.length; i++) if (chosen.has(i)) keep.add(refs.indexOf(ordered[i]));
  const hydrated = new Map();
  for (let index = 0; index < refs.length; index++) {
    if (!keep.has(index)) continue;
    const ref = refs[index];
    const image = await store.load(ref.sha).catch(() => null);
    if (!image) continue;
    if (!hydrated.has(ref.mi)) hydrated.set(ref.mi, new Map());
    hydrated.get(ref.mi).set(ref.pi, image);
  }
  if (!hydrated.size) return { messages: next, archived, hydrated: 0 };

  // The image goes right after its reference: the reference stays, so the next
  // turn can restore it again and the model keeps the id to ask for it later.
  const out = next.map((message, mi) => {
    const marks = hydrated.get(mi);
    if (!marks || !Array.isArray(message?.content)) return message;
    const content = [];
    message.content.forEach((part, pi) => {
      content.push(part);
      if (marks.has(pi)) content.push(marks.get(pi));
    });
    return { ...message, content };
  });
  return { messages: out, archived, hydrated: [...hydrated.values()].reduce((sum, marks) => sum + marks.size, 0) };
}

// --- before_provider_request: the serialized payload -----------------------

const isImagePart = part => part?.type === 'image' || part?.type === 'image_url' || part?.type === 'input_image';

export function payloadImages(payload) {
  const images = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      node.forEach(item => walk(item, depth + 1));
      return;
    }
    if (isImagePart(node)) {
      const payload = imagePayload(node);
      images.push({ part: node, bytes: payload ? rawBytes(payload.base64) : 0 });
      return;
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(payload, 0);
  return images;
}

export function trimPayloadImages(payload, budgetBytes) {
  const images = payloadImages(payload);
  if (!images.length) return { payload, dropped: 0, size: 0, sizeAfter: 0 };
  const size = Buffer.byteLength(JSON.stringify(payload));
  if (size <= budgetBytes) return { payload, dropped: 0, size, sizeAfter: size };
  let remaining = size;
  let dropped = 0;
  for (const image of images) {
    if (remaining <= budgetBytes) break;
    const part = image.part;
    for (const key of ['data', 'image_url', 'source']) delete part[key];
    part.type = 'text';
    part.text = `[скриншот не отправлен в этот запрос: ${Math.round(image.bytes / 1024)} КБ base64; оригинал в TaskBridge]`;
    remaining -= image.bytes;
    dropped += 1;
  }
  return { payload, dropped, size, sizeAfter: Buffer.byteLength(JSON.stringify(payload)) };
}

// --- extension entry point --------------------------------------------------

export default function (pi) {
  const env = process.env;
  const policy = {
    keepImages: positive(env.TASKBRIDGE_MEDIA_KEEP_IMAGES, DEFAULT_POLICY.keepImages),
    imageBudgetBytes: Math.round(positive(env.TASKBRIDGE_MEDIA_IMAGE_BUDGET_MB, DEFAULT_POLICY.imageBudgetBytes / MB) * MB),
    requestBudgetBytes: Math.round(positive(env.TASKBRIDGE_MEDIA_REQUEST_BUDGET_MB, DEFAULT_POLICY.requestBudgetBytes / MB) * MB)
  };
  let store = null;
  if (env.TASKBRIDGE_MEDIA_ROOT) {
    try {
      store = createFileStore(env.TASKBRIDGE_MEDIA_ROOT);
      fs.mkdirSync(env.TASKBRIDGE_MEDIA_ROOT, { recursive: true });
    } catch (error) {
      // A broken store must not take the session down: fall back to the
      // in-request trimming below, which needs no disk.
      console.error(`[TaskBridge media] store disabled: ${error.message}`);
      store = null;
    }
  }
  const notifyEnabled = String(env.TASKBRIDGE_MEDIA_NOTIFY ?? '1') !== '0';
  // One notice per turn: a turn is many model calls, and the same eleven images
  // are skipped in each of them.
  let announced = false;
  pi.on('turn_start', () => { announced = false; });

  const announce = (ctx, text) => {
    if (!notifyEnabled || announced) return;
    announced = true;
    try { ctx?.ui?.notify?.(text, 'info'); } catch { /* a notice must never break a turn */ }
  };

  // The screenshot leaves the transcript as base64 and keeps a reference.
  if (store) {
    pi.on('tool_result', async (event) => {
      // The same rule for every tool, including taskbridge_media_open: the
      // transcript keeps a reference, and the `context` hook hands the picture
      // back to the model on the very next call. Skipping the archive there
      // would put the base64 of every reopened screenshot back into the file.
      const result = await applyToolResultPolicy(event?.content, { save: (base64, mimeType) => store.save(base64, mimeType) });
      if (!result.changed) return undefined;
      return {
        content: result.content,
        ...(event.structuredContent !== undefined ? { structuredContent: redactStructured(event.structuredContent) } : {})
      };
    });
  }

  pi.on('context', async (event, ctx) => {
    const result = store
      ? await projectContext(event.messages, { store, ...policy })
      : applyMediaPolicy(event.messages, policy);
    const skipped = result.dropped ?? 0;
    if (!skipped && !result.hydrated) return undefined;
    if (skipped) {
      announce(ctx, `TaskBridge: в запрос ушли ${result.kept} из ${result.kept + skipped} изображений. `
        + 'Старые скриншоты остались в истории сессии и не отправляются повторно.');
    }
    return { messages: result.messages };
  });

  pi.on('before_provider_request', (event) => {
    const result = trimPayloadImages(event.payload, policy.requestBudgetBytes);
    return result.dropped ? result.payload : undefined;
  });

  // Any archived screenshot on demand: the reference in the transcript is enough
  // to ask for the picture again, without it being in every request.
  pi.registerTool({
    name: 'taskbridge_media_open',
    label: 'Открыть архивный скриншот',
    description: 'Reopen a screenshot that TaskBridge archived out of the conversation. '
      + 'Pass the sha256 id from a reference like [[taskbridge-media:<sha>]]. Returns the image itself.',
    promptSnippet: 'taskbridge_media_open: reopen an archived screenshot by its [[taskbridge-media:sha]] id',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'sha256 id from the reference' } },
      required: ['id'],
      additionalProperties: false
    },
    async execute(_toolCallId, params) {
      if (!store) return { content: [{ type: 'text', text: 'TaskBridge media store is disabled for this session.' }], isError: true };
      const id = String(params?.id || '');
      const image = await store.load(id);
      if (!image) {
        // «Повреждён» и «не найден» — разные новости: во втором случае скриншот
        // надо перечитать заново, в первом надо сначала починить файл
        // (следующее сохранение тех же байт перезапишет его атомарно).
        const state = await store.verify?.(id).catch(() => null);
        const text = state === 'corrupt'
          ? 'Архивный скриншот есть в хранилище, но его файл повреждён (содержимое не совпадает с sha256). Перечитайте изображение инструментом read — TaskBridge сохранит его заново.'
          : 'Скриншот не найден в локальном хранилище TaskBridge.';
        return { content: [{ type: 'text', text }], isError: true };
      }
      return { content: [image] };
    }
  });
}
