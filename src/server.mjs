import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from './config.mjs';
import { listDirectory, resolveBrowsablePath } from './project-browser.mjs';
import { TaskStore } from './task-store.mjs';
import { TaskManager } from './task-manager.mjs';
import { AccessControl } from './auth.mjs';
import { contentType, containedFile, serveFile, FILE_LIMITS } from './files.mjs';
import { RuntimeControl } from './runtime-control.mjs';
import { ensureTlsCert } from './tls.mjs';
import { trimStreamingDeltas } from './event-trim.mjs';
import { windowByTurns } from './event-window.mjs';
import { multipartBoundary } from './multipart.mjs';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const webDir = path.join(rootDir, 'web');
const dataRoot = path.join(rootDir, 'data');

// Identifies exactly which build/commit this running process was started
// from, so a stale-vs-fresh deploy is visible in the UI instead of guessed
// at. version is the human-facing number (bumped by hand per release); the
// commit is extra detail for debugging which exact code that number maps to.
const build = await (async () => {
  const version = await fs.readFile(path.join(rootDir, 'package.json'), 'utf8').then(text => JSON.parse(text).version, () => null);
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%h %cI'], { cwd: rootDir, windowsHide: true });
    const [commit, date] = stdout.trim().split(' ');
    return { version, commit: commit || null, date: date || null };
  } catch {
    return { version, commit: null, date: null };
  }
})();

const config = await loadConfig(rootDir);
await fs.mkdir(dataRoot, { recursive: true });
const store = new TaskStore(dataRoot);
const manager = new TaskManager(config, dataRoot, store);
await manager.init();

// Checkpoint and close SQLite cleanly on Ctrl+C instead of leaving a WAL tail.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { try { store.close(); } catch {} process.exit(0); });
}
const access = new AccessControl(config.server?.auth, dataRoot);
await access.init();
const runtimeControl = new RuntimeControl(manager.runtimeManager, manager);
// AUTO dispatcher switches the managed model profile by restarting the runtime.
manager.runtimeSwitcher = profileId => runtimeControl.restart(profileId);
const httpsConfig = config.server?.https || {};

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

// Abandoned uploads are only referenced by a token the client may never use.
setInterval(() => manager.uploads.cleanup().catch(() => {}), 30 * 60 * 1000).unref();

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

function uniqueProjectId(manager, name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
  let id = base;
  for (let n = 2; manager.projects.has(id); n++) id = `${base}-${n}`;
  return id;
}

