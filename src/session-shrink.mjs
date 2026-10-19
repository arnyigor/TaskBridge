import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Pi keeps every base64 image it ever read inside its session file, and every
// new request re-sends the whole transcript. Images are what explodes that
// payload: 39 full-resolution screenshots weighed 47.6 MB of the 48.6 MB a
// Blender session carried on 2026-10-19, while its TEXT was 0.2 MB and its
// context 28 % of a 1M-token window. Pi's own protection is token-based
// (auto-compaction fires on contextTokens), so nothing measured the bytes, and
// the provider's edge — which refuses a request body over ~50 MB — answered
// every request with
//   413 Failed to buffer the request body: length limit exceeded
// The session could then never start again: Pi retried that permanent error
// every 5 s (824 attempts in one log) and the panel showed «ждём провайдера».
//
// Measured against api.deepseek.com the same day: a 50 300 086-byte body is
// accepted, 50 400 086 is refused, regardless of the model named in it.
//
// Repair keeps the history: the base64 of the OLD images is moved to a local
// artifact file (deduplicated by SHA-256) and replaced by a one-line reference.
// Text, thinking, tool calls, message ids and parent links are untouched, so Pi
// loads the session as before; the newest images stay inline because a running
// step needs them.

export const DEFAULT_KEEP_IMAGES = 2;

// Half of the measured ~50 MB edge: the request also carries the system prompt,
// project instructions and tool schemas, and a session keeps growing after it
// starts, so the ceiling itself is not a safe place to sit.
export const DEFAULT_SESSION_MAX_MB = 24;

export const DEFAULT_ARTIFACT_LABEL = 'data/media';

const IMAGE_TYPES = new Set(['image', 'image_url', 'input_image']);
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function imagePayload(part) {
  if (typeof part?.data === 'string') return { base64: part.data, mimeType: part?.mimeType || part?.media_type || 'image/png' };
  const url = typeof part?.image_url?.url === 'string' ? part.image_url.url : null;
  if (url && url.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (match) return { base64: match[2], mimeType: match[1] };
  }
  if (typeof part?.source?.data === 'string') return { base64: part.source.data, mimeType: part?.source?.media_type || 'image/png' };
  return null;
}

function imageBytes(part) {
  return imagePayload(part)?.base64.length ?? 0;
}

const plainPlaceholder = bytes => ({
  type: 'text',
  text: `[скриншот исключён из активного контекста: ${Math.round(bytes / 1024)} КБ в base64 превышали лимит тела запроса провайдера]`
});

// Step 1, pure: which images does a repair drop, and what does the file look
// like as records. "Keep the newest N" needs the whole transcript first.
export function planShrink(text, { keepImages = DEFAULT_KEEP_IMAGES } = {}) {
  const lines = text.split('\n');
  const parsed = lines.map(line => {
    if (!line.trim()) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  });
  const badLine = lines.findIndex((line, index) => line.trim() && !parsed[index]);
  const images = [];
  parsed.forEach((record, lineIndex) => {
    const content = record?.message?.content;
    if (!Array.isArray(content)) return;
    content.forEach((part, partIndex) => {
      if (!IMAGE_TYPES.has(part?.type)) return;
      const bytes = imageBytes(part);
      if (bytes > 0) images.push({ lineIndex, partIndex, bytes, part });
    });
  });
  const keep = Math.max(0, Math.trunc(keepImages));
  const drop = images.slice(0, Math.max(0, images.length - keep));
  return {
    lines,
    parsed,
    images,
    drop,
    unparsedLine: badLine >= 0 ? badLine + 1 : 0,
    stats: {
      images: images.length,
      dropped: drop.length,
      kept: images.length - drop.length,
      droppedBytes: drop.reduce((sum, item) => sum + item.bytes, 0),
      bytesBefore: images.reduce((sum, item) => sum + item.bytes, 0)
    }
  };
}

// Step 2, pure: the new file text. `placeholder(part, bytes)` decides what the
// model and the operator see in place of the image; only lines that lost an
// image are re-serialized, every other line stays byte-for-byte.
export function applyShrink(plan, { placeholder = plainPlaceholder } = {}) {
  const next = plan.parsed.slice();
  const changed = new Set();
  for (const { lineIndex, partIndex, bytes, part } of plan.drop) {
    if (!changed.has(lineIndex)) {
      next[lineIndex] = { ...plan.parsed[lineIndex], message: { ...plan.parsed[lineIndex].message, content: plan.parsed[lineIndex].message.content.slice() } };
      changed.add(lineIndex);
    }
    next[lineIndex].message.content[partIndex] = placeholder(part, bytes);
  }
  return plan.lines.map((line, index) => (changed.has(index) ? JSON.stringify(next[index]) : line)).join('\n');
}

// Pure convenience: repair a transcript in memory (no artifacts on disk).
export function shrinkSession(text, { keepImages = DEFAULT_KEEP_IMAGES } = {}) {
  const plan = planShrink(text, { keepImages });
  return {
    text: plan.drop.length ? applyShrink(plan) : text,
    ...plan.stats,
    unparsed: plan.unparsedLine ? 1 : 0
  };
}

