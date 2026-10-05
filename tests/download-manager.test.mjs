import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
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
