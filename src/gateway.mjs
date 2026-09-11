#!/usr/bin/env node
// Gateway process (TZ step 5, P-3): HTTP/SSE front that owns no agent state.
//
// Serves the static web app and translates client calls into commands to the
// AgentHost over the IPC transport. The host owns the TaskManager, the Pi
// processes, the store, the instance lock and (eventually) the cloud
// connector, so this gateway can be killed and restarted without disturbing
// the agent — which is exactly the property "step 5" is after.
//
// Default `npm start` is unaffected: the legacy monolith (src/server.mjs)
// stays the working default and rollback until a gateway has proven itself
// against a real host. To exercise the split by hand:
//   node src/host.mjs                                (terminal 1; prints port)
//   HOST_PORT=<port> node src/gateway.mjs             (terminal 2)
//
// Data and IPC-token paths can be overridden with TASKBRIDGE_DATA_DIR (useful
// for tests and for pointing at a non-default data root).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GatewayClient, readToken } from './ipc.mjs';
import { loadConfig } from './config.mjs';
import { multipartBoundary } from './multipart.mjs';
import { UploadStore } from './uploads.mjs';
import { trimStreamingDeltas } from './event-trim.mjs';
import { windowByTurns } from './event-window.mjs';

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB_DIR = path.join(ROOT_DIR, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function errorJson(res, status, error) {
  json(res, status, { error: error?.message || String(error), code: error?.code || 'INTERNAL_ERROR' });
}

function notFound(res) { errorJson(res, 404, Object.assign(new Error('Not found'), { code: 'NOT_FOUND' })); }

// --- static ---------------------------------------------------------------

function serveStatic(webDir, req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (/^\/session\//.test(rel)) rel = '/index.html';
  const file = path.join(webDir, rel);
  if (!file.startsWith(path.resolve(webDir))) return notFound(res);
  let body;
  try { body = fs.readFileSync(file); } catch { return notFound(res); }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'max-age=3600',
    'content-length': body.length,
  });
  res.end(body);
}

// --- gateway ---------------------------------------------------------------