function lanAddresses(port, scheme = 'http') {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        out.push({ interface: name, ip: addr.address, url: `${scheme}://${addr.address}:${port}` });
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

async function handleRequest(req, res) {
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
      const [busy, modelReady, engine] = await Promise.all([manager.runtimeManager.getBusyStatus(), manager.runtimeManager.isReady(), manager.runtimeManager.getEngineInfo()]);
      return json(res, 200, {
        name: 'TaskBridge MVP',
        build,
        addresses: [
          ...lanAddresses(Number(config.server?.port || 8787)),
          ...(httpsConfig.enabled ? lanAddresses(Number(httpsConfig.port || 8443), 'https') : [])
        ],
        modelBusy: busy.unknown ? null : busy.busy,
        modelReady,
        engine,
        fileLimits: FILE_LIMITS
      });
    }

    if (req.method === 'GET' && pathname === '/api/projects') {
      return json(res, 200, manager.listProjects());
    }

    if (req.method === 'POST' && pathname === '/api/uploads') {
      const boundary = multipartBoundary(req.headers['content-type']);
      if (!boundary) throw Object.assign(new Error('Ожидается multipart/form-data с boundary.'), { code: 'INPUT_INVALID' });
      const token = manager.uploads.newToken();
      return json(res, 201, await manager.uploads.receive(req, boundary, token));
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (req.method === 'DELETE' && projectMatch) {
      manager.removeProject(projectMatch[1]);
      await saveConfig(rootDir, config);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/project-browser') {
      return json(res, 200, await listDirectory(config, url.searchParams.get('path')));
    }
    if (req.method === 'POST' && pathname === '/api/project-browser/register') {
      const body = await readJson(req);
      const resolved = await resolveBrowsablePath(config, body.path);
      const name = String(body.name || path.basename(resolved)).trim().slice(0, 120) || path.basename(resolved);
      const id = uniqueProjectId(manager, name);
      const project = { id, name, path: resolved, useWorktree: false, verification: [] };
      manager.registerProject(project);
      await saveConfig(rootDir, config);
      return json(res, 201, manager.listProjects().find(p => p.id === id));
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
      const after = Number(url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw Object.assign(new Error('Invalid event cursor'), { code: 'INPUT_INVALID' });
      const events = trimStreamingDeltas(await store.readEvents(match[1], 0, after));
      // tail: turn-aligned windowing for paginated history load (see
      // event-window.mjs). Without it, behaves exactly as before — full or
      // limit-sliced history, always used by refreshTask()'s small
      // after-cursor catch-up polls, which don't need windowing.
      if (url.searchParams.has('tail')) {
        const tail = Number(url.searchParams.get('tail'));
        const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null;
        if (!Number.isSafeInteger(tail) || tail <= 0) throw Object.assign(new Error('Invalid tail count'), { code: 'INPUT_INVALID' });
        if (before != null && (!Number.isSafeInteger(before) || before < 0)) throw Object.assign(new Error('Invalid before cursor'), { code: 'INPUT_INVALID' });
        return json(res, 200, windowByTurns(events, tail, before));
      }
      const limit = Number(url.searchParams.get('limit') ?? 500);
      return json(res, 200, limit ? events.slice(-limit) : events);
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
      return json(res, 200, await manager.message(match[1], body.text, body.mode || 'auto', body.files || [], body.uploadToken));
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

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/apply$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req).catch(() => ({}));
      return json(res, 200, await manager.applyTask(match[1], { force: body.force === true }));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/worktree$/);
    if (req.method === 'DELETE' && match) return json(res, 200, await manager.cleanupWorktree(match[1]));

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
      : ['INPUT_INVALID', 'PROJECT_DIRTY', 'NOT_CONFIGURED'].includes(error.code) ? 400
      : ['BUSY', 'MODEL_BUSY', 'SESSION_UNAVAILABLE', 'SOURCE_MOVED', 'NOTHING_TO_APPLY'].includes(error.code) ? 409
      : error.code === 'AUTH_REQUIRED' ? 401
      : ['FILE_FORBIDDEN', 'ORIGIN_FORBIDDEN'].includes(error.code) ? 403
      : error.code === 'RATE_LIMITED' ? 429
      : ['NOT_FOUND', 'ENOENT'].includes(error.code) ? 404
      : 500;
    errorJson(res, status, error);
  }
}

const host = config.server?.host || '0.0.0.0';
const port = Number(config.server?.port || 8787);
const server = http.createServer(handleRequest);
server.listen(port, host, () => {
  console.log(`\nTaskBridge MVP listening on ${host}:${port}`);
  console.log(`Local: http://127.0.0.1:${port}`);
  for (const item of lanAddresses(port)) console.log(`LAN (${item.interface}): ${item.url}`);
  console.log(access.enabled ? '\nPairing enabled. Open localhost and click «Подключить телефон» for a code.\n' : '\nPairing disabled by configuration.\n');
});

if (httpsConfig.enabled) {
  const httpsPort = Number(httpsConfig.port || 8443);
  try {
    const { key, cert, certPath } = await ensureTlsCert(dataRoot);
    https.createServer({ key, cert }, handleRequest).listen(httpsPort, host, () => {
      console.log(`HTTPS listening on ${host}:${httpsPort} (self-signed cert: ${certPath})`);
      for (const item of lanAddresses(httpsPort, 'https')) console.log(`LAN HTTPS (${item.interface}): ${item.url}`);
      console.log('Self-signed certificate: the browser will warn "not secure" once per device until you accept it.\n');
    });
  } catch (error) {
    console.error(`HTTPS disabled: failed to prepare certificate (${error.message}). Is 'openssl' on PATH?`);
  }
}
