import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { DownloadManager } from '../src/download-manager.mjs';

// Локальный HTTP-сервер вместо Hugging Face: отдаёт статические файлы,
// поддерживает обрыв соединения для проверки отмены.
function startServer(files) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent(req.url.replace(/^\//, ''));
      const body = files[name];
      if (body == null) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}`,
      // fetch (undici) держит keep-alive сокеты после ответа: без
      // closeAllConnections сервер закрывается в гонке с ними и libuv на
      // Windows может уронить процесс (uv_handle_closing) уже после тестов.
      close: () => new Promise(done => {
        server.closeAllConnections();
        server.close(() => done());
      })
    }));
  });
}

async function tempRoot(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `taskbridge-${label}-`));
}

function waitFor(manager, state, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`job did not reach ${state}`)), timeoutMs);
    manager.on('update', j => { if (j.state === state) { clearTimeout(timer); resolve(j); } });
  });
}

test('DownloadManager downloads files, verifies sizes and reports INSTALLED', async () => {
  const { base, close } = await startServer({
    'model.gguf': Buffer.alloc(1000, 7),
    'mmproj-f16.gguf': Buffer.alloc(200, 3)
  });
  const root = await tempRoot('dl');
  try {
    const installed = [];
    const manager = new DownloadManager(root, { onInstalled: job => installed.push(job) });
    const job = await manager.start({
      repo: 'org/model', revision: 'main',
      files: [{ path: 'model.gguf', size: 1000 }, { path: 'mmproj-f16.gguf', size: 200 }],
      dir: path.join(root, 'model'), resolveBase: base
    });
    // Задание стартует асинхронно: к моменту ответа оно может уже качаться.
    assert.ok(['QUEUED', 'DOWNLOADING'].includes(job.state));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('download did not finish')), 5000);
      manager.on('update', j => { if (j.state === 'INSTALLED') { clearTimeout(timer); resolve(); } });
    });
    const final = manager.list({ id: job.id });
    assert.equal(final.state, 'INSTALLED');
    assert.equal(final.downloadedBytes, 1200);
    const body = await fs.readFile(path.join(root, 'model', 'model.gguf'));
    assert.equal(body.length, 1000);
    assert.equal(body[0], 7);
    // часть-файлы убраны
    await assert.rejects(() => fs.access(path.join(root, 'model', '.taskbridge-part')));
    assert.equal(installed.length, 1);
    assert.equal(installed[0].id, job.id);
  } finally {
    await close();
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test('DownloadManager cancels a job and retry skips complete files', async () => {
  const big = Buffer.alloc(2_000_000, 9);
  const { base, close } = await startServer({ 'big.gguf': big, 'small.gguf': Buffer.alloc(10, 1) });
  const root = await tempRoot('dl-cancel');
  try {
    const manager = new DownloadManager(root);
    const job = await manager.start({
      repo: 'org/model', files: [{ path: 'big.gguf', size: big.length }, { path: 'small.gguf', size: 10 }],
      dir: path.join(root, 'model'), resolveBase: base
    });
    // отмена приходит во время большой загрузки
    manager.once('update', j => { if (j.state === 'DOWNLOADING') manager.cancel(j.id); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('job never settled')), 5000);
      manager.on('update', j => { if (j.state === 'CANCELLED') { clearTimeout(timer); resolve(); } });
    });
    assert.equal(manager.list({ id: job.id }).state, 'CANCELLED');
    // undici завершает обработку abort асинхронно — даём тик, иначе teardown роняет uv.
    await new Promise(r => setTimeout(r, 50));

    // retry: большой файл не скачан целиком, малый может быть готов — докачивает
    const retried = await manager.retry(job.id);
    assert.ok(['DOWNLOADING', 'QUEUED'].includes(retried.state));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('retry did not finish')), 5000);
      manager.on('update', j => { if (j.state === 'INSTALLED') { clearTimeout(timer); resolve(); } });
    });
    const done = manager.list({ id: job.id });
    assert.equal(done.state, 'INSTALLED');
    assert.equal(done.downloadedBytes, big.length + 10);
  } finally {
    await close();
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test('DownloadManager resumes a part file with Range 206 and verifies SHA-256', async () => {
  const body = Buffer.from('0123456789');
  const ranges = [];
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      ranges.push(req.headers.range || null);
      const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]);
        res.writeHead(206, { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}`, 'content-length': body.length - start });
        res.end(body.subarray(start));
        return;
      }
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
    });
    s.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise(done => { s.closeAllConnections(); s.close(() => done()); })
    }));
  });
  const root = await tempRoot('dl-range');
  try {
    const dir = path.join(root, 'model');
    await fs.mkdir(path.join(dir, '.taskbridge-part'), { recursive: true });
    await fs.writeFile(path.join(dir, '.taskbridge-part', 'model.gguf'), body.subarray(0, 5));
    const manager = new DownloadManager(root);
    const job = await manager.start({
      repo: 'org/model', files: [{ path: 'model.gguf', size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') }],
      dir, resolveBase: server.base
    });
    await waitFor(manager, 'INSTALLED');
    assert.equal((await fs.readFile(path.join(dir, 'model.gguf'))).toString(), body.toString());
    assert.equal(manager.list({ id: job.id }).downloadedBytes, body.length);
    assert.deepEqual(ranges, ['bytes=5-']);
  } finally {
    await server.close();
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test('DownloadManager restarts instead of appending when Range is ignored', async () => {
  const body = Buffer.from('abcdefghij');
  const root = await tempRoot('dl-range-200');
  const { base, close } = await startServer({ 'model.gguf': body });
  try {
    const dir = path.join(root, 'model');
    await fs.mkdir(path.join(dir, '.taskbridge-part'), { recursive: true });
    await fs.writeFile(path.join(dir, '.taskbridge-part', 'model.gguf'), Buffer.from('wrong'));
    const manager = new DownloadManager(root);
    const job = await manager.start({ repo: 'org/model', files: [{ path: 'model.gguf', size: body.length }], dir, resolveBase: base });
    await waitFor(manager, 'INSTALLED');
    assert.equal((await fs.readFile(path.join(dir, 'model.gguf'))).toString(), body.toString());
    assert.equal(manager.list({ id: job.id }).downloadedBytes, body.length);
  } finally {
    await close();
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test('DownloadManager rejects a mismatched Content-Range offset', async () => {
  const root = await tempRoot('dl-bad-range');
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.writeHead(206, { 'content-range': 'bytes 0-9/10', 'content-length': 5 });
      res.end('56789');
    });
    s.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise(done => { s.closeAllConnections(); s.close(() => done()); })
    }));
  });
  try {
    const dir = path.join(root, 'model');
    await fs.mkdir(path.join(dir, '.taskbridge-part'), { recursive: true });
    await fs.writeFile(path.join(dir, '.taskbridge-part', 'model.gguf'), '01234');
    const manager = new DownloadManager(root);
    const job = await manager.start({ repo: 'org/model', files: [{ path: 'model.gguf', size: 10 }], dir, resolveBase: server.base });
    await waitFor(manager, 'FAILED');
    assert.match(manager.list({ id: job.id }).error, /Content-Range/);
  } finally {
    await server.close();
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test('DownloadManager treats 416 with a complete part as installed', async () => {
  const body = Buffer.from('complete');
  const root = await tempRoot('dl-416');
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => { res.writeHead(416); res.end(); });
    s.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise(done => { s.closeAllConnections(); s.close(() => done()); })
    }));
  });
  try {
    const dir = path.join(root, 'model');
    await fs.mkdir(path.join(dir, '.taskbridge-part'), { recursive: true });
    await fs.writeFile(path.join(dir, '.taskbridge-part', 'model.gguf'), body);
    const manager = new DownloadManager(root);
    await manager.start({ repo: 'org/model', files: [{ path: 'model.gguf', size: body.length }], dir, resolveBase: server.base });
    await waitFor(manager, 'INSTALLED');
    assert.equal((await fs.readFile(path.join(dir, 'model.gguf'))).toString(), body.toString());
  } finally {
    await server.close();
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test('DownloadManager retries after a broken HTTP stream and resumes the part', async () => {
  const body = Buffer.from('broken-stream-body');
  let first = true;
  const root = await tempRoot('dl-broken-stream');
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
      if (first) {
        first = false;
        res.writeHead(200, { 'content-length': body.length });
        res.write(body.subarray(0, 6));
        res.destroy();
        return;
      }
      const start = range ? Number(range[1]) : 0;
      res.writeHead(range ? 206 : 200, {
        ...(range ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
        'content-length': body.length - start
      });
      res.end(body.subarray(start));
    });
    s.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise(done => { s.closeAllConnections(); s.close(() => done()); })
    }));
  });
  try {
    const dir = path.join(root, 'model');
    const manager = new DownloadManager(root);
    const job = await manager.start({ repo: 'org/model', files: [{ path: 'model.gguf', size: body.length }], dir, resolveBase: server.base });
    await waitFor(manager, 'FAILED');
    await manager.retry(job.id);
    await waitFor(manager, 'INSTALLED');
    assert.equal((await fs.readFile(path.join(dir, 'model.gguf'))).toString(), body.toString());
  } finally {
    await server.close();
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test('DownloadManager restarts after 416 when the part is incomplete', async () => {
  const body = Buffer.from('restarted');
  let calls = 0;
  const root = await tempRoot('dl-416-restart');
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      calls += 1;
      if (calls === 1) { res.writeHead(416); res.end(); return; }
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
    });
    s.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise(done => { s.closeAllConnections(); s.close(() => done()); })
    }));
  });
  try {
    const dir = path.join(root, 'model');
    await fs.mkdir(path.join(dir, '.taskbridge-part'), { recursive: true });
    await fs.writeFile(path.join(dir, '.taskbridge-part', 'model.gguf'), 'old');
    const manager = new DownloadManager(root);
    await manager.start({ repo: 'org/model', files: [{ path: 'model.gguf', size: body.length }], dir, resolveBase: server.base });
    await waitFor(manager, 'INSTALLED');
    assert.equal((await fs.readFile(path.join(dir, 'model.gguf'))).toString(), body.toString());
    assert.equal(calls, 2);
  } finally {
    await server.close();
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test('DownloadManager limits concurrent downloads', async () => {
  let active = 0;
  let maxActive = 0;
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        const body = Buffer.alloc(5, 1);
        res.writeHead(200, { 'content-length': body.length });
        res.end(body, () => { active -= 1; });
      }, 80);
    });
    s.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise(done => { s.closeAllConnections(); s.close(() => done()); })
    }));
  });
  const root = await tempRoot('dl-queue');
  try {
    const manager = new DownloadManager(root, { maxConcurrentDownloads: 2 });
    const jobs = await Promise.all([0, 1, 2, 3].map(i => manager.start({
      repo: `org/model-${i}`, files: [{ path: `m${i}.gguf`, size: 5 }], dir: path.join(root, `m${i}`), resolveBase: server.base
    })));
    await Promise.all(jobs.map(job => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('download did not finish')), 5000);
      manager.on('update', j => { if (j.id === job.id && j.state === 'INSTALLED') { clearTimeout(timer); resolve(); } });
    })));
    assert.equal(maxActive, 2);
  } finally {
    await server.close();
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test('DownloadManager preserves libraryId and sends download headers', async () => {
  let auth = null;
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      auth = req.headers.authorization || null;
      const body = Buffer.alloc(12, 4);
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
    });
    s.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise(done => { s.closeAllConnections(); s.close(() => done()); })
    }));
  });
  const root = await tempRoot('dl-headers');
  try {
    const manager = new DownloadManager(root, { downloadHeaders: () => ({ authorization: 'Bearer test-token' }) });
    const job = await manager.start({
      repo: 'org/private', revision: 'main', libraryId: 'hf:org/private@main:Q4_K_M',
      files: [{ path: 'private.gguf', size: 12 }], dir: path.join(root, 'private'), resolveBase: server.base
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('download did not finish')), 5000);
      manager.on('update', j => { if (j.state === 'INSTALLED') { clearTimeout(timer); resolve(); } });
    });
    const final = manager.list({ id: job.id });
    assert.equal(final.libraryId, 'hf:org/private@main:Q4_K_M');
    assert.equal(auth, 'Bearer test-token');
    assert.doesNotMatch(await fs.readFile(path.join(root, 'downloads.json'), 'utf8'), /test-token|authorization/i);
  } finally {
    await server.close();
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test('DownloadManager marks in-flight jobs INTERRUPTED after restart and refuses unsafe paths', async () => {
  const root = await tempRoot('dl-restore');
  try {
    // Имитируем состояние на момент смерти процесса: задание было DOWNLOADING.
    const stateFile = path.join(root, 'downloads.json');
    const fake = [{ id: 'dl-old', repo: 'org/model', revision: 'main', dir: root, label: 'model',
      files: [{ path: 'a.gguf', size: 5, done: false }], totalBytes: 5, downloadedBytes: 2,
      state: 'DOWNLOADING', error: null, createdAt: 1, updatedAt: 2, startedAt: 1 }];
    await fs.writeFile(stateFile, JSON.stringify(fake), 'utf8');

    const manager = new DownloadManager(root);
    const restored = manager.list({ id: 'dl-old' });
    assert.equal(restored.state, 'INTERRUPTED');

    await assert.rejects(() => manager.start({ repo: 'x', files: [], dir: root }), /файлов загрузки/i);
    await assert.rejects(
      () => manager.start({ repo: 'x', files: [{ path: '../../evil.gguf', size: 1 }], dir: root, resolveBase: 'http://127.0.0.1:1' }),
      /Недопустимый путь/);
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test('DownloadManager.clearFinished drops terminal jobs and keeps active ones', async () => {
  const root = await tempRoot('dl-clear');
  try {
    const manager = new DownloadManager(root);
    // завершённое задание в состоянии на момент «смерти процесса»
    await fs.writeFile(path.join(root, 'downloads.json'), JSON.stringify([
      { id: 'done-1', repo: 'a', revision: 'main', dir: root, label: 'a', files: [], totalBytes: 1, downloadedBytes: 1, state: 'INSTALLED', createdAt: 1, updatedAt: 1 },
      { id: 'dead-1', repo: 'b', revision: 'main', dir: root, label: 'b', files: [], totalBytes: 1, downloadedBytes: 0, state: 'DOWNLOADING', createdAt: 1, updatedAt: 1 }
    ]), 'utf8');
    const restored = new DownloadManager(root);
    assert.equal(restored.list({ id: 'dead-1' }).state, 'INTERRUPTED', 'восстановленное прервано');
    const removed = restored.clearFinished();
    assert.equal(removed, 2, 'оба терминальных задания убраны');
    assert.equal(restored.list().length, 0);
    // активные задания при очистке не трогаются
    const { base, close } = await startServer({ 'x.gguf': Buffer.alloc(10, 1) });
    const job = await restored.start({ repo: 'c', files: [{ path: 'x.gguf', size: 10 }], dir: path.join(root, 'c'), resolveBase: base });
    assert.equal(restored.clearFinished(), 0, 'активное задание не удалено');
    assert.equal(restored.list({ id: job.id })?.state === null, false);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), 5000);
      restored.on('update', j => { if (j.state === 'INSTALLED') { clearTimeout(t); res(); } });
    });
    assert.equal(restored.clearFinished(), 1);
    await close();
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});
