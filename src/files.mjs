import fs from 'node:fs/promises';
import { createReadStream, constants as fsConstants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const invalid = message => Object.assign(new Error(message), { code: 'INPUT_INVALID' });
const forbidden = () => Object.assign(new Error('Этот файл недоступен для выдачи.'), { code: 'FILE_FORBIDDEN' });
export const FILE_LIMITS = { count: 10, totalBytes: 16 * 1024 * 1024, uploadFileBytes: 64 * 1024 * 1024, uploadBytes: 128 * 1024 * 1024, outputBytes: 256 * 1024 * 1024 };
const skippedDirs = new Set(['.git', '.pi', '.taskbridge-input', 'node_modules', 'data', '.gradle', '.idea']);

export function isPrivatePath(value) {
  const parts = String(value).replaceAll('\\', '/').split('/');
  return parts.some(p => /^(?:\.git|\.pi|\.ssh|\.aws|\.codex|node_modules|data)$/i.test(p) || /^(?:\.env(?:\..*)?|secret(?:s)?(?:\..*)?|credentials(?:\..*)?|config\.json|server-auth\.json|auth\.json)$/i.test(p) || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(p));
}

export function contentType(name) {
  const ext = path.extname(name).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.patch': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })[ext] || (/\.(?:kt|kts|py|java|ts|tsx|jsx|xml|yaml|yml|toml|sh|bat|cmd|ps1|sql|c|h|cpp)$/i.test(name) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
}

export function validateFiles(files = [], limits = FILE_LIMITS) {
  if (!Array.isArray(files) || files.length > limits.count) throw invalid(`Можно прикрепить до ${limits.count} файлов.`);
  let total = 0;
  return files.map(file => {
    if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 180 || /[<>:"/\\|?*\x00-\x1f]/.test(file.name) || /[. ]$/.test(file.name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file.name)) throw invalid('Недопустимое имя файла.');
    if (typeof file.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw invalid(`Повреждены данные файла ${file.name}.`);
    // Bound allocation before decoding. Empty files are valid.
    if (file.base64.length > Math.ceil(limits.totalBytes / 3) * 4) throw Object.assign(invalid('Превышен лимит файлов.'), { code: 'BODY_TOO_LARGE' });
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.toString('base64') !== file.base64 || (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size !== bytes.length))) throw invalid(`Размер или кодировка файла ${file.name} не совпадает с содержимым.`);
    total += bytes.length;
    if (total > limits.totalBytes) throw Object.assign(invalid(`Суммарный размер файлов превышает ${limits.totalBytes / 1048576} MiB.`), { code: 'BODY_TOO_LARGE' });
    return { id: crypto.randomUUID(), name: file.name, size: bytes.length, mimeType: contentType(file.name), bytes };
  });
}

// Streaming uploads are resolved by the UploadStore and then validated here:
// the client only supplies ids, so name/size/mime come from what was written.
export function validateUploadRefs(refs, resolved, limits = FILE_LIMITS) {
  if (!Array.isArray(refs) || refs.length > limits.count) throw invalid(`Можно прикрепить до ${limits.count} файлов.`);
  let total = 0;
  return resolved.map(file => {
    if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 180) throw invalid('Недопустимое имя файла.');
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw invalid(`Размер файла ${file.name} неизвестен.`);
    if (file.size > limits.uploadFileBytes) throw Object.assign(invalid(`Файл ${file.name} превышает ${limits.uploadFileBytes / 1048576} МиБ.`), { code: 'BODY_TOO_LARGE' });
    total += file.size;
    if (total > limits.uploadBytes) throw Object.assign(invalid(`Суммарный размер файлов превышает ${limits.uploadBytes / 1048576} МиБ.`), { code: 'BODY_TOO_LARGE' });
    return file;
  });
}

export function metadata(file) {
  const { bytes, sourcePath, ...rest } = file;
  return rest;
}

export async function containedFile(rootDir, requestedPath, { allowPrivate = false } = {}) {
  const root = await fs.realpath(rootDir);
  const requested = path.resolve(root, requestedPath);
  const check = target => {
    const rel = path.relative(root, target);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw invalid('Путь выходит за пределы рабочей папки.');
    if (!allowPrivate && isPrivatePath(rel)) throw forbidden();
    return target;
  };
  check(requested);
  return check(await fs.realpath(requested));
}

async function makeInputDirectory(workspace, taskId, fileId) {
  let directory = await fs.realpath(workspace);
  for (const part of ['.taskbridge-input', taskId, fileId]) {
    directory = path.join(directory, part);
    await fs.mkdir(directory).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid('Каталог вложений не должен быть ссылкой.');
  }
  return directory;
}

