import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

// Stage 1 of the roadmap over real HTTP: device tokens (R1.2), Origin (R1.3),
// the reverse-proxy trap (R1.4) and the pairing QR (R1.7). A "remote" client is
// simulated the way every remote client really arrives here — through a
// loopback reverse proxy that appends the real address to X-Forwarded-For.
const PHONE = '100.101.102.103';

function request(base, route, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(route, base);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const remote = (extra = {}) => ({ 'x-forwarded-for': PHONE, ...extra });

test('stage 1: pairing, Bearer, cookies, Origin, proxy headers, revocation', { timeout: 60000 }, async t => {
  const fixture = await startFixture(undefined, {
    server: { auth: { enabled: true, allowedOrigins: ['https://pc.tailnet-test.ts.net/'] }, tailscale: { httpsUrl: 'https://pc.tailnet-test.ts.net' } }
  });
  t.after(() => fixture.close());
  const { base } = fixture;
  const host = new URL(base).host;

  // --- R1.4: nothing that trusts "local" leaks through a proxy -------------
  const pairing = await request(base, '/api/auth/pairing');
  assert.equal(pairing.status, 200);
  assert.match(pairing.data.code, /^\d{8}$/);
  assert.equal((await request(base, '/api/auth/pairing', { headers: remote() })).status, 403, 'a proxied tailnet peer must not read the code');
  assert.equal((await request(base, '/api/auth/pairing', { headers: { 'tailscale-user-login': 'someone@example.com' } })).status, 403, 'a request tagged by tailscale serve is not local');
  assert.equal((await request(base, '/api/tasks', { headers: remote() })).status, 401, 'Host 127.0.0.1 behind a proxy does not bypass auth');
  // Our own proxy forwarding the PC's browser keeps it local.
  assert.equal((await request(base, '/api/auth/pairing', { headers: { 'x-forwarded-for': '127.0.0.1' } })).status, 200);

  // --- R1.7: the QR payload ------------------------------------------------
  const qr = pairing.data.qr;
  assert.equal(qr.v, 1);
  assert.equal(qr.pairingCode, pairing.data.code);
  assert.equal(Date.parse(qr.expiresAt), pairing.data.expiresAt);
  assert.ok(qr.name);
  assert.ok(qr.endpoints.some(item => item.kind === 'tailnet-https' && item.url === 'https://pc.tailnet-test.ts.net'), JSON.stringify(qr.endpoints));
  for (const item of qr.endpoints) assert.ok(['lan', 'tailnet', 'tailnet-https'].includes(item.kind), item.kind);

  // --- R1.2: a native client pairs and uses Bearer -------------------------
  const wrong = await request(base, '/api/auth/pair', { method: 'POST', headers: remote(), body: { code: '00000000' === pairing.data.code ? '11111111' : '00000000' } });
  assert.equal(wrong.status, 401);
  const phone = await request(base, '/api/auth/pair', { method: 'POST', headers: remote(), body: { code: pairing.data.code, deviceName: 'Pixel', clientKind: 'android' } });
  assert.equal(phone.status, 200, JSON.stringify(phone.data));
  assert.match(phone.data.token, /^[a-f0-9]{64}$/);
  assert.match(phone.data.deviceId, /^d_[a-f0-9]{12}$/);
  const bearer = { authorization: `Bearer ${phone.data.token}` };

  assert.equal((await request(base, '/api/tasks', { headers: remote(bearer) })).status, 200, 'Bearer opens the API');
  assert.equal((await request(base, '/api/tasks', { headers: remote({ authorization: `Bearer ${'0'.repeat(64)}` }) })).status, 401, 'an unknown token does not');
  assert.equal((await request(base, '/api/tasks', { headers: remote({ authorization: 'Bearer nonsense' }) })).status, 401);
  // A native POST carries no Origin and is fine with Bearer (R1.3).
  const created = await request(base, '/api/tasks', { method: 'POST', headers: remote(bearer), body: { projectId: 'fixture', prompt: 'from the phone' } });
  assert.equal(created.status, 202, JSON.stringify(created.data));

  // --- the browser: cookie only, never a token in the body -----------------
  const code = (await request(base, '/api/auth/pairing')).data.code;
  const browser = await request(base, '/api/auth/pair', { method: 'POST', headers: remote({ origin: base }), body: { code } });
  assert.equal(browser.status, 200);
  assert.equal(browser.data.token, undefined, 'the web client must not see its token (HttpOnly)');
  const setCookie = String(browser.headers['set-cookie']);
  assert.match(setCookie, /taskbridge_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict/);
  const cookie = { cookie: setCookie.split(';')[0] };
  assert.equal((await request(base, '/api/tasks', { headers: remote(cookie) })).status, 200);
  // R1.3: a state-changing request with a cookie but no Origin is not a browser.
  const noOrigin = await request(base, '/api/tasks', { method: 'POST', headers: remote(cookie), body: { projectId: 'fixture', prompt: 'x' } });
  assert.equal(noOrigin.status, 401);
  const sameOrigin = await request(base, '/api/tasks', { method: 'POST', headers: remote({ ...cookie, origin: `http://${host}` }), body: { projectId: 'fixture', prompt: 'from the browser' } });
  assert.equal(sameOrigin.status, 202, JSON.stringify(sameOrigin.data));

  // --- R1.3: Origin allowlist ----------------------------------------------
  const evil = await request(base, '/api/tasks', { method: 'POST', headers: remote({ ...cookie, origin: 'https://evil.example' }), body: { projectId: 'fixture', prompt: 'x' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.data.code, 'ORIGIN_FORBIDDEN');
  const tailnet = await request(base, '/api/tasks', { method: 'POST', headers: remote({ ...cookie, origin: 'https://pc.tailnet-test.ts.net' }), body: { projectId: 'fixture', prompt: 'via serve' } });
  assert.equal(tailnet.status, 202, 'an allowlisted origin passes even though Host differs');

  // --- devices: list, persistence, revocation ------------------------------
  const listed = await request(base, '/api/auth/devices', { headers: remote(bearer) });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.devices.length, 2);
  const mine = listed.data.devices.find(device => device.current);
  assert.equal(mine.deviceId, phone.data.deviceId);
  assert.equal(mine.name, 'Pixel');
  assert.equal(mine.kind, 'android');
  assert.equal(listed.data.devices.find(device => !device.current).kind, 'web');
  for (const device of listed.data.devices) assert.equal(device.tokenHash, undefined, 'hashes never leave the server');

  const saved = await fs.readFile(path.join(fixture.root, 'data', 'server-auth.json'), 'utf8');
  assert.ok(!saved.includes(phone.data.token), 'the token itself is never stored');
  assert.equal(JSON.parse(saved).devices.length, 2);

  // A token survives a restart: the device list is on disk.
  await fixture.restart();
  assert.equal((await request(base, '/api/tasks', { headers: remote(bearer) })).status, 200);

  // Only the PC revokes.
  assert.equal((await request(base, `/api/auth/devices/${phone.data.deviceId}`, { method: 'DELETE', headers: remote(bearer) })).status, 403);
  assert.equal((await request(base, `/api/auth/devices/${phone.data.deviceId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request(base, `/api/auth/devices/${phone.data.deviceId}`, { method: 'DELETE' })).status, 404);
  assert.equal((await request(base, '/api/tasks', { headers: remote(bearer) })).status, 401, 'a revoked token is dead at once');
  assert.equal((await request(base, '/api/tasks', { headers: remote(cookie) })).status, 200, 'the other device is untouched');
});

test('stage 1: rate limit per client behind the proxy, over HTTP', { timeout: 30000 }, async t => {
  const fixture = await startFixture(undefined, { server: { auth: { enabled: true } } });
  t.after(() => fixture.close());
  const code = (await request(fixture.base, '/api/auth/pairing')).data.code;
  const bad = code === '00000000' ? '11111111' : '00000000';
  for (let i = 0; i < 5; i++) assert.equal((await request(fixture.base, '/api/auth/pair', { method: 'POST', headers: { 'x-forwarded-for': '192.168.1.50' }, body: { code: bad } })).status, 401);
  assert.equal((await request(fixture.base, '/api/auth/pair', { method: 'POST', headers: { 'x-forwarded-for': '192.168.1.50' }, body: { code } })).status, 429, 'locked out even with the right code');
  assert.equal((await request(fixture.base, '/api/auth/pair', { method: 'POST', headers: { 'x-forwarded-for': '192.168.1.51' }, body: { code } })).status, 200, 'another phone is not');
});
