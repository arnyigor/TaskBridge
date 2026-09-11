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
import { acquireInstanceLock } from './instance-lock.mjs';
import { resolveCloudConfig, validateCloudConfig } from './cloud/cloud-config.mjs';
import { CloudWorker } from './cloud/cloud-worker.mjs';
import { CloudClient } from './cloud/cloud-client.mjs';
import { secretFingerprint } from './cloud/machine-auth.mjs';
import { issueDeviceToken, DEFAULT_DEVICE_TOKEN_TTL_MS } from './cloud/device-token.mjs';
import { TrustedDevices, newDeviceId } from './cloud/trusted-devices.mjs';
import { createRelayConnector } from './cloud/relay-connector.mjs';
import { PushCenter, notificationFor } from './push/push-center.mjs';
import { buildMachineHeartbeat } from './domain/machine-state.mjs';
import { readPiSettings, imagesBlocked } from './pi-settings.mjs';

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
let instanceLock;
try {
  instanceLock = acquireInstanceLock(dataRoot);
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}
process.on('exit', () => instanceLock.release());
const store = new TaskStore(dataRoot, {
  synchronous: config.server?.sqlite?.synchronous,
  busyTimeoutMs: config.server?.sqlite?.busyTimeoutMs
});
const manager = new TaskManager(config, dataRoot, store);
// The Pi approval extension needs a loopback endpoint and its absolute path.
manager.approvalBaseUrl = `http://127.0.0.1:${Number(config.server?.port || 8787)}`;
manager.approvalExtensionPath = path.join(rootDir, 'pi-extension', 'taskbridge-approval.js');
await manager.init();
// Router mode is meant to be always-on: the process is a cheap supervisor that
// only loads models on demand. Start it eagerly so the model picker and the UI
// can discover local models right away; a failure must not stop the server.
if (manager.localModels.enabled) {
  manager.startLocal().catch(error => console.error(`[TaskBridge] Router start failed: ${error.message}`));
}

// Checkpoint and close SQLite cleanly on Ctrl+C instead of leaving a WAL tail.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await cloudWorker?.stop(); } catch {}
    try { await relayConnector?.stop(); } catch {}
    try { store.close(); } catch {}
    process.exit(0);
  });
}
const access = new AccessControl(config.server?.auth, dataRoot);
await access.init();
const runtimeControl = new RuntimeControl(manager.runtimeManager, manager);
// AUTO dispatcher switches the managed model profile by restarting the runtime.
manager.runtimeSwitcher = profileId => runtimeControl.restart(profileId);
const httpsConfig = config.server?.https || {};

// Optional cloud control plane (§6, §11, §90). Local-only mode is the default
// and must keep working with no Vercel dependency at all.
let cloudConfig = resolveCloudConfig(config, process.env, { dataRoot });
let cloudCheck = validateCloudConfig(cloudConfig);
let cloudWorker = null;
let relayConnector = null;
// Which phones may reach this machine (pairing, § cloud-protocol.md). Revocation
// has to be enforced here: a device token is a stateless signature the relay
// cannot take back.
const trustedDevices = await new TrustedDevices(dataRoot).load();
// Web Push (§ notifications): the machine is its own application server, so a
// finished session reaches the phone even with the PWA closed — and the text is
// encrypted for that phone alone, with no cloud in the path.
const push = await new PushCenter(dataRoot).load();