export async function stageFiles(task, taskDir, files) {
  const staged = [];
  await fs.mkdir(path.join(taskDir, 'files'), { recursive: true });
  try {
    for (const file of files) {
      const directory = await makeInputDirectory(task.workspacePath, task.id, file.id);
      const item = { ...metadata(file), direction: 'input', path: path.relative(task.workspacePath, path.join(directory, file.name)).replaceAll('\\', '/') };
      staged.push(item);
      if (file.sourcePath) {
        // Uploaded file: copy it into the task and the workspace, then the
        // staging directory is discarded by the caller.
        await fs.copyFile(file.sourcePath, path.join(taskDir, 'files', file.id), fsConstants.COPYFILE_EXCL);
        await fs.copyFile(file.sourcePath, path.join(directory, file.name), fsConstants.COPYFILE_EXCL);
      } else {
        await fs.writeFile(path.join(taskDir, 'files', file.id), file.bytes, { flag: 'wx' });
        await fs.writeFile(path.join(directory, file.name), file.bytes, { flag: 'wx' });
      }
    }
    return staged;
  } catch (error) { await rollbackFiles(task, taskDir, staged); throw error; }
}

export async function rollbackFiles(task, taskDir, files) {
  for (const file of files) {
    if (!/^[a-f0-9-]{36}$/.test(file.id)) continue;
    await fs.unlink(path.join(taskDir, 'files', file.id)).catch(() => {});
    // Validate each target; unlink only this submission's files, never recurse.
    const input = await containedFile(task.workspacePath, file.path, { allowPrivate: true }).catch(() => null);
    if (input && path.basename(path.dirname(input)) === file.id) {
      await fs.unlink(input).catch(() => {});
      await fs.rmdir(path.dirname(input)).catch(() => {});
    }
  }
}

export async function snapshotWorkspace(workspace) {
  const files = new Map();
  let visited = 0;
  let truncated = false;
  async function visit(dir, relative = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (++visited > 15000) { truncated = true; return; }
      const rel = path.join(relative, entry.name);
      if (isPrivatePath(rel) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!skippedDirs.has(entry.name)) await visit(path.join(dir, entry.name), rel); }
      else if (entry.isFile()) {
        const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
        if (stat) files.set(rel.replaceAll('\\', '/'), { size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await visit(workspace);
  return { files, truncated };
}

export async function captureOutputs(task, taskDir, baseline) {
  if (!baseline) return { files: [], warnings: [] };
  const after = await snapshotWorkspace(task.workspacePath);
  const files = [], warnings = [];
  if (baseline.truncated || after.truncated) warnings.push('Рабочая папка слишком велика: список результатов может быть неполным.');
  await fs.mkdir(path.join(taskDir, 'files'), { recursive: true });
  for (const [name, stat] of after.files) {
    const before = baseline.files.get(name);
    if (before && before.size === stat.size && before.mtimeMs === stat.mtimeMs) continue;
    if (files.length >= 100 || stat.size > FILE_LIMITS.outputBytes) { warnings.push(`Файл ${name} не сохранён: превышен лимит результатов.`); continue; }
    const id = crypto.randomUUID();
    try {
      const source = await containedFile(task.workspacePath, name);
      await fs.copyFile(source, path.join(taskDir, 'files', id));
      files.push({ id, name: path.basename(name), path: name, size: (await fs.stat(path.join(taskDir, 'files', id))).size, mimeType: contentType(name), direction: 'output', createdAt: new Date().toISOString() });
    } catch (error) { warnings.push(`Не удалось сохранить ${name}: ${error.message}`); }
  }
  return { files, warnings };
}

export async function serveFile(req, res, target, name, download = false) {
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw Object.assign(new Error('Файл не найден.'), { code: 'NOT_FOUND' });
  const ext = path.extname(name).toLowerCase();
  const active = ['.html', '.htm', '.svg', '.xhtml'].includes(ext);
  const mime = /\.(?:js|mjs|css|json)$/i.test(name) ? 'text/plain; charset=utf-8' : contentType(name);
  const disposition = (download || active || mime === 'application/octet-stream' || mime === 'application/zip') ? 'attachment' : 'inline';
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16));
  const headers = { 'content-type': mime, 'content-disposition': `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'content-security-policy': "sandbox; default-src 'none'", 'accept-ranges': 'bytes' };
  let start = 0, end = stat.size - 1, status = 200;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
    }
    if (!range || (!range[1] && !range[2]) || start > end || start >= stat.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` }); res.end(); return;
    }
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['content-length'] = Math.max(0, end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !stat.size) { res.end(); return; }
  await pipeline(createReadStream(target, { start, end }), res);
}