const MB = 1024 * 1024;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// The original image, once, on disk. Content-addressed: the same screenshot read
// twice is stored once, and a second repair of the same session writes nothing.
export async function saveArtifact(dir, part, bytes) {
  const payload = imagePayload(part);
  if (!payload) return null;
  const buffer = Buffer.from(payload.base64, 'base64');
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const extension = EXTENSIONS[payload.mimeType] || 'bin';
  const file = path.join(dir, `${sha}.${extension}`);
  const exists = await fs.access(file).then(() => true, () => false);
  if (!exists) await fs.writeFile(file, buffer);
  return { file, sha256: sha, bytes, mimeType: payload.mimeType, written: !exists };
}

// A record of what the repair may not change: message ids, parent links, record
// types. If the rewritten file does not match, the original is restored and the
// repair is reported as failed instead of pretending to have worked.
function fingerprint(lines) {
  const ids = [];
  const parents = [];
  const types = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { return null; }
    types.set(record.type, (types.get(record.type) || 0) + 1);
    if (record.id) ids.push(record.id);
    if (record.parentId !== undefined) parents.push(`${record.id}>${record.parentId}`);
  }
  return { ids: ids.join(','), parents: parents.join(','), types: [...types].sort().map(([type, count]) => `${type}:${count}`).join(',') };
}

// Repairs one session file in place. Never touches a file that does not parse,
// never grows a file, and keeps a `.bak-<timestamp>` copy next to it: the repair
// is reversible and idempotent (a second run finds no oversized images).
export async function shrinkSessionFile(file, {
  keepImages = DEFAULT_KEEP_IMAGES,
  limitBytes = DEFAULT_SESSION_MAX_MB * MB,
  artifactDir = null,
  artifactLabel = DEFAULT_ARTIFACT_LABEL
} = {}) {
  if (!file) return { changed: false, reason: 'no-file' };
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return { changed: false, reason: 'missing' };
  if (stat.size <= limitBytes) return { changed: false, reason: 'under-limit', beforeBytes: stat.size };

  const text = await fs.readFile(file, 'utf8');
  const plan = planShrink(text, { keepImages });
  if (plan.unparsedLine) {
    // A corrupt transcript is not something to rewrite on a guess.
    return { changed: false, reason: 'invalid', line: plan.unparsedLine, beforeBytes: stat.size };
  }
  if (!plan.drop.length) {
    return { changed: false, reason: 'no-images', beforeBytes: stat.size, images: plan.images.length };
  }

  const artifacts = [];
  let placeholder = plainPlaceholder;
  if (artifactDir) {
    await fs.mkdir(artifactDir, { recursive: true });
    const saved = new Map();
    for (const item of plan.drop) {
      if (!saved.has(item.part)) {
        const artifact = await saveArtifact(artifactDir, item.part, item.bytes);
        if (artifact) saved.set(item.part, artifact);
      }
      const artifact = saved.get(item.part);
      if (artifact) artifacts.push(artifact);
    }
    const byPart = new Map([...saved]);
    placeholder = (part, bytes) => {
      const artifact = byPart.get(part);
      if (!artifact) return plainPlaceholder(bytes);
      // An absolute path, because that is what Pi's `read` resolves without the
      // session's working directory (path-utils resolvePath keeps absolutes); a
      // `data/media/...` label would resolve against the workspace and miss.
      return {
        type: 'text',
        text: `[скриншот исключён из активного контекста: ${Math.round(bytes / 1024)} КБ base64; оригинал: ${artifact.file} — можно перечитать инструментом read]`
      };
    };
  }

  const next = applyShrink(plan, { placeholder });
  const before = fingerprint(plan.lines);
  const after = fingerprint(next.split('\n'));
  if (!before || !after || before.ids !== after.ids || before.parents !== after.parents || before.types !== after.types) {
    return { changed: false, reason: 'integrity', beforeBytes: stat.size };
  }

  const backup = `${file}.bak-${stamp()}`;
  await fs.copyFile(file, backup);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  await fs.writeFile(temp, next, 'utf8');
  await fs.rename(temp, file);

  const afterBytes = Buffer.byteLength(next, 'utf8');
  if (afterBytes >= stat.size) {
    await fs.copyFile(backup, file).catch(() => {});
    return { changed: false, reason: 'no-gain', beforeBytes: stat.size, afterBytes };
  }
  return {
    changed: true,
    reason: 'shrunk',
    beforeBytes: stat.size,
    afterBytes,
    dropped: plan.stats.dropped,
    kept: plan.stats.kept,
    images: plan.stats.images,
    artifacts: artifacts.length,
    artifactBytes: artifacts.reduce((sum, item) => sum + item.bytes, 0),
    written: artifacts.filter(item => item.written).length,
    backup
  };
}

// One line for the event log / UI: «48.7 → 5.2 МБ».
export function describeShrink(result) {
  const mb = bytes => (bytes / 1048576).toFixed(1);
  return `${mb(result.beforeBytes)} → ${mb(result.afterBytes)} МБ, старых скриншотов исключено из контекста: ${result.dropped}, оставлено: ${result.kept}`;
}