// Resolves the effective cloud configuration from config.json + environment,
// validates it and (re)starts the worker. Used at boot and when the settings
// screen saves a new configuration (§91).
async function applyCloudConfig({ quiet = false } = {}) {
  if (cloudWorker) {
    await cloudWorker.stop().catch(() => {});
    cloudWorker = null;
  }
  if (relayConnector) {
    await relayConnector.stop().catch(() => {});
    relayConnector = null;
  }
  cloudConfig = resolveCloudConfig(config, process.env, { dataRoot });
  cloudCheck = validateCloudConfig(cloudConfig);
  if (!cloudConfig.enabled) return { enabled: false, problems: [] };
  if (!cloudCheck.ok) {
    console.error(`[TaskBridge] cloud transport disabled: ${cloudCheck.problems.join('; ')}`);
    return { enabled: false, problems: cloudCheck.problems };
  }
  const aliases = {};
  for (const project of config.projects || []) {
    const alias = String(project.id || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    if (alias && project.path) aliases[alias] = project.path;
  }
  cloudWorker = new CloudWorker({
    config: cloudConfig,
    manager,
    store,
    dataRoot,
    version: build.version,
    aliases
  });
  cloudWorker.start().catch((error) => {
    console.error(`[TaskBridge] cloud transport failed to start: ${error.message}`);
  });
  // The realtime path: the machine dials the relay itself, so the shared UI on a
  // phone reaches this API without an inbound port. Off by default — polling
  // through the cloud API stays authoritative until an operator turns it on.
  if (cloudConfig.realtime && cloudConfig.relayUrl) {
    relayConnector = createRelayConnector({
      url: cloudConfig.relayUrl,
      machineId: cloudConfig.machineId,
      machineSecret: cloudConfig.machineSecret,
      manager,
      dispatcher: cloudWorker.dispatcher,
      store,
      localApiBase: `http://127.0.0.1:${Number(config.server?.port || 8787)}`,
      // A revoked phone is refused here, frame by frame, and a live one keeps
      // its "last seen" fresh for the devices screen.
      isDeviceAllowed: (deviceId) => {
        if (!deviceId) return false;
        if (!trustedDevices.allowed(deviceId)) return false;
        trustedDevices.touch(deviceId);
        return true;
      }
    });
    relayConnector.start().catch((error) => {
      console.error(`[TaskBridge] relay connector failed to start: ${error.message}`);
    });
    if (!quiet) console.log(`[TaskBridge] relay: ${cloudConfig.relayUrl}`);
  }
  if (!quiet) console.log(`[TaskBridge] cloud transport enabled: ${cloudConfig.url} as ${cloudConfig.machineId}`);
  return { enabled: true, problems: [] };
}
await applyCloudConfig();

const sseClients = new Map();

// A single request must not materialize an unbounded history in memory. Older
// pages are reached with ?tail/?before; this is the hard ceiling per request.
const maxEventsPerRequest = Math.min(Math.max(Number(config.server?.maxEventsPerRequest || 20000), 1), 200000);

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
  // Only what an operator waits for (finished, failed, needs a confirmation).
  const notification = notificationFor(event, manager.getTask?.(event.taskId));
  if (notification) push.notify(notification).catch(() => {});
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
  const shell = path.join(path.resolve(webDir), 'index.html');
  if (!target.startsWith(path.resolve(webDir) + path.sep) && target !== shell) {
    return false;
  }
  const send = async (file) => {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-cache' });
    res.end(data);
    return true;
  };
  try {
    return await send(target);
  } catch {
    // Client routes such as /session/<id> are not files on disk: hand them the
    // SPA shell so a reload, a bookmark or a phone link opens the same session.
    // API callers keep their own JSON 404 instead of receiving HTML.
    if (urlPath !== '/' && !path.extname(urlPath) && !urlPath.startsWith('/api/')) {
      try { return await send(shell); } catch { return false; }
    }
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
    // --- cloud settings screen (§91) -----------------------------------------
    if (req.method === 'GET' && pathname === '/api/cloud/config') {
      const saved = config.cloud || {};
      const envLocked = ['TASKBRIDGE_CLOUD_ENABLED', 'TASKBRIDGE_CLOUD_URL', 'TASKBRIDGE_MACHINE_ID', 'TASKBRIDGE_MACHINE_SECRET']
        .filter(key => process.env[key]);
      return json(res, 200, {
        enabled: cloudConfig.enabled,
        url: cloudConfig.url,
        machineId: cloudConfig.machineId,
        machineDisplayName: cloudConfig.machineDisplayName || '',
        authMode: cloudConfig.authMode,
        hasSecret: Boolean(cloudConfig.machineSecret),
        secretFingerprint: cloudConfig.machineSecret ? secretFingerprint(cloudConfig.machineSecret) : null,
        realtime: cloudConfig.realtime,
        eventFlushMs: cloudConfig.eventFlushMs,
        eventBatchMax: cloudConfig.eventBatchMax,
        heartbeatSeconds: cloudConfig.heartbeatSeconds,
        idlePollSeconds: cloudConfig.idlePollSeconds,
        activePollSeconds: cloudConfig.activePollSeconds,
        maxOutboxMb: cloudConfig.maxOutboxMb,
        redactPaths: cloudConfig.redactPaths,
        protocolVersion: cloudConfig.protocolVersion,
        envLocked,
        saved: {
          enabled: Boolean(saved.enabled),
          url: saved.url || '',
          machineId: saved.machineId || '',
          machineDisplayName: saved.machineDisplayName || '',
          hasSecret: Boolean(saved.machineSecret)
        }
      });
    }

    if (req.method === 'POST' && pathname === '/api/cloud/config') {
      const body = await readJson(req);
      const next = { ...(config.cloud || {}) };
      if ('enabled' in body) next.enabled = Boolean(body.enabled);
      if ('url' in body) next.url = String(body.url || '').trim();
      if ('machineId' in body) next.machineId = String(body.machineId || '').trim();
      if ('machineDisplayName' in body) next.machineDisplayName = String(body.machineDisplayName || '').trim().slice(0, 120);
      if ('authMode' in body && ['bearer', 'hmac'].includes(String(body.authMode))) next.authMode = String(body.authMode);
      if ('redactPaths' in body) next.redactPaths = Boolean(body.redactPaths);
      if (body.machineSecret) next.machineSecret = String(body.machineSecret);
      if (body.clearSecret) delete next.machineSecret;

      // Validate the candidate *before* persisting, so a typo cannot leave the
      // machine with a cloud transport that never starts.
      const candidate = resolveCloudConfig({ ...config, cloud: next }, process.env, { dataRoot });
      const candidateCheck = validateCloudConfig(candidate);
      if (!candidateCheck.ok) {
        return errorJson(res, 400, Object.assign(new Error(candidateCheck.problems.join('; ')), { code: 'INPUT_INVALID' }));
      }
      config.cloud = next;
      await saveConfig(rootDir, config);
      const applied = await applyCloudConfig({ quiet: true });
      return json(res, 200, { ok: true, enabled: applied.enabled, machineId: cloudConfig.machineId, url: cloudConfig.url });
    }

    if (req.method === 'POST' && pathname === '/api/cloud/test') {
      const body = await readJson(req);
      const saved = config.cloud || {};
      const candidate = resolveCloudConfig({
        ...config,
        cloud: {
          ...saved,
          enabled: true,
          url: body.url ?? saved.url,
          machineId: body.machineId ?? saved.machineId,
          machineSecret: body.machineSecret || saved.machineSecret
        }
      }, process.env, { dataRoot });
      const candidateCheck = validateCloudConfig(candidate);
      if (!candidateCheck.ok) return json(res, 200, { ok: false, problems: candidateCheck.problems });
      const client = new CloudClient({
        baseUrl: candidate.url,
        machineId: candidate.machineId,
        machineSecret: candidate.machineSecret,
        authMode: candidate.authMode,
        protocolVersion: candidate.protocolVersion,
        timeoutMs: 10000
      });
      try {
        await client.heartbeat(buildMachineHeartbeat({
          machineId: candidate.machineId,
          displayName: candidate.machineDisplayName || null,
          version: build.version,
          status: 'ONLINE',
          protocolVersion: candidate.protocolVersion
        }));
        return json(res, 200, { ok: true, machineId: candidate.machineId, url: candidate.url });
      } catch (error) {
        return json(res, 200, { ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.message } });
      }
    }

    // --- web push (§ notifications) ------------------------------------------
    if (req.method === 'GET' && pathname === '/api/push/key') {
      access.require(req);
      // The public half only: the private key never leaves this machine.
      return json(res, 200, { publicKey: push.publicKey, subscriptions: push.list() });
    }

    if (req.method === 'POST' && pathname === '/api/push/subscribe') {
      access.require(req);
      const body = await readJson(req);
      try {
        const saved = await push.subscribe(body.subscription, { name: body.name, deviceId: body.deviceId || null });
        return json(res, 200, { ok: true, subscription: saved });
      } catch (error) {
        return errorJson(res, 400, error);
      }
    }

    if (req.method === 'POST' && pathname === '/api/push/unsubscribe') {
      access.require(req);
      const body = await readJson(req);
      return json(res, 200, { ok: await push.unsubscribe(body.endpoint) });
    }

    // A real notification through the real push service, so "почему не приходит"
    // is answered on the spot instead of at the next finished session.
    if (req.method === 'POST' && pathname === '/api/push/test') {
      access.require(req);
      const result = await push.notify({
        title: 'TaskBridge: проверка',
        body: 'Уведомления работают.',
        taskId: null,
        type: 'TEST',
        at: new Date().toISOString()
      });
      return json(res, 200, result);
    }

    // --- pairing a phone (§ pairing) -----------------------------------------
    // The QR is minted here, on the machine that owns the secret: it carries the
    // public address, this machine's id and a device token signed with the
    // machine secret. The token travels in the URL *fragment*, which a browser
    // never sends to a server — the cloud only ever sees /pair.
    if (req.method === 'POST' && pathname === '/api/cloud/pair') {
      access.require(req);
      // Minting a credential is a local act, like the LAN pairing code.
      if (access.enabled && !access.local(req)) return errorJson(res, 403, Object.assign(new Error('Подключить телефон можно только с самого компьютера.'), { code: 'FORBIDDEN' }));
      if (!cloudConfig.url || !cloudConfig.machineSecret) {
        return errorJson(res, 400, Object.assign(new Error('Сначала настройте облако: адрес и секрет машины.'), { code: 'INPUT_INVALID' }));
      }
      const body = await readJson(req).catch(() => ({}));
      const deviceId = newDeviceId();
      const expiresAt = Date.now() + DEFAULT_DEVICE_TOKEN_TTL_MS;
      const token = issueDeviceToken({ machineId: cloudConfig.machineId, deviceId, secret: cloudConfig.machineSecret });
      const device = await trustedDevices.add({
        deviceId,
        name: body.name,
        machineId: cloudConfig.machineId,
        expiresAt: new Date(expiresAt).toISOString()
      });
      const link = `${cloudConfig.url}/pair#m=${encodeURIComponent(cloudConfig.machineId)}&t=${encodeURIComponent(token)}&r=${encodeURIComponent(cloudConfig.relayUrl || '')}`;
      return json(res, 200, { device, url: link, expiresAt: device.expiresAt, machineId: cloudConfig.machineId });
    }

    if (req.method === 'GET' && pathname === '/api/cloud/devices') {
      access.require(req);
      // Never the tokens themselves: they exist only inside the QR, once.
      return json(res, 200, { devices: trustedDevices.list(), relayUrl: cloudConfig.relayUrl || '', realtime: Boolean(cloudConfig.realtime) });
    }

    {
      const match = pathname.match(/^\/api\/cloud\/devices\/([^/]+)$/);
      if (match && (req.method === 'DELETE' || req.method === 'POST')) {
        access.require(req);
        if (access.enabled && !access.local(req)) return errorJson(res, 403, Object.assign(new Error('Отзывать устройства можно только с компьютера.'), { code: 'FORBIDDEN' }));
        const deviceId = decodeURIComponent(match[1]);
        try {
          // POST revokes (the entry stays visible as revoked), DELETE forgets it.
          if (req.method === 'POST') return json(res, 200, { device: await trustedDevices.revoke(deviceId) });
          await trustedDevices.remove(deviceId);
          return json(res, 200, { ok: true });
        } catch (error) {
          return errorJson(res, error.code === 'NOT_FOUND' ? 404 : 400, error);
        }
      }
    }

    if (req.method === 'GET' && pathname === '/debug/cloud') {
      // Diagnostics only (§88). Never returns the machine secret.
      access.require(req);
      if (!cloudWorker) return json(res, 200, { enabled: false, reason: cloudCheck.ok ? 'Cloud transport is disabled by configuration.' : cloudCheck.problems });
      return json(res, 200, await cloudWorker.status());
    }

    if (req.method === 'GET' && pathname === '/api/metrics') {
      // Local metrics (§89). Prometheus text via ?format=prometheus.
      access.require(req);
      const prometheus = url.searchParams.get('format') === 'prometheus';
      if (!cloudWorker) {
        if (prometheus) {
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
          return res.end('# cloud transport disabled\n');
        }
        return json(res, 200, { enabled: false, metrics: null });
      }
      if (prometheus) {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(cloudWorker.metrics.toPrometheus());
      }
      return json(res, 200, { enabled: true, ...cloudWorker.metrics.snapshot() });
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { status: 'ok' });
    }

    // --- interactive tool approvals (§52–§55) --------------------------------
    // The Pi extension is a local process without a session cookie, so these two
    // endpoints authenticate with the per-task approval token instead. They are
    // handled before the cookie gate for exactly that reason.
    let approvalMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/approval$/);
    if (req.method === 'POST' && approvalMatch) {
      const taskId = approvalMatch[1];
      if (!manager.getTask(taskId)) return errorJson(res, 404, Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' }));
      if (!manager.checkApprovalToken(taskId, req.headers['x-taskbridge-approval'])) {
        return errorJson(res, 403, Object.assign(new Error('Invalid approval token'), { code: 'FORBIDDEN' }));
      }
      const body = await readJson(req);
      return json(res, 200, manager.beginApproval(taskId, body));
    }
    approvalMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/approval\/([^/]+)$/);
    if (req.method === 'GET' && approvalMatch) {
      const taskId = approvalMatch[1];
      if (!manager.checkApprovalToken(taskId, req.headers['x-taskbridge-approval'])) {
        return errorJson(res, 403, Object.assign(new Error('Invalid approval token'), { code: 'FORBIDDEN' }));
      }
      const state = manager.approvalStatus(taskId, approvalMatch[2]);
      return state
        ? json(res, 200, state)
        : errorJson(res, 404, Object.assign(new Error('Approval not found'), { code: 'NOT_FOUND' }));
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

    if (req.method === 'GET' && pathname === '/api/models') {
      const refresh = url.searchParams.get('refresh') === '1';
      return json(res, 200, await manager.listModels({ refresh }));
    }

    if (req.method === 'GET' && pathname === '/api/local') {
      // Deliberate user action: it may probe Pi once so the advertised provider
      // id is one Pi actually serves.
      return json(res, 200, await manager.localStatus({ probeCatalog: true }));
    }
    if (req.method === 'POST' && pathname === '/api/local/start') {
      return json(res, 200, await manager.startLocal());
    }
    if (req.method === 'POST' && pathname === '/api/local/load') {
      const { model } = await readJson(req);
      return json(res, 200, await manager.loadLocalModel(model));
    }
    if (req.method === 'POST' && pathname === '/api/local/unload') {
      const { model } = await readJson(req);
      return json(res, 200, await manager.unloadLocalModel(model));
    }
    if (req.method === 'POST' && pathname === '/api/local/stop') {
      return json(res, 200, await manager.stopLocal());
    }
    if (req.method === 'GET' && pathname === '/api/local/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 2000\n\n');
      const send = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {} };
      const onStatus = data => send('status', data);
      const onProgress = data => send('progress', data);
      const onEvent = data => send('event', data);
      manager.localModels.on('status', onStatus);
      manager.localModels.on('progress', onProgress);
      manager.localModels.on('event', onEvent);
      manager.localStatus().then(status => send('snapshot', status)).catch(() => {});
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      res.on('close', () => {
        clearInterval(heartbeat);
        manager.localModels.off('status', onStatus);
        manager.localModels.off('progress', onProgress);
        manager.localModels.off('event', onEvent);
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/mcp') {
      return json(res, 200, await manager.mcpStatus());
    }
    if (req.method === 'POST' && pathname === '/api/mcp/mode') {
      const body = await readJson(req);
      const mode = String(body.mode || '');
      if (!['inherit', 'managed', 'off'].includes(mode)) throw Object.assign(new Error('Неизвестный режим MCP.'), { code: 'INPUT_INVALID' });
      config.pi = config.pi || {};
      config.pi.mcp = { ...(config.pi.mcp || {}), mode };
      await saveConfig(rootDir, config);
      await manager.mcp.ensureReady().catch(() => {});
      return json(res, 200, await manager.mcpStatus());
    }
    if (req.method === 'POST' && pathname === '/api/mcp/import') {
      return json(res, 200, await manager.importMcp());
    }
    if (req.method === 'POST' && pathname === '/api/mcp/servers') {
      const body = await readJson(req);
      if (typeof body.name !== 'string' || !body.name.trim()) throw Object.assign(new Error('Не указан MCP-сервер.'), { code: 'INPUT_INVALID' });
      return json(res, 200, await manager.setMcpServer(body.name.trim(), body.enabled !== false));
    }
    if (req.method === 'POST' && pathname === '/api/mcp/tools') {
      const body = await readJson(req);
      if (typeof body.server !== 'string' || !body.server.trim()) throw Object.assign(new Error('Не указан MCP-сервер.'), { code: 'INPUT_INVALID' });
      return json(res, 200, await manager.setMcpTool(body.server.trim(), body.tool, body.enabled !== false));
    }

    if (req.method === 'GET' && pathname === '/api/info') {
      const [busy, modelReady, engine, local] = await Promise.all([
        manager.local.getBusyStatus(), manager.local.isReady(), manager.local.getEngineInfo(), manager.localStatus()
      ]);
      const settings = await readPiSettings().catch(() => null);
      const warnings = [];
      if (imagesBlocked(settings)) {
        warnings.push({
          code: 'PI_IMAGES_BLOCKED',
          message: 'В настройках Pi включён images.blockImages — Pi заменяет любые картинки на текст «Image reading is disabled.» до отправки модели. Выключите его командой /images или в /settings, иначе никакая vision-модель не увидит вложения.'
        });
      }
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
        local,
        warnings,
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
    // Native Pi sessions across every project, grouped, with a "likely current"
    // suggestion (§ importer P0). The project-scoped route above stays for
    // compatibility.
    if (req.method === 'GET' && pathname === '/api/native-sessions') {
      return json(res, 200, await manager.nativeSessions.listAll());
    }
    if (req.method === 'GET' && pathname === '/api/native-sessions/preview') {
      return json(res, 200, await manager.nativeSessions.preview({
        projectId: url.searchParams.get('projectId'),
        sessionKey: url.searchParams.get('key')
      }));
    }
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
      const requested = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 500;
      if (!Number.isSafeInteger(requested) || requested < 0) throw Object.assign(new Error('Invalid event limit'), { code: 'INPUT_INVALID' });
      const limit = requested === 0 ? maxEventsPerRequest : Math.min(requested, maxEventsPerRequest);
      const events = trimStreamingDeltas(await store.readEvents(match[1], limit, after));
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
      return json(res, 200, events);
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
        const history = await store.readEvents(match[1], maxEventsPerRequest, after);
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
      // now: true is "send immediately, do not wait for the local model" (the
      // Ctrl+Enter path); otherwise a busy model means the prompt is queued.
      return json(res, 200, await manager.message(match[1], body.text, body.mode || 'auto', body.files || [], body.uploadToken,
        { now: body.now === true, queue: body.queue === true }));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/pending\/send$/);
    if (req.method === 'POST' && match) return json(res, 200, await manager.sendPendingNow(match[1]));

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/pending$/);
    if (req.method === 'DELETE' && match) return json(res, 200, await manager.dropPending(match[1]));

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/model$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.setModel(match[1], body.provider, body.id || body.modelId));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/thinking$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.setThinkingLevel(match[1], body.level));
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

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/approvals$/);
    if (req.method === 'GET' && match) {
      if (!manager.getTask(match[1])) return errorJson(res, 404, Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' }));
      return json(res, 200, manager.listApprovals(match[1]));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/approvals\/([^/]+)$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      const decision = String(body.decision || '');
      if (!['ALLOW_ONCE', 'DENY'].includes(decision)) throw Object.assign(new Error('Неизвестное решение по подтверждению.'), { code: 'INPUT_INVALID' });
      if (!manager.resolveApproval(match[1], match[2], decision)) {
        return errorJson(res, 404, Object.assign(new Error('Запрос подтверждения уже неактуален.'), { code: 'NOT_FOUND' }));
      }
      return json(res, 200, { ok: true, approvalId: match[2], decision });
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/tools\/([^/]+)\/output$/);
    if (req.method === 'GET' && match) {
      if (!manager.getTask(match[1])) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const maxKb = Number(url.searchParams.get('maxKb') || 0);
      const result = await manager.fetchToolOutput(match[1], match[2], maxKb > 0 ? { maxBytes: maxKb * 1024 } : {});
      return json(res, 200, result);
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
      : ['INPUT_INVALID', 'PROJECT_DIRTY', 'NOT_CONFIGURED', 'MODEL_NOT_FOUND'].includes(error.code) ? 400
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
