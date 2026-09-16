import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReverseProxy } from '../src/proxy.mjs';
import { ensureTlsCert } from '../src/tls.mjs';

function startUpstream(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), chunks }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// Boots an upstream plus a proxy in front of it and tears both down after the
// test, so each case reads as one scenario instead of a stack of cleanup.
async function withProxy(t, handler, proxyOptions = {}) {
  const { server: up, port: upPort } = await startUpstream(handler);
  t.after(() => new Promise((resolve) => up.close(resolve)));
  const proxy = createReverseProxy({ upstreamPort: upPort, port: 0, host: '127.0.0.1', logger: { error: () => {} }, ...proxyOptions });
  await proxy.listen();
  t.after(() => proxy.close());
  return { proxy, upPort };
}

test('the proxy returns the upstream status, headers and body', async (t) => {
  const { proxy } = await withProxy(t, (req, res) => {
    res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });

  const res = await request(proxy.port, { method: 'GET', path: '/api/tasks?after=7' });
  assert.equal(res.status, 201);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(res.body), { ok: true, path: '/api/tasks?after=7' });
});

test('the original Host header reaches the app untouched', async (t) => {
  // /api/auth/pairing answers only to a loopback peer AND a loopback Host. Every
  // request behind a proxy has a loopback peer, so the Host leg is the only one
  // left — rewriting it would expose the pairing code to the whole LAN.
  const { proxy } = await withProxy(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`${req.headers.host || ''}|${req.headers['x-forwarded-for'] || ''}`);
  });

  const res = await request(proxy.port, { path: '/api/auth/pairing', headers: { host: '192.168.1.212:8787' } });
  assert.equal(res.body, '192.168.1.212:8787|127.0.0.1');
});

test('the proxy appends the real client address to X-Forwarded-For', async (t) => {
  // A client-supplied value is preserved in front; the entry this hop appends
  // goes last and is the trustworthy one — that is how the app tells a PC using
  // its own LAN address from a phone when both arrive via loopback.
  const { proxy } = await withProxy(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.headers['x-forwarded-for'] || '');
  });
  const res = await request(proxy.port, { path: '/', headers: { 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(res.body, '198.51.100.7, 127.0.0.1');
});

test('an event stream is forwarded as it is written, not held until its end', async (t) => {
  const { proxy } = await withProxy(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    res.write('data: first\n\n');
    setTimeout(() => { res.write('data: second\n\n'); res.end(); }, 60);
  });

  const seen = [];
  let headersBeforeEnd = false;
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, path: '/api/tasks/x/stream' }, (res) => {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      res.on('data', (chunk) => {
        if (seen.length === 0) headersBeforeEnd = true;
        seen.push(chunk.toString());
      });
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end();
  });

  assert.ok(headersBeforeEnd);
  assert.equal(seen.length, 2, `each write must arrive on its own, got ${JSON.stringify(seen)}`);
  assert.match(seen[0], /first/);
  assert.doesNotMatch(seen[0], /second/);
  assert.match(seen[1], /second/);
});

test('a request body streams upstream instead of being buffered first', async (t) => {
  let receivedFirstChunk = null;
  const { proxy } = await withProxy(t, (req, res) => {
    let bytes = 0;
    req.on('data', (chunk) => {
      if (bytes === 0) receivedFirstChunk = Date.now();
      bytes += chunk.length;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(String(bytes));
    });
  });

  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: '/api/uploads' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.write('a'.repeat(1024));
    // The second half leaves only after the upstream has been observed reading
    // the first: a proxy that buffered the whole body would not have done that.
    setTimeout(() => req.end('b'.repeat(1024)), 60);
  });

  assert.equal(result, '2048');
  assert.ok(receivedFirstChunk !== null && receivedFirstChunk - started < 60, 'the upstream saw the body while the client was still sending');
});

test('an unreachable upstream answers 502 instead of hanging or crashing', async (t) => {
  // Nothing listens on this port: the proxy must fail fast and stay alive.
  const proxy = createReverseProxy({ upstreamPort: 9, port: 0, host: '127.0.0.1', logger: { error: () => {} } });
  await proxy.listen();
  t.after(() => proxy.close());

  const res = await request(proxy.port, { path: '/api/info' });
  assert.equal(res.status, 502);
  assert.equal(JSON.parse(res.body).code, 'BAD_GATEWAY');

  // Still usable for the next request (a refused connection must not wedge it).
  const again = await request(proxy.port, { path: '/api/info' });
  assert.equal(again.status, 502);
});

test('the proxy binds the address it is given, and refuses to start without an upstream', async (t) => {
  assert.throws(() => createReverseProxy({ port: 0, host: '127.0.0.1' }), /upstreamPort is required/);

  const { server: up, port: upPort } = await startUpstream((req, res) => res.end('up'));
  t.after(() => new Promise((resolve) => up.close(resolve)));
  const proxy = createReverseProxy({ upstreamPort: upPort, port: 0, host: '127.0.0.1' });
  t.after(() => proxy.close());
  const bound = await proxy.listen();

  // The LAN face may listen on 0.0.0.0; this asserts the app-facing side is
  // pinned where the caller asked, which is what keeps a second door shut.
  assert.equal(bound.address, '127.0.0.1');
  assert.equal(proxy.address, '127.0.0.1');
  assert.ok(proxy.port > 0);

  const res = await request(proxy.port, { path: '/' });
  assert.equal(res.body, 'up');
  await sleep(0); // keep the async shape obvious for the teardown hooks
});

test('with a certificate the proxy terminates TLS and still forwards plain http', async (t) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-tls-'));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  // The self-signed cert comes from the same helper the app uses, so this also
  // covers "TLS moved to the proxy" (step 3) — except where openssl is missing.
  let tls;
  try { tls = await ensureTlsCert(dataRoot); }
  catch (error) { t.skip(`no certificate available: ${error.message}`); return; }

  const { server: up, port: upPort } = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ scheme: req.headers['x-forwarded-proto'] || 'http' }));
  });
  t.after(() => new Promise((resolve) => up.close(resolve)));

  const proxy = createReverseProxy({ upstreamPort: upPort, port: 0, host: '127.0.0.1', tls, logger: { error: () => {} } });
  await proxy.listen();
  t.after(() => proxy.close());

  const body = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: proxy.port, path: '/api/info', rejectUnauthorized: false }, (res) => {
      assert.equal(res.statusCode, 200);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });

  assert.deepEqual(JSON.parse(body), { scheme: 'http' });
  assert.match(proxy.baseUrl, /^https:/);
});
