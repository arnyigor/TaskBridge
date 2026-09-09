import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { TaskStore } from './task-store.mjs';
import { TaskManager } from './task-manager.mjs';
import { AccessControl } from './auth.mjs';
import { contentType, containedFile, serveFile, FILE_LIMITS } from './files.mjs';
import { RuntimeControl } from './runtime-control.mjs';

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
const access = new AccessControl(config.server?.auth, dataRoot);
await access.init();
const runtimeControl = new RuntimeControl(manager.runtimeManager, manager);

const sseClients = new Map();

function addSseClient(taskId, res, cursor = 0) {
  const client = { res, cursor, pending: [], replaying: true };
  if (!sseClients.has(taskId)) sseClients.set(taskId, new Set());
  sseClients.get(taskId).add(client);
  res.on('close', () => sseClients.get(taskId)?.delete(client));
  return client;
}

function sendSse(res, event) {
  res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
}

function deliver(client, event) {
  if (event.seq <= client.cursor) return;
  sendSse(client.res, event);
  client.cursor = event.seq;
}

manager.on('task-event', (event) => {
  for (const client of sseClients.get(event.taskId) || []) {
    if (client.replaying) client.pending.push(event);
    else try { deliver(client, event); } catch {}
  }
});

setInterval(() => {
  for (const clients of sseClients.values()) {
    for (const client of clients) {
      try { client.res.write(': heartbeat\n\n'); } catch {}
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
  try {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const pathname = decodeURIComponent(url.pathname);
    access.checkOrigin(req);
    if (req.method === 'GET' && pathname === '/api/auth') return json(res, 200, { authenticated: access.authenticated(req), enabled: access.enabled, local: access.local(req) });
    if (req.method === 'POST' && pathname === '/api/auth/pair') {
      const body = await readJson(req);
      access.pair(req, res, body.code);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/auth/pairing') {
      if (!access.enabled || !access.local(req)) return errorJson(res, 403, new Error('Код доступен только на компьютере через localhost.'));
      return json(res, 200, access.pairing());
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { status: 'ok' });
    }
    if (pathname.startsWith('/api/')) access.require(req);

    if (req.method === 'GET' && pathname === '/api/runtime') return json(res, 200, await runtimeControl.status());
    if (req.method === 'POST' && pathname === '/api/runtime/start') {
      const { profileId } = await readJson(req);
      if (manager.activeTaskId || manager.admitting || manager.runtimeChanging) throw Object.assign(new Error('Дождитесь завершения текущей операции.'), { code: 'MODEL_BUSY' });
      manager.runtimeChanging = true;
      try { await manager.runtimeManager.ensureRunning(() => {}, profileId); }
      finally { manager.runtimeChanging = false; }
      return json(res, 200, await runtimeControl.status());
    }
    if (req.method === 'POST' && pathname === '/api/runtime/restart') {
      const { profileId } = await readJson(req);
      await runtimeControl.restart(profileId);
      return json(res, 200, await runtimeControl.status());
    }

    if (req.method === 'GET' && pathname === '/api/info') {
      const [busy, modelReady] = await Promise.all([manager.runtimeManager.getBusyStatus(), manager.runtimeManager.isReady()]);
      return json(res, 200, {
        name: 'TaskBridge MVP',
        version: '0.1.0',
        addresses: lanAddresses(Number(config.server?.port || 8787)),
        modelBusy: busy.unknown ? null : busy.busy,
        modelReady,
        fileLimits: FILE_LIMITS
      });
    }

    if (req.method === 'GET' && pathname === '/api/projects') {
      return json(res, 200, manager.listProjects());
    }

    const sessionsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/pi-sessions$/);
    if (req.method === 'GET' && sessionsMatch) return json(res, 200, await manager.nativeSessions.list(sessionsMatch[1]));
    if (req.method === 'POST' && pathname === '/api/tasks/from-session') return json(res, 201, await manager.importSession(await readJson(req)));

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
    if (req.method === 'PATCH' && match) return json(res, 200, await manager.renameTask(match[1], (await readJson(req)).title));

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/events$/);
    if (req.method === 'GET' && match) {
      if (!manager.getTask(match[1])) return errorJson(res, 404, Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' }));
      return json(res, 200, await store.readEvents(match[1], Number(url.searchParams.get('limit') ?? 500), Number(url.searchParams.get('after') ?? 0)));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/stream$/);
    if (req.method === 'GET' && match) {
      const task = manager.getTask(match[1]);
      if (!task) return errorJson(res, 404, Object.assign(new Error('Task not found'), { code: 'NOT_FOUND' }));
      const after = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
      if (!Number.isSafeInteger(after) || after < 0) throw Object.assign(new Error('Invalid event cursor'), { code: 'INPUT_INVALID' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 1500\n\n');
      // Register before reading disk: concurrent live events are buffered until
      // replay is complete, closing the gap between history and subscription.
      const client = addSseClient(match[1], res, after);
      try {
        const history = await store.readEvents(match[1], 0, after);
        for (const event of history) deliver(client, event);
        for (const event of client.pending.sort((a, b) => a.seq - b.seq)) deliver(client, event);
        client.pending = [];
        client.replaying = false;
      } catch { res.end(); }
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

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/files(?:\/([a-f0-9-]{36}))?$/);
    if (['GET', 'HEAD'].includes(req.method) && match) {
      const task = manager.getTask(match[1]);
      if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const files = [...(task.attachments || []), ...(task.outputFiles || [])];
      if (!match[2]) return json(res, 200, files);
      const file = files.find(f => f.id === match[2]);
      if (!file) throw Object.assign(new Error('Файл не найден.'), { code: 'NOT_FOUND' });
      const target = await containedFile(path.join(store.taskDir(task.id), 'files'), file.id, { allowPrivate: true });
      await serveFile(req, res, target, file.name, url.searchParams.get('download') === '1');
      return;
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts\/([^/]+)$/);
    if (['GET', 'HEAD'].includes(req.method) && match) {
      if (!manager.getTask(match[1])) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const name = path.basename(match[2]);
      const target = await containedFile(path.join(store.taskDir(match[1]), 'artifacts'), name);
      await serveFile(req, res, target, name, url.searchParams.get('download') === '1');
      return;
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/workspace-file$/);
    if (['GET', 'HEAD'].includes(req.method) && match) {
      const task = manager.getTask(match[1]);
      if (!task?.workspacePath) throw Object.assign(new Error('Рабочая папка не найдена.'), { code: 'NOT_FOUND' });
      const target = await containedFile(task.workspacePath, String(url.searchParams.get('path') || ''));
      await serveFile(req, res, target, path.basename(target), url.searchParams.get('download') === '1');
      return;
    }

    if (req.method === 'GET' && await serveStatic(pathname, res)) return;
    errorJson(res, 404, Object.assign(new Error('Not found'), { code: 'NOT_FOUND' }));
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    console.error(error.message);
    const status = error.code === 'BODY_TOO_LARGE' ? 413
      : ['INPUT_INVALID', 'PROJECT_DIRTY'].includes(error.code) ? 400
      : ['BUSY', 'MODEL_BUSY', 'SESSION_UNAVAILABLE'].includes(error.code) ? 409
      : error.code === 'AUTH_REQUIRED' ? 401
      : ['FILE_FORBIDDEN', 'ORIGIN_FORBIDDEN'].includes(error.code) ? 403
      : error.code === 'RATE_LIMITED' ? 429
      : ['NOT_FOUND', 'ENOENT'].includes(error.code) ? 404
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
  console.log(access.enabled ? '\nPairing enabled. Open localhost and click «Подключить телефон» for a code.\n' : '\nPairing disabled by configuration.\n');
});
