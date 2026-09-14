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

// Hop-by-hop headers belong to a single connection and must not be forwarded
// (RFC 9110 §7.6.1). `transfer-encoding` is included on purpose: Node frames the
// forwarded message itself, and copying the upstream's framing breaks chunked
// responses and SSE.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function forwardRequestHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  // The app sees the connection coming from loopback (this process). Tell it
  // where the request really came from without pretending it is a substitute
  // for the Host check above.
  const existing = headers['x-forwarded-for'];
  out['x-forwarded-for'] = existing ? `${existing}, 127.0.0.1` : '127.0.0.1';
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
// not a configuration.
export function createReverseProxy({ upstreamHost = '127.0.0.1', upstreamPort, port = 0, host = '0.0.0.0', logger = console } = {}) {
  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) throw new Error('upstreamPort is required');
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const upstream = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: forwardRequestHeaders(req.headers),
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
  });

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
      this.baseUrl = `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${bound.port}`;
      return bound;
    },
    async close() {
      for (const socket of sockets) { try { socket.destroy(); } catch { /* already gone */ } }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
