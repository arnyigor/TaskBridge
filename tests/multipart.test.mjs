import test from 'node:test';
import assert from 'node:assert/strict';
import { multipartBoundary, parseMultipart } from '../src/multipart.mjs';

function build(parts, boundary) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`));
      chunks.push(Buffer.from(`Content-Type: ${part.type || 'application/octet-stream'}\r\n\r\n`));
      chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      chunks.push(Buffer.from(part.data));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function* trickle(buffer, size = 5) {
  for (let i = 0; i < buffer.length; i += size) yield buffer.subarray(i, i + size);
}

async function collect(stream, boundary, options = {}) {
  const fields = {};
  const files = [];
  await parseMultipart(stream, boundary, {
    onField: (name, value) => { fields[name] = value; },
    onFile: async ({ filename }) => {
      const chunks = [];
      return { write: chunk => chunks.push(Buffer.from(chunk)), end: async () => { files.push({ name: filename, data: Buffer.concat(chunks) }); } };
    },
    ...options
  });
  return { fields, files };
}

test('boundary is extracted from quoted and unquoted content types', () => {
  assert.equal(multipartBoundary('multipart/form-data; boundary=abc123'), 'abc123');
  assert.equal(multipartBoundary('multipart/form-data; boundary="a b c"'), 'a b c');
  assert.equal(multipartBoundary('application/json'), null);
  assert.equal(multipartBoundary(''), null);
});

test('fields and files stream across chunk boundaries with bytes preserved', async () => {
  const boundary = '----TaskBridgeBoundary42';
  const binary = Buffer.from([0, 1, 2, 3, 0, 255, 254, 13, 10, 45, 45]);
  const body = build([
    { name: 'projectId', data: 'fixture' },
    { name: 'files', filename: 'заметка.txt', data: 'привет upload\n', type: 'text/plain' },
    { name: 'files', filename: 'data.bin', data: binary, type: 'application/octet-stream' }
  ], boundary);
  const { fields, files } = await collect(trickle(body, 7), boundary);
  assert.equal(fields.projectId, 'fixture');
  assert.deepEqual(files.map(f => f.name), ['заметка.txt', 'data.bin']);
  assert.equal(files[0].data.toString('utf8'), 'привет upload\n');
  assert.deepEqual(files[1].data, binary);
});

test('a boundary split exactly across chunks is still detected', async () => {
  const boundary = 'split-boundary';
  const body = build([{ name: 'files', filename: 'x.txt', data: 'hello world' }], boundary);
  // One byte at a time is the worst case for the rolling buffer.
  const { files } = await collect(trickle(body, 1), boundary);
  assert.equal(files[0].data.toString('utf8'), 'hello world');
});

test('per-file size limit aborts the upload', async () => {
  const boundary = 'limit-boundary';
  const body = build([{ name: 'files', filename: 'big.bin', data: Buffer.alloc(2048, 7) }], boundary);
  await assert.rejects(collect(trickle(body, 64), boundary, { maxFileBytes: 1024 }), { code: 'BODY_TOO_LARGE' });
});

test('a body without a boundary is rejected', async () => {
  await assert.rejects(parseMultipart(trickle(Buffer.from('no multipart here')), 'missing'), { code: 'INPUT_INVALID' });
});
