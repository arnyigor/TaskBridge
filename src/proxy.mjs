// The LAN-facing half of the split (docs/agent-host-separation.md §12, variant B).
//
// It owns no state: every request is passed to the app behind it over loopback
// HTTP and the answer is streamed back. The one and only implementation of the
// API stays in that app — this process exists to be restartable (the goal of
// step 5) and to keep the two guarantees a naive proxy silently breaks:
//
//   1. the original Host header is forwarded untouched. `/api/auth/pairing`
//      answers only to a loopback peer *and* a loopback Host, so rewriting Host
//      to 127.0.0.1 would hand the pairing code to every phone in the LAN —
//      every request already arrives from loopback (this process).
//   2. bodies are piped, never buffered. A 64 MiB upload reaches the app while
//      it is still being sent, and an SSE stream is not held until its end.
//
// This module deliberately knows nothing about TaskBridge: no routes, no store,
// no config. Wiring (bind address, port, TLS, launcher) is the caller's job.

import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { ensureTlsCert } from './tls.mjs';

// Hop-by-hop headers belong to a single connection and must not be forwarded
// (RFC 9110 §7.6.1). `transfer-encoding` is included on purpose: Node frames the
// forwarded message itself, and copying the upstream's framing breaks chunked
// responses and SSE.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function forwardRequestHeaders(headers, clientAddress) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  // The app sees every connection coming from loopback (this process), so a
  // Host check alone cannot tell the PC (using its LAN address) from a phone.
  // Append the address this hop actually received the request from as the last
  // X-Forwarded-For entry: a client may prepend its own value, but it cannot
  // change the entry we add, so the last one is trustworthy.
  const client = clientAddress ? String(clientAddress) : '127.0.0.1';
  const existing = headers['x-forwarded-for'];
  out['x-forwarded-for'] = existing ? `${existing}, ${client}` : client;
  return out;
}

function responseHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

// start() resolves once the proxy is listening; `address`/`port` are then the
// bound ones. `upstreamPort` is required — a proxy with nowhere to go is a bug,
// not a configuration. `tls: { key, cert }` makes it an https listener (the
// proxy owns the public TLS face, the app behind it stays plain loopback http).
export function createReverseProxy({ upstreamHost = '127.0.0.1', upstreamPort, port = 0, host = '0.0.0.0', tls = null, logger = console } = {}) {
  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) throw new Error('upstreamPort is required');
  const sockets = new Set();

  const handle = (req, res) => {
    const upstream = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: forwardRequestHeaders(req.headers, req.socket?.remoteAddress),
    });

    upstream.on('response', (up) => {
      res.writeHead(up.statusCode, responseHeaders(up.headers));
      // Headers must be on the wire before the first event, otherwise a live
      // stream looks like a hung request for as long as the agent thinks.
      res.flushHeaders?.();
      up.pipe(res);
    });

    upstream.on('error', (error) => {
      if (res.headersSent) { res.destroy(); return; }
      logger.error?.(`[proxy] upstream ${upstreamHost}:${upstreamPort} unreachable: ${error.message}`);
      const body = JSON.stringify({ error: 'TaskBridge upstream is not reachable', code: 'BAD_GATEWAY' });
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });

    // The client left (closed tab, phone off Wi-Fi): stop talking upstream
    // instead of leaving a half-open request behind.
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  };

  const server = tls
    ? https.createServer({ key: tls.key, cert: tls.cert }, handle)
    : http.createServer(handle);

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    server,
    port: null,
    address: null,
    baseUrl: null,
    async listen() {
      const bound = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address());
        });
      });
      this.port = bound.port;
      this.address = bound.address;
      this.baseUrl = `${tls ? 'https' : 'http'}://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${bound.port}`;
      return bound;
    },
    async close() {
      for (const socket of sockets) { try { socket.destroy(); } catch { /* already gone */ } }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// --- CLI main (only when run directly) --------------------------------------
// The second process of variant B. The app behind it is started separately and
// told to bind loopback (TASKBRIDGE_BIND_HOST); this process is the one the LAN
// — and the phone — talk to, including TLS.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dataRoot = path.join(rootDir, 'data');
  const config = await loadConfig(rootDir);
  const upstreamPort = Number(process.env.LAN_INTERNAL_PORT);
  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
    console.error('[proxy] LAN_INTERNAL_PORT is required (the port the app listens on)');
    process.exit(1);
  }
  const host = process.env.LAN_HOST || config.server?.host || '0.0.0.0';
  const port = Number(process.env.LAN_PORT || config.server?.port || 8787);
  const httpsConfig = config.server?.https || {};

  const started = [];
  const plain = createReverseProxy({ upstreamPort, port, host });
  await plain.listen();
  started.push(plain);
  console.log(`[proxy] http://${host}:${plain.port} -> 127.0.0.1:${upstreamPort}`);

  // The app listens on both a plain and a TLS port; the proxy mirrors that, so
  // an existing phone bookmark on https keeps working in split mode.
  // LAN_TLS=off is for callers that must not touch 8443 (acceptance harnesses):
  // the config is the repo's, so https.enabled there is not about them.
  if (httpsConfig.enabled && process.env.LAN_TLS !== 'off') {
    try {
      const { key, cert, certPath } = await ensureTlsCert(dataRoot);
      const secure = createReverseProxy({ upstreamPort, port: Number(httpsConfig.port || 8443), host, tls: { key, cert } });
      await secure.listen();
      started.push(secure);
      console.log(`[proxy] https://${host}:${secure.port} -> 127.0.0.1:${upstreamPort} (self-signed: ${certPath})`);
    } catch (error) {
      console.error(`[proxy] HTTPS disabled: failed to prepare certificate (${error.message}). Is 'openssl' on PATH?`);
    }
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    for (const item of started) { try { await item.close(); } catch { /* already gone */ } }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
