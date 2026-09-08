import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { TaskStore } from './task-store.mjs';
import { TaskManager } from './task-manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const webDir = path.join(rootDir, 'web');
const dataRoot = path.join(rootDir, 'data');

const config = await loadConfig(rootDir);
await fs.mkdir(dataRoot, { recursive: true });
const store = new TaskStore(dataRoot);
const manager = new TaskManager(config, dataRoot, store);
await manager.init();

const sseClients = new Map();

function addSseClient(taskId, res) {
  if (!sseClients.has(taskId)) sseClients.set(taskId, new Set());
  sseClients.get(taskId).add(res);
  res.on('close', () => sseClients.get(taskId)?.delete(res));
}

function sendSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

manager.on('task-event', (event) => {
  for (const res of sseClients.get(event.taskId) || []) {
    try { sendSse(res, event); } catch {}
  }
});

setInterval(() => {
  for (const clients of sseClients.values()) {
    for (const res of clients) {
      try { res.write(': heartbeat\n\n'); } catch {}
    }
  }
}, 15000).unref();

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function errorJson(res, status, error) {
  json(res, status, {
    error: error.message || String(error),
    code: error.code || 'INTERNAL_ERROR'
  });
}

async function readJson(req) {
  const maxBytes = Number(config.server?.maxBodyMb || 25) * 1024 * 1024;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(`Request body exceeds ${config.server?.maxBodyMb || 25} MB`);
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function lanAddresses(port) {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        out.push({ interface: name, ip: addr.address, url: `http://${addr.address}:${port}` });
      }
    }
  }
  return out;
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[ext] || 'application/octet-stream';
}

async function serveStatic(urlPath, res) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(webDir, relative);
  if (!target.startsWith(path.resolve(webDir) + path.sep) && target !== path.join(path.resolve(webDir), 'index.html')) {
    return false;
  }
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, { 'content-type': contentType(target), 'cache-control': 'no-cache' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function listArtifacts(taskId) {
  const dir = path.join(store.taskDir(taskId), 'artifacts');
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { status: 'ok' });
    }

    if (req.method === 'GET' && pathname === '/api/info') {
      return json(res, 200, {
        name: 'TaskBridge MVP',
        version: '0.1.0',
        addresses: lanAddresses(Number(config.server?.port || 8787))
      });
    }

    if (req.method === 'GET' && pathname === '/api/projects') {
      return json(res, 200, manager.listProjects());
    }

    if (req.method === 'GET' && pathname === '/api/tasks') {
      return json(res, 200, manager.listTasks());
    }

    if (req.method === 'POST' && pathname === '/api/tasks') {
      const body = await readJson(req);
      const task = await manager.createTask(body);
      return json(res, 202, task);
    }

    let match = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      const task = manager.getTask(match[1]);
      return task ? json(res, 200, task) : errorJson(res, 404, Object.assign(new Error('Task not found'), { code: 'NOT_FOUND' }));
    }
    if (req.method === 'DELETE' && match) {
      await manager.deleteTask(match[1]);
      return json(res, 200, { ok: true });
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/events$/);
    if (req.method === 'GET' && match) {
      return json(res, 200, await store.readEvents(match[1], Number(url.searchParams.get('limit') || 500)));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/stream$/);
    if (req.method === 'GET' && match) {
      const task = manager.getTask(match[1]);
      if (!task) return errorJson(res, 404, Object.assign(new Error('Task not found'), { code: 'NOT_FOUND' }));
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 1500\n\n');
      const history = await store.readEvents(match[1], 100);
      for (const event of history) sendSse(res, event);
      addSseClient(match[1], res);
      return;
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/state$/);
    if (req.method === 'GET' && match) {
      return json(res, 200, { state: await manager.state(match[1]) });
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && match) {
      return json(res, 200, await manager.cancel(match[1]));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/message$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.message(match[1], body.text, body.mode || 'auto', body.files || []));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/auto-compaction$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.setAutoCompaction(match[1], body.enabled));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/compact$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, { result: await manager.compact(match[1], body.instructions || '') });
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts$/);
    if (req.method === 'GET' && match) {
      return json(res, 200, await listArtifacts(match[1]));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      const name = path.basename(match[2]);
      const target = path.join(store.taskDir(match[1]), 'artifacts', name);
      try {
        const data = await fs.readFile(target);
        res.writeHead(200, {
          'content-type': contentType(target),
          'content-disposition': `inline; filename="${name.replaceAll('"', '')}"`
        });
        res.end(data);
      } catch {
        errorJson(res, 404, Object.assign(new Error('Artifact not found'), { code: 'NOT_FOUND' }));
      }
      return;
    }

    if (req.method === 'GET' && await serveStatic(pathname, res)) return;
    errorJson(res, 404, Object.assign(new Error('Not found'), { code: 'NOT_FOUND' }));
  } catch (error) {
    console.error(error);
    const status = error.code === 'BODY_TOO_LARGE' ? 413
      : ['INPUT_INVALID', 'PROJECT_DIRTY'].includes(error.code) ? 400
      : error.code === 'BUSY' ? 409
      : error.code === 'NOT_FOUND' ? 404
      : 500;
    errorJson(res, status, error);
  }
});

const host = config.server?.host || '0.0.0.0';
const port = Number(config.server?.port || 8787);
server.listen(port, host, () => {
  console.log(`\nTaskBridge MVP listening on ${host}:${port}`);
  console.log(`Local: http://127.0.0.1:${port}`);
  for (const item of lanAddresses(port)) console.log(`LAN (${item.interface}): ${item.url}`);
  console.log('\nNo login/auth is enabled in this PoC. Use only on a trusted private LAN.\n');
});
