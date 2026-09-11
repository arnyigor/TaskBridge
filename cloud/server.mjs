import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore, resolveStoreTarget } from './lib/store.mjs';
import { CloudAuth, loadAuthConfig } from './lib/auth.mjs';
import { createRouter } from './lib/router.mjs';
import { errorBody } from './lib/errors.mjs';

// Local/self-hosted host for the cloud control plane. Vercel uses
// cloud/api/index.mjs instead; both share cloud/lib/router.mjs so the API
// contract cannot drift between them.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// One UI for both realities (docs/cloud-ui.md): this dev host serves the very
// same web/ that the machine serves and that Vercel deploys (outputDirectory in
// vercel.json), so the cloud copy cannot drift from the local one.
const webDir = path.resolve(__dirname, '..', 'web');

const PORT = Number(process.env.CLOUD_PORT || 8788);
const HOST = process.env.CLOUD_HOST || '0.0.0.0';
// Explicit CLOUD_STORE wins; otherwise a configured Postgres URL is used, and
// a local run falls back to SQLite (a serverless deployment must not).
const STORE_TARGET = process.env.CLOUD_STORE
  || (resolveStoreTarget(process.env) !== 'memory:'
    ? resolveStoreTarget(process.env)
    : `sqlite:${path.join(__dirname, 'data', 'taskbridge-cloud.db')}`);

function log(level, entry) {
  const line = JSON.stringify({ level, at: new Date().toISOString(), ...entry });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

async function readBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw Object.assign(new Error('Body too large'), { code: 'INPUT_INVALID' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function createCloudService({ storeTarget = STORE_TARGET, env = process.env, logger = log } = {}) {
  const store = await openStore(storeTarget);
  const auth = new CloudAuth(loadAuthConfig(env));
  const router = createRouter({ store, auth, logger, offlineAfterMs: Number(env.CLOUD_MACHINE_OFFLINE_MS || 60000) });
  return { store, auth, router, logger };
}

async function serveStatic(urlPath, res) {
  let relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  // A session address is the app shell itself (vercel.json rewrites it too):
  // a reload or a bookmark must land on the same conversation.
  if (relative === 'session' || relative.startsWith('session/')) relative = 'index.html';
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';
  const target = path.resolve(webDir, relative);
  if (!target.startsWith(path.resolve(webDir) + path.sep)) return false;
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(target)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export async function startServer({ port = PORT, host = HOST, storeTarget = STORE_TARGET, env = process.env, logger = log } = {}) {
  const service = await createCloudService({ storeTarget, env, logger });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/tasks/stream') {
        return handleStream(req, res, url, service);
      }
      if (url.pathname.startsWith('/api/')) {
        const rawBody = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : '';
        let body = {};
        if (rawBody) {
          try { body = JSON.parse(rawBody); }
          catch { const { status, body: payload } = errorBody(Object.assign(new Error('Invalid JSON body'), { code: 'INPUT_INVALID' })); res.writeHead(status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(payload)); }
        }
        const result = await service.router.handle({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: req.headers,
          body,
          rawBody
        });
        const text = JSON.stringify(result.body, null, 2);
        res.writeHead(result.status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(text)
        });
        return res.end(text);
      }
      if (await serveStatic(url.pathname, res)) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found', details: {} } }));
    } catch (error) {
      const { status, body } = errorBody(error);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    }
  });

  // Retention (§70): completed task metadata and old events are pruned on a
  // schedule; large tool logs never leave the machine in the first place.
  const retentionTimer = setInterval(() => {
    service.store.prune(service.router.retention)
      .then(result => { if (result.tasks || result.events) logger('info', { component: 'CloudServer', event: 'retention_pruned', ...result }); })
      .catch(() => {});
  }, 6 * 60 * 60 * 1000);
  retentionTimer.unref?.();

  await new Promise(resolve => server.listen(port, host, resolve));
  logger('info', { component: 'CloudServer', event: 'listening', host, port, store: storeTarget });

  return {
    server,
    service,
    port: server.address().port,
    close: async () => {
      clearInterval(retentionTimer);
      await new Promise(resolve => server.close(resolve));
      await service.store.checkpoint?.().catch?.(() => {});
      await service.store.close();
    }
  };
}

// SSE is a latency optimization on top of polling (§40, §41). The client still
// tracks lastReceivedSeq and re-fetches on reconnect, so a dropped stream can
// never lose output.
function handleStream(req, res, url, service) {
  const taskId = url.searchParams.get('taskId') || '';
  const token = url.searchParams.get('token') || '';
  const after = Number(url.searchParams.get('after') || 0);
  let user;
  try {
    user = service.auth.requireUser({ authorization: `Bearer ${token}` });
  } catch {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid token', details: {} } }));
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write('retry: 2000\n\n');

  let cursor = Number.isSafeInteger(after) && after > 0 ? after : 0;
  let closed = false;
  res.on('close', () => { closed = true; });

  const tick = async () => {
    if (closed) return;
    try {
      const task = await service.store.getTask(taskId);
      if (!task || (task.ownerId && task.ownerId !== user.id)) { res.write('event: error\ndata: {"code":"TASK_NOT_FOUND"}\n\n'); res.end(); closed = true; return; }
      const events = await service.store.listEvents(taskId, { after: cursor, limit: 500 });
      for (const event of events) {
        if (event.seq <= cursor) continue;
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = Number(event.seq);
      }
      res.write(': ping\n\n');
    } catch { /* next tick retries */ }
    if (!closed) setTimeout(tick, 1000).unref?.();
  };
  tick();
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  startServer().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
