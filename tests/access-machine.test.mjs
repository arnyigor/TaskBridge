import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AccessControl, lanAllowed, isTailnetIp } from '../src/auth.mjs';

// `machine()` decides whether a request came from the computer itself — the gate
// for opening a file with an OS application. It must say yes for the PC (even
// when it reaches the app through the LAN proxy from its own LAN address) and no
// for a phone on the same network.
const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
const access = () => new AccessControl({}, os.tmpdir()); // auth off: no files involved

test('machine() accepts loopback and this host, rejects everybody else', () => {
  const a = access();
  assert.equal(a.machine(req('127.0.0.1')), true, 'loopback IPv4');
  assert.equal(a.machine(req('::1')), true, 'loopback IPv6');
  assert.equal(a.machine(req('::ffff:127.0.0.1')), true, 'IPv4-mapped loopback');
  assert.equal(a.machine(req('203.0.113.9')), false, 'a remote address is not this machine');

  // A LAN address this host actually owns counts as the machine; a phone's does not.
  const own = Object.values(os.networkInterfaces()).flat().map(i => i && i.address).find(address => address && !/^127\.|^::1$/.test(address));
  if (own) assert.equal(a.machine(req(own)), true, `own address ${own}`);
  assert.equal(a.machine(req('198.51.100.7')), false, 'an address this host does not own');
});

test('machine() trusts only the last X-Forwarded-For entry from a loopback proxy', () => {
  const a = access();
  // Browser on the PC using the machine's LAN address: the proxy forwards it.
  assert.equal(a.machine(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.212' })), true);
  // A phone: the proxy appended the phone's address.
  assert.equal(a.machine(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.50' })), false);
  // A client may prepend its own value; the entry our proxy appended is last and
  // is the one we trust, so a spoofed "I am the PC" cannot get in.
  assert.equal(a.machine(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.212, 192.168.1.50' })), false);
  assert.equal(a.machine(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.50, 127.0.0.1' })), true);
});

test('the Host-based local() rule is unchanged (the pairing code still needs it)', () => {
  const a = access();
  assert.equal(a.local(req('127.0.0.1', { host: 'localhost:8787' })), true);
  assert.equal(a.local(req('127.0.0.1', { host: '192.168.1.212:8787' })), false);
});

test('pair() rate-limits per real client, not per proxy socket', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-auth-'));
  const a = new AccessControl({ enabled: true }, dir);
  await a.init();
  const res = { setHeader() {} };
  const viaProxy = ip => req('127.0.0.1', { 'x-forwarded-for': ip });
  for (let i = 0; i < 5; i++) await assert.rejects(a.pair(viaProxy('192.168.1.50'), res, { code: 'wrong' }), { code: 'AUTH_REQUIRED' });
  await assert.rejects(a.pair(viaProxy('192.168.1.50'), res, { code: 'wrong' }), { code: 'RATE_LIMITED' });
  // Another phone behind the same proxy is not locked out by the first one.
  const paired = await a.pair(viaProxy('192.168.1.51'), res, { code: a.pairing().code });
  assert.match(paired.token, /^[a-f0-9]{64}$/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('device tokens persist, legacy signed cookies keep working until expiry', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-auth-'));
  const a = new AccessControl({ enabled: true }, dir);
  await a.init();
  const { token, device } = await a.addDevice({ name: 'Pixel', kind: 'android' });
  const b = new AccessControl({ enabled: true }, dir);
  await b.init();
  const remote = headers => ({ method: 'GET', ...req('192.168.1.50', { host: '192.168.1.2:8787', ...headers }) });
  assert.equal(b.authenticated(remote({ authorization: `Bearer ${token}` })), true, 'token survives a restart');
  assert.equal(b.device(remote({ authorization: `Bearer ${token}` })).deviceId, device.deviceId);
  await b.removeDevice(device.deviceId);
  assert.equal(b.authenticated(remote({ authorization: `Bearer ${token}` })), false);

  const unsigned = `${Date.now() + 86400000}.${'ab'.repeat(16)}`;
  const legacy = `taskbridge_session=${unsigned}.${b.sign(unsigned)}`;
  assert.equal(b.authenticated(remote({ cookie: legacy })), true, 'an old cookie still works');
  const expired = `${Date.now() - 1000}.${'ab'.repeat(16)}`;
  assert.equal(b.authenticated(remote({ cookie: `taskbridge_session=${expired}.${b.sign(expired)}` })), false);
  assert.equal(b.authenticated(remote({ cookie: `taskbridge_session=${unsigned}.${'0'.repeat(64)}` })), false, 'a forged signature does not');
  await fs.rm(dir, { recursive: true, force: true });
});

test('isTailnetIp() covers exactly 100.64.0.0/10', () => {
  for (const ip of ['100.64.0.1', '100.101.102.103', '100.127.255.254']) assert.equal(isTailnetIp(ip), true, ip);
  for (const ip of ['100.63.255.255', '100.128.0.0', '10.0.0.1', '192.168.1.1', '']) assert.equal(isTailnetIp(ip), false, ip);
});

test('lanAllowed(): beyond loopback only with auth on (R1.1)', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.equal(lanAllowed(host, {}), true, host);
  assert.equal(lanAllowed('0.0.0.0', { enabled: false }), false);
  assert.equal(lanAllowed('192.168.1.42', undefined), false);
  assert.equal(lanAllowed('0.0.0.0', { enabled: true }), true);
});