// `options` (all optional except config):
//   dataRoot, rootDir, hostPort, port, tokenFile, store.
// Returns { server, baseUrl, agent, close } once connected and listening.
export async function createGateway({ config, rootDir = ROOT_DIR, webDir = WEB_DIR, dataRoot = path.join(ROOT_DIR, 'data'), hostPort, port, tokenFile = path.join(path.join(ROOT_DIR, 'data'), 'host-ipc.json'), maxEvents = 20000 }) {
  // The gateway writes uploads straight to the shared data root (uploads are
  // files on disk, not task state), so binary never crosses the IPC; the host
  // resolves the staged files by token from the same directory.
  const uploadMb = Number(config.server?.maxUploadMb || 0);
  const uploads = new UploadStore(dataRoot, uploadMb > 0
    ? { maxFileBytes: uploadMb * 1024 * 1024, maxTotalBytes: uploadMb * 2 * 1024 * 1024 }
    : {});

  const token = readToken(tokenFile);
  if (!token) throw new Error(`no IPC token at ${tokenFile} — start the host first`);

  const agent = new GatewayClient({ host: '127.0.0.1', port: hostPort, token, reconnect: true });

  const sseClients = new Map();
  function addSseClient(taskId, res, cursor) {
    const client = { res, cursor, pending: [], replaying: true };
    if (!sseClients.has(taskId)) sseClients.set(taskId, new Set());
    sseClients.get(taskId).add(client);
    res.on('close', () => sseClients.get(taskId)?.delete(client));
    return client;
  }
  function sendSse(res, event) { res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`); }
  function deliver(client, event) {
    if (event.seq <= client.cursor) return;
    sendSse(client.res, event);
    client.cursor = event.seq;
  }

  agent.on('event', (type, data) => {
    if (type !== 'task-event' || !data?.taskId) return;
    for (const client of sseClients.get(data.taskId) || []) {
      if (client.replaying) client.pending.push(data);
      else try { deliver(client, data); } catch {}
    }
  });

  async function handleStream(res, id, after) {
    if (!Number.isSafeInteger(after) || after < 0) throw Object.assign(new Error('Invalid event cursor'), { code: 'INPUT_INVALID' });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    const client = addSseClient(id, res, after);
    try {
      const events = await agent.request('events', { id, count: maxEvents, after });
      for (const event of events) deliver(client, event);
      for (const event of client.pending.sort((a, b) => a.seq - b.seq)) deliver(client, event);
      client.pending = [];
      client.replaying = false;
    } catch { res.end(); }
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { return errorJson(res, 400, new Error('Bad request')); }
    const pathname = decodeURIComponent(url.pathname);
    const q = url.searchParams;
    const method = req.method;
    const ok = (data) => json(res, 200, data);

    const readBody = async () => {
      const maxBytes = Number(config.server?.maxBodyMb || 25) * 1024 * 1024;
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) { const e = new Error('body too large'); e.code = 'BODY_TOO_LARGE'; throw e; }
        chunks.push(chunk);
      }
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    };

    try {
      if (method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(webDir, req, res, pathname);

      if (method === 'GET' && pathname === '/api/info') return ok({ build: { version: 'gateway' }, cloud: { enabled: false } });
      if (method === 'GET' && pathname === '/api/projects') return ok(await agent.request('listProjects'));
      if (method === 'GET' && pathname === '/api/tasks') return ok(await agent.request('listTasks'));
      if (method === 'POST' && pathname === '/api/tasks') return json(res, 201, await agent.request('createTask', { input: await readBody() }));
      if (method === 'POST' && pathname === '/api/tasks/from-session') return json(res, 201, await agent.request('importSession', { input: await readBody() }));
      if (method === 'POST' && pathname === '/api/uploads') {
        const boundary = multipartBoundary(req.headers['content-type']);
        if (!boundary) throw Object.assign(new Error('Ожидается multipart/form-data с boundary.'), { code: 'INPUT_INVALID' });
        const token = uploads.newToken();
        return json(res, 201, await uploads.receive(req, boundary, token));
      }

      const taskPath = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
      if (taskPath) {
        const id = taskPath[1];
        const a1 = taskPath[2];
        const a2 = taskPath[3];

        if (method === 'GET' && !a1) return ok(await agent.request('getTask', { id }));
        if (method === 'PATCH' && !a1) return ok(await agent.request('renameTask', { id, title: (await readBody()).title }));
        if (method === 'DELETE' && !a1) return ok(await agent.request('deleteTask', { id }));

        if (method === 'GET') {
          if (a1 === 'events' && !a2) {
            if (!(await agent.request('getTask', { id }))) { notFound(res); return; }
            const after = Number(q.get('after') ?? 0);
            if (!Number.isSafeInteger(after) || after < 0) throw Object.assign(new Error('Invalid event cursor'), { code: 'INPUT_INVALID' });
            const requested = q.has('limit') ? Number(q.get('limit')) : 500;
            if (!Number.isSafeInteger(requested) || requested < 0) throw Object.assign(new Error('Invalid event limit'), { code: 'INPUT_INVALID' });
            const limit = requested === 0 ? maxEvents : Math.min(requested, maxEvents);
            const events = trimStreamingDeltas(await agent.request('events', { id, count: limit, after }));
            // tail: turn-aligned windowing for paginated history load; without
            // it return the bare array exactly like the monolith.
            if (q.has('tail')) {
              const tail = Number(q.get('tail'));
              const before = q.has('before') ? Number(q.get('before')) : null;
              if (!Number.isSafeInteger(tail) || tail <= 0) throw Object.assign(new Error('Invalid tail count'), { code: 'INPUT_INVALID' });
              if (before != null && (!Number.isSafeInteger(before) || before < 0)) throw Object.assign(new Error('Invalid before cursor'), { code: 'INPUT_INVALID' });
              return ok(windowByTurns(events, tail, before));
            }
            return ok(events);
          }
          if (a1 === 'state' && !a2) return ok({ state: await agent.request('state', { id }) });
          if (a1 === 'stream' && !a2) return handleStream(res, id, Number(req.headers['last-event-id'] || q.get('after') || 0));
          if (a1 === 'approvals' && !a2) return ok(await agent.request('listApprovals', { id }));
          return notFound(res);
        }

        if (method === 'POST' && a1 === 'message' && !a2) {
          const b = await readBody();
          return ok(await agent.request('message', { id, text: b.text, mode: b.mode, files: b.files || [], uploadToken: b.uploadToken, now: b.now === true, queue: b.queue === true }));
        }
        if (method === 'POST' && a1 === 'cancel') return ok(await agent.request('cancel', { id }));
        if (method === 'POST' && a1 === 'compact') return ok(await agent.request('compact', { id, instructions: (await readBody()).instructions }));
        if (method === 'POST' && a1 === 'apply') return ok(await agent.request('applyTask', { id, force: (await readBody()).force === true }));
        if (method === 'POST' && a1 === 'model' && !a2) { const b = await readBody(); return ok(await agent.request('setModel', { id, provider: b.provider, modelId: b.modelId ?? b.id })); }
        if (method === 'POST' && a1 === 'thinking' && !a2) return ok(await agent.request('setThinking', { id, level: (await readBody()).level }));
        if (method === 'POST' && a1 === 'auto-compaction' && !a2) return ok(await agent.request('setAutoCompaction', { id, enabled: (await readBody()).enabled === true }));
        if (method === 'POST' && a1 === 'pending' && a2 === 'send') return ok(await agent.request('sendPendingNow', { id }));
        if (method === 'DELETE' && a1 === 'pending' && !a2) return ok(await agent.request('dropPending', { id }));
        if (method === 'POST' && a1 === 'approvals' && a2) return ok(await agent.request('resolveApproval', { id, approvalId: a2, decision: await readBody() }));
        if (method === 'DELETE' && a1 === 'worktree' && !a2) return ok(await agent.request('cleanupWorktree', { id }));
        return notFound(res);
      }

      notFound(res);
    } catch (error) {
      errorJson(res, 500, error);
    }
  });

  const heartbeat = setInterval(() => {
    for (const clients of sseClients.values()) {
      for (const client of clients) { try { client.res.write(': heartbeat\n\n'); } catch {} }
    }
  }, 15000);
  heartbeat.unref?.();

  await agent.connect();
  agent.subscribe();

  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const bound = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address());
    });
  });

  async function close() {
    clearInterval(heartbeat);
    try { agent.close(); } catch {}
    // Force SSE/responses closed so server.close resolves even with an
    // operator's tab still mid-stream on shutdown.
    for (const socket of sockets) { try { socket.destroy(); } catch {} }
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, port: bound.port, baseUrl: `http://127.0.0.1:${bound.port}`, agent, close };
}

// --- CLI main (only when run directly) --------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootDir = ROOT_DIR;
  const dataRoot = process.env.TASKBRIDGE_DATA_DIR ? path.resolve(process.env.TASKBRIDGE_DATA_DIR) : path.join(rootDir, 'data');
  const config = await loadConfig(rootDir);
  const hostPort = Number(process.env.HOST_PORT) > 0 ? Number(process.env.HOST_PORT) : (config.server?.port || 8787);
  const port = Number(process.env.GATEWAY_PORT) > 0 ? Number(process.env.GATEWAY_PORT) : (config.server?.port || 8787);
  const gateway = await createGateway({ config, rootDir, dataRoot, hostPort, port, tokenFile: path.join(dataRoot, 'host-ipc.json') })
    .catch((error) => { console.error(`[Gateway] ${error.message}`); process.exit(1); });
  console.log(`[Gateway] listening on ${gateway.baseUrl}; host ${hostPort}`);
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    console.log('[Gateway] shutting down …');
    await gateway.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
