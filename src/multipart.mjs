// Minimal streaming multipart/form-data parser (no dependencies). It never
// buffers whole files: file bodies are handed to a sink chunk by chunk, which
// is what lets uploads exceed the JSON body limit without base64 inflation.
const fail = (code, message) => Object.assign(new Error(message), { code });

export function multipartBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  const boundary = match?.[1] || match?.[2];
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) return null;
  return boundary;
}

function parseHeaders(text) {
  const headers = {};
  for (const line of text.split('\r\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function unquote(value) {
  return value.replace(/\\(.)/g, '$1');
}

export async function parseMultipart(req, boundary, options = {}) {
  const {
    maxBytes = 128 * 1024 * 1024,
    maxFiles = 10,
    maxFieldBytes = 64 * 1024,
    maxFileBytes = 64 * 1024 * 1024,
    maxHeaderBytes = 16 * 1024,
    onField = async () => {},
    onFile = async () => null
  } = options;

  const marker = Buffer.from(`--${boundary}`);
  const separator = Buffer.from(`\r\n--${boundary}`);
  const iterator = req[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  let total = 0;
  let finished = false;
  let fileCount = 0;
  const fields = {};

  const fill = async () => {
    if (finished) return false;
    const { value, done } = await iterator.next();
    if (done) { finished = true; return false; }
    total += value.length;
    if (total > maxBytes) throw fail('BODY_TOO_LARGE', `Тело запроса превышает ${Math.round(maxBytes / 1048576)} МиБ.`);
    buffer = buffer.length ? Buffer.concat([buffer, value]) : Buffer.from(value);
    return true;
  };

  // Keeps only the tail that could still contain a boundary split across chunks.
  const find = async needle => {
    let from = 0;
    while (true) {
      const index = buffer.indexOf(needle, from);
      if (index !== -1) return index;
      from = Math.max(0, buffer.length - needle.length + 1);
      if (!await fill()) return -1;
    }
  };

  const ensure = async count => {
    while (buffer.length < count && !finished) await fill();
    return buffer.length >= count;
  };

  const start = await find(marker);
  if (start === -1) throw fail('INPUT_INVALID', 'Не найден multipart boundary.');
  buffer = buffer.subarray(start + marker.length);

  while (true) {
    if (!await ensure(2)) break;
    const delimiter = buffer.subarray(0, 2).toString('latin1');
    if (delimiter === '--') break; // closing boundary
    if (delimiter !== '\r\n') throw fail('INPUT_INVALID', 'Повреждён multipart.');
    buffer = buffer.subarray(2);

    let headerEnd = buffer.indexOf('\r\n\r\n');
    while (headerEnd === -1) {
      if (buffer.length > maxHeaderBytes) throw fail('INPUT_INVALID', 'Слишком большой заголовок части.');
      if (!await fill()) throw fail('INPUT_INVALID', 'Незавершённые заголовки части.');
      headerEnd = buffer.indexOf('\r\n\r\n');
    }
    const headers = parseHeaders(buffer.subarray(0, headerEnd).toString('utf8'));
    buffer = buffer.subarray(headerEnd + 4);

    const disposition = headers['content-disposition'] || '';
    const name = unquote(/(?:^|;)\s*name="((?:[^"\\]|\\.)*)"/i.exec(disposition)?.[1] ?? '');
    const filenameMatch = /(?:^|;)\s*filename="((?:[^"\\]|\\.)*)"/i.exec(disposition);
    const isFile = Boolean(filenameMatch);
    const filename = isFile ? unquote(filenameMatch[1]) : null;
    const mimeType = headers['content-type'] || 'application/octet-stream';

    let sink = null;
    const chunks = [];
    let size = 0;
    if (isFile) {
      if (++fileCount > maxFiles) throw fail('INPUT_INVALID', `Можно загрузить до ${maxFiles} файлов.`);
      sink = await onFile({ name, filename, contentType: mimeType });
      if (!sink) throw fail('INPUT_INVALID', 'Не удалось начать приём файла.');
    }
    const limit = isFile ? maxFileBytes : maxFieldBytes;
    const write = async chunk => {
      if (!chunk.length) return;
      size += chunk.length;
      if (size > limit) throw fail('BODY_TOO_LARGE', `Файл ${filename || name} превышает лимит.`);
      if (sink) await sink.write(chunk);
      else chunks.push(chunk);
    };

    // Stream the body out as it arrives. Only a possible partial separator at
    // the tail is kept, so memory stays bounded regardless of file size.
    let closed = false;
    while (true) {
      const index = buffer.indexOf(separator);
      if (index !== -1) {
        await write(buffer.subarray(0, index));
        buffer = buffer.subarray(index + separator.length);
        closed = true;
        break;
      }
      const keep = separator.length - 1;
      if (buffer.length > keep) {
        await write(buffer.subarray(0, buffer.length - keep));
        buffer = buffer.subarray(buffer.length - keep);
      }
      if (!await fill()) {
        await write(buffer);
        buffer = Buffer.alloc(0);
        break;
      }
    }

    if (sink) await sink.end(size);
    else {
      const value = Buffer.concat(chunks).toString('utf8');
      fields[name] = value;
      await onField(name, value);
    }
    if (!closed) break;
  }

  return { fields, total };
}
